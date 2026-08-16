# ADR 0060 — Concurrent read/analysis batches inside one agent turn

- **Status:** Accepted
- **Date:** 2026-07-16
- **Relates to:** ADR 0055 (agent loop), ADR 0056 (per-turn diffs), ADR 0033
  (streaming event model), `plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md` (E1 —
  the pattern source: a study of the Claude Code orchestration loop; patterns
  only, no ported code).

## Context

A desktop agent turn frequently makes several sidecar-backed reads —
`get_timeline` + `get_transcript` + `analyze_silence` in one turn is typical
reconnaissance — and `executeToolCalls` awaited each call in strict sequence,
so three 120ms engine round-trips cost ~360ms of pure queueing. Reads and
analyses never produce operations and never advance the turn's speculative
working copy, so serializing them buys no correctness; it only adds latency on
exactly the runs the desktop app (product priority #1) cares about.

At the same time, the serial order is *load-bearing* everywhere else: mutating
calls thread a speculative working copy call-to-call (each validated edit
advances the timeline the next call is validated against), the sidebar assumes
each call's `running → settled → tool_result` lifecycle arrives as an ordered
unit, and the spin guard's `callFacts` depend on repeat reads being served by
the run's memo and marked non-novel.

## Decision

Partition each turn's calls into batches (`concurrency.ts`):

- **Runs of consecutive concurrency-safe calls** — `kind === 'read' |
  'analysis'`, per `concurrencySafe()` in the tool registry — form one batch
  dispatched against a bounded pool (`FRAMEPILOT_MAX_TOOL_CONCURRENCY`,
  default 4; deliberately below the reference architecture's 10 because a busy
  render sidecar thrashed by parallel ffmpeg probes is slower than a short
  queue).
- **Every other call** (`mutate`/`action`/`ask`/`unavailable`) is its own
  serial singleton batch. Mutations therefore stay strictly serial, and the
  working-copy threading is untouched.
- A per-tool `serialOnly` flag opts a stateful read back out (`load_skill`
  pins into the run's ordered, bounded skill ledger). A predicate error or
  arg-parse failure conservatively means *not* safe.
- **Fold in original call order.** A concurrent batch buffers each call's
  outcome and emits its events — `running`, settled status, `tool_result` —
  at fold time, in original call order. The observable event stream, notes,
  callFacts, and the stop-on-cancelled point are byte-identical to serial
  execution (golden-tested); concurrency changes wall clock only.
- **Duplicate calls never share a batch**: the partitioner splits on repeated
  novelty keys so a repeat read lands in a later batch and is still served by
  the read memo (non-novel — the signal the spin guard needs), instead of two
  identical calls racing and both missing the memo.
- A concurrency-safe call that unexpectedly returns ops/project (a
  misregistered tool kind) fails loud in dev and is logged + folded
  deterministically in prod.

## Consequences

- 3 sidecar reads per turn: **374ms → 123ms (3.05×)** with a 120ms fake
  sidecar round-trip (E1.7 evidence, `plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md`).
- The UI shows a concurrent call's card only when its batch folds, not the
  instant it dispatches — a deliberate trade for byte-identical event order.
  Serial singletons (every mutation, ask, action) keep the live `running` card.
- Raising the pool beyond 4 requires desktop-scale perf evidence against a
  real busy sidecar (plan §5, sidecar contention risk).
