# Editing latency — aggregate measurement (E3)

Generated 2026-09-14T19:59:43.295Z. Source: 419 files in the desktop conversations directory (1 unreadable/non-conversation, skipped).

Numbers only — no transcript content is reproduced here (user data).

## Coverage

- Conversations processed: 418
- Conversations with zero events: 0
- Event groups without a `user_message` (excluded from turn stats): 364
- User turns measured: 785
- Of those, turns with a `usage.modelCalls`: 231 (missing: 554)
- Turns with a terminal run status: 748 (missing: 37)
- Turns that produced at least one applied patch: 369

## Headline stages — overall

| stage | n | p50 | p90 | max |
|---|---|---|---|---|
| time to first model output | 719 | 3572ms | 25.8s | 598.3s |
| time to first applied patch | 369 | 57.9s | 240.3s | 1144.2s |
| time to run end | 748 | 36.4s | 361.2s | 3023.0s |
| model calls / turn | 231 | 7 | 22 | 156 |
| review wait (all) | 80 | 28ms | 96.7s | 323.5s |
| review wait (explicit timeout text) | 7 | 300.0s | 323.5s | 323.5s |
| review wait (derived from event gap) | 73 | 25ms | 202ms | 96.7s |

## Host tool wall time by kind — overall

| kind | total ms | per-turn p50 | per-turn p90 | per-turn max |
|---|---|---|---|---|
| transcribe | 11.0s | 0ms | 0ms | 8210ms |
| index_media | 585.3s | 0ms | 20ms | 121.0s |
| render | 19.4s | 0ms | 0ms | 16.4s |
| frame_pulls | 744.2s | 0ms | 0ms | 120.1s |
| other | 6383.0s | 2ms | 7735ms | 915.8s |

## Wall-time decomposition (turns with a terminal status)

Turns decomposed: 748

| bucket | total | share |
|---|---|---|
| model calls (thinking/generation/network — total minus tool time minus review wait) | 95325.3s | 91.2% |
| host tool wall time | 7126.6s | 6.8% |
| perceptual review wait | 2050.6s | 2.0% |

**Dominant stage:** model calls, at 91.2% of decomposed wall time across 748 turns. Model calls/turn is n=231, p50 7, p90 22, max 156 — the same call-count spread M4 named as the token-cost lever is, by these numbers, also the wall-clock lever: a turn's latency scales with how many model round trips its agent loop takes, not with tool or review time. See the per-model table below — models with the highest p50/p90 call counts also have the highest run-end latency.

## By model (n ≥ 5)

| model | n | first output p50/p90 | run end p50/p90 | model calls p50/p90 |
|---|---|---|---|---|
| gpt-5.5 | 158 | 4139ms / 40.1s | 42.5s / 231.9s | 2 / 14 |
| deepseek-v4-pro | 111 | 4382ms / 9785ms | 41.8s / 396.8s | 6 / 10 |
| claude-opus-5 | 81 | 3596ms / 33.1s | 154.6s / 409.4s | 10 / 19 |
| openrouter/auto-beta | 52 | 7647ms / 15.5s | 82.3s / 631.0s | 11 / 34 |
| claude-opus-4-7 | 38 | 10.7s / 34.2s | 37.0s / 182.0s | 1 / 19 |
| openai/gpt-4.1 | 38 | 15ms / 21ms | 11.2s / 23.3s | — / — |
| tencent/hy3:free | 33 | 25ms / 11.2s | 87.3s / 633.7s | — / — |
| openrouter/auto | 28 | 7890ms / 21.5s | 292.9s / 1163.2s | 11 / 32 |
| openrouter/free | 28 | 8236ms / 47.5s | 66.7s / 457.4s | 3 / 14 |
| nvidia/nemotron-3-ultra-550b-a55b | 23 | 13ms / 14.3s | 22.9s / 357.5s | 16 / 16 |
| gemini-2.5-flash | 22 | 12ms / 38ms | 884ms / 31.9s | — / — |
| qwen3:14b | 17 | 13ms / 23ms | 317ms / 181.1s | — / — |
| thinkingmachines/inkling | 15 | 4486ms / 12.6s | 9463ms / 38.3s | 5 / 9 |
| mock | 12 | 15ms / 33.7s | 35.6s / 230.2s | — / — |
| deepseek-v4-flash | 11 | 2909ms / 4299ms | 62.2s / 105.2s | — / — |
| meta/llama-3.1-70b-instruct | 9 | 7ms / 14ms | 28.0s / 72.3s | — / — |
| claude-sonnet-5 | 9 | 5280ms / 152.5s | 437.6s / 1098.6s | 22 / 23 |
| sonnet | 9 | 12.0s / 24.2s | 17.4s / 81.7s | — / — |
| stealth/ox-alpha | 8 | 6186ms / 67.0s | 26.3s / 190.2s | 4 / 4 |
| openai/gpt-5.6-luna | 8 | 1138ms / 3942ms | 1629ms / 3950ms | — / — |
| claude-opus-4-8 | 8 | 26ms / 11.4s | 36ms / 11.4s | — / — |
| inclusionai/ling-3.0-flash-fin:free | 7 | 6462ms / 8124ms | 1594.9s / 3023.0s | 81 / 156 |
| google/gemma-4-31b-it:free | 6 | 16ms / 24ms | 195.8s / 628.6s | — / — |
| gpt-5.6-sol | 6 | 1942ms / 2306ms | 3491ms / 3751ms | 1 / 1 |
| gpt-5.6-luna | 5 | 30.4s / 59.9s | 43.4s / 59.9s | — / — |

