import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { COLUMN_MIGRATIONS, Store, MIGRATIONS, THREAD_INFO_MIGRATION } from "./store";
import { buildReport, resolveRange } from "./report";
import { parseModelPricing } from "./pricing";
import type { TurnRow } from "./store";

function freshStore(): Store {
  const db = new Database(":memory:");
  const store = new Store({
    query: <T,>(sql: string, params: unknown[] = []): T[] => {
      const statement = db.prepare(sql);
      return statement.reader ? (statement.all(...params) as T[]) : (statement.run(...params), []);
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
  store.migrate(MIGRATIONS);
  db.exec(THREAD_INFO_MIGRATION);
  for (const migration of COLUMN_MIGRATIONS) db.exec(migration.sql);
  return store;
}

function turn(overrides: Partial<TurnRow> & { key: string }): TurnRow {
  const at = overrides.at ?? new Date("2026-11-13T10:00:00Z").getTime();
  return {
    threadId: "thr_1",
    turnId: overrides.key,
    providerId: "acp-codex-acp",
    providerFamily: "codex",
    model: "deepseek/cheap",
    at,
    day: "2026-11-13",
    month: "2026-11",
    tokens: {
      inputTokens: 1000,
      cachedInputTokens: 9000,
      cacheWriteInputTokens: 0,
      outputTokens: 500,
      reasoningTokens: 0,
    },
    source: "codex" as const,
    generationId: null,
    exactCostUsd: null,
    counted: true,
    ...overrides,
  };
}

describe("store and reports", () => {
  it("prices turns collected before any price snapshot once prices arrive", () => {
    const store = freshStore();
    // Recorded while the model was unknown: no price existed yet.
    store.upsertTurn(turn({ key: "thr_1:t-t1" }));
    const before = buildReport(store, resolveRange("all"));
    expect(before.totals.unpricedTurns).toBe(1);
    expect(before.totals.costUsd).toBe(0);

    const pricing = parseModelPricing("deepseek/cheap", {
      pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" },
    });
    expect(pricing).not.toBeNull();
    if (pricing !== null) store.savePricing([pricing]);

    // The aggregate recomputes from the current snapshot, even though the
    // stored row was written without one.
    const after = buildReport(store, resolveRange("all"));
    const expected = 1000 * 3e-7 + 9000 * 6e-9 + 500 * 1.2e-6;
    expect(after.totals.unpricedTurns).toBe(0);
    expect(after.totals.costUsd).toBeCloseTo(expected, 10);
    expect(after.totals.cacheHitRate).toBeCloseTo(0.9);
    expect(after.totals.inputTokens).toBe(1000);
    expect(after.totals.cachedInputTokens).toBe(9000);
    expect(after.totals.outputTokens).toBe(500);
    expect(after.byModel[0]?.key).toBe("deepseek/cheap");
    expect(after.byThread[0]?.key).toBe("thr_1");
    expect(after.byProvider[0]?.key).toBe("codex");
    expect(after.byDay[0]?.key).toBe("2026-11-13");
  });

  it("keeps an exact generation cost over the estimate", () => {
    const store = freshStore();
    store.savePricing([
      parseModelPricing("deepseek/cheap", {
        pricing: { prompt: "0.0000003", completion: "0.0000012" },
      })!,
    ]);
    store.upsertTurn(turn({ key: "thr_1:t-t1" }));
    store.setExactCost("thr_1:t-t1", 0.0123);
    const report = buildReport(store, resolveRange("all"));
    expect(report.totals.costUsd).toBeCloseTo(0.0123, 10);
    expect(report.totals.exactTurns).toBe(1);
    expect(report.totals.estimatedTurns).toBe(0);
  });

  it("excludes turns outside the requested period", () => {
    const store = freshStore();
    store.savePricing([
      parseModelPricing("deepseek/cheap", {
        pricing: { prompt: "0.0000003", completion: "0.0000012" },
      })!,
    ]);
    store.upsertTurn(turn({ key: "old", at: new Date("2026-10-01T10:00:00Z").getTime() }));
    store.upsertTurn(turn({ key: "new", at: new Date("2026-11-13T10:00:00Z").getTime() }));
    const today = resolveRange("today", { now: new Date("2026-11-13T18:00:00").getTime() });
    expect(buildReport(store, today).totals.turns).toBe(1);
    expect(buildReport(store, resolveRange("all", { now: new Date("2026-11-13T18:00:00").getTime() })).totals.turns).toBe(2);
  });

  it("records provider segments once and reports their OpenRouter origin", () => {
    const store = freshStore();
    const segment = {
      key: "gen:abc",
      openrouter: true,
      model: "deepseek/cheap",
      at: 1794561789991,
      generationId: "abc",
      responseId: "resp_abc",
      tokens: { inputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 5, reasoningTokens: 0 },
    };
    expect(store.upsertCodexSegment("thr_1", segment)).toBe(true);
    expect(store.upsertCodexSegment("thr_1", segment)).toBe(false);
    expect(store.threadUsesOpenRouter("thr_1")).toBe(true);
    expect(store.threadUsesOpenRouter("thr_2")).toBeNull();
  });

  it("keeps thread names and model overrides reported by bb", () => {
    const store = freshStore();
    store.setThreadInfo("thr_1", "Fix the ledger", "openrouter/deepseek/cheap");
    store.setThreadInfo("thr_1", null, null);
    expect(store.threadLabel("thr_1")).toBe("Fix the ledger");
    expect(store.modelOverride("thr_1")).toBe("openrouter/deepseek/cheap");
    expect(store.threadOverrides().get("thr_1")).toBe("openrouter/deepseek/cheap");
    expect(store.threadLabel("thr_unknown")).toBeNull();
    expect(store.modelOverride("thr_unknown")).toBeNull();
  });
});
