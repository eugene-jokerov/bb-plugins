/**
 * `bb openrouter-cost` — the agent- and human-facing report command.
 *
 * All numbers come from the same RPC-shared report builder, so the CLI and
 * the sidebar always agree. Output is bounded: grouping tables cap at 25
 * rows and the turn list at 50.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Totals } from "./report.js";
import { formatCompactTokens, formatUsd, PERIODS } from "./report.js";
import type { TurnRow } from "./store.js";

const TABLE_ROWS = 25;
const TURN_ROWS = 50;

export interface CliDeps {
  report: (
    period: string,
    from?: string,
    to?: string,
  ) => {
    period: string;
    label: string;
    fromMs: number;
    toMs: number;
    totals: Totals;
    byModel: { key: string; label: string; totals: Totals }[];
    byProvider: { key: string; label: string; totals: Totals }[];
    byDay: { key: string; label: string; totals: Totals }[];
    byThread: { key: string; label: string; totals: Totals }[];
    pricingFetchedAt: number | null;
    keyInfo: unknown;
  };
  thread: (threadId: string) => {
    threadId: string;
    totals: Totals;
    turns: TurnRow[];
    providerFamily: string | null;
  } | null;
  badge: (threadId: string | null) => {
    allTime: string;
    today: string;
    thread: string | null;
    allTimeUsd: number;
    todayUsd: number;
    threadUsd: number | null;
  };
  refreshPrices: () => Promise<{ fetchedAt: number | null; error: string | null }>;
  priceExact: () => Promise<{ priced: number; error: string | null }>;
  keyInfo: () => Promise<{ keyInfo: unknown; error: string | null }>;
  hasApiKey: () => boolean;
  lastError: () => string | null;
  contextLength: (model: string) => number | null;
  settingsProvider: () => Promise<void>;
}

const USAGE = [
  "Usage:",
  "  bb openrouter-cost                       Report for the last 30 days",
  "  bb openrouter-cost [--period <period>] [--from <date>] [--to <date>] [--json]",
  "  bb openrouter-cost thread [id]          One thread's turns, tokens, cache and cost",
  "  bb openrouter-cost models               Price list snapshot for used models",
  "  bb openrouter-cost badge [id]           The sidebar badge values",
  "  bb openrouter-cost refresh              Re-download model prices from OpenRouter",
  "  bb openrouter-cost exact                Fetch exact per-generation costs",
  "  bb openrouter-cost key                  OpenRouter key limit and spend",
  "",
  `Periods: ${PERIODS.join(", ")} (custom needs --from and --to as YYYY-MM-DD).`,
].join("\n");

function parseArgs(argv: string[]): {
  command: string;
  json: boolean;
  period?: string;
  from?: string;
  to?: string;
  threadId?: string;
} {
  const positional: string[] = [];
  let json = false;
  let period: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--period" || arg === "-p") period = argv[++index];
    else if (arg.startsWith("--period=")) period = arg.slice("--period=".length);
    else if (arg === "--from") from = argv[++index];
    else if (arg.startsWith("--from=")) from = arg.slice("--from=".length);
    else if (arg === "--to") to = argv[++index];
    else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  return {
    command: positional[0] ?? "report",
    json,
    period,
    from,
    to,
    threadId: positional[1],
  };
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function dateOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

function totalsLines(totals: Totals, indent = ""): string[] {
  const cache = totals.promptTokens === 0 ? 0 : totals.cachedInputTokens;
  return [
    `${indent}Turns       ${totals.turns}`,
    `${indent}Input       ${totals.inputTokens.toLocaleString("en-US")} tokens (+${totals.cachedInputTokens.toLocaleString("en-US")} cached, ${totals.cacheWriteInputTokens.toLocaleString("en-US")} cache writes)`,
    `${indent}Output      ${(totals.outputTokens + totals.reasoningTokens).toLocaleString("en-US")} tokens (${totals.reasoningTokens.toLocaleString("en-US")} reasoning)`,
    `${indent}Cache       ${percent(totals.cacheHitRate)} of ${totals.promptTokens.toLocaleString("en-US")} prompt tokens (${cache.toLocaleString("en-US")} cached)`,
    `${indent}Cost        ${formatUsd(totals.costUsd)}  (eff. ${formatUsd(totals.effectiveInputPricePerMTok)}/1M prompt)`,
    `${indent}Accuracy    ${totals.exactTurns} exact, ${totals.estimatedTurns} estimated, ${totals.unpricedTurns} unpriced`,
  ];
}

function groupRows(
  groups: { key: string; label: string; totals: Totals }[],
): string[][] {
  return groups.slice(0, TABLE_ROWS).map((group) => [
    group.label.length > 40 ? `${group.label.slice(0, 39)}…` : group.label,
    String(group.totals.turns),
    formatCompactTokens(group.totals.promptTokens),
    formatCompactTokens(group.totals.cachedInputTokens),
    formatCompactTokens(group.totals.outputTokens + group.totals.reasoningTokens),
    percent(group.totals.cacheHitRate),
    formatUsd(group.totals.costUsd),
  ]);
}

const GROUP_HEADER = ["Bucket", "Turns", "In", "Cached", "Out", "Cache", "Cost"];

function keyInfoLines(keyInfo: unknown): string[] {
  if (keyInfo === null || typeof keyInfo !== "object") return [];
  const info = keyInfo as {
    limitUsd?: number | null;
    limitRemainingUsd?: number | null;
    spendUsd?: number | null;
    resetAt?: string | null;
    resetsAt?: string | null;
    limitReset?: string | null;
  };
  const lines: string[] = [];
  if (typeof info.spendUsd === "number") {
    lines.push(`OpenRouter key spend ${formatUsd(info.spendUsd)}`);
  }
  if (typeof info.limitUsd === "number") {
    lines.push(
      `OpenRouter key limit ${formatUsd(info.limitUsd)}${
        typeof info.limitRemainingUsd === "number"
          ? `, remaining ${formatUsd(info.limitRemainingUsd)}`
          : ""
      }${info.limitReset ? ` (reset ${info.limitReset}${info.resetsAt ? ` at ${info.resetsAt}` : ""})` : ""}`,
    );
  }
  return lines;
}

export function registerCli(bb: BbPluginApi, deps: CliDeps): void {
  bb.cli.register({
    name: "openrouter-cost",
    summary: "Token usage and OpenRouter cost per turn, model, provider and day",
    commands: [
      {
        name: "report",
        summary: "Cost and token totals for a period (default: last 30 days)",
        usage: "bb openrouter-cost [--period <today|yesterday|7d|30d|month|all|custom>] [--from <date> --to <date>] [--json]",
      },
      {
        name: "thread",
        summary: "One thread's turns with tokens, cache and cost",
        usage: "bb openrouter-cost thread [thread-id] [--json]",
      },
      {
        name: "models",
        summary: "Price list snapshot for the models that were used",
        usage: "bb openrouter-cost models [--json]",
      },
      {
        name: "badge",
        summary: "Sidebar badge values (all time, today, one thread)",
        usage: "bb openrouter-cost badge [thread-id] [--json]",
      },
      {
        name: "refresh",
        summary: "Re-download model prices from OpenRouter",
        usage: "bb openrouter-cost refresh [--json]",
      },
      {
        name: "exact",
        summary: "Fetch exact generation costs from OpenRouter",
        usage: "bb openrouter-cost exact [--json]",
      },
      {
        name: "key",
        summary: "OpenRouter key spend and limit",
        usage: "bb openrouter-cost key [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs(argv);
      } catch (cause) {
        return {
          exitCode: 2,
          stderr: `${cause instanceof Error ? cause.message : String(cause)}\n${USAGE}`,
        };
      }
      try {
        switch (parsed.command) {
          case "help":
            return { exitCode: 0, stdout: USAGE };
          case "report": {
            const result = deps.report(
              parsed.period ?? "30d",
              parsed.from,
              parsed.to,
            );
            if (json) return reply(result, "");
            const lines = [
              `OpenRouter cost — ${result.label} (${dateOf(result.fromMs)}..${dateOf(
                result.toMs - 1,
              )})`,
              "",
              ...totalsLines(result.totals),
            ];
            const keyLines = keyInfoLines(result.keyInfo);
            if (keyLines.length > 0) lines.push("", ...keyLines);
            if (result.byDay.length > 0) {
              lines.push("", "By day", table(GROUP_HEADER, groupRows(result.byDay)));
            }
            if (result.byModel.length > 0) {
              lines.push("", "By model", table(GROUP_HEADER, groupRows(result.byModel)));
            }
            if (result.byProvider.length > 1) {
              lines.push(
                "",
                "By provider",
                table(GROUP_HEADER, groupRows(result.byProvider)),
              );
            }
            if (result.byThread.length > 0) {
              lines.push(
                "",
                "Top threads",
                table(GROUP_HEADER, groupRows(result.byThread)),
              );
            }
            if (result.totals.unpricedTurns > 0) {
              lines.push(
                "",
                `${result.totals.unpricedTurns} turn(s) have no price for their model; run \`bb openrouter-cost refresh\`.`,
              );
            }
            if (!deps.hasApiKey()) {
              lines.push(
                "",
                "No OpenRouter API key configured: prices cannot refresh. Set one with `bb plugin config openrouter-cost set apiKey <key>` or OPENROUTER_API_KEY.",
              );
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "thread": {
            const threadId = parsed.threadId ?? ctx.threadId;
            if (threadId === undefined) {
              return {
                exitCode: 2,
                stderr: `Which thread? Pass a thread id.\n${USAGE}`,
              };
            }
            const result = deps.thread(threadId);
            if (result === null) {
              return {
                exitCode: 1,
                stderr: `Thread ${threadId} is unknown to bb (it may have been deleted).`,
              };
            }
            if (json) {
              return reply(
                {
                  threadId: result.threadId,
                  providerFamily: result.providerFamily,
                  totals: result.totals,
                  turns: result.turns.slice(-TURN_ROWS),
                },
                "",
              );
            }
            const lines = [
              `Thread ${result.threadId}${result.providerFamily ? ` (${result.providerFamily})` : ""}`,
              "",
              ...totalsLines(result.totals),
              "",
              table(
                ["When", "Model", "In", "Cached", "Out", "Cost", "Src"],
                result.turns.slice(-TURN_ROWS).map((turn) => [
                  new Date(turn.at).toISOString().slice(0, 16).replace("T", " "),
                  turn.model ?? "unknown",
                  formatCompactTokens(turn.tokens.inputTokens),
                  formatCompactTokens(turn.tokens.cachedInputTokens),
                  formatCompactTokens(
                    turn.tokens.outputTokens + turn.tokens.reasoningTokens,
                  ),
                  turn.exactCostUsd !== null
                    ? `${formatUsd(turn.exactCostUsd)}`
                    : turn.estimatedCostUsd !== undefined
                      ? `~${formatUsd(turn.estimatedCostUsd)}`
                      : "?",
                  turn.exactCostUsd !== null ? "exact" : turn.source,
                ]),
              ),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "models": {
            const result = deps.report("all");
            const lines = result.byModel.map((group) => ({
              model: group.key,
              contextLength: deps.contextLength(group.key),
              totals: group.totals,
            }));
            if (json) return reply({ models: lines }, "");
            if (lines.length === 0) return { exitCode: 0, stdout: "No turns recorded yet." };
            return {
              exitCode: 0,
              stdout: table(
                ["Model", "Ctx", "Turns", "In", "Cached", "Cache", "Cost"],
                lines.map((line) => [
                  line.model,
                  line.contextLength === null ? "?" : formatCompactTokens(line.contextLength),
                  String(line.totals.turns),
                  formatCompactTokens(line.totals.inputTokens),
                  formatCompactTokens(line.totals.cachedInputTokens),
                  percent(line.totals.cacheHitRate),
                  formatUsd(line.totals.costUsd),
                ]),
              ),
            };
          }
          case "badge": {
            const result = deps.badge(parsed.threadId ?? null);
            if (json) return reply(result, "");
            const lines = [`All time  ${result.allTime}`, `Today     ${result.today}`];
            if (result.thread !== null) lines.push(`Thread    ${result.thread}`);
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "refresh": {
            const result = await deps.refreshPrices();
            if (json) return reply(result, "");
            if (result.error !== null) {
              return { exitCode: 1, stderr: `price refresh failed: ${result.error}` };
            }
            return {
              exitCode: 0,
              stdout: `Model prices refreshed at ${new Date(
                result.fetchedAt ?? Date.now(),
              ).toISOString()}.`,
            };
          }
          case "exact": {
            const result = await deps.priceExact();
            if (json) return reply(result, "");
            if (result.error !== null) {
              return { exitCode: 1, stderr: `exact pricing failed: ${result.error}` };
            }
            return {
              exitCode: 0,
              stdout:
                result.priced === 0
                  ? "No generations needed exact pricing."
                  : `Priced ${result.priced} generation(s) exactly.`,
            };
          }
          case "key": {
            const result = await deps.keyInfo();
            if (json) return reply(result, "");
            if (result.error !== null) {
              return { exitCode: 1, stderr: `OpenRouter key lookup failed: ${result.error}` };
            }
            const lines = keyInfoLines(result.keyInfo);
            return {
              exitCode: 0,
              stdout: lines.length === 0 ? "OpenRouter reports no limit for this key." : lines.join("\n"),
            };
          }
          default:
            return {
              exitCode: 2,
              stderr: `${parsed.command === "" ? "" : `unknown command ${parsed.command}\n`}${USAGE}`,
            };
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { exitCode: 1, stderr: message };
      }
    },
  });
}
