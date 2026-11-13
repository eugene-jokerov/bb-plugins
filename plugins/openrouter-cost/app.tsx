/**
 * bb-plugin-openrouter-cost frontend: the cost page in the sidebar, a section
 * in each thread's Info tab, and a cost badge on sidebar rows.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_DetailRow as DetailRow,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_Icon as Icon,
  experimental_useRpcKeyedQuery,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginRpcResult,
  ExperimentalThreadContextSegmentProps,
  ExperimentalThreadInfoProps,
  ExperimentalThreadRowMetadataDataInput,
  ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  formatCompactTokens,
  formatDateTime,
  formatPercent,
  formatTokens,
  formatUsd,
} from "./theme";

const CHANGED_CHANNEL = "cost-changed";
type Period = "today" | "yesterday" | "7d" | "30d" | "month" | "all";

const PERIOD_LABELS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

type Methods = Extract<keyof typeof rpcContract, string>;
type Result<Method extends Methods> = PluginRpcResult<(typeof rpcContract)[Method]>;
type Report = Result<"report">;
type ThreadData = Result<"thread">;

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-card p-4 ${className}`}>{children}</div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xl font-semibold tabular-nums">{value}</div>
      {hint === undefined ? null : (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function SummaryTable({
  title,
  groups,
  empty,
  showName = false,
}: {
  title: string;
  groups: { key: string; label: string; totals: Report["totals"] }[];
  empty: string;
  showName?: boolean;
}) {
  return (
    <Card>
      <h2 className="text-sm font-medium">{title}</h2>
      {groups.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="text-right">
                <th className="py-1 pr-2 text-left font-normal">
                  {showName ? "Model" : "Period"}
                </th>
                <th className="py-1 px-2 font-normal">Turns</th>
                <th className="py-1 px-2 font-normal">In</th>
                <th className="py-1 px-2 font-normal">Cached</th>
                <th className="py-1 px-2 font-normal">Out</th>
                <th className="py-1 px-2 font-normal">Cache</th>
                <th className="py-1 pl-2 font-normal">Cost</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {groups.map((group) => (
                <tr key={group.key} className="border-t border-border/60 text-right">
                  <td className="max-w-[16rem] truncate py-1.5 pr-2 text-left" title={group.label}>
                    {group.label}
                  </td>
                  <td className="py-1.5 px-2">{group.totals.turns}</td>
                  <td className="py-1.5 px-2">{formatCompactTokens(group.totals.inputTokens)}</td>
                  <td className="py-1.5 px-2">{formatCompactTokens(group.totals.cachedInputTokens)}</td>
                  <td className="py-1.5 px-2">
                    {formatCompactTokens(group.totals.outputTokens + group.totals.reasoningTokens)}
                  </td>
                  <td className="py-1.5 px-2">{formatPercent(group.totals.cacheHitRate)}</td>
                  <td className="py-1.5 pl-2 font-medium">{formatUsd(group.totals.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CostPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [period, setPeriod] = useState<Period>("30d");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("report", { period }).then(
      (result) => {
        setReport(result);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, period]);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime(CHANGED_CHANNEL, () => load());

  const run = (name: string, action: () => Promise<void>) => {
    setBusy(name);
    action()
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(null));
  };

  const totals = report?.totals;
  const keyInfo = report?.keyInfo ?? null;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl space-y-3 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-center gap-1">
          {PERIOD_LABELS.map((entry) => (
            <Button
              key={entry.value}
              size="sm"
              variant={period === entry.value ? "secondary" : "ghost"}
              onClick={() => setPeriod(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run("refresh", async () => {
                  await rpc.call("refreshPrices");
                  load();
                })
              }
            >
              <Icon name="RefreshCw" className="mr-1 size-3.5" />
              {busy === "refresh" ? "Refreshing…" : "Prices"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run("exact", async () => {
                  await rpc.call("priceExact", {});
                  load();
                })
              }
            >
              <Icon name="BadgeCheck" className="mr-1 size-3.5" />
              {busy === "exact" ? "Checking…" : "Exact"}
            </Button>
          </div>
        </div>

        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {totals === undefined ? (
          <EmptyState>Loading costs…</EmptyState>
        ) : (
          <>
            <Card>
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium">
                  {report?.label ?? period}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {report?.pricingFetchedAt
                    ? `prices ${formatDateTime(report.pricingFetchedAt)}`
                    : "no price snapshot yet"}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Cost" value={formatUsd(totals.costUsd)} hint={`${totals.turns} turns`} />
                <Stat
                  label="Input"
                  value={formatCompactTokens(totals.inputTokens)}
                  hint={`${formatCompactTokens(totals.promptTokens)} prompt total`}
                />
                <Stat
                  label="Cached input"
                  value={formatCompactTokens(totals.cachedInputTokens)}
                  hint={`${formatPercent(totals.cacheHitRate)} hit rate`}
                />
                <Stat
                  label="Output"
                  value={formatCompactTokens(totals.outputTokens + totals.reasoningTokens)}
                  hint={`${formatCompactTokens(totals.reasoningTokens)} reasoning`}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-4 text-xs text-muted-foreground sm:grid-cols-3">
                <div>
                  Effective input price{" "}
                  <span className="font-medium text-foreground">
                    {formatUsd(totals.effectiveInputPricePerMTok)}/1M
                  </span>
                </div>
                <div>
                  Cache writes{" "}
                  <span className="font-medium text-foreground">
                    {formatTokens(totals.cacheWriteInputTokens)}
                  </span>
                </div>
                <div>
                  Accuracy{" "}
                  <span className="font-medium text-foreground">
                    {totals.exactTurns} exact, {totals.estimatedTurns} est., {totals.unpricedTurns} n/a
                  </span>
                </div>
              </div>
              {keyInfo === null ? null : (
                <p className="mt-2 text-xs text-muted-foreground">
                  OpenRouter key spend {formatUsd(keyInfo.spendUsd ?? 0)}
                  {keyInfo.limitUsd === null
                    ? ""
                    : ` of ${formatUsd(keyInfo.limitUsd)} (${formatUsd(
                        keyInfo.limitRemainingUsd ?? 0,
                      )} left${keyInfo.resetsAt ? `, resets ${keyInfo.resetsAt.slice(0, 16).replace("T", " ")}` : ""})`}
                </p>
              )}
            </Card>
            <SummaryTable
              title="By model"
              groups={report?.byModel ?? []}
              empty="No OpenRouter turns in this period."
              showName
            />
            <SummaryTable
              title="By day"
              groups={report?.byDay ?? []}
              empty="No turns in this period."
            />
            <SummaryTable
              title="Top threads"
              groups={report?.byThread ?? []}
              empty="No turns in this period."
            />
          </>
        )}
      </div>
    </div>
  );
}

/** The thread Info tab: this thread's cost and every turn's split. */
function ThreadCostSection({ threadId }: ExperimentalThreadInfoProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ThreadData | null>(null);
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => {
    rpc.call("thread", { threadId }).then(setData, () => setData(null));
  }, [rpc, threadId]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(CHANGED_CHANNEL, () => load());
  if (data === null || data.turns.length === 0) return null;
  const totals = data.totals;
  const turns = showAll ? data.turns : data.turns.slice(0, 8);
  return (
    <InfoSection
      label="OpenRouter cost"
      count={data.turns.length}
      accessory={
        <span className="text-xs text-muted-foreground">
          {formatUsd(totals.costUsd)} · {formatPercent(totals.cacheHitRate)} cached
        </span>
      }
    >
      <div className="space-y-1 text-sm">
        <DetailRow label="Cost" icon="CircleDollarSign">
          {formatUsd(totals.costUsd)}{" "}
          <span className="text-muted-foreground">
            ({totals.exactTurns} exact, {totals.estimatedTurns} estimated)
          </span>
        </DetailRow>
        <DetailRow label="Tokens" icon="Hash">
          {formatTokens(totals.inputTokens)} in{" "}
          <span className="text-muted-foreground">
            +{formatTokens(totals.cachedInputTokens)} cached
          </span>{" "}
          · {formatTokens(totals.outputTokens + totals.reasoningTokens)} out
        </DetailRow>
        {data.contextLength === null ? null : (
          <DetailRow label="Context" icon="Gauge">
            {formatTokens(totals.promptTokens + totals.outputTokens + totals.reasoningTokens)}{" "}
            of {formatTokens(data.contextLength)} window
          </DetailRow>
        )}
      </div>
      <InfoList
        items={turns}
        getKey={(turn) => turn.key}
        limit={turns.length}
        renderItem={(turn) => (
          <InfoListRow
            leading={<Icon name={turn.exact ? "BadgeCheck" : "Sigma"} className="size-3" />}
            leadingLabel={turn.exact ? "Exact OpenRouter price" : "Estimated price"}
            name={turn.model ?? "unknown model"}
            context={`${formatTokens(turn.inputTokens)} in · ${formatTokens(
              turn.cachedInputTokens,
            )} cached · ${formatTokens(turn.outputTokens + turn.reasoningTokens)} out`}
            trailing={
              <span className="tabular-nums">
                {turn.costUsd === null ? "—" : formatUsd(turn.costUsd)}
              </span>
            }
            title={formatDateTime(turn.at)}
          />
        )}
      />
      {data.turns.length > 8 ? (
        <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${data.turns.length} turns`}
        </Button>
      ) : null}
    </InfoSection>
  );
}

type Badges = Record<string, string> | undefined;

/**
 * The sidebar asks for every visible row; two calls fill them all — the
 * period totals once and one badge per thread — and a realtime signal refills
 * whatever the server recorded since.
 */
function useBadges({ threads }: ExperimentalThreadRowMetadataDataInput): Badges {
  const rpc = useRpc<typeof rpcContract>();
  const [badges, setBadges] = useState<Badges>(undefined);
  const ids = threads.map((thread) => thread.id);
  const key = ids.join(",");

  const fetchOne = useCallback(
    (threadId: string) =>
      rpc.call("badge", { threadId }).then(
        (result) => {
          setBadges((previous) => {
            const next = { ...(previous ?? {}) };
            if (result.thread === null) delete next[threadId];
            else next[threadId] = result.thread;
            return next;
          });
        },
        () => undefined,
      ),
    [rpc],
  );

  useEffect(() => {
    for (const threadId of key === "" ? [] : key.split(",")) void fetchOne(threadId);
  }, [fetchOne, key]);
  useRealtime(CHANGED_CHANNEL, () => {
    for (const threadId of key === "" ? [] : key.split(",")) void fetchOne(threadId);
  });
  return badges;
}

function CostBadge({ thread, data }: ExperimentalThreadRowMetadataProps<Badges>) {
  const value = data?.[thread.id];
  if (value === undefined || value === null) return null;
  return (
    <span className="text-[10px] tabular-nums text-muted-foreground" title="OpenRouter cost of this thread">
      {value}
    </span>
  );
}

type ThreadSummary = { costUsd: number; exact: number; estimated: number; unpriced: number };

/**
 * The thread's cost as a segment of the context row above its composer, next
 * to bb's parent-thread and changed-files segments. Sits last in the row, so
 * it lands beside the context-window ring. Shows nothing until the thread has
 * priced turns: a `$0.00` for "not counted yet" would read as a free thread.
 */
function ThreadCostSegment(props: ExperimentalThreadContextSegmentProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [summary, setSummary] = useState<ThreadSummary | null>(null);
  const load = useCallback(() => {
    rpc.call("thread", { threadId: props.threadId }).then(
      (result) => {
        const { totals, turns } = result;
        setSummary(
          turns.length === 0
            ? null
            : {
                costUsd: totals.costUsd,
                exact: totals.exactTurns,
                estimated: totals.estimatedTurns,
                unpriced: totals.unpricedTurns,
              },
        );
      },
      () => setSummary(null),
    );
  }, [rpc, props.threadId]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(CHANGED_CHANNEL, () => load());
  if (summary === null) return null;
  const basis =
    summary.unpriced > 0
      ? `${summary.exact} exact, ${summary.estimated} estimated, ${summary.unpriced} unpriced`
      : `${summary.exact} exact, ${summary.estimated} estimated`;
  return (
    <span
      className="text-xs tabular-nums text-muted-foreground"
      title={`OpenRouter cost of this thread (${basis} turns)`}
    >
      {formatUsd(summary.costUsd)}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "costs",
    title: "OpenRouter cost",
    icon: "CircleDollarSign",
    path: "costs",
    component: CostPage,
  });
  app.slots.experimental_threadInfoSection({
    id: "openrouter-cost",
    group: "usage",
    order: 20,
    component: ThreadCostSection,
  });
  app.slots.experimental_threadRowMetadata<Badges>({
    id: "cost",
    order: 30,
    useData: useBadges,
    component: CostBadge,
  });
  // Последняя деталь строки контекста: сразу перед кружком контекстного окна bb.
  app.slots.experimental_threadContextSegment({
    id: "cost",
    title: "OpenRouter cost",
    // После git: стоимость треда — последняя деталь строки контекста.
    group: "9_cost",
    summary: ThreadCostSegment,
  });
});
