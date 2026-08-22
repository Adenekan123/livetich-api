import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** A question drafted from ALOC, already shaped like our ExamQuestion input so
 *  the instructor can review then save it straight through create-exam. */
export interface DraftQuestion {
  body: string;
  options: string[];
  correctIndex: number;
  topic?: string;
}

export interface DraftResult {
  questions: DraftQuestion[];
  /** ALOC credits left after this call; null when served from the cache. */
  creditsRemaining: number | null;
  /** True = served from the pool (no credit spent). */
  fromCache: boolean;
}

/** ALOC's raw question mapped to our shape, keeping its id + actual year for
 *  the cache pool. */
interface RawDraft extends DraftQuestion {
  id: string;
  year: number | null;
}

/** Letters ALOC uses for its options map, in presentation order. */
const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Pulls real past-exam questions (JAMB/WAEC/NECO/Post-UTME) from ALOC and maps
 * them into our draft shape. Backed by a shared cache pool so repeat pulls of
 * the same subject/exam cost no credits. The API key is server-side only.
 */
@Injectable()
export class AlocService {
  private readonly logger = new Logger(AlocService.name);
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.apiKey = config.get<string>('ALOC_API_KEY');
    this.baseUrl =
      config.get<string>('ALOC_API_URL') ?? 'https://dev.aloc.com.ng/api/v1';
    if (!this.apiKey) {
      this.logger.warn('ALOC_API_KEY not set — question import is disabled.');
    }
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  async fetchDraft(params: {
    subject: string;
    examType: string;
    year?: number;
    limit: number;
  }): Promise<DraftResult> {
    const subject = params.subject.trim().toLowerCase();
    const examType = params.examType.trim().toLowerCase();
    const { year, limit } = params;
    const where: Prisma.AlocQuestionCacheWhereInput = {
      subject,
      examType,
      ...(year ? { year } : {}),
    };

    // Cache-first: if the pool already has enough, serve without a credit.
    const cachedCount = await this.prisma.alocQuestionCache.count({ where });
    if (cachedCount >= limit) {
      const skip = Math.floor(Math.random() * (cachedCount - limit + 1));
      const rows = await this.prisma.alocQuestionCache.findMany({
        where,
        take: limit,
        skip,
      });
      return {
        questions: rows.map((r) => this.rowToDraft(r)),
        creditsRemaining: null,
        fromCache: true,
      };
    }

    // Miss → spend one credit, then top up the pool for next time.
    const { drafts, creditsRemaining } = await this.callAloc(subject, examType, year);
    if (drafts.length) {
      await this.prisma.$transaction(
        drafts.map((d) =>
          this.prisma.alocQuestionCache.upsert({
            where: { id: d.id },
            update: {},
            create: {
              id: d.id,
              subject,
              examType,
              year: d.year,
              body: d.body,
              options: d.options,
              correctIndex: d.correctIndex,
              topic: d.topic ?? null,
            },
          }),
        ),
      );
    }

    return {
      questions: drafts.slice(0, limit).map(({ body, options, correctIndex, topic }) => ({
        body,
        options,
        correctIndex,
        topic,
      })),
      creditsRemaining,
      fromCache: false,
    };
  }

  private rowToDraft(r: {
    body: string;
    options: Prisma.JsonValue;
    correctIndex: number;
    topic: string | null;
  }): DraftQuestion {
    return {
      body: r.body,
      options: r.options as string[],
      correctIndex: r.correctIndex,
      topic: r.topic ?? undefined,
    };
  }

  private async callAloc(
    subject: string,
    examType: string,
    year?: number,
  ): Promise<{ drafts: RawDraft[]; creditsRemaining: number | null }> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Question import is not configured (ALOC_API_KEY missing).',
      );
    }
    const qs = new URLSearchParams({ subject, examType });
    if (year) qs.set('year', String(year));

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/questions?${qs.toString()}`, {
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
      });
    } catch (e) {
      throw new BadGatewayException(`ALOC request failed: ${(e as Error).message}`);
    }

    const payload = (await res.json().catch(() => null)) as AlocResponse | null;
    // ALOC 404s subjects/exam-types it doesn't carry (e.g. it serves `jamb`,
    // `waec`, `post_utme` but not `neco`). Surface that as a clear, actionable
    // message instead of a generic 502 "ALOC error: not_found".
    if (res.status === 404) {
      throw new NotFoundException(
        `No ALOC questions for "${subject}" (${examType}). Try a different subject or exam type.`,
      );
    }
    if (!res.ok || !payload) {
      const msg = payload?.error || payload?.message || `HTTP ${res.status}`;
      throw new BadGatewayException(`ALOC error: ${msg}`);
    }

    const rows = Array.isArray(payload.data) ? payload.data : [];
    const drafts = rows
      .map((q) => this.map(q))
      .filter((q): q is RawDraft => q !== null);
    return { drafts, creditsRemaining: payload.meta?.creditsRemaining ?? null };
  }

  /** Map one ALOC question; skip anything malformed or image-based (we can't
   *  render an image-only prompt as plain MCQ text). */
  private map(q: AlocQuestion): RawDraft | null {
    if (!q?.id || !q.text || q.imageUrl) return null;
    const opts = q.options ?? {};
    const options: string[] = [];
    let correctIndex = -1;
    for (const letter of OPTION_LETTERS) {
      const val = opts[letter];
      if (val == null || val === '') continue;
      if (letter === q.correctAnswer) correctIndex = options.length;
      options.push(String(val));
    }
    if (options.length < 2 || correctIndex < 0) return null;
    return {
      id: q.id,
      year: typeof q.year === 'number' ? q.year : null,
      body: q.text,
      options,
      correctIndex,
      topic: q.metadata?.topic || q.subject || undefined,
    };
  }
}

// ---- Minimal shape of the ALOC v1 response we depend on ----
interface AlocQuestion {
  id?: string;
  text?: string;
  options?: Record<string, string | null>;
  correctAnswer?: string;
  subject?: string;
  year?: number;
  imageUrl?: string | null;
  metadata?: { topic?: string } | null;
}
interface AlocResponse {
  data?: AlocQuestion[];
  meta?: { creditsRemaining?: number };
  error?: string;
  message?: string;
}
