import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, Type } from '@google/genai';

export interface DraftQuestion {
  body: string;
  options: string[];
  correctIndex: number;
}
export interface DraftTask {
  title: string;
  instructions?: string;
}
export interface DraftResult {
  questions: DraftQuestion[];
  tasks: DraftTask[];
}

/** Longest slice of source text we send (keeps token cost + latency bounded). */
const MAX_SOURCE_CHARS = 24_000;

/**
 * Thin wrapper over Gemini for AUTHORING-TIME drafting only. Never on the
 * per-student runtime path. Structured JSON output keeps parsing deterministic;
 * the caller still lets an instructor review before anything is published.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly client: GoogleGenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('GEMINI_API_KEY');
    // Flash-Lite: cheap, generous free-tier quota, ample for authoring-time
    // drafting. Override with GEMINI_MODEL if you have quota on a bigger model.
    this.model = config.get<string>('GEMINI_MODEL') ?? 'gemini-flash-lite-latest';
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('GEMINI_API_KEY not set — AI drafting is disabled.');
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async draftAssessment(input: {
    courseTitle: string;
    sectionTitle: string;
    sourceText: string;
    questionCount: number;
    taskCount: number;
  }): Promise<DraftResult> {
    if (!this.client) {
      throw new ServiceUnavailableException('AI drafting is not configured');
    }

    const source = input.sourceText.slice(0, MAX_SOURCE_CHARS);
    const prompt = [
      `You are helping an instructor build a formative assessment for the topic`,
      `"${input.sectionTitle}" in the course "${input.courseTitle}".`,
      ``,
      `Using ONLY the source material below, write:`,
      `- ${input.questionCount} multiple-choice questions that test understanding`,
      `  of this topic. Each has 3-4 plausible options and exactly one correct`,
      `  answer (correctIndex is the 0-based position of the correct option).`,
      `- ${input.taskCount} short remediation tasks a student should do if they`,
      `  get this topic wrong (a concrete review/practice action, 1-2 sentences).`,
      ``,
      `Do not invent facts beyond the source. Keep questions clear and unambiguous.`,
      ``,
      `SOURCE MATERIAL:`,
      source,
    ].join('\n');

    let raw: string;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              questions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    body: { type: Type.STRING },
                    options: { type: Type.ARRAY, items: { type: Type.STRING } },
                    correctIndex: { type: Type.INTEGER },
                  },
                  required: ['body', 'options', 'correctIndex'],
                },
              },
              tasks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    instructions: { type: Type.STRING },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['questions', 'tasks'],
          },
        },
      });
      raw = response.text ?? '';
    } catch (e) {
      this.logger.error(`Gemini request failed: ${String(e)}`);
      throw new ServiceUnavailableException('AI drafting failed — try again');
    }

    return this.sanitize(raw);
  }

  /** Parse + clamp the model output to what our schema accepts. */
  private sanitize(raw: string): DraftResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ServiceUnavailableException('AI returned an unexpected format');
    }
    const obj = (parsed ?? {}) as {
      questions?: unknown[];
      tasks?: unknown[];
    };

    const questions: DraftQuestion[] = [];
    for (const q of Array.isArray(obj.questions) ? obj.questions : []) {
      const item = q as Partial<DraftQuestion>;
      const body = typeof item.body === 'string' ? item.body.trim() : '';
      const options = Array.isArray(item.options)
        ? item.options
            .filter((o): o is string => typeof o === 'string')
            .map((o) => o.trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];
      let correctIndex =
        typeof item.correctIndex === 'number' ? item.correctIndex : 0;
      if (correctIndex < 0 || correctIndex >= options.length) correctIndex = 0;
      if (body.length >= 2 && options.length >= 2) {
        questions.push({ body, options, correctIndex });
      }
    }

    const tasks: DraftTask[] = [];
    for (const t of Array.isArray(obj.tasks) ? obj.tasks : []) {
      const item = t as Partial<DraftTask>;
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const instructions =
        typeof item.instructions === 'string'
          ? item.instructions.trim()
          : undefined;
      if (title.length >= 2) tasks.push({ title, instructions });
    }

    return { questions, tasks };
  }
}
