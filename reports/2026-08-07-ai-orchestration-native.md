# AI orchestration baseline — native

> [!WARNING]
> - **Only 5 prompt(s) were run; M0.1 asks for at least 20.** p95 over a handful of prompts is one unlucky call, not a percentile. Treat this as indicative.
> - **3 of 5 run(s) failed.** Their model calls are still in the sample set — a call that happened and then errored still cost money and time, and dropping it would flatter the numbers. But a failed run is a short run, so it pulls the per-turn figures down.

> Captured 2026-08-07 by `scripts/capture-ai-baseline.mjs`. **Measured, not estimated.**
> This is the M0.1 budget every later phase of `plan/LANGCHAIN-MIGRATION.md` is judged
> against: no worse than these p50/p95 TTFT and cost-per-turn figures, and no lower
> prompt-cache hit rate.

## Conditions

| | |
| --- | --- |
| Provider | `deepseek` (adapter: `native`) |
| Model | `deepseek-v4-pro` |
| Project | `project_my_new.fp.json` |
| Prompts run | 5 (2 completed, 3 failed) |
| Model calls measured | 62 (62 streamed, 0 non-streaming) |
| Wall time | 1738s |

## Per-turn measurements

| Metric | Value |
| --- | --- |
| Time to first token (ms) | p50 1563 · p95 2953 · min 985 · max 86556 |
| Turn wall time (ms) | p50 19519 · p95 79278 · min 2776 · max 99918 |
| Input tokens | p50 17120 · p95 26354 · min 0 · max 28312 |
| Output tokens | p50 816 · p95 3173 · min 0 · max 5043 |
| Cost per turn (USD) | p50 $0.0679 · p95 $0.0995 · min $0.0000 · max $0.1399 |
| Total spend (USD) | $4.5397 |
| Prompt-cache hit rate | — not reported by this provider |

## How to read this

- **TTFT is time to the first _content_ chunk**, not the first chunk of any kind. Anthropic
  sends usage on `message_start`; counting that would report a latency nobody experienced.
- **Non-streaming calls carry `ttftMs === wallMs`** because they have no first-token
  moment. 0 of 62 samples are non-streaming.
- **0 of 62 samples have `ttftMs === wallMs` in total**.
- **An absent cache-hit rate means the provider did not report cache counts**, not that
  the hit rate was zero. Unreported turns are excluded from the denominator so a provider
  gap cannot masquerade as a 0% rate a later phase then "matches".
- **Percentiles are nearest-rank**, so every figure above is a real observation rather
  than an interpolation between two.

## Comparing a later phase against this

```ts
import { checkAgainstBudget } from '@framepilot/ai-sdk';
checkAgainstBudget(baseline, candidate, 0.05); // 5% tolerance for measurement noise
```

To measure the other adapter under identical conditions, re-run with
`FRAMEPILOT_AI_PROVIDER_IMPL=langchain` — same
`--project`, same `--prompts`, same model. The label is derived from that variable, not
passed in, so the two reports cannot be confused for one another.
