/**
 * OpenRouter pricing snapshot and per-request cost math.
 *
 * OpenRouter publishes prices per token in USD at /api/v1/models, and applies
 * time-of-day "overrides" (utc_days, utc_start..utc_end, negative when the
 * window wraps midnight). This module keeps the raw pricing object and
 * resolves the effective price for a moment in time.
 */

export const PRICING_CURRENCIES = ["native", "USD", "RUB"] as const;
export type PricingCurrency = (typeof PRICING_CURRENCIES)[number];

export interface PricingWindow {
  utcDays: string[] | null;
  utcStart: number | null;
  utcEnd: number | null;
  prompt: number;
  completion: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface ModelPricing {
  model: string;
  name: string;
  contextLength: number | null;
  promptPerToken: number;
  completionPerToken: number;
  cacheReadPerToken: number | null;
  cacheWritePerToken: number | null;
  overrides: PricingWindow[];
  fetchedAt: number;
}

export interface TokenCounts {
  /** Prompt tokens OpenRouter billed as fresh (cache read excluded). */
  inputTokens: number;
  /** Prompt tokens served from the prompt cache, billed at the cache rate. */
  cachedInputTokens: number;
  /** Prompt tokens written to the prompt cache, billed at the write rate. */
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const ZERO_TOKENS: TokenCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export interface CostBreakdown {
  inputUsd: number;
  cachedInputUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  totalUsd: number;
  /** Whether every token bucket could be priced (false: approximate). */
  priced: boolean;
  /** Per-token prices actually used; null when the model has no price. */
  rate: {
    promptPerToken: number;
    completionPerToken: number;
    cacheReadPerToken: number | null;
    cacheWritePerToken: number | null;
  } | null;
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

type RawRecord = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseWindow(raw: unknown): PricingWindow | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as RawRecord;
  const prompt = numberOrNull(record.prompt);
  const completion = numberOrNull(record.completion);
  if (prompt === null || completion === null) return null;
  const days = Array.isArray(record.utc_days)
    ? record.utc_days
        .filter((day): day is string => typeof day === "string")
        .map((day) => day.toLowerCase())
    : null;
  return {
    utcDays: days !== null && days.length > 0 ? days : null,
    utcStart: numberOrNull(record.utc_start),
    utcEnd: numberOrNull(record.utc_end),
    prompt,
    completion,
    cacheRead: numberOrNull(record.input_cache_read),
    cacheWrite: numberOrNull(record.input_cache_write),
  };
}

export function parseModelPricing(
  model: string,
  entry: unknown,
  fetchedAt = Date.now(),
): ModelPricing | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as RawRecord;
  const pricing =
    record.pricing !== null && typeof record.pricing === "object"
      ? (record.pricing as RawRecord)
      : record;
  const prompt = numberOrNull(pricing.prompt);
  const completion = numberOrNull(pricing.completion);
  if (prompt === null || completion === null) return null;
  const overrides = Array.isArray(pricing.overrides)
    ? pricing.overrides
        .map(parseWindow)
        .filter((window): window is PricingWindow => window !== null)
    : [];
  return {
    model,
    name: typeof record.name === "string" ? record.name : model,
    contextLength: numberOrNull(record.context_length),
    promptPerToken: prompt,
    completionPerToken: completion,
    cacheReadPerToken: numberOrNull(pricing.input_cache_read),
    cacheWritePerToken: numberOrNull(pricing.input_cache_write),
    overrides,
    fetchedAt,
  };
}

function windowApplies(window: PricingWindow, at: Date): boolean {
  const day = DAY_NAMES[at.getUTCDay()] ?? "";
  if (window.utcDays !== null && !window.utcDays.includes(day)) return false;
  if (window.utcStart === null) return true;
  const hour = at.getUTCHours();
  const start = window.utcStart;
  const end = window.utcEnd ?? 0;
  if (end === 0) return hour >= start;
  if (start <= end) return hour >= start && hour < end;
  // Wraps midnight, e.g. 1000..0 means 10:00..24:00.
  return hour >= start || hour < end;
}

export interface EffectiveRate {
  promptPerToken: number;
  completionPerToken: number;
  cacheReadPerToken: number | null;
  cacheWritePerToken: number | null;
}

/** The prices in force at `at`. The first matching override wins. */
export function effectiveRate(
  pricing: ModelPricing,
  at: Date = new Date(),
): EffectiveRate {
  const match = pricing.overrides.find((window) => windowApplies(window, at));
  if (match === undefined) {
    return {
      promptPerToken: pricing.promptPerToken,
      completionPerToken: pricing.completionPerToken,
      cacheReadPerToken: pricing.cacheReadPerToken,
      cacheWritePerToken: pricing.cacheWritePerToken,
    };
  }
  return {
    promptPerToken: match.prompt,
    completionPerToken: match.completion,
    cacheReadPerToken: match.cacheRead ?? pricing.cacheReadPerToken,
    cacheWritePerToken: match.cacheWrite ?? pricing.cacheWritePerToken,
  };
}

export function costOf(
  pricing: ModelPricing | null,
  tokens: TokenCounts,
  at: Date = new Date(),
): CostBreakdown {
  if (pricing === null) {
    return {
      inputUsd: 0,
      cachedInputUsd: 0,
      cacheWriteUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
      priced: false,
      rate: null,
    };
  }
  const rate = effectiveRate(pricing, at);
  const inputUsd = tokens.inputTokens * rate.promptPerToken;
  const cachedInputUsd =
    tokens.cachedInputTokens * (rate.cacheReadPerToken ?? rate.promptPerToken);
  const cacheWriteUsd =
    tokens.cacheWriteInputTokens * (rate.cacheWritePerToken ?? rate.promptPerToken);
  const outputUsd =
    (tokens.outputTokens + tokens.reasoningTokens) * rate.completionPerToken;
  return {
    inputUsd,
    cachedInputUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd,
    priced: true,
    rate,
  };
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function isZeroTokens(tokens: TokenCounts): boolean {
  return (
    tokens.inputTokens === 0 &&
    tokens.cachedInputTokens === 0 &&
    tokens.cacheWriteInputTokens === 0 &&
    tokens.outputTokens === 0 &&
    tokens.reasoningTokens === 0
  );
}
