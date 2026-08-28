import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import {
  AiConfidence,
  AiReviewStatus,
  CodingFindingKind,
  CodingSubmissionStatus,
  CodingVerdict,
} from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CodingSubmissionsService } from './coding-submissions.service';
import { CodingLiveService } from './coding-live.service';

/** Bumped when the prompt/schema changes, so a review records how it was made. */
const PROMPT_VERSION = 'coding-review-gemini-v1';
const PROVIDER = 'google';
/**
 * Gemini 3.1 Flash-Lite by default — cheap, generous quota, ample for reviewing
 * a single submission. `gemini-flash-lite-latest` tracks the current Flash-Lite;
 * pin an exact id via CODING_AI_MODEL when you subscribe.
 */
const MODEL = process.env.CODING_AI_MODEL || 'gemini-flash-lite-latest';

/** The structured verdict we require back from the model. Enums line up 1:1
 *  with the Prisma enums so persistence is a direct map. */
const ReviewSchema = z.object({
  overallScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Overall quality score 0–100, grounded in the rubric.'),
  confidence: z
    .enum(['HIGH', 'MEDIUM', 'LOW'])
    .describe('Your confidence in this assessment overall.'),
  summary: z.string().describe('2–4 sentence summary for the instructor.'),
  requirementResults: z
    .array(
      z.object({
        requirementId: z.string(),
        verdict: z.enum(['PASS', 'PARTIAL', 'FAIL']),
      }),
    )
    .describe('One entry for every requirement id, using the exact ids given.'),
  findings: z
    .array(
      z.object({
        kind: z.enum(['BUG', 'SECURITY', 'QUALITY', 'ARCHITECTURE', 'STRENGTH']),
        title: z.string(),
        body: z.string(),
        confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      }),
    )
    .describe('Concrete findings; include at least one strength where earned.'),
});
type ReviewOutput = z.infer<typeof ReviewSchema>;

/** The same shape expressed for Gemini's structured-output `responseSchema`.
 *  The returned JSON is still validated against ReviewSchema (zod) before use. */
const GEMINI_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overallScore: { type: Type.INTEGER },
    confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW'] },
    summary: { type: Type.STRING },
    requirementResults: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          requirementId: { type: Type.STRING },
          verdict: { type: Type.STRING, enum: ['PASS', 'PARTIAL', 'FAIL'] },
        },
        required: ['requirementId', 'verdict'],
      },
    },
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: {
            type: Type.STRING,
            enum: ['BUG', 'SECURITY', 'QUALITY', 'ARCHITECTURE', 'STRENGTH'],
          },
          title: { type: Type.STRING },
          body: { type: Type.STRING },
          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
        required: ['kind', 'title', 'body', 'confidence'],
      },
    },
  },
  required: [
    'overallScore',
    'confidence',
    'summary',
    'requirementResults',
    'findings',
  ],
};

/**
 * Coding Instructor Plugin — the AI code reviewer (Claude). It is an assistant,
 * never the final authority: it reads the student's code against the assignment
 * requirements + rubric and returns a structured, instructor-overridable verdict.
 * It never executes code and never claims a test ran (there is no test runner).
 */
