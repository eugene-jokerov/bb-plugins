/**
 * Where per-turn token usage and model names come from.
 *
 * bb records the model that ran a turn in its event log, and
 * `thread/tokenUsage/updated` carries the usage counts. Timing data, and for
 * OpenRouter traffic the generation id that `GET /api/v1/generation` prices
 * exactly, live in the provider's own session files (Codex rollouts, Claude
 * Code transcripts) on the machine that ran the agent. Every source here is
 * optional: a missing file only makes a turn's estimate coarser, never wrong.
 */
import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import type { TokenCounts } from "./pricing.js";

export interface TurnUsageRecord {
  threadId: string;
  /** bb turn id from the event scope, e.g. "<thread>-t3". */
  turnId: string | null;
  providerThreadId: string | null;
  /** Epoch ms of when the usage was reported. */
  at: number;
  model: string | null;
  tokens: TokenCounts;
  /** OpenRouter generation id when the provider exposed one. */
  generationId: string | null;
  /** A provider response id that is not an OpenRouter generation id. */
  responseId?: string | null;
  source: "bb" | "codex" | "api";
}

export interface ModelCatalogEntry {
  model: string;
  name: string;
  contextLength: number | null;
}

export interface BbUsageRecord {
  threadId: string;
  turnId: string | null;
  providerThreadId: string | null;
  at: number;
  tokens: TokenCounts;
}

/**
 * bb's event log and thread rows, read through bb's own loopback HTTP API.
 *
 * The SDK's `threads.events.list` requires a typed filter, so this uses the
 * same public endpoint the app and CLI use: `/api/v1/threads/<id>/events`.
 * It runs from the server process, where the API is always reachable.
 */
export interface BbEventsReader {
  /** One thread's usage events, newest first. */
  usage(threadId: string): Promise<BbUsageRecord[]>;
  /**
   * Threads whose events mention this provider (agent) session id (or the
   * session it was forked from, which `parentSessionIds` also lists).
   */
  threadsByAgentSession(providerThreadId: string, parentSessionIds?: string[]): Promise<string[]>;
  /** The thread an event's provider session runs in, newest thread first. */
  threadForSession(
    threads: Pick<BbThread, "id">[],
    providerSessionId: string,
    parentSessionIds: string[],
  ): Promise<string | null>;
  /**
   * The agent session a thread runs in: its newest `thread/identity` event.
   * A resuming Codex session is named after its own id but also mentions the
   * root session in `parent_thread_id`.
   */
  threadSessions(threadId: string): Promise<{ sessionId: string; parentSessionIds: string[] } | null>;
  /** Threads to reconcile at startup: active and recently updated. */
  recentThreads(limit: number): Promise<BbThread[]>;
  /** The newest `client/turn/requested` model of a thread, if any. */
  requestedModel(threadId: string): Promise<string | null>;
}

export interface BbThread {
  id: string;
  providerId: string;
  createdAt: number;
  title: string | null;
  modelOverride: string | null;
}

interface EventRow {
  seq: number;
  type: string;
  createdAt?: number;
  data?: unknown;
}

/** bb's thread event endpoint rejects a page above 100 rows. */
const EVENT_PAGE = 100;

function eventTime(row: { createdAt?: number }): number {
  return typeof row.createdAt === "number" ? row.createdAt : Date.now();
}

/** One turn's usage as bb recorded it. */
export interface BbUsageRecord {
  threadId: string;
  turnId: string | null;
  providerThreadId: string | null;
  at: number;
  tokens: TokenCounts;
}

