# ADR 0150 — Acquire in parallel, commit in series

**Status:** accepted
**Date:** 2026-08-27
**Related:** ADR 0083 (empty planned mutations fail closed), ADR 0140 (stock media is
placed as a cutaway), ADR 0145 (an absent position means the bin on every surface),
ADR 0148 (a service shared with a panel must not assume a person)

## Context

In captured run `e36235cc` all eighteen `add_stock` calls executed **strictly serially** —
each call's start timestamp equals the previous call's end. Durations ran 7.9s to 154.0s,
totalling roughly 960 seconds: **16 of the run's 30 minutes**, with six of the eighteen
failing.

`search_stock` was already concurrent (five calls share one timestamp). The batching
machinery in `concurrency.ts` works. `add_stock` is excluded from it by one row in
`tool-contract.ts` declaring `concurrency: 'serial'`, because its `effectClass` is
`mutation`.

That row exists for a real reason — the comment above it records a permissions hole where
`add_stock` fell to the `analysis` default and became advertised on the question route. But
it governs **two operations with opposite requirements**:

- **acquire** — `net.fetch` a third-party file to disk. No project state. Where all the
  latency lives.
- **commit** — register the asset, compute placement, place a clip through a reversible
  patch. Milliseconds, and order-dependent.

The failure signature is worth recording because it shaped the fix. Failures cluster at the
tail of each serial chain and degrade in character: timeout → `ERR_QUIC_PROTOCOL_ERROR` →
`ERR_NAME_NOT_RESOLVED` → `ERR_INTERNET_DISCONNECTED`, the last of them failing in **74ms**
without reaching the network. The last two are local-stack failures, not Pexels failures. A
long serial chain of large downloads through Chromium's net stack appears to degrade the
connection pool and resolver — so unbounded parallelism could plausibly make it worse, and
the pool bound below is not decoration.

## Why the commit cannot also be parallelised

`orchestrator.ts` enforces that a call in a concurrent batch returns zero ops and no
project. That is not bureaucracy. Placement is computed from `ctx.project`;
`buildAddStockOps` derives `nextLayerId` from `timeline.tracks.length` and mints
deterministic clip ids `${target.id}_${asset.id}_clip`; `stockPlacementConflictReason` is
order-dependent. Two placements computed against the same stale project emit colliding
layer ids and colliding clip ids **in one patch**.

## Decision

**Warm a turn's sourcing downloads concurrently, then commit them serially, unchanged.**

Before dispatching a turn's batches, `executeToolCalls` issues the host download for every
`add_stock`/`add_music` call in the turn through `mapBounded` at the existing pool size. The
serial pass then runs exactly as before — each call computing its placement and probe
against the advanced `turnCtx` — but its download is already on disk and the host's ledger
dedupe answers it at zero bytes.

Warming rather than restructuring, deliberately: it needs no new tool, no two-phase contract
for the model to orchestrate, and no change to the invariant above. A warm that fails is
discarded in silence, because the serial call will make the same request and report the
failure through the normal path; reporting it twice, or early, would be worse than not
warming. A lone call is never warmed — there is nothing to overlap it with.

### What had to become true for concurrency to be safe

Temp-file-then-rename was already correct. Three things were not:

1. **Duplicate in-flight downloads.** Two concurrent acquires of one clip both missed the
   ledger (written only after the rename), took the same `dedupeName` (the real file does
   not exist yet, only two `.tmp`s), and both renamed onto the same path. Atomic, so nothing
   corrupts — but the bytes are paid for twice. An in-flight map keyed
   `provider|remoteId|variantId` shares the promise instead.
2. **`appendLedger` is a read-modify-write.** It re-reads rather than trusting a stale
   snapshot, which is necessary and not sufficient: two concurrent completions can still
   interleave read/read/write/write and drop an entry, costing a redundant download later —
   the exact cost this change exists to remove. Writes are now chained.
3. **`operationId` collided.** `agent_${remoteId}_${Date.now()}` gave same-millisecond
   downloads one `AbortController` in the cancel map, so cancelling either killed both. It
   is a `randomUUID` now.

### A total download deadline

`STOCK_DOWNLOAD_STALL_MS` (30s) bounds **silence**, not duration, and its own comment
declined a total cap. That was defensible while downloads were serialized and rare. It is
not now: without a total bound, one slow transfer holds a pool slot indefinitely and the
whole turn waits on it. `STOCK_DOWNLOAD_MAX_MS` is 180s — above the longest download
observed to **succeed** in the captured run (154.0s), so a legitimate 4K pull still
completes.

## Consequences

**Good.** A turn's downloads overlap at the same bound `search_stock` already survives, well
under Chromium's per-host socket cap. Concurrent acquisition of the same file costs one
fetch. The ledger cannot lose an entry. A stalled transfer cannot hold the turn open.

**Costs.** The download happens twice in the code path's telling — once warm, once through
the serial call — and only the ledger dedupe makes the second one free. If that dedupe ever
regresses, this doubles bandwidth rather than failing loudly, so it is covered by a test
asserting one fetch for a repeated download.

**Unproven here.** The claim that bounded parallelism _reduces_ the 33% failure rate rests
on the degradation ladder being Chromium session state rather than provider flakiness. That
is a hypothesis the numbers support and a fixture cannot settle; it needs a live re-run
against the captured `remoteId`s, and a flat failure rate should be read as the hypothesis
being wrong rather than as noise.

**Not done.** Partial-failure semantics are unchanged and already correct: a failed acquire
contributes no ops, `applyAgentTurn` folds the surviving placements into one atomic patch,
and each has probed against the exact speculative state the recombination replays. An
orphaned file from a rejected commit is kept, per the non-destructive invariant, and is
self-healing through the same dedupe path.