@Injectable()
export class CodingAiReviewService {
  private readonly log = new Logger(CodingAiReviewService.name);
  // Gemini client; null when GEMINI_API_KEY is unset (review degrades to a
  // human decision rather than crashing the pipeline).
  private readonly gemini = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly submissions: CodingSubmissionsService,
    private readonly live: CodingLiveService,
  ) {}

  /** After a submission lands, run the review if the assignment opts in. */
  async maybeAutoReview(submissionId: string) {
    const submission = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: { assignment: { select: { aiAutoReview: true } } },
    });
    if (submission?.assignment.aiAutoReview) this.enqueue(submissionId);
  }

  /** Manager re-runs the review manually. */
  async requestReview(user: JwtPayload, submissionId: string) {
    const submission = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: { assignment: { select: { courseId: true } } },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    await this.courses.assertCanManageCourse(
      user,
      submission.assignment.courseId,
    );
    this.enqueue(submissionId);
    return { queued: true };
  }

  /** Fire-and-forget the review (single-process; a queue arrives with scale). */
  enqueue(submissionId: string) {
    void this.review(submissionId).catch((err) => {
      this.log.error(`AI review failed for ${submissionId}: ${String(err)}`);
    });
  }

  /** Run one review end to end: build context → call Claude → persist. */
  async review(submissionId: string): Promise<void> {
    const submission = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      include: {
        assignment: {
          include: {
            requirements: { orderBy: { order: 'asc' } },
            rubric: { orderBy: { order: 'asc' } },
          },
        },
      },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    const { assignment } = submission;

    const review = await this.prisma.codingAiReview.create({
      data: {
        submissionId,
        provider: PROVIDER,
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        status: AiReviewStatus.RUNNING,
      },
    });
    await this.prisma.codingSubmission.update({
      where: { id: submissionId },
      data: { status: CodingSubmissionStatus.UNDER_REVIEW },
    });

    // No key configured (e.g. local dev): fail the review gracefully and hand
    // the submission to the instructor rather than crashing the pipeline.
    if (!this.gemini) {
      await this.fail(review.id, submissionId, 'AI review is not configured');
      return;
    }

    try {
      const files = await this.submissions.readSubmissionText(submissionId);
      const output = await this.callGemini(assignment, files);
      await this.persist(review.id, submissionId, assignment.requirements, output);
    } catch (err) {
      await this.fail(review.id, submissionId, String(err));
      throw err;
    }
  }

  // ---------- Gemini call ----------

  private async callGemini(
    assignment: {
      title: string;
      description: string | null;
      language: string | null;
      framework: string | null;
      requirements: { id: string; text: string; mandatory: boolean }[];
      rubric: { criterion: string; weight: number; mandatory: boolean; aiInstructions: string | null }[];
    },
    files: { path: string; content: string }[],
  ): Promise<ReviewOutput> {
    const requirementLines = assignment.requirements
      .map((r) => `- [${r.id}]${r.mandatory ? ' (MANDATORY)' : ''} ${r.text}`)
      .join('\n');
    const rubricLines = assignment.rubric.length
      ? assignment.rubric
          .map(
            (r) =>
              `- ${r.criterion} — weight ${r.weight}%${r.mandatory ? ' (mandatory)' : ''}${r.aiInstructions ? ` — ${r.aiInstructions}` : ''}`,
          )
          .join('\n')
      : '(no explicit rubric — weight correctness and requirement coverage)';
    const code = files.length
      ? files
          .map((f) => `\n----- FILE: ${f.path} -----\n${f.content}`)
          .join('\n')
      : '(no readable source files were found in the submission)';

    const system = [
      'You are an expert programming instructor reviewing a student submission.',
      'You are an assistant to the human instructor, NOT the final authority.',
      'Rules:',
      '- Judge each requirement only from the code you were given.',
      '- You cannot run the code and there is no automated test runner; never claim a test passed or failed.',
      '- Return every requirement id exactly once, with your best-supported verdict.',
      '- Be honest about uncertainty: use LOW confidence when the code is ambiguous.',
      '- Ground the overall score in the rubric and requirement coverage.',
    ].join('\n');

    const user = [
      `Assignment: ${assignment.title}`,
      assignment.language ? `Language: ${assignment.language}` : '',
      assignment.framework ? `Framework: ${assignment.framework}` : '',
      assignment.description ? `\nDescription:\n${assignment.description}` : '',
      `\nRequirements (id in brackets):\n${requirementLines}`,
      `\nRubric:\n${rubricLines}`,
      `\nStudent submission files:\n${code}`,
    ]
      .filter(Boolean)
      .join('\n');

    if (!this.gemini) {
      throw new Error('AI review is not configured');
    }
    const response = await this.gemini.models.generateContent({
      model: MODEL,
      contents: `${system}\n\n${user}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        temperature: 0.2,
      },
    });

    const raw = response.text ?? '';
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error('AI review did not return valid JSON');
    }
    // Trust nothing: validate/coerce the model output against our own schema.
    const parsed = ReviewSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('AI review did not match the expected schema');
    }
    return parsed.data;
  }

  // ---------- Persistence ----------

  private async persist(
    reviewId: string,
    submissionId: string,
    requirements: { id: string; mandatory: boolean }[],
    out: ReviewOutput,
  ) {
    const validIds = new Set(requirements.map((r) => r.id));
    const seen = new Set<string>();
    const results = out.requirementResults.filter((r) => {
      if (!validIds.has(r.requirementId) || seen.has(r.requirementId)) {
        return false;
      }
      seen.add(r.requirementId);
      return true;
    });

    const confidence = out.confidence as AiConfidence;
    const needsReview = confidence === AiConfidence.LOW;

    await this.prisma.$transaction([
      this.prisma.codingAiReview.update({
        where: { id: reviewId },
        data: {
          status: AiReviewStatus.DONE,
          score: out.overallScore,
          confidence,
          summary: out.summary,
          findings: {
            create: out.findings.map((f) => ({
              kind: f.kind as CodingFindingKind,
              title: f.title.slice(0, 250),
              body: f.body,
              confidence: f.confidence as AiConfidence,
            })),
          },
          results: {
            create: results.map((r) => ({
              requirementId: r.requirementId,
              verdict: r.verdict as CodingVerdict,
            })),
          },
        },
      }),
      this.prisma.codingSubmission.update({
        where: { id: submissionId },
        data: {
          provisionalScore: out.overallScore,
          status: needsReview
            ? CodingSubmissionStatus.NEEDS_REVIEW
            : CodingSubmissionStatus.AI_REVIEWED,
        },
      }),
    ]);

    // The provisional score just landed — push it to the live board + staff card.
    await this.live.broadcastSubmissionUpdate(submissionId);
  }

  private async fail(reviewId: string, submissionId: string, message: string) {
    await this.prisma.$transaction([
      this.prisma.codingAiReview.update({
        where: { id: reviewId },
        data: { status: AiReviewStatus.ERROR, error: message.slice(0, 1000) },
      }),
      // Hand it to a human rather than leaving it stuck under review.
      this.prisma.codingSubmission.update({
        where: { id: submissionId },
        data: { status: CodingSubmissionStatus.NEEDS_REVIEW },
      }),
    ]);
    await this.live.broadcastSubmissionUpdate(submissionId);
  }
}