export function createBbEventsReader(
  baseUrl: string,
  log: (message: string) => void,
): BbEventsReader {
  async function getJson<T>(path: string): Promise<T | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { Origin: baseUrl },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        log(`bb API ${path}: HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (cause) {
      log(`bb API ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }

  async function usage(threadId: string): Promise<BbUsageRecord[]> {
    // The API caps a page at 100 events, so a long thread takes two pages.
    const rows =
      (await getJson<EventRow[]>(
        `/api/v1/threads/${encodeURIComponent(threadId)}/events?types=${encodeURIComponent(
          "thread/tokenUsage/updated",
        )}&order=desc&limit=${EVENT_PAGE}`,
      )) ?? [];
    const records: BbUsageRecord[] = [];
    for (const row of rows) {
      const data =
        row.data !== null && typeof row.data === "object"
          ? (row.data as Record<string, unknown>)
          : null;
      const tokens = usageBreakdownFrom(data);
      if (tokens === null) continue;
      records.push({
        threadId,
        turnId: null,
        providerThreadId:
          typeof data?.providerThreadId === "string" ? data.providerThreadId : null,
        at: eventTime(row as { createdAt?: number }),
        tokens,
      });
    }
    const oldest = rows[rows.length - 1];
    if (rows.length === EVENT_PAGE && oldest !== undefined) {
      const older =
        (await getJson<EventRow[]>(
          `/api/v1/threads/${encodeURIComponent(threadId)}/events?types=${encodeURIComponent(
            "thread/tokenUsage/updated",
          )}&order=desc&limit=${EVENT_PAGE}&beforeSeq=${oldest.seq}`,
        )) ?? [];
      for (const row of older) {
        const data =
          row.data !== null && typeof row.data === "object"
            ? (row.data as Record<string, unknown>)
            : null;
        const tokens = usageBreakdownFrom(data);
        if (tokens === null) continue;
        records.push({
          threadId,
          turnId: null,
          providerThreadId:
            typeof data?.providerThreadId === "string" ? data.providerThreadId : null,
          at: eventTime(row as { createdAt?: number }),
          tokens,
        });
      }
    }
    return records;
  }

  async function threadsByAgentSession(
    providerThreadId: string,
    parentSessionIds: string[] = [],
  ): Promise<string[]> {
    const sessionIds = [providerThreadId, ...parentSessionIds];
    const threads =
      (await getJson<{ id: string }[]>(`/api/v1/threads?includeHidden=true&limit=200`)) ?? [];
    const found: string[] = [];
    for (const thread of threads) {
      const events =
        (await getJson<EventRow[]>(
          `/api/v1/threads/${encodeURIComponent(thread.id)}/events?types=${encodeURIComponent(
            "thread/identity",
          )}&order=desc&limit=20`,
        )) ?? [];
      if (events.length === 0) {
        // thread/identity is the only event that always names the agent
        // session; fall back to any event carrying it.
        const any =
          (await getJson<EventRow[]>(
            `/api/v1/threads/${encodeURIComponent(thread.id)}/events?order=desc&limit=${EVENT_PAGE}`,
          )) ?? [];
        if (any.some((event) => sessionIds.some((id) => containsSession(event.data, id)))) {
          found.push(thread.id);
        }
        continue;
      }
      if (events.some((event) => sessionIds.some((id) => containsSession(event.data, id)))) {
        found.push(thread.id);
      }
    }
    return found;
  }

  async function threadSessions(
    threadId: string,
  ): Promise<{ sessionId: string; parentSessionIds: string[] } | null> {
    const rows =
      (await getJson<EventRow[]>(
        `/api/v1/threads/${encodeURIComponent(threadId)}/events?types=${encodeURIComponent(
          "thread/identity",
        )}&order=desc&limit=20`,
      )) ?? [];
    const row = rows[0];
    const data = row?.data !== null && typeof row?.data === "object" ? row.data : null;
    const providerThreadId = nonEmpty((data as { providerThreadId?: unknown } | null)?.providerThreadId);
    if (providerThreadId === null) return null;
    return {
      sessionId: providerThreadId,
      parentSessionIds: sessionIds(data).filter((id) => id !== providerThreadId),
    };
  }

  async function threadForSession(
    threads: Pick<BbThread, "id">[],
    providerSessionId: string,
    parentSessionIds: string[],
  ): Promise<string | null> {
    const sessionIds = [providerSessionId, ...parentSessionIds];
    for (const thread of threads) {
      const events =
        (await getJson<EventRow[]>(
          `/api/v1/threads/${encodeURIComponent(thread.id)}/events?types=${encodeURIComponent(
            "thread/identity",
          )}&order=desc&limit=20`,
        )) ?? [];
      if (events.length === 0) continue;
      if (events.some((event) => sessionIds.some((id) => containsSession(event.data, id)))) {
        return thread.id;
      }
    }
    return null;
  }

  async function recentThreads(limit: number): Promise<BbThread[]> {
    const rows =
      (await getJson<
        {
          id: string;
          providerId: string;
          createdAt: number;
          title?: string | null;
          titleFallback?: string | null;
          modelOverride?: string | null;
        }[]
      >(
        `/api/v1/threads?includeHidden=true&limit=${limit}`,
      )) ?? [];
    return rows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      createdAt: row.createdAt,
      title: nonEmpty(row.title) ?? nonEmpty(row.titleFallback),
      modelOverride: nonEmpty(row.modelOverride),
    }));
  }

  async function requestedModel(threadId: string): Promise<string | null> {
    const rows =
      (await getJson<EventRow[]>(
        `/api/v1/threads/${encodeURIComponent(threadId)}/events?types=${encodeURIComponent(
          "client/turn/requested",
        )}&order=desc&limit=20`,
      )) ?? [];
    for (const row of rows) {
      const model =
        row.data !== null && typeof row.data === "object"
          ? ((row.data as { execution?: { model?: unknown } }).execution?.model ?? null)
          : null;
      const found = nonEmpty(model);
      if (found !== null) return found;
    }
    return null;
  }

  return {
    usage,
    threadsByAgentSession,
    threadSessions,
    threadForSession,
    recentThreads,
    requestedModel,
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Everything that looks like a provider session id, in payload order. */
function sessionIds(value: unknown): string[] {
  const found: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (SESSION_LIKE.test(item) && !found.includes(item)) found.push(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item !== null && typeof item === "object") {
      Object.values(item as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return found;
}

const SESSION_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function containsSession(value: unknown, providerThreadId: string): boolean {
  if (typeof value === "string") return value === providerThreadId;
  if (Array.isArray(value)) return value.some((item) => containsSession(item, providerThreadId));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsSession(item, providerThreadId),
    );
  }
  return false;
}

function pick(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Rejects zero-only breakdowns: they mean "not reported". */
function nonZero(tokens: TokenCounts): TokenCounts | null {
  const sum =
    tokens.inputTokens +
    tokens.cachedInputTokens +
    tokens.cacheWriteInputTokens +
    tokens.outputTokens +
    tokens.reasoningTokens;
  return sum === 0 ? null : tokens;
}

/**
 * Normalizes bb's `thread/tokenUsage/updated` data: either
 * `{ tokenUsage: { total, last } }` or a bare breakdown, using `last` when
 * present because `total` is cumulative for the whole agent session.
 */
export function usageBreakdownFrom(data: unknown): TokenCounts | null {
  if (data === null || typeof data !== "object") return null;
  const outer = data as Record<string, unknown>;
  const usage =
    outer.tokenUsage !== null && typeof outer.tokenUsage === "object"
      ? (outer.tokenUsage as Record<string, unknown>)
      : outer;
  const last =
    usage.last !== null && typeof usage.last === "object"
      ? (usage.last as Record<string, unknown>)
      : null;
  const sample = last ?? usage;
  const input = pick(sample, ["inputTokens", "input", "prompt_tokens"]);
  const cached = pick(sample, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadInputTokens",
    "input_cache_read_tokens",
  ]);
  const output = pick(sample, ["outputTokens", "output", "completion_tokens"]);
  if (input === 0 && cached === 0 && output === 0) {
    const total = pick(sample, ["totalTokens", "total"]);
    if (total === 0) return null;
    return nonZero({
      inputTokens: Math.max(0, total - output - cached),
      cachedInputTokens: cached,
      cacheWriteInputTokens: pick(sample, [
        "cacheWriteInputTokens",
        "cache_write_input_tokens",
      ]),
      outputTokens: output,
      reasoningTokens: pick(sample, [
        "reasoningOutputTokens",
        "reasoning_output_tokens",
        "reasoning_tokens",
      ]),
    });
  }
  return nonZero({
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: pick(sample, [
      "cacheWriteInputTokens",
      "cache_write_input_tokens",
    ]),
    outputTokens: output,
    reasoningTokens: pick(sample, [
      "reasoningOutputTokens",
      "reasoning_output_tokens",
      "reasoning_tokens",
    ]),
  });
}

/** Parses a serialized usage payload (settings/tests/older call sites). */
export function parseTokenUsage(raw: string): TokenCounts | null {
  try {
    return usageBreakdownFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Codex writes one JSONL rollout per agent session. The file header names the
 * model, `event_msg`/`token_count` lines carry cumulative usage, and when
 * Codex talks to OpenRouter every user turn in the transcript carries the
 * generation id OpenRouter charged for. `integration.cache` is the source
 * Codex itself reports for "how much of the prompt was cached".
 */
export interface CodexSegment {
  /**
   * Stable identity inside one session: the provider's own record id (turn
   * id, else response id), else time plus counts.
   */
  key: string;
  providerSessionId: string;
  /**
   * `session_meta.parent_thread_id` / `session_id`: a bb thread resuming a
   * Codex session starts a fresh child session, but bb keeps naming the root.
   */
  parentSessionIds: string[];
  /** False when the agent ran on a model provider other than OpenRouter. */
  openrouter: boolean;
  model: string | null;
  at: number;
  /**
   * OpenRouter's generation id, which `/generation` prices exactly. Codex
   * reports its upstream response id (`gen-…`) instead; it resolves there but
   * carries no cost, so it is kept only for display.
   */
  generationId: string | null;
  /** A provider response id that is not an OpenRouter generation id. */
  responseId: string | null;
  tokens: TokenCounts;
}

/** One model request priced from OpenRouter's billing API (`/generation`). */
export interface ApiUsageRecord {
  threadId: string;
  at: number;
  model: string;
  generationId: string;
  tokens: TokenCounts;
  costUsd: number;
}

interface CodexRolloutState {
  providerSessionId: string;
  parentSessionIds: string[];
  model: string | null;
  previousTotals: TokenCounts | null;
  openrouter: boolean;
  segments: CodexSegment[];
  /** Never emit the same usage record twice (last 4 MiB may replay it). */
  segmentKeys: Set<string>;
}

const rolloutCache = new Map<string, { size: number; state: CodexRolloutState }>();

const SESSION_FILE =
  /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]{36})\.jsonl$/;

/** Root holding a Codex installation's session rollouts. */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}

