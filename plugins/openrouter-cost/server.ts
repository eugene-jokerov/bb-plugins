/**
 * bb-plugin-openrouter-cost — what did the agents cost?
 *
 * Token counts come from bb's own event log (`thread/tokenUsage/updated`) and,
 * for Codex sessions, from the provider's rollout files, which are finer
 * grained and carry the OpenRouter generation id. Prices come from OpenRouter:
 * the model catalog for estimates (including time-of-day overrides and the
 * prompt-cache read/write rates) and `GET /api/v1/generation` for the exact
 * charge. Nothing here sits on a turn's hot path.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  priceGenerations,
  recomputeCosts,
  sleep,
  turnRowFromUsage,
} from "./collect.js";
import { fetchCatalog, fetchKeyInfo } from "./openrouter.js";
import {
  buildReport,
  PERIODS,
  resolveModels,
  resolveRange,
  threadCost,
  totalsFromTurns,
} from "./report.js";
import {
  codexHome,
  createBbEventsReader,
  readCodexRollouts,
  type BbEventsReader,
  type TurnUsageRecord,
} from "./sources.js";
import { COLUMN_MIGRATIONS, Store, THREAD_INFO_MIGRATION } from "./store.js";
import { priceOfTurn, providerFamily } from "./price.js";
import { formatUsd } from "./theme.js";
import type { TurnRow } from "./store.js";
import { registerCli } from "./cli.js";

export const CHANGED_CHANNEL = "cost-changed";
const TICK_MS = 20_000;
/** OpenRouter prunes generations after a while; stop retrying a 404 row. */
const EXACT_RETRIES = 3;

