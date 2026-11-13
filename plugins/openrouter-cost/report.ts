/**
 * Query -> answer. Every number the CLI, RPC and the sidebar show is built
 * here so the surfaces can never disagree.
 */
import { priceOfTurn, providerFamily } from "./price.js";
import type { TokenCounts } from "./pricing.js";
import { costForTokens } from "./price.js";
import type { Store, AggregateColumn, AggregateRow } from "./store.js";
import type { TurnRow } from "./store.js";

export const PERIODS = ["today", "yesterday", "7d", "30d", "month", "all", "custom"] as const;
export type Period = (typeof PERIODS)[number];

export interface Range {
  fromMs: number;
  toMs: number;
  label: string;
}

export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function resolveRange(
  period: string,
  opts: { now?: number; from?: string; to?: string } = {},
): Range {
  const now = opts.now ?? Date.now();
  const today = startOfDay(now);
  switch (period) {
    case "today":
      return { fromMs: today, toMs: addDays(today, 1), label: "today" };
    case "yesterday":
      return { fromMs: addDays(today, -1), toMs: today, label: "yesterday" };
    case "7d":
      return { fromMs: addDays(today, -6), toMs: addDays(today, 1), label: "last 7 days" };
    case "30d":
      return { fromMs: addDays(today, -29), toMs: addDays(today, 1), label: "last 30 days" };
    case "month": {
      const start = new Date(now);
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      return { fromMs: start.getTime(), toMs: addDays(today, 1), label: "this month" };
    }
    case "all":
      return { fromMs: 0, toMs: addDays(today, 1), label: "all time" };
    case "custom": {
      const fromMs = opts.from === undefined ? NaN : Date.parse(opts.from);
      const toMs = opts.to === undefined ? NaN : Date.parse(opts.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
        throw new Error('custom range needs --from and --to as YYYY-MM-DD with from <= to');
      }
      return {
        fromMs: startOfDay(fromMs),
        toMs: addDays(startOfDay(toMs), 1),
        label: `${opts.from}..${opts.to}`,
      };
    }
    default:
      throw new Error(`unknown period "${period}"; use one of ${PERIODS.join(", ")}`);
  }
}

/**
 * The model that ran each turn: a thread-level override, else the newest
 * `client/turn/requested` model in bb's event log for that thread. bb's own
 * tables live in another database, so the collector copies what it needs
 * into `thread_info`; an unknown override is simply not set.
 */
export function resolveModels(store: Store, threadIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const threadId of threadIds) {
    const override = store.modelOverride(threadId);
    if (override !== null) {
      result.set(threadId, override);
      continue;
    }
  }
  return result;
}

export interface Totals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  promptTokens: number;
  totalTokens: number;
  costUsd: number;
  exactTurns: number;
  estimatedTurns: number;
  unpricedTurns: number;
  /** Share of prompt tokens served from cache (0..1). */
  cacheHitRate: number;
  /** USD per million prompt tokens actually paid. */
  effectiveInputPricePerMTok: number;
}

export const ZERO_TOTALS: Totals = {
  turns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  promptTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  exactTurns: 0,
  estimatedTurns: 0,
  unpricedTurns: 0,
  cacheHitRate: 0,
  effectiveInputPricePerMTok: 0,
};

function finishTotals(totals: Totals): Totals {
  totals.promptTokens =
    totals.inputTokens + totals.cachedInputTokens + totals.cacheWriteInputTokens;
  totals.totalTokens = totals.promptTokens + totals.outputTokens + totals.reasoningTokens;
  totals.cacheHitRate =
    totals.promptTokens === 0 ? 0 : totals.cachedInputTokens / totals.promptTokens;
  totals.effectiveInputPricePerMTok =
    totals.promptTokens === 0 ? 0 : (totals.costUsd / totals.promptTokens) * 1_000_000;
  return totals;
}

