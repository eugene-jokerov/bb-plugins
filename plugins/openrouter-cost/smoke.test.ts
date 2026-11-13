import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { costOf, effectiveRate, parseModelPricing, type ModelPricing } from "./pricing";
import { priceOfTurn, providerFamily } from "./price";
import { Store } from "./store";
import { buildReport, resolveRange, totalsFromTurns } from "./report";
import { parseTokenUsage, readCodexRollouts, sessionsRoot } from "./sources";

function memoryDb() {
  const Database = (globalThis as unknown as { __Database?: unknown }).__Database;
  void Database;
}

describe("pricing", () => {
  const raw = {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek Flash",
    context_length: 258400,
    pricing: {
      prompt: "0.0000003",
      completion: "0.0000012",
      input_cache_read: "0.000000006",
      input_cache_write: "0.0000000004",
      overrides: [
        {
          utc_days: ["monday"],
          utc_start: 0,
          utc_end: 100,
          prompt: "0.00000015",
          completion: "0.0000006",
          input_cache_read: "0.000000003",
        },
      ],
    },
  };

  it("parses string prices and overrides", () => {
    const pricing = parseModelPricing(raw.id, raw, 1);
    expect(pricing?.promptPerToken).toBeCloseTo(3e-7);
    expect(pricing?.cacheReadPerToken).toBeCloseTo(6e-9);
    expect(pricing?.cacheWritePerToken).toBeCloseTo(4e-10);
    expect(pricing?.overrides).toHaveLength(1);
  });

  it("uses the time-of-day override when it applies", () => {
    const pricing = parseModelPricing(raw.id, raw, 1) as ModelPricing;
    const mondayMorning = new Date("2026-11-16T02:00:00Z"); // a Monday, hour 2
    const tuesday = new Date("2026-11-17T02:00:00Z");
    expect(effectiveRate(pricing, mondayMorning).promptPerToken).toBeCloseTo(1.5e-7);
    expect(effectiveRate(pricing, tuesday).promptPerToken).toBeCloseTo(3e-7);
  });

  it("prices input, cached input, cache writes and output separately", () => {
    const pricing = parseModelPricing(raw.id, raw, 1) as ModelPricing;
    const cost = costOf(
      pricing,
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWriteInputTokens: 1_000_000,
        outputTokens: 100_000,
        reasoningTokens: 0,
      },
      new Date("2026-11-17T02:00:00Z"),
    );
    const expected = 3e-7 * 1e6 + 6e-9 * 1e6 + 4e-10 * 1e6 + 1.2e-6 * 1e5;
    expect(cost.totalUsd).toBeCloseTo(expected, 10);
    expect(cost.priced).toBe(true);
  });

  it("marks an unknown model as unpriced instead of guessing", () => {
    const cost = costOf(null, {
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    });
    expect(cost.priced).toBe(false);
    expect(cost.totalUsd).toBe(0);
    expect(
      priceOfTurn(
        {
          at: 0,
          model: null,
          exactCostUsd: null,
          tokens: {
            inputTokens: 10,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 5,
            reasoningTokens: 0,
          },
        },
        () => null,
      ).usd,
    ).toBeNull();
  });

  it("prefers the exact generation cost over any estimate", () => {
    expect(
      priceOfTurn(
        {
          at: 0,
          model: "m",
          exactCostUsd: 0.42,
          estimatedCostUsd: 9,
          tokens: {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        },
        () => null,
      ),
    ).toEqual({ usd: 0.42, exact: true });
  });
});

describe("ranges", () => {
  const now = new Date("2026-11-13T15:00:00").getTime();
  it("resolves the preset periods", () => {
    expect(resolveRange("today", { now }).label).toBe("today");
    const week = resolveRange("7d", { now });
    expect(Math.round((week.toMs - week.fromMs) / 86_400_000)).toBe(7);
    expect(resolveRange("month", { now }).fromMs).toBe(
      new Date(2026, 10, 1).getTime(),
    );
  });
  it("rejects a reversed custom range", () => {
    expect(() =>
      resolveRange("custom", { from: "2026-11-10", to: "2026-11-01" }),
    ).toThrow(/from <= to/);
  });
});

describe("usage parsing", () => {
  it("reads bb's cumulative shape", () => {
    const tokens = parseTokenUsage(
      JSON.stringify({
        tokenUsage: {
          total: {
            inputTokens: 1200,
            cachedInputTokens: 900,
            outputTokens: 40,
            reasoningOutputTokens: 7,
          },
          last: {
            inputTokens: 300,
            cachedInputTokens: 250,
            cacheWriteInputTokens: 0,
            outputTokens: 12,
            reasoningOutputTokens: 3,
          },
        },
      }),
    );
    expect(tokens).toEqual({
      inputTokens: 300,
      cachedInputTokens: 250,
      cacheWriteInputTokens: 0,
      outputTokens: 12,
      reasoningTokens: 3,
    });
  });
  it("returns null for rows without counts", () => {
    expect(parseTokenUsage("{}")).toBeNull();
    expect(parseTokenUsage("not json")).toBeNull();
  });
});