/** `<root>/sessions`, or the root itself when it already is one. */
export function sessionsRoot(root: string): string {
  return path.basename(path.normalize(root)) === "sessions"
    ? root
    : path.join(root, "sessions");
}

function findSessionFiles(sessionsRoot: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];
  const cutoff = new Date(sinceMs);
  const today = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Sessions live under YYYY/MM/DD; skip directories older than `since`.
        if (/^\d{4}$/.test(entry.name)) {
          const year = Number(entry.name);
          if (year < cutoff.getUTCFullYear()) continue;
        }
        await walk(full);
      } else if (entry.name.endsWith(".jsonl") && entry.name.includes("rollout-")) {
        const match = entry.name.match(
          /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/,
        );
        if (match !== null) {
          const started = Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6]),
          );
          if (started < sinceMs || started > today.getTime()) continue;
        }
        found.push(full);
      }
    }
  };
  return walk(sessionsRoot).then(() => found);
}

export async function readCodexRollouts(
  logsRoot: string,
  sinceMs: number,
  log: (message: string) => void,
): Promise<CodexSegment[]> {
  const root = sessionsRoot(logsRoot);
  if (!existsSync(root)) return [];
  const files = await findSessionFiles(root, sinceMs);
  const segments: CodexSegment[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      const cached = rolloutCache.get(file);
      if (cached !== undefined && cached.size === info.size) {
        segments.push(...cached.state.segments);
        continue;
      }
      const state = await parseRollout(file);
      rolloutCache.set(file, { size: info.size, state });
      segments.push(...state.segments);
    } catch (cause) {
      log(
        `cannot read provider log ${file}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
  return segments;
}

/**
 * Incremental and resilient: a rollout can be huge, and the last line may be
 * half-written while the agent is running. Only the last 4 MiB are read, which
 * is enough for the token counters of the latest turns.
 */
async function parseRollout(file: string): Promise<CodexRolloutState> {
  const state: CodexRolloutState = {
    providerSessionId: SESSION_FILE.exec(file)?.[1] ?? path.basename(file, ".jsonl"),
    parentSessionIds: [],
    model: null,
    previousTotals: null,
    openrouter: false,
    segments: [],
    segmentKeys: new Set(),
  };
  const info = await stat(file);
  const start = Math.max(0, info.size - 4 * 1024 * 1024);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    let responseId: string | null = null;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let item: Record<string, unknown>;
      try {
        item = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload =
        item.payload !== null && typeof item.payload === "object"
          ? (item.payload as Record<string, unknown>)
          : item;
      const type = typeof item.type === "string" ? item.type : "";
      if (type === "session_meta") {
        for (const id of [payload.session_id, payload.parent_thread_id, payload.parent_session_id]) {
          const found = nonEmpty(id);
          if (found !== null && found !== state.providerSessionId && !state.parentSessionIds.includes(found)) {
            state.parentSessionIds.push(found);
          }
        }
        if (typeof payload.model_provider === "string") {
          state.openrouter = /openrouter/i.test(payload.model_provider);
        }
      }
      if (type === "turn_context") {
        if (typeof payload.model === "string") state.model = payload.model;
        if (typeof payload.model_provider === "string") {
          state.openrouter = /openrouter/i.test(payload.model_provider);
        }
      }
      if (type === "event_msg" && payload.type === "thread_settings_applied") {
        const settings =
          payload.thread_settings !== null && typeof payload.thread_settings === "object"
            ? (payload.thread_settings as Record<string, unknown>)
            : null;
        if (typeof settings?.model === "string") state.model = settings.model;
        const provider =
          settings?.model_provider_id ?? settings?.model_provider ?? payload.model_provider;
        if (typeof provider === "string") state.openrouter = /openrouter/i.test(provider);
      }
      if (type === "event_msg" && payload.type === "user_message") {
        const id = payload.generation_id ?? payload.generationId ?? null;
        if (typeof id === "string" && id.trim() !== "") responseId = id.trim();
      }
      // Newer Codex builds write one record per upstream response, with that
      // response's own usage. It is exact and needs no cumulative deltas.
      if (type === "token_usage_record") {
        const usage =
          payload.turn_token_usage !== null && typeof payload.turn_token_usage === "object"
            ? (payload.turn_token_usage as Record<string, unknown>)
            : payload.usage !== null && typeof payload.usage === "object"
              ? (payload.usage as Record<string, unknown>)
              : null;
        if (usage === null) continue;
        const tokens = nonZero({
          inputTokens: Math.max(
            0,
            pick(usage, ["input_tokens"]) - pick(usage, ["cached_input_tokens"]),
          ),
          cachedInputTokens: pick(usage, ["cached_input_tokens"]),
          cacheWriteInputTokens: pick(usage, ["cache_write_input_tokens"]),
          outputTokens: pick(usage, ["output_tokens"]),
          reasoningTokens: pick(usage, ["reasoning_output_tokens"]),
        });
        if (tokens === null) continue;
        const responseId = nonEmpty(payload.response_id);
        const turnId = nonEmpty(payload.turn_id);
        const at = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : Date.now();
        pushSegment(state, {
          key: turnId !== null ? `turn:${turnId}` : `resp:${responseId ?? at}`,
          model: state.model,
          at,
          generationId: null,
          responseId,
          tokens,
        });
        continue;
      }
      // Older builds only write cumulative token counters; diff them.
      if (type !== "event_msg" || payload.type !== "token_count") continue;
      const info = payload.info;
      if (info === null || typeof info !== "object") continue;
      const record = info as Record<string, unknown>;
      const total =
        record.total_token_usage !== null && typeof record.total_token_usage === "object"
          ? (record.total_token_usage as Record<string, unknown>)
          : null;
      const last =
        record.last_token_usage !== null && typeof record.last_token_usage === "object"
          ? (record.last_token_usage as Record<string, unknown>)
          : null;
      let delta: TokenCounts | null = null;
      if (total !== null) {
        const totals: TokenCounts = {
          inputTokens: pick(total, ["input_tokens"]),
          cachedInputTokens: pick(total, ["cached_input_tokens"]),
          cacheWriteInputTokens: pick(total, ["cache_write_input_tokens"]),
          outputTokens: pick(total, ["output_tokens"]),
          reasoningTokens: pick(total, ["reasoning_output_tokens"]),
        };
        delta = state.previousTotals === null
          ? totals
          : subtract(totals, state.previousTotals);
        state.previousTotals = totals;
      } else if (last !== null) {
        delta = {
          inputTokens: pick(last, ["input_tokens"]),
          cachedInputTokens: pick(last, ["cached_input_tokens"]),
          cacheWriteInputTokens: pick(last, ["cache_write_input_tokens"]),
          outputTokens: pick(last, ["output_tokens"]),
          reasoningTokens: pick(last, ["reasoning_output_tokens"]),
        };
      }
      if (delta === null) continue;
      const meaningful =
        delta.outputTokens > 0 || delta.inputTokens > 0 || delta.cachedInputTokens > 0;
      if (!meaningful) continue;
      const at = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : Date.now();
      pushSegment(state, {
        key: `${state.providerSessionId}:${at}:${delta.outputTokens}:${delta.cachedInputTokens}:${delta.inputTokens}`,
        model: state.model,
        at,
        generationId: null,
        responseId,
        tokens: {
          // Codex counts cached prompt tokens inside input_tokens.
          inputTokens: Math.max(0, delta.inputTokens - delta.cachedInputTokens),
          cachedInputTokens: delta.cachedInputTokens,
          cacheWriteInputTokens: delta.cacheWriteInputTokens,
          outputTokens: delta.outputTokens,
          reasoningTokens: delta.reasoningTokens,
        },
      });
    }
  } finally {
    await handle.close();
  }
  return state;
}

function pushSegment(
  state: CodexRolloutState,
  segment: Omit<CodexSegment, "providerSessionId" | "openrouter" | "parentSessionIds">,
): void {
  const key = `${state.providerSessionId}:${segment.key}`;
  if (state.segmentKeys.has(key)) return;
  state.segmentKeys.add(key);
  state.segments.push({
    ...segment,
    key,
    providerSessionId: state.providerSessionId,
    parentSessionIds: [...state.parentSessionIds],
    openrouter: state.openrouter,
  });
}

function subtract(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, a.cacheWriteInputTokens - b.cacheWriteInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    reasoningTokens: Math.max(0, a.reasoningTokens - b.reasoningTokens),
  };
}