export function totalsFromAggregates(rows: AggregateRow[]): Totals {
  const totals = { ...ZERO_TOTALS };
  for (const row of rows) {
    totals.turns += row.set_turns;
    totals.inputTokens += row.input_tokens;
    totals.cachedInputTokens += row.cached_input_tokens;
    totals.cacheWriteInputTokens += row.cache_write_input_tokens;
    totals.outputTokens += row.output_tokens;
    totals.reasoningTokens += row.reasoning_tokens;
    totals.costUsd += row.cost_usd ?? 0;
    totals.exactTurns += row.exact_turns;
    totals.estimatedTurns += row.estimated_turns;
    totals.unpricedTurns += row.unpriced_turns;
  }
  return finishTotals(totals);
}

export function costUsdOf(row: TurnRow, store: Store): number | null {
  return priceOfTurn(row, (model) => store.getPricing(model)).usd;
}

export function totalsFromTurns(rows: TurnRow[], store: Store): Totals {
  const totals = { ...ZERO_TOTALS };
  for (const row of rows) {
    totals.turns += 1;
    totals.inputTokens += row.tokens.inputTokens;
    totals.cachedInputTokens += row.tokens.cachedInputTokens;
    totals.cacheWriteInputTokens += row.tokens.cacheWriteInputTokens;
    totals.outputTokens += row.tokens.outputTokens;
    totals.reasoningTokens += row.tokens.reasoningTokens;
    const cost = costUsdOf(row, store);
    if (cost === null) totals.unpricedTurns += 1;
    else {
      totals.costUsd += cost;
      if (row.exactCostUsd !== null) totals.exactTurns += 1;
      else totals.estimatedTurns += 1;
    }
  }
  return finishTotals(totals);
}

export interface ReportGroup {
  key: string;
  label: string;
  totals: Totals;
}

export interface CostReport {
  range: Range;
  totals: Totals;
  byModel: ReportGroup[];
  byProvider: ReportGroup[];
  byDay: ReportGroup[];
  byThread: ReportGroup[];
  pricingFetchedAt: number | null;
}

const DIMENSIONS: AggregateColumn[] = ["model", "provider_family", "day", "thread_id"];

export function buildReport(
  store: Store,
  range: Range,
  opts: { threadLimit?: number } = {},
): CostReport {
  const groups = new Map<AggregateColumn, ReportGroup[]>();
  const estimator = (model: string, tokens: TokenCounts, atMs: number): number =>
    costForTokens(store.getPricing(model), tokens, atMs);
  for (const dimension of DIMENSIONS) {
    groups.set(
      dimension,
      store
        .aggregate(dimension, range, estimator)
        .map((row) => ({ key: row.bucket, label: row.bucket, totals: totalsFromAggregates([row]) }))
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd),
    );
  }
  const byModel = groups.get("model") ?? [];
  const byProvider = groups.get("provider_family") ?? [];
  const byDay = (groups.get("day") ?? []).sort((a, b) => a.key.localeCompare(b.key));
  const byThread = (groups.get("thread_id") ?? []).slice(0, opts.threadLimit ?? 15).map((group) => ({
    ...group,
    label: store.threadLabel(group.key) ?? group.key,
  }));
  return {
    range,
    totals: totalsFromAggregates(
      store.aggregate("day", range, estimator),
    ),
    byModel,
    byProvider,
    byDay,
    byThread,
    pricingFetchedAt: store.pricingFetchedAt(),
  };
}

export interface ThreadCost {
  threadId: string;
  turns: TurnRow[];
  totals: Totals;
  providerFamily: string | null;
}

export function threadCost(store: Store, threadId: string): ThreadCost {
  const turns = store.threadTurns(threadId);
  return {
    threadId,
    turns,
    totals: totalsFromTurns(turns, store),
    providerFamily: turns[0] === undefined ? null : providerFamily(turns[0].providerId),
  };
}

/** What the sidebar badge shows: the period's cost, or the current thread's. */
export interface CostBadge {
  value: string;
  title: string;
}

export { formatUsd, formatCompactTokens } from "./theme.js";