describe("provider family", () => {
  it("maps provider ids to families", () => {
    expect(providerFamily("acp-codex-acp")).toBe("codex");
    expect(providerFamily("codex")).toBe("codex");
    expect(providerFamily("claude-code")).toBe("claude");
    expect(providerFamily("acp-cursor")).toBe("cursor");
  });
});

describe("codex rollouts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb-orcost-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads incremental token deltas and the generation id", async () => {
    const session = "01a1d437-c313-7493-bcbe-873c8c4c2687";
    const dir = path.join(sessionsRoot(root), "2026", "11", "13");
    mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `rollout-2026-11-13T12-00-00-${session}.jsonl`,
    );
    const lines = [
      {
        type: "session_meta",
        payload: { model_provider: "openrouter" },
      },
      {
        type: "turn_context",
        payload: { model: "deepseek/x", model_provider: "openrouter" },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "hi", generation_id: "gen-1" },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 700,
              output_tokens: 10,
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 2500,
              cached_input_tokens: 1900,
              output_tokens: 30,
            },
          },
        },
      },
    ];
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const since = new Date("2026-11-13T00:00:00Z").getTime() - 86_400_000;
    const segments = await readCodexRollouts(root, since, () => undefined);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.providerSessionId).toBe(session);
    expect(segments[0]?.model).toBe("deepseek/x");
    expect(segments[0]?.responseId).toBe("gen-1");
    // Codex counts cache reads inside input_tokens.
    expect(segments[0]?.tokens.inputTokens).toBe(300);
    expect(segments[0]?.tokens.cachedInputTokens).toBe(700);
    expect(segments[1]?.tokens.inputTokens).toBe(300);
    expect(segments[1]?.tokens.cachedInputTokens).toBe(1200);
    expect(segments[0]?.generationId).toBeNull();
    expect(segments[0]?.responseId).toBe("gen-1");
  });

  it("reads per-response usage records of newer Codex builds", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rollouts-"));
    const session = "01a1d41f-1717-7b20-900c-990edbed3f91";
    const file = path.join(
      root,
      "sessions",
      "2026",
      "11",
      "13",
      `rollout-2026-11-13T12-00-01-${session}.jsonl`,
    );
    mkdirSync(path.dirname(file), { recursive: true });
    const lines = [
      {
        type: "session_meta",
        payload: {
          id: session,
          session_id: "01a1d41e-f20d-7691-838f-0a2533acf0c8",
          parent_thread_id: "01a1d41e-f20d-7691-838f-0a2533acf0c8",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: {
            model: "deepseek/deepseek-v4.1-flash-1017",
            model_provider_id: "openrouter",
          },
        },
      },
      {
        type: "token_usage_record",
        timestamp: "2026-11-13T09:00:00.000Z",
        payload: {
          turn_id: "turn-1",
          response_id: "gen-1794555643-v4UwRoA06o7ExNFhOhqF",
          turn_token_usage: {
            input_tokens: 11_113,
            cached_input_tokens: 3_712,
            output_tokens: 14,
            reasoning_output_tokens: 0,
          },
        },
      },
      {
        type: "token_usage_record",
        timestamp: "2026-11-13T09:01:00.000Z",
        payload: {
          turn_id: "turn-2",
          response_id: "resp_abc",
          turn_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 7 },
        },
      },
    ];
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const since = new Date("2026-11-12T00:00:00Z").getTime();
    const segments = await readCodexRollouts(root, since, () => undefined);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.model).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(segments[0]?.openrouter).toBe(true);
    expect(segments[0]?.parentSessionIds).toEqual(["01a1d41e-f20d-7691-838f-0a2533acf0c8"]);
    expect(segments[0]?.tokens).toEqual({
      inputTokens: 7_401,
      cachedInputTokens: 3_712,
      cacheWriteInputTokens: 0,
      outputTokens: 14,
      reasoningTokens: 0,
    });
    expect(segments[0]?.responseId).toBe("gen-1794555643-v4UwRoA06o7ExNFhOhqF");
    expect(segments[1]?.responseId).toBe("resp_abc");
    expect(segments[1]?.tokens.inputTokens).toBe(500);
  });
});

describe("reports", () => {
  it("sums tokens and cache hit rate per bucket", () => {
    const totals = totalsFromTurns(
      [
        {
          key: "a",
          threadId: "t",
          turnId: "t-t1",
          providerId: "codex",
          providerFamily: "codex",
          model: "m",
          at: 0,
          day: "2026-11-13",
          month: "2026-11",
          tokens: {
            inputTokens: 100,
            cachedInputTokens: 900,
            cacheWriteInputTokens: 0,
            outputTokens: 50,
            reasoningTokens: 0,
          },
          source: "codex",
          generationId: null,
          exactCostUsd: 0.5,
          counted: true,
        },
      ],
      { getPricing: () => null } as unknown as Store,
    );
    expect(totals.cacheHitRate).toBeCloseTo(0.9);
    expect(totals.promptTokens).toBe(1000);
    expect(totals.exactTurns).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.5);
  });
});

void memoryDb;
void buildReport;
