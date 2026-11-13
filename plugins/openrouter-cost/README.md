# OpenRouter Cost

Counts every agent turn's tokens and prices them through OpenRouter.

## What it counts

| Counter | Source | Notes |
| --- | --- | --- |
| Input (fresh prompt) | Codex rollout or bb `thread/tokenUsage/updated` | excludes cache reads |
| Cached input | same | prompt cache hits, billed at the cache rate |
| Cache writes | same, when the provider reports it | billed at the write rate when present |
| Output | same | completion tokens |
| Reasoning | same | billed with output, shown separately |

## Where prices come from

1. **Exact** — OpenRouter `GET /api/v1/generation?id=…` for an OpenRouter
   generation id the provider exposed. This is the amount OpenRouter charged.
   Codex logs its upstream `response_id` (`gen-…`) instead; that id resolves
   there but with `total_cost: 0`, which cannot be told apart from a free
   model, so such turns stay on the estimate.
2. **Estimate** — the model's price in the catalog snapshot
   (`GET /api/v1/models`), applied per token bucket, including the
   `overrides` windows (time-of-day or weekday discounts). The price in force
   at the time of the turn is used.
3. **Unpriced** — a model with no snapshot (not on OpenRouter, or prices not
   fetched yet). Reported as a count, never silently billed as zero.

## Surfaces

- Sidebar page **OpenRouter cost**: period totals, by day, by model, top
  threads, OpenRouter key spend/limit, and the price refresh timestamp. The
  **Prices** button re-downloads the catalog; **Exact** asks OpenRouter for
  the exact cost of recorded generations.
- Thread **Info tab → OpenRouter cost**: this thread's totals, context window
  usage and a per-turn list with `exact`/`estimated` marks.
- **Sidebar row badge** (with Organize → Rows → Metadata on): the thread's
  cost.
- **`bb openrouter-cost`** — see `bb openrouter-cost --help`.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | empty | Secret. Empty falls back to `OPENROUTER_API_KEY`. |
| `countAllProviders` | `true` | Bill every provider through OpenRouter. Off: only threads whose provider session ran on OpenRouter (known from Codex rollouts). |
| `priceRefreshHours` | `6` | Catalog refresh interval; `0` refreshes on load only. |
| `providerLogsDir` | empty | Root with `sessions/` (Codex rollouts). Empty uses `CODEX_HOME` or `~/.codex`. |
| `exactPricing` | `true` | Fetch exact generation costs over the network. |

Set secrets with `bb plugin config openrouter-cost set apiKey <key>` (stored in
a 0600 file, never shown to the UI or to agents).

## Architecture

The plugin runs on the server, which also hosts the plugin host worker.

- `sources.ts` reads bb through its loopback HTTP API (`/api/v1/threads`,
  `/api/v1/threads/<id>/events`, pages of at most 100 events) and Codex
  rollout JSONL (`token_usage_record` per response on new builds, cumulative
  `token_count` on old ones). A plugin worker cannot read bb's own `bb.db`
  reliably, so nothing queries it.
- `store.ts` is the plugin's own SQLite (`turns`, `codex_segments`,
  `thread_info` — a cache of bb's thread titles and model overrides —
  `model_prices`, `model_context`). Migrations on shipped indexes are
  append-only; new columns go through `COLUMN_MIGRATIONS`.
- `openrouter.ts` is a small API client; `price.ts`/`pricing.ts` price a turn.
- `report.ts` builds every aggregate; `cli.ts` and `server.ts` present it.
- A background service records usage, refreshes prices, and prices exact
  generations; `thread.active`/`thread.idle` events trigger a sync of that
  thread. Each 20 s tick walks the rollout directory once for all active
  threads rather than once per thread. Nothing runs on the turn's hot path.
- Rollout segments are attributed to the bb thread whose `thread/identity`
  session matches, including the parent session a resuming Codex session
  forks from. When neither matches, that thread's cumulative bb event is held
  back (it would double-count the session) and retried on the next tick.

`npm test` runs the pricing, range, rollout-parsing and store/report tests.
