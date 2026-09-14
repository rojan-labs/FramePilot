# Editing latency — aggregate measurement (E3)

Generated 2026-09-13T20:16:03.107Z. Source: 418 files in the desktop conversations directory (1 unreadable/non-conversation, skipped).

Numbers only — no transcript content is reproduced here (user data).

## Coverage

- Conversations processed: 417
- Conversations with zero events: 0
- Event groups without a `user_message` (excluded from turn stats): 362
- User turns measured: 783
- Of those, turns with a `usage.modelCalls`: 229 (missing: 554)
- Turns with a terminal run status: 746 (missing: 37)
- Turns that produced at least one applied patch: 367

## Headline stages — overall

| stage | n | p50 | p90 | max |
|---|---|---|---|---|
| time to first model output | 717 | 3568ms | 25.8s | 598.3s |
| time to first applied patch | 367 | 57.8s | 230.2s | 1144.2s |
| time to run end | 746 | 36.3s | 357.5s | 3023.0s |
| model calls / turn | 229 | 6 | 22 | 156 |
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
| other | 6369.7s | 2ms | 7542ms | 915.8s |

## Wall-time decomposition (turns with a terminal status)

Turns decomposed: 746

| bucket | total | share |
|---|---|---|
| model calls (thinking/generation/network — total minus tool time minus review wait) | 94575.1s | 91.2% |
| host tool wall time | 7113.4s | 6.9% |
| perceptual review wait | 2050.6s | 2.0% |

**Dominant stage:** model calls, at 91.2% of decomposed wall time across 746 turns. Model calls/turn is n=229, p50 6, p90 22, max 156 — the same call-count spread M4 named as the token-cost lever is, by these numbers, also the wall-clock lever: a turn's latency scales with how many model round trips its agent loop takes, not with tool or review time. See the per-model table below — models with the highest p50/p90 call counts also have the highest run-end latency.

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
| sonnet | 9 | 12.0s / 24.2s | 17.4s / 81.7s | — / — |
| stealth/ox-alpha | 8 | 6186ms / 67.0s | 26.3s / 190.2s | 4 / 4 |
| openai/gpt-5.6-luna | 8 | 1138ms / 3942ms | 1629ms / 3950ms | — / — |
| claude-opus-4-8 | 8 | 26ms / 11.4s | 36ms / 11.4s | — / — |
| inclusionai/ling-3.0-flash-fin:free | 7 | 6462ms / 8124ms | 1594.9s / 3023.0s | 81 / 156 |
| claude-sonnet-5 | 7 | 5523ms / 152.5s | 437.6s / 1098.6s | 23 / 23 |
| google/gemma-4-31b-it:free | 6 | 16ms / 24ms | 195.8s / 628.6s | — / — |
| gpt-5.6-sol | 6 | 1942ms / 2306ms | 3491ms / 3751ms | 1 / 1 |
| gpt-5.6-luna | 5 | 30.4s / 59.9s | 43.4s / 59.9s | — / — |

(19 model(s) with n < 5 omitted from this table.)

## Before vs after 2026-09-13 (ramp-render fix)

| period | n | first output p50/p90 | run end p50/p90 | review wait p50/p90 (n) |
|---|---|---|---|---|
| before-2026-09-13 | 783 | 3568ms / 25.8s | 36.3s / 357.5s | 28ms / 96.7s (80) |

_No conversation in this set has a `from-2026-09-13` turn — the transcripts on this machine predate the ramp-render fix (`84ff4719`), so the before/after split above is honestly unmeasurable here rather than reported as a false 0/0 improvement._

## Reading these numbers

- `time to first applied patch` and `time to run end` are NOT nested: the patch stat is over only the turns that produced one (367 of 783); the run-end stat is over every turn that reached a terminal status (746), most of which are chat-only or refused and finish fast. A larger patch p50 than run-end p50 reflects that denominator difference, not a contradiction.
- The wall-time decomposition attributes every turn-second either to a `tool_call`'s own `runtimeMs`, an explicit or derived review wait, or the remainder (model calls: network + generation + orchestrator think time, none of which is separately timestamped in the log). It is additive by construction (the three shares sum to 1) and is only computed for the 746 turns with a terminal status.
- `review wait (derived)` is a proxy — the gap since the immediately preceding event — used only when the reviewer's own text has no explicit `timed out after Nms` figure to read.

