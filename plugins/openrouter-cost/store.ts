/**
 * Plugin-owned SQLite schema plus every aggregate the CLI, RPC and the
 * sidebar read. Aggregates are computed in SQL so sums stay 64-bit safe.
 */
import type { ModelPricing, TokenCounts } from "./pricing.js";

export type TurnSource = "bb" | "codex" | "api";

/** Upper bound on rows any report loads, keeps CLI output bounded. */
export const REPORT_ROW_LIMIT = 5000;

export interface Bucket {
  day: string;
  month: string;
}

export interface TurnRow {
  key: string;
  threadId: string;
  turnId: string | null;
  providerId: string;
  providerFamily: string;
  model: string | null;
  at: number;
  day: string;
  month: string;
  tokens: TokenCounts;
  source: TurnSource;
  generationId: string | null;
  /** The provider's response id when it is not an OpenRouter generation. */
  responseId?: string | null;
  exactCostUsd: number | null;
  estimatedCostUsd?: number;
  /** False for calls of a provider that never goes through OpenRouter. */
  counted: boolean;
}

/** Minimal surface shared by the real plugin DB and the test DB. */
export interface StoreDb {
  /**
   * Runs any statement; returns rows for row-returning SQL and nothing for
   * writes. `better-sqlite3` itself requires `all` vs `run` to be chosen in
   * advance, so the SDK database handle passed here implements this method.
   */
  query<T>(sql: string, params?: unknown[]): T[];
  /** Runs a DDL script of statements separated by semicolons. */
  exec(sql: string): void;
  close(): void;
}

export const MIGRATIONS: string[] = [
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
   CREATE INDEX IF NOT EXISTS turns_model ON turns (model);
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
];

/**
 * Columns added after the first release. SQLite cannot add an `IF NOT EXISTS`
 * column, so the caller checks `PRAGMA table_info` before running each one.
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; sql: string }[] = [
  { table: "turns", column: "response_id", sql: "ALTER TABLE turns ADD COLUMN response_id TEXT" },
  {
    table: "codex_segments",
    column: "response_id",
    sql: "ALTER TABLE codex_segments ADD COLUMN response_id TEXT",
  },
];

/** A cache of bb's own thread rows; created outside the append-only list. */
export const THREAD_INFO_MIGRATION = `CREATE TABLE IF NOT EXISTS thread_info (
  thread_id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  model_override TEXT,
  updated_at INTEGER NOT NULL
);`;

interface TurnSqlRow {
  key: string;
  thread_id: string;
  turn_id: string | null;
  provider_id: string;
  provider_family: string;
  model: string | null;
  at_ms: number;
  day: string;
  month: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  source: TurnSource;
  generation_id: string | null;
  response_id: string | null;
  exact_cost_usd: number | null;
  estimated_cost_usd: number | null;
  counted: number;
}

function toTurnRow(row: TurnSqlRow): TurnRow {
  return {
    key: row.key,
    threadId: row.thread_id,
    turnId: row.turn_id,
    providerId: row.provider_id,
    providerFamily: row.provider_family,
    model: row.model,
    at: row.at_ms,
    day: row.day,
    month: row.month,
    tokens: {
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteInputTokens: row.cache_write_input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
    },
    source: row.source,
    generationId: row.generation_id,
    responseId: row.response_id ?? null,
    exactCostUsd: row.exact_cost_usd,
    estimatedCostUsd: row.estimated_cost_usd ?? undefined,
    counted: row.counted === 1,
  };
}

export class Store {
  readonly #db: StoreDb;
  readonly #now: () => number;
  #priceCache = new Map<string, ModelPricing | null>();

  constructor(db: StoreDb, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  query<T>(sql: string, params: unknown[] = []): T[] {
    return this.#db.query<T>(sql, params);
  }

  migrate(statements: string[] = MIGRATIONS): void {
    for (const statement of statements) this.#db.exec(statement);
  }

  kvGet(name: string): string | null {
    const rows = this.#db.query<{ value: string }>(
      "SELECT value FROM kv WHERE name = ?",
      [name],
    );
    return rows[0]?.value ?? null;
  }

