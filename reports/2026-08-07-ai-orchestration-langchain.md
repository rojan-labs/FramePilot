# AI orchestration baseline — langchain

> [!WARNING]
> - **Only 5 prompt(s) were run; M0.1 asks for at least 20.** p95 over a handful of prompts is one unlucky call, not a percentile. Treat this as indicative.
> - **3 of 5 run(s) failed.** Their model calls are still in the sample set — a call that happened and then errored still cost money and time, and dropping it would flatter the numbers. But a failed run is a short run, so it pulls the per-turn figures down.

> Captured 2026-08-07 by `scripts/capture-ai-baseline.mjs`. **Measured, not estimated.**
> **This is a candidate measurement, not the budget.** It ran on the LangChain adapter,
> so it is the thing being judged. The budget is a `native` capture under the same
> project, prompts and model; compare them with `checkAgainstBudget`.

## Conditions

| | |
| --- | --- |
| Provider | `deepseek` (adapter: `langchain`) |
| Model | `deepseek-v4-pro` |
| Project | `project_my_new.fp.json` |
| Prompts run | 5 (2 completed, 3 failed) |
| Model calls measured | 63 (63 streamed, 0 non-streaming) |
| Wall time | 1551s |

## Per-turn measurements

| Metric | Value |
| --- | --- |
| Time to first token (ms) | p50 1521 · p95 2377 · min 981 · max 5226 |
| Turn wall time (ms) | p50 14839 · p95 80088 · min 2659 · max 98616 |
| Input tokens | p50 3050 · p95 11559 · min 6 · max 12039 |
| Output tokens | p50 751 · p95 4168 · min 95 · max 5249 |
| Cost per turn (USD) | p50 $0.0187 · p95 $0.0973 · min $0.0016 · max $0.1134 |
| Total spend (USD) | $1.9207 |
| Prompt-cache hit rate | 79.9% |

## How to read this

- **TTFT is time to the first _content_ chunk**, not the first chunk of any kind. Anthropic
  sends usage on `message_start`; counting that would report a latency nobody experienced.
- **Non-streaming calls carry `ttftMs === wallMs`** because they have no first-token
  moment. 0 of 63 samples are non-streaming.
- **0 of 63 samples have `ttftMs === wallMs` in total**.
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
`FRAMEPILOT_AI_PROVIDER_IMPL=native` — same
`--project`, same `--prompts`, same model. The label is derived from that variable, not
passed in, so the two reports cannot be confused for one another.
