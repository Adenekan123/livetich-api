import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
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

/** Bumped when the prompt/schema changes, so a review records how it was made. */
const PROMPT_VERSION = 'coding-review-v1';
const PROVIDER = 'anthropic';
/** Overridable so the pilot can trade quality for cost without a code change. */
const MODEL = process.env.CODING_AI_MODEL || 'claude-opus-5';

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

/**
 * Coding Instructor Plugin — the AI code reviewer (Claude). It is an assistant,
 * never the final authority: it reads the student's code against the assignment
 * requirements + rubric and returns a structured, instructor-overridable verdict.
 * It never executes code and never claims a test ran (there is no test runner).
 */
@Injectable()
export class CodingAiReviewService {
  private readonly log = new Logger(CodingAiReviewService.name);
  private readonly anthropic = new Anthropic();

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly submissions: CodingSubmissionsService,
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
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      await this.fail(review.id, submissionId, 'AI review is not configured');
      return;
    }

    try {
      const files = await this.submissions.readSubmissionText(submissionId);
      const output = await this.callClaude(assignment, files);
      await this.persist(review.id, submissionId, assignment.requirements, output);
    } catch (err) {
      await this.fail(review.id, submissionId, String(err));
      throw err;
    }
  }

  // ---------- Claude call ----------

  private async callClaude(
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

    const response = await this.anthropic.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: zodOutputFormat(ReviewSchema), effort: 'medium' },
    });

    if (!response.parsed_output) {
      throw new Error('AI review did not return a valid structured result');
    }
    return response.parsed_output;
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
  }
}
