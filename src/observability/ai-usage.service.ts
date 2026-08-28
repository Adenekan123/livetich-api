import { Injectable, Logger } from '@nestjs/common';
import { AiUsageFeature, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Estimated USD price per 1M tokens, keyed by a case-insensitive substring of
 * the model id (first match wins). These are ESTIMATES for the usage dashboard,
 * not billing — keep them roughly current. Override the whole table via the
 * AI_PRICE_TABLE env (JSON) if you want, but the defaults are fine for the pilot.
 */
interface Rate {
  inputPer1M: number;
  outputPer1M: number;
}
const DEFAULT_RATES: Record<string, Rate> = {
  'flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
  flash: { inputPer1M: 0.3, outputPer1M: 2.5 },
  pro: { inputPer1M: 1.25, outputPer1M: 10 },
};
const FALLBACK_RATE: Rate = { inputPer1M: 0.1, outputPer1M: 0.4 };

export interface AiUsageRecord {
  feature: AiUsageFeature;
  provider: string;
  model: string;
  orgId?: string | null;
  userId?: string | null;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  refId?: string | null;
  status?: 'ok' | 'error';
}

/**
 * Records one AI-model call (tokens + estimated cost) for the admin usage
 * dashboard. Best-effort: a metering failure never breaks the AI call itself.
 */
@Injectable()
export class AiUsageService {
  private readonly log = new Logger(AiUsageService.name);
  private readonly rates = loadRates();

  constructor(private readonly prisma: PrismaService) {}

  /** Look up the per-1M rate for a model id (substring match, case-insensitive). */
  private rateFor(model: string): Rate {
    const m = model.toLowerCase();
    for (const [key, rate] of Object.entries(this.rates)) {
      if (m.includes(key)) return rate;
    }
    return FALLBACK_RATE;
  }

  estimateCost(model: string, promptTokens: number, outputTokens: number): number {
    const rate = this.rateFor(model);
    const cost =
      (promptTokens / 1_000_000) * rate.inputPer1M +
      (outputTokens / 1_000_000) * rate.outputPer1M;
    // 6dp matches the Decimal(12,6) column.
    return Math.round(cost * 1_000_000) / 1_000_000;
  }

  /** Persist one usage row (fire-and-forget; failures are logged, not thrown). */
  record(rec: AiUsageRecord): void {
    const promptTokens = rec.promptTokens ?? 0;
    const outputTokens = rec.outputTokens ?? 0;
    const totalTokens = rec.totalTokens ?? promptTokens + outputTokens;
    const estCostUsd = this.estimateCost(rec.model, promptTokens, outputTokens);

    void this.prisma.aiUsage
      .create({
        data: {
          feature: rec.feature,
          provider: rec.provider,
          model: rec.model,
          orgId: rec.orgId ?? null,
          userId: rec.userId ?? null,
          promptTokens,
          outputTokens,
          totalTokens,
          estCostUsd: new Prisma.Decimal(estCostUsd),
          refId: rec.refId ?? null,
          status: rec.status ?? 'ok',
        },
      })
      .catch((err) =>
        this.log.error(`ai usage write failed (${rec.model}): ${String(err)}`),
      );
  }
}

/** Merge env-provided rates (AI_PRICE_TABLE JSON) over the built-in defaults. */
function loadRates(): Record<string, Rate> {
  const raw = process.env.AI_PRICE_TABLE;
  if (!raw) return DEFAULT_RATES;
  try {
    const parsed = JSON.parse(raw) as Record<string, Rate>;
    return { ...DEFAULT_RATES, ...parsed };
  } catch {
    return DEFAULT_RATES;
  }
}
