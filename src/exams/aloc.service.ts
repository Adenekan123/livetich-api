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

/** The largest page ALOC will serve; asking for more is a 400. */
const ALOC_MAX_PAGE = 15;

/**
 * How many pages one import may walk before giving up and returning what it
 * has. A request for the 40-question maximum needs three full pages, and part
 * of every page is dropped as image-based, so this leaves real headroom without
 * letting a single click run away with the credit balance.
 */
const MAX_PAGES = 6;

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

  /**
   * The years this subject + exam type can actually be imported for.
   *
   * ALOC will not tell us. Its 404 carries a catalogue of subjects and exam
   * types but nothing about years, and coverage turns out to be per pair
   * rather than a single range: JAMB mathematics skips 2020 and stops at 2023,
   * JAMB english has 2020 but not 2023, JAMB physics runs through 2024, and
   * WAEC accounting answers for no year at all while answering perfectly well
   * without one. Any fixed list in the UI would therefore be wrong for most
   * subjects, and a year picker that offers dead years is worse than a text
   * box — it looks authoritative.
   *
   * So the years come from the questions themselves. Every cached row carries
   * the year ALOC stamped on it, which makes the distinct years in the pool a
   * list that cannot be wrong: each one is backed by questions we are holding.
   * An unseen pair is seeded with a single page first, and the list fills out
   * on its own as that pair gets imported.
   */
  async availableYears(
    subjectRaw: string,
    examTypeRaw: string,
  ): Promise<number[]> {
    const subject = subjectRaw.trim().toLowerCase();
    const examType = examTypeRaw.trim().toLowerCase();
    const where = { subject, examType };

    if ((await this.prisma.alocQuestionCache.count({ where })) === 0) {
      // Never imported: one page is enough to learn the shape of this pair.
      // A pair ALOC does not carry at all throws, which the caller reports as
      // "no years" rather than as a failure — nothing is broken, there is
      // simply nothing to offer.
      try {
        const seed = await this.callAloc(
          subject,
          examType,
          undefined,
          null,
          ALOC_MAX_PAGE,
        );
        await this.persist(seed.drafts, subject, examType);
      } catch {
        return [];
      }
    }

    const rows = await this.prisma.alocQuestionCache.findMany({
      where: { ...where, year: { not: null } },
      distinct: ['year'],
      select: { year: true },
      orderBy: { year: 'desc' },
    });
    return rows.map((r) => r.year).filter((y): y is number => y !== null);
  }

  /** Add a page of drafts to the shared pool, ignoring ones already held. */
  private persist(drafts: RawDraft[], subject: string, examType: string) {
    if (!drafts.length) return Promise.resolve([]);
    return this.prisma.$transaction(
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

    // Miss → walk ALOC's cursor until the pool can answer this request.
    //
    // ALOC is deterministic: the same query without a cursor returns the same
    // page every time. Fetching one page and stopping therefore topped the pool
    // up to ten rows and never past it, so a default request for twenty could
    // never be served from cache — every import spent a credit to re-fetch
    // questions we already had, and a few clicks later the free tier started
    // answering 429. Following nextCursor is what makes the pool grow, and a
    // growing pool is what makes the cache mean anything.
    let cursor: string | null = null;
    let creditsRemaining: number | null = null;
    let pooled = cachedCount;

    for (let page = 0; page < MAX_PAGES && pooled < limit; page++) {
      let batch: Awaited<ReturnType<typeof this.callAloc>>;
      try {
        batch = await this.callAloc(subject, examType, year, cursor, limit);
      } catch (e) {
        // Only the first page may fail the whole import. Once we are walking
        // the cursor we already have questions — persisted, and counted in
        // `pooled` — so letting a later page's error out would hand the
        // instructor a "no questions" page while the questions sat in the
        // pool. Stop walking and serve what we gathered.
        if (pooled > cachedCount) break;
        throw e;
      }
      creditsRemaining = batch.creditsRemaining ?? creditsRemaining;

      if (batch.drafts.length) {
        await this.persist(batch.drafts, subject, examType);
        // Recount rather than adding the page size: upserts dedupe, so a page
        // we have seen before adds nothing. Trusting the page size here is how
        // a loop like this turns into a silent credit leak.
        pooled = await this.prisma.alocQuestionCache.count({ where });
      }

      if (!batch.hasMore || !batch.nextCursor) break;
      cursor = batch.nextCursor;
    }

    // Serve from the pool rather than from the last page: rows that were
    // already cached count towards this request too.
    const rows = await this.prisma.alocQuestionCache.findMany({
      where,
      take: limit,
    });
    return {
      questions: rows.map((r) => this.rowToDraft(r)),
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
    year: number | undefined,
    cursor: string | null,
    want: number,
  ): Promise<{
    drafts: RawDraft[];
    creditsRemaining: number | null;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Question import is not configured (ALOC_API_KEY missing).',
      );
    }
    const qs = new URLSearchParams({ subject, examType });
    if (year) qs.set('year', String(year));
    // ALOC rejects anything over 15 with a 400, so ask for the page we can
    // actually get rather than for the caller's whole appetite.
    qs.set('limit', String(Math.min(want, ALOC_MAX_PAGE)));
    if (cursor) qs.set('cursor', cursor);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/questions?${qs.toString()}`, {
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
      });
    } catch (e) {
      throw new BadGatewayException(
        `ALOC request failed: ${(e as Error).message}`,
      );
    }

    const payload = (await res.json().catch(() => null)) as AlocResponse | null;

    // The free tier rate-limits hard, and a 429 used to fall through to the
    // generic branch below and reach the instructor as "Bad Gateway — ALOC
    // error: HTTP 429", which reads like the feature is broken rather than
    // like it needs a minute. Say which it is.
    if (res.status === 429) {
      throw new ServiceUnavailableException(
        'ALOC is rate-limiting us right now. Wait a minute and import again — anything already imported is kept.',
      );
    }

    // ALOC 404s any combination of filters it cannot fill, without saying
    // which one was at fault. Name them all — above all the year, which is the
    // usual culprit and the easiest to relax: ALOC's JAMB mathematics stops
    // around 2019, so asking for 2024 fails on a subject and exam type that
    // are otherwise perfectly well covered.
    //
    // The `hints` it returns alongside are deliberately NOT repeated back. They
    // are a global catalogue, not this pair's coverage: they list `neco` and
    // `state` under exam types and `history` and `insurance` under subjects,
    // all of which 404 in practice. Relaying them turned a failed import into
    // a confident suggestion that fails too.
    if (res.status === 404) {
      const where = year ? `${examType} ${year}` : examType;
      const advice = year
        ? ' Try another year, or clear the year to take whatever it has.'
        : ' Try another exam type or subject.';
      throw new NotFoundException(
        `ALOC has no "${subject}" questions for ${where}.${advice}`,
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
    return {
      drafts,
      creditsRemaining: payload.meta?.creditsRemaining ?? null,
      nextCursor: payload.pagination?.nextCursor ?? null,
      hasMore: payload.pagination?.hasMore ?? false,
    };
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
  /** Cursor pagination. Without following this, every query returns page one. */
  pagination?: {
    nextCursor?: string | null;
    prevCursor?: string | null;
    hasMore?: boolean;
  };
  /** Sent alongside a 404: the filters ALOC actually carries. */
  hints?: {
    availableSubjects?: string[];
    supportedExamTypes?: string[];
  };
  error?: string;
  message?: string;
}
