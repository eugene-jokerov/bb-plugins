/**
 * Thin OpenRouter API client. Every call is optional at runtime: a failed
 * pricing refresh keeps the previous snapshot, and a failed generation lookup
 * just leaves the turn on the token-based estimate.
 */
import type { ModelCatalogEntry } from "./sources.js";
import {
  parseModelPricing,
  type ModelPricing,
  type TokenCounts,
} from "./pricing.js";

const API_BASE = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 15_000;

export interface OpenRouterResult<T> {
  ok: boolean;
  value: T | null;
  error: string | null;
  httpStatus: number | null;
}

async function request(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  pathAndQuery: string,
  body?: unknown,
): Promise<OpenRouterResult<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "HTTP-Referer": "https://getbb.app",
        "X-Title": "bb openrouter-cost",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        value: null,
        error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
        httpStatus: response.status,
      };
    }
    try {
      return { ok: true, value: JSON.parse(text), error: null, httpStatus: response.status };
    } catch {
      return { ok: false, value: null, error: "invalid JSON from OpenRouter", httpStatus: response.status };
    }
  } catch (cause) {
    const message =
      cause instanceof Error
        ? cause.name === "AbortError"
          ? `timed out after ${TIMEOUT_MS}ms`
          : cause.message
        : String(cause);
    return { ok: false, value: null, error: message, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface CatalogResult {
  models: ModelCatalogEntry[];
  pricing: ModelPricing[];
}

export async function fetchCatalog(
  apiKey: string,
): Promise<OpenRouterResult<CatalogResult>> {
  const result = await request(apiKey, "GET", "/models");
  if (!result.ok || result.value === null) {
    return { ...result, value: null } as OpenRouterResult<CatalogResult>;
  }
  const data = (result.value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { ok: false, value: null, error: "unexpected /models payload", httpStatus: result.httpStatus };
  }
  const fetchedAt = Date.now();
  const models: ModelCatalogEntry[] = [];
  const pricing: ModelPricing[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string") continue;
    const contextLength =
      typeof record.context_length === "number" ? record.context_length : null;
    models.push({
      model: id,
      name: typeof record.name === "string" ? record.name : id,
      contextLength,
    });
    const parsed = parseModelPricing(id, record, fetchedAt);
    if (parsed !== null) pricing.push(parsed);
  }
  return {
    ok: true,
    value: { models, pricing },
    error: null,
    httpStatus: result.httpStatus,
  };
}

export interface KeyInfo {
  label: string | null;
  spendUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  limitReset: string | null;
  resetsAt: string | null;
}

export async function fetchKeyInfo(apiKey: string): Promise<OpenRouterResult<KeyInfo>> {
  const result = await request(apiKey, "GET", "/key");
  if (!result.ok || result.value === null) {
    return { ...result, value: null } as OpenRouterResult<KeyInfo>;
  }
  const data = (result.value as { data?: Record<string, unknown> }).data;
  if (data === undefined || typeof data !== "object") {
    return { ok: false, value: null, error: "unexpected /key payload", httpStatus: result.httpStatus };
  }
  const budget =
    data.effective_budget !== null && typeof data.effective_budget === "object"
      ? (data.effective_budget as Record<string, unknown>)
      : null;
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    ok: true,
    error: null,
    httpStatus: result.httpStatus,
    value: {
      label: typeof data.label === "string" ? data.label : null,
      spendUsd: num(budget?.spend_usd) ?? num(data.usage),
      limitUsd: num(budget?.limit_usd) ?? num(data.limit),
      limitRemainingUsd: num(budget?.remaining_usd) ?? num(data.limit_remaining),
      limitReset: typeof data.limit_reset === "string" ? data.limit_reset : null,
      resetsAt: typeof budget?.resets_at === "string" ? budget.resets_at : null,
    },
  };
}

export interface Generation {
  id: string;
  model: string | null;
  totalCostUsd: number | null;
  upstreamCostUsd: number | null;
  tokens: TokenCounts;
  createdAt: string | null;
}

export async function fetchGeneration(
  apiKey: string,
  generationId: string,
): Promise<OpenRouterResult<Generation>> {
  const result = await request(apiKey, "GET", `/generation?id=${encodeURIComponent(generationId)}`);
  if (!result.ok || result.value === null) {
    return { ...result, value: null } as OpenRouterResult<Generation>;
  }
  const data = (result.value as { data?: Record<string, unknown> }).data;
  if (data === undefined || typeof data !== "object") {
    return { ok: false, value: null, error: "unexpected /generation payload", httpStatus: result.httpStatus };
  }
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    ok: true,
    error: null,
    httpStatus: result.httpStatus,
    value: {
      id: typeof data.id === "string" ? data.id : generationId,
      model: typeof data.model === "string" ? data.model : null,
      totalCostUsd: num(data.total_cost),
      upstreamCostUsd: num(data.upstream_inference_cost),
      tokens: {
        inputTokens: num(data.native_tokens_prompt) ?? num(data.tokens_prompt) ?? 0,
        cachedInputTokens: num(data.native_tokens_cached) ?? 0,
        cacheWriteInputTokens: num(data.native_tokens_cache_write) ?? 0,
        outputTokens: num(data.native_tokens_completion) ?? num(data.tokens_completion) ?? 0,
        reasoningTokens: num(data.native_tokens_reasoning) ?? 0,
      },
      createdAt: typeof data.created_at === "string" ? data.created_at : null,
    },
  };
}