(19 model(s) with n < 5 omitted from this table.)

## Before vs after 2026-09-13 (ramp-render fix)

| period | n | first output p50/p90 | run end p50/p90 | review wait p50/p90 (n) |
|---|---|---|---|---|
| before-2026-09-13 | 783 | 3568ms / 25.8s | 36.3s / 357.5s | 28ms / 96.7s (80) |
| from-2026-09-13 | 2 | 4780ms / 4780ms | 535.3s / 535.3s | — / — (0) |
## Per model call (context_usage pairs)

- Model calls with settled usage: 2276; wall total 55088.7s; wall p50/p90 13.2s / 54.1s; output tokens p50/p90 1125 / 8076; tool calls per call p50 2
- Fixed cost per call (fit over 2248): **7310ms** intercept, then 179 output tokens/s
- Time to first token p50/p90: 9490ms / 47.2s (n=1812)
- Classifier call: n=385, wall p50/p90 3621ms / 9318ms, output tokens p50 64
- Read-only steps straight after an applied edit: 102 (4.5% of calls), 1751.5s
- Steps with no tool call before the turn's last: 26, 1255.5s
- Cache: 1352 calls report cache reads (p50 24934); writes p50 —; uncached input p50 10347; 382 calls re-billed the tool block

### By run stage

| group | calls | wall share | wall mean | wall p50 | output tok mean | tool calls p50 |
|---|---|---|---|---|---|---|
| apply | 1386 | 61.5% | 24.5s | 14.5s | 3527 | 2 |
| analyze | 501 | 22.8% | 25.1s | 11.5s | 2231 | 2 |
| plan | 54 | 4.3% | 44.2s | 27.2s | 4903 | 1 |
| (none) | 80 | 4.2% | 28.7s | 9303ms | 545 | 1 |
| interpret | 149 | 3.2% | 12.0s | 7553ms | 821 | 3 |
| repair | 70 | 2.8% | 21.9s | 16.4s | 2395 | 1 |
| inspect | 36 | 1.1% | 17.2s | 10.0s | 947 | 1 |

### By reasoning effort (as sent)

| group | calls | wall share | wall mean | wall p50 | output tok mean | tool calls p50 |
|---|---|---|---|---|---|---|
| (not recorded) | 2276 | 100.0% | 24.2s | 13.2s | 2946 | 2 |

### By stage and effort

| group | calls | wall share | wall mean | wall p50 | output tok mean | tool calls p50 |
|---|---|---|---|---|---|---|
| apply · (not recorded) | 1386 | 61.5% | 24.5s | 14.5s | 3527 | 2 |
| analyze · (not recorded) | 501 | 22.8% | 25.1s | 11.5s | 2231 | 2 |
| plan · (not recorded) | 54 | 4.3% | 44.2s | 27.2s | 4903 | 1 |
| (none) · (not recorded) | 80 | 4.2% | 28.7s | 9303ms | 545 | 1 |
| interpret · (not recorded) | 149 | 3.2% | 12.0s | 7553ms | 821 | 3 |
| repair · (not recorded) | 70 | 2.8% | 21.9s | 16.4s | 2395 | 1 |
| inspect · (not recorded) | 36 | 1.1% | 17.2s | 10.0s | 947 | 1 |

### By provider

| group | calls | wall share | wall mean | wall p50 | output tok mean | tool calls p50 |
|---|---|---|---|---|---|---|
| openrouter | 1513 | 66.6% | 24.2s | 13.3s | 3612 | 2 |
| openai-compatible | 292 | 11.1% | 21.0s | 9704ms | 1607 | 2 |
| deepseek | 67 | 6.8% | 55.5s | 24.5s | 3746 | 2 |
| ollama | 224 | 5.7% | 13.9s | 9905ms | 868 | 2 |
| claude-agent-sdk | 128 | 5.6% | 24.1s | 17.2s | 1796 | 2 |
| (unknown) | 28 | 3.0% | 58.9s | 23.7s | — | 2 |
| nvidia | 21 | 1.3% | 33.3s | 20.6s | 655 | 1 |
| vercel-gateway | 3 | 0.0% | 4673ms | 5079ms | 89 | 2 |

## Reading these numbers

- `time to first applied patch` and `time to run end` are NOT nested: the patch stat is over only the turns that produced one (367 of 783); the run-end stat is over every turn that reached a terminal status (746), most of which are chat-only or refused and finish fast. A larger patch p50 than run-end p50 reflects that denominator difference, not a contradiction.
- The wall-time decomposition attributes every turn-second either to a `tool_call`'s own `runtimeMs`, an explicit or derived review wait, or the remainder (model calls: network + generation + orchestrator think time, none of which is separately timestamped in the log). It is additive by construction (the three shares sum to 1) and is only computed for the 746 turns with a terminal status.
- `review wait (derived)` is a proxy — the gap since the immediately preceding event — used only when the reviewer's own text has no explicit `timed out after Nms` figure to read.