  kvSet(name: string, value: string): void {
    this.#db.query(
      "INSERT INTO kv (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      [name, value],
    );
  }

  upsertTurn(row: TurnRow): void {
    this.#db.query(
      `INSERT INTO turns (key, thread_id, turn_id, provider_id, provider_family, model, at_ms, day, month,
         input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_tokens,
         source, generation_id, response_id, exact_cost_usd, estimated_cost_usd, counted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         model = excluded.model,
         provider_id = excluded.provider_id,
         provider_family = excluded.provider_family,
         input_tokens = excluded.input_tokens,
         cached_input_tokens = excluded.cached_input_tokens,
         cache_write_input_tokens = excluded.cache_write_input_tokens,
         output_tokens = excluded.output_tokens,
         reasoning_tokens = excluded.reasoning_tokens,
         generation_id = COALESCE(turns.generation_id, excluded.generation_id),
         response_id = COALESCE(turns.response_id, excluded.response_id),
         exact_cost_usd = COALESCE(turns.exact_cost_usd, excluded.exact_cost_usd),
         estimated_cost_usd = COALESCE(excluded.estimated_cost_usd, turns.estimated_cost_usd),
         counted = excluded.counted,
         updated_at = excluded.updated_at`,
      [
        row.key,
        row.threadId,
        row.turnId,
        row.providerId,
        row.providerFamily,
        row.model,
        row.at,
        row.day,
        row.month,
        row.tokens.inputTokens,
        row.tokens.cachedInputTokens,
        row.tokens.cacheWriteInputTokens,
        row.tokens.outputTokens,
        row.tokens.reasoningTokens,
        row.source,
        row.generationId,
        row.responseId ?? null,
        row.exactCostUsd,
        row.estimatedCostUsd ?? null,
        row.counted ? 1 : 0,
        this.#now(),
      ],
    );
  }

  deleteTurn(key: string): void {
    this.#db.query("DELETE FROM turns WHERE key = ?", [key]);
  }

  getTurn(key: string): TurnRow | null {
    const rows = this.#db.query<TurnSqlRow>("SELECT * FROM turns WHERE key = ?", [key]);
    return rows[0] === undefined ? null : toTurnRow(rows[0]);
  }

  listTurns(options: { sinceMs?: number; threadId?: string; limit?: number } = {}): TurnRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.sinceMs !== undefined) {
      where.push("at_ms >= ?");
      params.push(options.sinceMs);
    }
    if (options.threadId !== undefined) {
      where.push("thread_id = ?");
      params.push(options.threadId);
    }
    const limit = Math.min(Math.max(options.limit ?? REPORT_ROW_LIMIT, 1), REPORT_ROW_LIMIT);
    params.push(limit);
    const rows = this.#db.query<TurnSqlRow>(
      `SELECT * FROM turns ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY at_ms DESC LIMIT ?`,
      params,
    );
    return rows.map(toTurnRow);
  }

  /** Turns of one thread, oldest first, regardless of the current filter. */
  threadTurns(threadId: string): TurnRow[] {
    return this.#db
      .query<TurnSqlRow>("SELECT * FROM turns WHERE thread_id = ? ORDER BY at_ms ASC", [threadId])
      .map(toTurnRow);
  }

  /** bb's title for a thread; null when this database has no such table. */
  threadLabel(threadId: string): string | null {
    const rows = this.#db.query<{ title: string | null }>(
      "SELECT title FROM thread_info WHERE thread_id = ?",
      [threadId],
    );
    return rows[0]?.title ?? null;
  }

  /**
   * Latest name and model override bb reports for a thread. Both may come
   * from different sources, so a null keeps the value already stored.
   */
  setThreadInfo(threadId: string, title: string | null, modelOverride: string | null): void {
    this.#db.query(
      `INSERT INTO thread_info (thread_id, title, model_override, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         title = COALESCE(excluded.title, thread_info.title),
         model_override = COALESCE(excluded.model_override, thread_info.model_override),
         updated_at = excluded.updated_at`,
      [threadId, title, modelOverride, Date.now()],
    );
  }

  /** A thread's model override as last reported by bb. */
  modelOverride(threadId: string): string | null {
    const rows = this.#db.query<{ model_override: string | null }>(
      "SELECT model_override FROM thread_info WHERE thread_id = ?",
      [threadId],
    );
    return rows[0]?.model_override ?? null;
  }

  /** The model most turns of a thread ran on (already stored on each row). */
  lastModel(threadId: string): string | null {
    const rows = this.#db.query<{ model: string | null }>(
      `SELECT model FROM turns WHERE thread_id = ? AND model IS NOT NULL
       ORDER BY at_ms DESC LIMIT 1`,
      [threadId],
    );
    return rows[0]?.model ?? null;
  }

  /** Every stored thread id, with its model override. */
  threadOverrides(): Map<string, string> {
    const rows = this.#db.query<{ thread_id: string; model_override: string | null }>(
      "SELECT thread_id, model_override FROM thread_info WHERE model_override IS NOT NULL",
    );
    const result = new Map<string, string>();
    for (const row of rows) {
      if (row.model_override !== null && row.model_override !== "") {
        result.set(row.thread_id, row.model_override);
      }
    }
    return result;
  }

  lastTurnAt(threadId: string): number | null {
    const rows = this.#db.query<{ at_ms: number | null }>(
      "SELECT MAX(at_ms) AS at_ms FROM turns WHERE thread_id = ?",
      [threadId],
    );
    return rows[0]?.at_ms ?? null;
  }

  unpricedTurns(limit = 25): TurnRow[] {
    return this.#db
      .query<TurnSqlRow>(
        `SELECT * FROM turns
          WHERE counted = 1 AND generation_id IS NOT NULL AND exact_cost_usd IS NULL
          ORDER BY at_ms ASC LIMIT ?`,
        [limit],
      )
      .map(toTurnRow);
  }

  setExactCost(key: string, usd: number): void {
    this.#db.query("UPDATE turns SET exact_cost_usd = ? WHERE key = ?", [usd, key]);
  }

  setEstimatedCost(key: string, usd: number): void {
    this.#db.query("UPDATE turns SET estimated_cost_usd = ? WHERE key = ?", [usd, key]);
  }

  saveGeneration(generationId: string, payload: unknown): void {
    this.kvSet(`generation:${generationId}`, JSON.stringify(payload));
  }

  /** A model with no snapshot yet: create the row so the UI can say so. */
  upsertModel(model: string, name: string, contextLength: number | null): void {
    this.#db.query(
      `INSERT INTO model_context (model, name, context_length) VALUES (?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET name = excluded.name,
         context_length = COALESCE(excluded.context_length, model_context.context_length)`,
      [model, name, contextLength],
    );
  }

  savePricing(list: ModelPricing[]): void {
    for (const pricing of list) {
      this.#db.query(
        `INSERT INTO model_prices (model, pricing_json, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET pricing_json = excluded.pricing_json,
           fetched_at = excluded.fetched_at`,
        [pricing.model, JSON.stringify(pricing), pricing.fetchedAt],
      );
      this.upsertModel(pricing.model, pricing.name, pricing.contextLength);
    }
    this.#priceCache.clear();
  }

  pricingFetchedAt(): number | null {
    const rows = this.#db.query<{ fetched_at: number | null }>(
      "SELECT MAX(fetched_at) AS fetched_at FROM model_prices",
    );
    return rows[0]?.fetched_at ?? null;
  }

  getPricing(model: string): ModelPricing | null {
    if (this.#priceCache.has(model)) return this.#priceCache.get(model) ?? null;
    const rows = this.#db.query<{ pricing_json: string }>(
      "SELECT pricing_json FROM model_prices WHERE model = ?",
      [model],
    );
    let parsed: ModelPricing | null = null;
    if (rows[0] !== undefined) {
      try {
        parsed = JSON.parse(rows[0].pricing_json) as ModelPricing;
      } catch {
        parsed = null;
      }
    }
    this.#priceCache.set(model, parsed);
    return parsed;
  }

  contextLength(model: string): number | null {
    const rows = this.#db.query<{ context_length: number | null }>(
      "SELECT context_length FROM model_context WHERE model = ?",
      [model],
    );
    return rows[0]?.context_length ?? null;
  }

  /** Returns true when the segment was new. */
  upsertCodexSegment(
    threadId: string,
    segment: {
      key: string;
      openrouter: boolean;
      model: string | null;
      at: number;
      generationId: string | null;
      responseId?: string | null;
      tokens: TokenCounts;
    },
  ): boolean {
    const key = `${threadId}:${segment.key}`;
    const before = this.#db.query<{ key: string }>(
      "SELECT key FROM codex_segments WHERE key = ?",
      [key],
    );
    if (before.length > 0) return false;
    this.#db.query(
      `INSERT INTO codex_segments (key, thread_id, openrouter, model, at_ms, generation_id,
           response_id, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
           reasoning_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          threadId,
          segment.openrouter ? 1 : 0,
          segment.model,
          segment.at,
          segment.generationId,
          segment.responseId ?? null,
          segment.tokens.inputTokens,
          segment.tokens.cachedInputTokens,
          segment.tokens.cacheWriteInputTokens,
          segment.tokens.outputTokens,
          segment.tokens.reasoningTokens,
        ],
      );
    return true;
  }

  /**
   * Whether every recorded provider segment of the thread came from
   * OpenRouter; null when no provider segments exist (bb events only).
   */
  threadUsesOpenRouter(threadId: string): boolean | null {
    const rows = this.#db.query<{ openrouter: number | null; count: number }>(
      `SELECT MIN(openrouter) AS openrouter, COUNT(*) AS count
         FROM codex_segments WHERE thread_id = ?`,
      [threadId],
    );
    const row = rows[0];
    if (row === undefined || row.count === 0) return null;
    return row.openrouter === 1;
  }

  codexTailTotal(threadId: string): TokenCounts {
    const rows = this.#db.query<{
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
    }>(
      `SELECT input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_tokens
         FROM codex_segments WHERE thread_id = ? ORDER BY at_ms DESC, key DESC LIMIT 1`,
      [threadId],
    );
    const row = rows[0];
    if (row === undefined) {
      return {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      };
    }
    return {
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteInputTokens: row.cache_write_input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
    };
  }

  codexSegmentCount(threadId: string): number {
    return (
      this.#db.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM codex_segments WHERE thread_id = ?",
        [threadId],
      )[0]?.count ?? 0
    );
  }

  /** Aggregate every counted turn grouped by a column expression. */
  /**
   * Aggregates counted turns between two instants, grouped by one of the
   * reported dimensions, folding stored estimates in for rows collected
   * before their model had a price. `estimatedUsd(model, tokens, atMs)` is
   * the caller's estimator so this module never owns pricing policy.
   */
  aggregate(
    column: AggregateColumn,
    range: { fromMs: number; toMs: number },
    estimatedUsd: (model: string, tokens: TokenCounts, atMs: number) => number,
  ): AggregateRow[] {
    const expr = AGGREGATE_COLUMNS[column];
    const totals = new Map<string, AggregateRow>();
    const sqlRows = this.#db.query<{
      bucket: string;
      key: string;
      model: string | null;
      at_ms: number;
      exact_cost_usd: number | null;
      estimated_cost_usd: number | null;
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
    }>(
      `SELECT ${expr} AS bucket, key, model, at_ms, exact_cost_usd, estimated_cost_usd,
         input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_tokens
       FROM turns WHERE counted = 1 AND at_ms >= ? AND at_ms < ?`,
      [range.fromMs, range.toMs],
    );
    for (const row of sqlRows) {
      const group = totals.get(row.bucket) ?? emptyAggregate(row.bucket);
      group.set_turns += 1;
      group.input_tokens += row.input_tokens;
      group.cached_input_tokens += row.cached_input_tokens;
      group.cache_write_input_tokens += row.cache_write_input_tokens;
      group.output_tokens += row.output_tokens;
      group.reasoning_tokens += row.reasoning_tokens;
      const tokens: TokenCounts = {
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        cacheWriteInputTokens: row.cache_write_input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
      };
      const estimate =
        row.estimated_cost_usd ?? estimatedUsd(row.model ?? "", tokens, row.at_ms);
      if (row.exact_cost_usd !== null) {
        group.cost_usd = (group.cost_usd ?? 0) + row.exact_cost_usd;
        group.exact_turns += 1;
      } else if (estimate > 0) {
        group.cost_usd = (group.cost_usd ?? 0) + estimate;
        group.estimated_turns += 1;
      } else {
        group.unpriced_turns += 1;
      }
      totals.set(row.bucket, group);
    }
    return [...totals.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }
}

function emptyAggregate(bucket: string): AggregateRow {
  return {
    bucket,
    set_turns: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: null,
    exact_turns: 0,
    estimated_turns: 0,
    unpriced_turns: 0,
  };
}

export type AggregateColumn = "day" | "month" | "model" | "provider_family" | "thread_id";

const AGGREGATE_COLUMNS: Record<AggregateColumn, string> = {
  day: "day",
  month: "month",
  model: "COALESCE(model, 'unknown')",
  provider_family: "provider_family",
  thread_id: "thread_id",
};

export interface AggregateRow {
  bucket: string;
  set_turns: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  exact_turns: number;
  estimated_turns: number;
  unpriced_turns: number;
}
