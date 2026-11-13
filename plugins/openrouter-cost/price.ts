/**
 * How a turn is priced: the exact charge OpenRouter reported for a
 * generation, a cached estimate, or the model's catalog price at the moment
 * of the turn (time-of-day overrides included). Plain math only, so the
 * frontend can use it too.
 */
import { costOf, type ModelPricing, type TokenCounts } from "./pricing.js";
import type { Bucket } from "./store.js";

export function bucketFor(atMs: number): Bucket {
  const date = new Date(atMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return { day: `${year}-${month}-${day}`, month: `${year}-${month}` };
}

export function costForTokens(
  pricing: ModelPricing | null,
  tokens: TokenCounts,
  atMs: number,
): number {
  return costOf(pricing, tokens, new Date(atMs)).totalUsd;
}

export function providerFamily(providerId: string): string {
  if (/claude/i.test(providerId)) return "claude";
  if (/codex/i.test(providerId)) return "codex";
  if (/^pi|pi-/i.test(providerId)) return "pi";
  if (/cursor/i.test(providerId)) return "cursor";
  if (/grok/i.test(providerId)) return "grok";
  return providerId;
}

export interface TurnPriceRow {
  at: number;
  model: string | null;
  tokens: TokenCounts;
  exactCostUsd: number | null;
  estimatedCostUsd?: number;
}

export function priceOfTurn<R extends TurnPriceRow>(
  row: R,
  pricingFor: (model: string) => ModelPricing | null,
): { usd: number | null; exact: boolean } {
  if (row.exactCostUsd !== null) return { usd: row.exactCostUsd, exact: true };
  if (typeof row.estimatedCostUsd === "number") {
    return { usd: row.estimatedCostUsd, exact: false };
  }
  if (row.model === null) return { usd: null, exact: false };
  const usd = costForTokens(pricingFor(row.model), row.tokens, row.at);
  return { usd: usd > 0 ? usd : null, exact: false };
}
