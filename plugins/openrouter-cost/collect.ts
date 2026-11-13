/**
 * Turns provider-side facts into cost rows. A row is written as soon as the
 * token counts are known; the price is either estimated from the model's
 * OpenRouter price (possibly with a time-of-day override) or replaced by the
 * exact generation cost once OpenRouter reports it.
 */
import { addTokens, ZERO_TOKENS, type TokenCounts } from "./pricing.js";
import { fetchGeneration } from "./openrouter.js";
import type { TurnUsageRecord } from "./sources.js";
import { Store } from "./store.js";
import type { TurnRow, TurnSource } from "./store.js";
import { bucketFor, costForTokens, providerFamily } from "./price.js";

export function turnKey(record: Pick<TurnUsageRecord, "threadId" | "turnId" | "at">): string {
  return `${record.threadId}:${record.turnId ?? record.at}`;
}

export function turnRowFromUsage(
  record: TurnUsageRecord,
  providerId: string,
  modelFallback: string | null,
  usesOpenRouter: boolean,
): TurnRow {
  const { day, month } = bucketFor(record.at);
  return {
    key: turnKey(record),
    threadId: record.threadId,
    turnId: record.turnId,
    providerId,
    providerFamily: providerFamily(providerId),
    model: record.model ?? modelFallback,
    at: record.at,
    day,
    month,
    tokens: record.tokens,
    source: record.source as TurnSource,
    generationId: record.generationId,
    responseId: record.responseId ?? null,
    exactCostUsd: null,
    counted: usesOpenRouter,
  };
}

/**
 * Recomputes the estimate for every given row from the current price
 * snapshot and caches it on the row. Rows priced exactly are left alone.
 * Returns how many rows changed.
 */
export function recomputeCosts(store: Store, rows: TurnRow[]): number {
  let updated = 0;
  for (const row of rows) {
    if (row.exactCostUsd !== null) continue;
    const pricing = row.model === null ? null : store.getPricing(row.model);
    const estimate = costForTokens(pricing, row.tokens, row.at);
    if (row.estimatedCostUsd !== estimate) {
      store.setEstimatedCost(row.key, estimate);
      updated += 1;
    }
  }
  return updated;
}

/**
 * Recalculates estimates for unpriced rows since `sinceMs` (used right after
 * a pricing refresh) and returns the number updated.
 */
export function recomputeUnpriced(store: Store, sinceMs: number): number {
  const rows = store.listTurns({ sinceMs, limit: 20_000 });
  return recomputeCosts(
    store,
    rows.filter((row) => row.counted && row.exactCostUsd === null && row.estimatedCostUsd === undefined),
  );
}

/** Waits `ms`, waking early when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Asks OpenRouter for the exact cost of recorded generations, newest first,
 * up to `limit` per pass. A 404 means OpenRouter has no such generation
 * (wrong key, pruned, or a non-OpenRouter request): the row is marked
 * unpriced-for-exact and keeps its estimate.
 *
 * Codex reports its upstream `response_id` rather than OpenRouter's own
 * generation id. `/generation` answers for that id but with `total_cost: 0`,
 * which cannot be told apart from a free model, so such a row keeps its
 * catalog estimate instead of being shown as an exact zero.
 */
export async function priceGenerations(
  store: Store,
  apiKey: string,
  log: (message: string) => void,
  limit = 25,
): Promise<number> {
  const pending = store.unpricedTurns(limit);
  let priced = 0;
  for (const row of pending) {
    if (row.generationId === null) continue;
    const result = await fetchGeneration(apiKey, row.generationId);
    if (!result.ok || result.value === null) {
      const status = result.httpStatus;
      if (status !== null && status !== 404 && status !== 401) {
        log(`generation ${row.generationId} not priced: ${result.error ?? "unknown error"}`);
      }
      if (status === 401) break;
      continue;
    }
    if (result.value.totalCostUsd === null) continue;
    if (result.value.totalCostUsd === 0 && row.responseId !== null) {
      log(`generation ${row.generationId}: no cost reported for a provider response id`);
      continue;
    }
    store.setExactCost(row.key, result.value.totalCostUsd);
    store.saveGeneration(result.value.id, result.value);
    priced += 1;
  }
  return priced;
}

export { addTokens, ZERO_TOKENS };
