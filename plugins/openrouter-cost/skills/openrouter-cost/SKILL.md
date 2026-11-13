---
name: openrouter-cost
description: Read token usage and OpenRouter cost with the `bb openrouter-cost` command. Use when the user asks what a thread, model, provider or period cost, how many input, cached or output tokens were spent, what the cache hit rate is, or to refresh OpenRouter prices.
---

# OpenRouter cost

The OpenRouter Cost plugin records each agent turn's token counts and prices
them with OpenRouter's catalog (or its exact generation charge when known).

## Commands

| Command | Effect |
| --- | --- |
| `bb openrouter-cost` | Last 30 days: totals and tables by day, model, provider, top threads |
| `bb openrouter-cost --period today` | Same for `today`, `yesterday`, `7d`, `30d`, `month`, `all` |
| `bb openrouter-cost --period custom --from 2026-11-01 --to 2026-11-10` | A date range |
| `bb openrouter-cost thread [id]` | One thread's turns with input, cached, output and cost (defaults to the current thread) |
| `bb openrouter-cost models` | Per-model totals with context size |
| `bb openrouter-cost key` | OpenRouter key spend, limit and remaining budget |
| `bb openrouter-cost refresh` | Re-download model prices |
| `bb openrouter-cost exact` | Fetch exact per-generation costs |

Add `--json` when output drives code.

## Reading the report

- `Cost` is a sum of exact and estimated turn costs; `Accuracy` says how many
  turns are exact, estimated or unpriced.
- `Cached` is input served from the prompt cache; `Cache` is the hit rate of
  prompt tokens. A high hit rate is what keeps an OpenRouter bill low.
- `Input` excludes cached tokens; prompt total = input + cached + cache
  writes.
- Unpriced turns mean their model has no price snapshot (not on OpenRouter,
  or prices not fetched yet); run `bb openrouter-cost refresh` first. Very
  old turns recorded before the model was known stay unpriced.
- `exact` appears only for OpenRouter's own generation ids. Codex turns
  usually stay `estimated` because Codex reports its upstream response id,
  which OpenRouter prices at zero.

Never estimate costs yourself from token counts — report the plugin's numbers.