const turnSchema = z.object({
  key: z.string(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  providerId: z.string(),
  model: z.string().nullable(),
  at: z.number(),
  source: z.string(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  costUsd: z.number().nullable(),
  exact: z.boolean(),
});

const totalsSchema = z.object({
  turns: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  promptTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number(),
  exactTurns: z.number(),
  estimatedTurns: z.number(),
  unpricedTurns: z.number(),
  cacheHitRate: z.number(),
  effectiveInputPricePerMTok: z.number(),
});

const groupSchema = z.object({
  key: z.string(),
  label: z.string(),
  totals: totalsSchema,
});

const keyInfoSchema = z
  .object({
    label: z.string().nullable(),
    spendUsd: z.number().nullable(),
    limitUsd: z.number().nullable(),
    limitRemainingUsd: z.number().nullable(),
    limitReset: z.string().nullable(),
    resetsAt: z.string().nullable(),
  })
  .nullable();

export const rpcContract = defineRpcContract({
  report: {
    input: z
      .object({
        period: z.enum(PERIODS).default("30d"),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .strict(),
    output: z.object({
      period: z.string(),
      label: z.string(),
      fromMs: z.number(),
      toMs: z.number(),
      totals: totalsSchema,
      byModel: z.array(groupSchema),
      byProvider: z.array(groupSchema),
      byDay: z.array(groupSchema),
      byThread: z.array(groupSchema),
      pricingFetchedAt: z.number().nullable(),
      keyInfo: keyInfoSchema,
    }),
  },
  thread: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      threadId: z.string(),
      providerFamily: z.string().nullable(),
      totals: totalsSchema,
      contextLength: z.number().nullable(),
      turns: z.array(turnSchema),
    }),
  },
  badge: {
    input: z.object({ threadId: z.string().nullable() }).strict(),
    output: z.object({
      allTime: z.string(),
      today: z.string(),
      thread: z.string().nullable(),
      allTimeUsd: z.number(),
      todayUsd: z.number(),
      threadUsd: z.number().nullable(),
    }),
  },
  refreshPrices: {
    input: z.null(),
    output: z.object({ models: z.number().nullable(), error: z.string().nullable() }),
  },
  priceExact: {
    input: z.object({}).strict(),
    output: z.object({ priced: z.number(), error: z.string().nullable() }),
  },
  keyInfo: {
    input: z.null(),
    output: z.object({ keyInfo: keyInfoSchema, error: z.string().nullable() }),
  },
});

interface KeyCache {
  value: z.infer<typeof keyInfoSchema>;
  error: string | null;
  fetchedAt: number;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default async function plugin(bb: BbPluginApi) {
  let settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "OpenRouter API key (empty: use OPENROUTER_API_KEY)",
      secret: true,
      default: "",
    },
    countAllProviders: {
      type: "boolean",
      label:
        "Count turns of every provider through OpenRouter (off: only providers whose sessions used OpenRouter)",
      default: true,
    },
    priceRefreshHours: {
      type: "number",
      label: "Refresh the model price list every N hours (0 = on load only)",
      experimental_schema: z.number().int().min(0).max(168),
      default: 6,
    },
    providerLogsDir: {
      type: "string",
      label: "Provider session logs root (empty: CODEX_HOME or ~/.codex)",
      default: "",
    },
    exactPricing: {
      type: "boolean",
      label: "Ask OpenRouter for exact generation costs (needs network)",
      default: true,
    },
  });
  let current = await settings.get();

  const db = bb.storage.database();
  // bb.storage.migrate is append-only: never reorder or edit these entries.
  // (An SQLite-only deployment that already ran index 0 would otherwise be
  // rejected for a changed statement hash.) `thread_info` is created here
  // instead: it is a cache of bb's own thread rows, not user data.
  db.exec(THREAD_INFO_MIGRATION);
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${migration.table})`).all();
    if (!columns.some((column) => column.name === migration.column)) db.exec(migration.sql);
  }
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS model_prices (
       model TEXT PRIMARY KEY NOT NULL,
       pricing_json TEXT NOT NULL,
       fetched_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS model_context (
       model TEXT PRIMARY KEY NOT NULL,
       name TEXT NOT NULL,
       context_length INTEGER
     );
     CREATE TABLE IF NOT EXISTS turns (
       key TEXT PRIMARY KEY NOT NULL,
       thread_id TEXT NOT NULL,
       turn_id TEXT,
       provider_id TEXT NOT NULL,
       provider_family TEXT NOT NULL,
       model TEXT,
       at_ms INTEGER NOT NULL,
       day TEXT NOT NULL,
       month TEXT NOT NULL,
       input_tokens INTEGER NOT NULL DEFAULT 0,
       cached_input_tokens INTEGER NOT NULL DEFAULT 0,
       cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
       output_tokens INTEGER NOT NULL DEFAULT 0,
       reasoning_tokens INTEGER NOT NULL DEFAULT 0,
       source TEXT NOT NULL,
       generation_id TEXT,
       exact_cost_usd REAL,
       estimated_cost_usd REAL,
       counted INTEGER NOT NULL DEFAULT 1,
       updated_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS turns_day ON turns (day);
     CREATE INDEX IF NOT EXISTS turns_thread ON turns (thread_id);
     CREATE TABLE IF NOT EXISTS codex_segments (
       key TEXT PRIMARY KEY NOT NULL,
       thread_id TEXT NOT NULL,
       openrouter INTEGER NOT NULL,
       model TEXT,
       at_ms INTEGER NOT NULL,
       generation_id TEXT,
       input_tokens INTEGER NOT NULL DEFAULT 0,
       cached_input_tokens INTEGER NOT NULL DEFAULT 0,
       cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
       output_tokens INTEGER NOT NULL DEFAULT 0,
       reasoning_tokens INTEGER NOT NULL DEFAULT 0
     );
     CREATE INDEX IF NOT EXISTS codex_segments_thread ON codex_segments (thread_id);
     CREATE TABLE IF NOT EXISTS kv (
       name TEXT PRIMARY KEY NOT NULL,
       value TEXT NOT NULL
     );`,
  ]);

  const store = new Store({
    query: <T,>(sql: string, params: unknown[] = []): T[] => {
      const statement = db.prepare<unknown[], T>(sql);
      if (statement.reader) return statement.all(...params);
      statement.run(...params);
      return [];
    },
    exec: (sql) => db.exec(sql),
    close: () => {},
  });

  let events: BbEventsReader | null = null;
  let keyCache: KeyCache = { value: null, error: null, fetchedAt: 0 };
  let refreshing: Promise<string | null> | null = null;
  let lastError: string | null = null;
  let lastRefreshAttemptAt = 0;
  let exactAttempts = new Map<string, number>();
  const synced = new Set<string>();

  function apiKey(): string | null {
    const fromSettings = current.apiKey.trim();
    if (fromSettings !== "") return fromSettings;
    const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
    return fromEnv === undefined || fromEnv === "" ? null : fromEnv;
  }

  function bbEvents(): BbEventsReader {
    if (events === null) {
      events = createBbEventsReader(bb.server.loopbackBaseUrl, (message) =>
        bb.log.warn(message),
      );
    }
    return events;
  }

  function providerLogsRoot(): string {
    const configured = current.providerLogsDir.trim();
    if (configured !== "") return configured;
    return codexHome();
  }

  /**
   * A provider that never talks to OpenRouter must not be billed; with the
   * default setting everything counted, because which provider actually
   * routed through OpenRouter is not visible from bb alone.
   */
  function usesOpenRouter(providerId: string, threadId: string): boolean {
    if (current.countAllProviders) return true;
    const family = providerFamily(providerId).toLowerCase();
    if (family !== "codex") return false;
    return store.threadUsesOpenRouter(threadId) !== false;
  }

  function refreshPrices(signal?: AbortSignal): Promise<string | null> {
    if (refreshing !== null) return refreshing;
    const key = apiKey();
    if (key === null) {
      const error = "no OpenRouter API key: set it in Settings or OPENROUTER_API_KEY";
      lastError = error;
      return Promise.resolve(error);
    }
    refreshing = (async () => {
      lastRefreshAttemptAt = Date.now();
      const result = await fetchCatalog(key);
      if (signal?.aborted) return lastError;
      if (!result.ok || result.value === null) {
        lastError = result.error ?? "pricing refresh failed";
        bb.log.warn(`pricing refresh failed: ${lastError}`);
        return lastError;
      }
      store.savePricing(result.value.pricing);
      const rows = store.listTurns({ sinceMs: 0 });
      recomputeCosts(store, rows);
      lastError = null;
      bb.realtime.publish(CHANGED_CHANNEL, { reason: "prices" });
      return null;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function refreshKeyInfo(): Promise<void> {
    const key = apiKey();
    if (key === null) return;
    const result = await fetchKeyInfo(key);
    keyCache = result.ok
      ? { value: result.value, error: null, fetchedAt: Date.now() }
      : { value: null, error: result.error, fetchedAt: Date.now() };
  }

  /** bb's per-turn usage rows of one thread, oldest first. */
  async function bbUsageRecords(threadId: string): Promise<TurnUsageRecord[]> {
    const records = await bbEvents().usage(threadId);
    return records
      .slice()
      .reverse()
      .map((record) => ({
        threadId,
        turnId: null,
        providerThreadId: record.providerThreadId,
        at: record.at,
        model: null,
        tokens: record.tokens,
        generationId: null,
        source: "bb" as const,
      }));
  }

  /**
   * Records every new bb-reported turn of the thread. A Codex rollout carries
   * a finer split (fresh vs. cached prompt tokens) than bb's cumulative
   * event, so when one exists the bb row yields to it.
   */
  async function recordBbTurns(threadId: string, providerId: string): Promise<boolean> {
    const model =
      resolveModels(store, [threadId]).get(threadId) ?? store.lastModel(threadId);
    const hasProviderSegments = store.codexSegmentCount(threadId) > 0;
    const uses = usesOpenRouter(providerId, threadId);
    let changed = false;
    for (const record of await bbUsageRecords(threadId)) {
      const key = `${record.threadId}:${record.turnId ?? record.at}`;
      const existing = store.getTurn(key);
      // Provider sessions and OpenRouter's own billing rows are finer than
      // this cumulative event; both yield.
      if (existing !== null && existing.source !== "bb") continue;
      if (
        hasProviderSegments &&
        record.tokens.inputTokens - record.tokens.cachedInputTokens < 0
      ) {
        continue;
      }
      const row = turnRowFromUsage(record, providerId, model, uses);
      store.upsertTurn(row);
      recomputeCosts(store, [row]);
      changed = true;
    }
    return changed;
  }

  /**
   * Provider rollouts are matched to bb threads by the agent session id bb
   * records on every event (the rollouts are named after it, or after the
   * session it was forked from). The rollout scan runs once per batch: it
   * walks the same log directory every time.
   */
  async function recordProviderSegments(
    threads: { id: string; providerId: string; createdAt: number }[],
    sinceMs: number,
  ): Promise<{ matched: Set<string>; complete: boolean }> {
    const matched = new Set<string>();
    const candidates = threads.filter((thread) => providerFamily(thread.providerId) === "codex");
    if (candidates.length === 0) return { matched, complete: true };
    const segments = await readCodexRollouts(providerLogsRoot(), sinceMs, (message) =>
      bb.log.debug(message),
    );
    if (segments.length === 0) return { matched, complete: true };
    const owners = new Map<string, string | null>();
    let unmatchedSession = false;
    for (const segment of segments) {
      let owner = owners.get(segment.providerSessionId);
      if (owner === undefined) {
        const found = await bbEvents().threadsByAgentSession(
          segment.providerSessionId,
          segment.parentSessionIds,
        );
        const known = found.filter((id) => candidates.some((thread) => thread.id === id));
        owner =
          known.length > 1
            ? await bbEvents().threadForSession(candidates, segment.providerSessionId, segment.parentSessionIds)
            : (known[0] ?? null);
        owners.set(segment.providerSessionId, owner);
        if (known.length === 0) unmatchedSession = true;
      }
      if (owner === null) continue;
      const known = candidates.find((thread) => thread.id === owner);
      if (known === undefined) continue;
      if (!store.upsertCodexSegment(owner, segment)) continue;
      const model =
        segment.model ??
        resolveModels(store, [owner]).get(owner) ??
        store.lastModel(owner);
      const row = turnRowFromUsage(
        {
          threadId: owner,
          turnId: null,
          providerThreadId: segment.providerSessionId,
          at: segment.at,
          model,
          tokens: segment.tokens,
          generationId: segment.generationId,
          responseId: segment.responseId,
          source: "codex",
        },
        known.providerId,
        model,
        usesOpenRouter(known.providerId, owner),
      );
      store.upsertTurn(row);
      recomputeCosts(store, [row]);
      matched.add(owner);
    }
    // A provider session that bb lists no thread for is skipped, not guessed:
    // its tokens would otherwise be folded into another thread's cumulative
    // events. `complete` tells the caller to hold those threads back.
    return { matched, complete: !unmatchedSession };
  }

  /** bb's provider id for a thread, from the live thread list. */
  async function bbProviderId(threadId: string): Promise<string | null> {
    const threads = await bbEvents().recentThreads(500);
    return threads.find((candidate) => candidate.id === threadId)?.providerId ?? null;
  }

  /**
   * Reconciles one batch of threads: provider rollouts once, then each
   * thread's bb usage events. `changed` collects the threads that moved.
   */
  async function syncThreads(
    threads: { id: string; providerId: string; createdAt: number; title: string | null; modelOverride: string | null }[],
  ): Promise<Set<string>> {
    const changed = new Set<string>();
    for (const thread of threads) {
      const name =
        thread.modelOverride ??
        (await bbEvents().requestedModel(thread.id)) ??
        store.modelOverride(thread.id);
      store.setThreadInfo(thread.id, thread.title, name);
    }
    const since = threads.reduce(
      (earliest, thread) => Math.min(earliest, store.lastTurnAt(thread.id) ?? thread.createdAt),
      Date.now(),
    );
    const provider = await recordProviderSegments(threads, since);
    for (const id of provider.matched) changed.add(id);
    for (const thread of threads) {
      // Provider sessions are the finer, exact-per-response source. Until bb
      // says which thread such a session belongs to, bb's cumulative events
      // would double-count it, so hold this thread back for the next tick.
      if (!provider.complete && !provider.matched.has(thread.id)) continue;
      if (await recordBbTurns(thread.id, thread.providerId)) changed.add(thread.id);
      synced.add(thread.id);
    }
    for (const threadId of changed) bb.realtime.publish(CHANGED_CHANNEL, { threadId });
    return changed;
  }

  async function syncThread(threadId: string): Promise<void> {
    const threads = await bbEvents().recentThreads(500);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) return;
    await syncThreads([thread]);
  }

  async function syncAll(): Promise<void> {
    const threads = await bbEvents().recentThreads(200);
    const pending = threads.filter((thread) => !synced.has(thread.id));
    if (pending.length > 0) await syncThreads(pending);
  }

  async function resyncActive(): Promise<void> {
    const active = new Set([...synced].slice(0, 20));
    if (active.size === 0) return;
    const threads = (await bbEvents().recentThreads(200)).filter((thread) =>
      active.has(thread.id),
    );
    if (threads.length > 0) await syncThreads(threads);
  }

  function syncNow(): Promise<void> {
    return syncAll().catch((cause: unknown) => {
      lastError = errorMessage(cause);
      bb.log.warn(`sync failed: ${lastError}`);
    });
  }

  async function priceExact(limit = 25): Promise<number> {
    if (!current.exactPricing) return 0;
    const key = apiKey();
    if (key === null) return 0;
    const pending = store
      .unpricedTurns(limit)
      .filter((row) => (exactAttempts.get(row.key) ?? 0) < EXACT_RETRIES);
    if (pending.length === 0) return 0;
    const priced = await priceGenerations(store, key, (message) =>
      bb.log.debug(message),
    );
    const stillPending = new Set(
      store.unpricedTurns(limit).map((row) => row.key),
    );
    for (const row of pending) {
      if (stillPending.has(row.key)) {
        exactAttempts.set(row.key, (exactAttempts.get(row.key) ?? 0) + 1);
      } else {
        exactAttempts.delete(row.key);
      }
    }
    if (priced > 0) bb.realtime.publish(CHANGED_CHANNEL, { reason: "exact" });
    return priced;
  }

  function report(period: string, from?: string, to?: string) {
    const range = resolveRange(period, { from, to });
    const built = buildReport(store, range);
    return {
      period,
      label: built.range.label,
      fromMs: built.range.fromMs,
      toMs: built.range.toMs,
      totals: built.totals,
      byModel: built.byModel.slice(0, 50),
      byProvider: built.byProvider,
      byDay: built.byDay,
      byThread: built.byThread,
      pricingFetchedAt: built.pricingFetchedAt,
      keyInfo: keyCache.value,
    };
  }

  function badge(threadId: string | null) {
    const all = resolveRange("all");
    const allTime = buildReport(store, all).totals;
    const today = buildReport(store, resolveRange("today")).totals;
    const thread =
      threadId === null ? null : totalsFromTurns(store.threadTurns(threadId), store);
    return {
      allTime: formatUsd(allTime.costUsd),
      today: formatUsd(today.costUsd),
      thread: thread === null ? null : formatUsd(thread.costUsd),
      allTimeUsd: allTime.costUsd,
      todayUsd: today.costUsd,
      threadUsd: thread === null ? null : thread.costUsd,
    };
  }

  async function refreshKeyInfoNow(): Promise<void> {
    if (Date.now() - keyCache.fetchedAt < 5 * 60 * 1000 && keyCache.value !== null) {
      return;
    }
    await refreshKeyInfo();
  }

  /** Settings are re-read on every sync so `bb plugin config` takes effect. */
  async function reloadSettings(): Promise<void> {
    const next = await settings.get();
    const keyChanged = next.apiKey !== current.apiKey;
    const logsChanged = next.providerLogsDir !== current.providerLogsDir;
    const countingChanged = next.countAllProviders !== current.countAllProviders;
    current = next;
    if (keyChanged || logsChanged || countingChanged) {
      synced.clear();
      await syncNow();
    }
  }

  bb.rpc.register(rpcContract, {
    report: async ({ period, from, to }) => {
      await reloadSettings();
      return report(period, from, to);
    },
    thread: ({ threadId }) => {
      const cost = threadCost(store, threadId);
      const model = cost.turns.find((turn) => turn.model !== null)?.model ?? null;
      return {
        threadId,
        providerFamily: cost.providerFamily,
        totals: cost.totals,
        contextLength: model === null ? null : store.contextLength(model),
        turns: cost.turns
          .slice()
          .reverse()
          .slice(0, 200)
          .map((turn) => ({
            key: turn.key,
            threadId: turn.threadId,
            turnId: turn.turnId,
            providerId: turn.providerId,
            model: turn.model,
            at: turn.at,
            source: turn.source,
            inputTokens: turn.tokens.inputTokens,
            cachedInputTokens: turn.tokens.cachedInputTokens,
            cacheWriteInputTokens: turn.tokens.cacheWriteInputTokens,
            outputTokens: turn.tokens.outputTokens,
            reasoningTokens: turn.tokens.reasoningTokens,
            costUsd: turnExactOrEstimate(turn),
            exact: turn.exactCostUsd !== null,
          })),
      };
    },
    badge: ({ threadId }) => badge(threadId),
    refreshPrices: async () => {
      await reloadSettings();
      const error = await refreshPrices();
      return { models: error === null ? store.pricingFetchedAt() : null, error };
    },
    priceExact: async () => {
      await reloadSettings();
      try {
        const priced = await priceExact(50);
        return { priced, error: null };
      } catch (cause) {
        return { priced: 0, error: errorMessage(cause) };
      }
    },
    keyInfo: async () => {
      await reloadSettings();
      await refreshKeyInfoNow();
      return { keyInfo: keyCache.value, error: keyCache.error };
    },
  });

  function turnExactOrEstimate(turn: {
    exactCostUsd: number | null;
    estimatedCostUsd?: number;
    model: string | null;
    tokens: TurnRow["tokens"];
    at: number;
  }): number | null {
    return priceOfTurn(turn, (model) => store.getPricing(model)).usd;
  }

  bb.events.on("thread.active", async ({ thread }) => {
    await reloadSettings();
    await syncThread(thread.id).catch((cause: unknown) =>
      bb.log.warn(`sync ${thread.id} failed: ${errorMessage(cause)}`),
    );
    void priceExact(10).catch(() => undefined);
  });
  bb.events.on("thread.idle", async ({ thread }) => {
    await syncThread(thread.id).catch((cause: unknown) =>
      bb.log.warn(`sync ${thread.id} failed: ${errorMessage(cause)}`),
    );
    await priceExact(20).catch((cause: unknown) =>
      bb.log.debug(`exact pricing deferred: ${errorMessage(cause)}`),
    );
  });
  bb.events.on("experimental_thread.events", ({ thread }) => {
    synced.add(thread.id);
  });

  // Cold start: populate from whatever bb and the provider logs already hold.
  bb.background.service("collector", {
    async start(signal) {
      await reloadSettings();
      await syncNow();
      if (signal.aborted) return;
      await refreshPrices(signal);
      await refreshKeyInfo();
      await syncNow();
      void priceExact(50).catch((cause: unknown) =>
        bb.log.debug(`exact pricing deferred: ${errorMessage(cause)}`),
      );
      while (!signal.aborted) {
        await sleep(TICK_MS, signal);
        if (signal.aborted) break;
        // Rollout files grow while an agent works; re-read the active ones
        // in one pass over the logs instead of one scan per thread.
        await resyncActive().catch((cause: unknown) =>
          bb.log.debug(`resync failed: ${errorMessage(cause)}`),
        );
        const hours = current.priceRefreshHours;
        if (
          hours > 0 &&
          Date.now() - (store.pricingFetchedAt() ?? 0) > hours * 60 * 60 * 1000
        ) {
          await refreshPrices(signal);
          await refreshKeyInfo();
        }
        void priceExact(15).catch(() => undefined);
      }
    },
  });

  addCommandLine();

  function addCommandLine(): void {
    registerCli(bb, {
      report: (period, from, to) => report(period, from, to),
      thread: (threadId) =>
        store.threadTurns(threadId).length > 0 ? threadCost(store, threadId) : null,
      badge,
      refreshPrices: async () => {
        await reloadSettings();
        const error = await refreshPrices();
        return { fetchedAt: store.pricingFetchedAt(), error };
      },
      priceExact: async () => {
        try {
          return { priced: await priceExact(50), error: null };
        } catch (cause) {
          return { priced: 0, error: errorMessage(cause) };
        }
      },
      keyInfo: async () => {
        await reloadSettings();
        await refreshKeyInfoNow();
        return { keyInfo: keyCache.value, error: keyCache.error };
      },
      hasApiKey: () => apiKey() !== null,
      contextLength: (model) => store.contextLength(model),
      lastError: () => lastError,
      settingsProvider: async () => {
        await reloadSettings();
      },
    });
  }

  bb.background.schedule("refresh-prices", "17 */6 * * *", async () => {
    if (current.priceRefreshHours === 0) return;
    await refreshPrices();
  });
}
