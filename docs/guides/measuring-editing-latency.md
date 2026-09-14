# Measuring editing latency from real conversation transcripts

Closes TRACKING.md item **E3** ("editing latency is not measured"). This is a
measurement guide, not a budget doc — see `docs/guides/performance-budgets.md`
for enforced engine-side budgets (interaction/render/decode). Editing latency
as experienced end-to-end in an agent run is a different thing: it spans
model round trips, host tool execution, and the perceptual review, none of
which is bounded by a CI-enforceable unit test, because it depends on a live
model provider. This is why it is measured from real usage instead.

## What it measures

`packages/ai-sdk/scripts/measure-edit-latency.mjs` reads the desktop's
persisted conversation logs — `AiEvent[]` arrays, one JSON file per
conversation, shape defined in `packages/ai-sdk/src/events.ts` — and computes,
per user turn (one `turnId`):

- **time to first model output** — `user_message.ts` → the first
  `assistant_delta` / `assistant_message` / `reasoning` / `reasoning_delta` /
  `tool_call` / `plan` event.
- **time to first applied patch** — `user_message.ts` → the first `diff`
  event (only over turns that produced one).
- **time to run end** — `user_message.ts` → the first terminal `status`
  event (`completed` / `failed` / `cancelled`).
- **model calls per turn** — the turn's `usage` event's `modelCalls` field.
- **host tool wall time, by kind** — summed `tool_call.runtimeMs` (the
  terminal emission of a re-emitted-by-`id` tool call), bucketed into
  `transcribe`, `index_media`, `render` (`render_preview`/`export_video`),
  `frame_pulls` (`get_frame`/`extract_frames`), and `other` (every other
  tool — the bulk of ordinary editing calls like `add_clip`/`trim_clip`).
- **perceptual-review wait** — the perceptual/temporal-evidence review has no
  dedicated `tool_call`; its outcome surfaces as a `review_finding` event or
  as warning/error/notification text. When that text carries an explicit
  `"timed out after Nms"` figure (the client's own measured duration), that
  figure is used; otherwise the wait is derived as the gap since the
  immediately preceding event in the conversation's global timeline — the
  same quantity `N2` (`84ff4719`) measured by hand for one call
  (`POST /review/temporal-evidence ... 6.06s`).

Aggregates (p50/p90/max) are reported overall, by `model` (n ≥ 5 only), and
split before/after 2026-09-13 (the date the ramp-render fix — `84ff4719` —
landed, which also fixed the review timeouts per `N2`).

## Honesty rules this script follows

- **No imputation.** A turn missing a field (no `usage` event, no terminal
  `status`, no `diff`) is counted as *missing* for that stat and excluded
  from that stat's sample — never filled with a default or a sibling
  value. The report's Coverage section states every missing count.
- **Two different denominators, stated explicitly.** "Time to first applied
  patch" is over turns-with-a-patch; "time to run end" is over
  turns-with-a-terminal-status. They are not comparable turn-for-turn, and
  the generated report says so under "Reading these numbers".
- **A derived number says so.** Review-wait samples are tagged `explicit` or
  `derived`; the report's aggregate table reports both, plus the combined
  `all`, so a reader can tell which numbers are text-sourced ground truth
  and which are a timestamp-gap proxy.
- **No wall-clock wait for a paid run.** This script only reads already-
  persisted JSON; it makes no model calls and needs no API key.

## Running it

```bash
node packages/ai-sdk/scripts/measure-edit-latency.mjs \
  [conversations-dir] [--out=path/to/report.md]
```

Defaults: `conversations-dir` is
`~/Library/Application Support/@framepilot/desktop/conversations`; `--out`
is `reports/latency/edit-latency-<date>.md` at the repo root. Conversation
JSON is read in place and never copied into the repo or into the generated
report — only aggregate numbers are written.

Unit tests (`packages/ai-sdk/scripts/measure-edit-latency.test.mjs`) exercise
the pure aggregation functions — `classifyToolKind`, `summarize`,
`extractTurns`, `aggregate` — against a synthetic event fixture, so the
math is covered without touching real user transcripts:

```bash
pnpm --filter @framepilot/ai-sdk exec vitest run scripts/measure-edit-latency.test.mjs
```

## What the first real run found (2026-09-14)

See `reports/latency/edit-latency-2026-09-14.md` for the full numbers. In
short, over 417 conversations / 783 measured user turns: model round trips
(not host tool execution, not the perceptual review) account for roughly
91% of decomposed wall time on a turn that reaches a terminal status, and
model-calls-per-turn is the widest-spread number across providers (p50 6,
p90 22, max 156) — the same call-count spread `M4` named as the token-cost
lever is, by this measurement, also the dominant latency lever. Host tool
time is real but a distant second (~7%), and perceptual-review wait smaller
still (~2%) on this data. No conversation in the captured set postdates the
2026-09-13 ramp-render fix, so the before/after split is honestly reported
as unmeasurable rather than a fabricated improvement number.

This is measurement only — no optimization was made here. A follow-up for
**performance-optimizer** would target reducing agent-loop round trips per
editing turn (fewer, larger tool-using turns; or a cheaper/faster classifier
so weak models don't need as many corrective calls), re-measured with this
same script for a real before/after.
