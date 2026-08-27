# 03 — Split `add_stock` into parallel acquire + serial commit

**Status:** `[x]` done — 2026-08-27, commit `1646ee5`; **ADR 0150**

**What shipped.** A turn's `add_stock`/`add_music` downloads are warmed concurrently
through `mapBounded` at the existing pool of 4 before the serial pass; the serial commit is
untouched and still probes against the advanced `turnCtx`. Concurrency made safe: an
in-flight map keyed `provider|remoteId|variantId`, serialized `appendLedger`, a
`randomUUID` `operationId`, and `STOCK_DOWNLOAD_MAX_MS` (180s) bounding total wall clock
alongside the 30s stall timer.

**Also shipped** (`e23fee0`): one retry for a transport failure only — `download_failed`,
`timeout`, `rate_limited`, or a raw `net::ERR_*`; never `too_large`/`unauthorized`/
`cancelled`, which are answers. A `.tmp` sweep on a project's first download, for fragments
a crashed session left behind. And `deduped` surfaced, so a re-download can be told from a
free cache hit.

**Not done. Step 11 — the live re-run against the captured 18 `remoteId`s — has not been
run.** The ≈960s → ≈250s figure and the failure-rate improvement are projections, not
measurements. A flat failure rate should be read as the QUIC hypothesis being wrong.
**Depends on:** 01 (measurement). Independent of 02 — can land in parallel.
**Blast radius:** `packages/ai-sdk/src/tool-contract.ts`,
`packages/ai-sdk/src/orchestrator.ts` (`executeToolCalls`),
`apps/desktop/electron/media/stock-service.ts`, `apps/desktop/electron/ai/stock-host.ts`,
`packages/ai-sdk/src/providers/stock-types.ts`. Desktop-first (`fp-media://`, sidecar).

---

## Outcome

Eighteen `add_stock` calls in one turn download **concurrently at a bounded pool of 4**,
then commit **serially in milliseconds**. Measured target on the captured run's workload:
**≈960s → ≈250s**, with the failure rate down from 33%.

---

## Why it is serial today

`tool-contract.ts:102-106` declares `add_stock` `concurrency: 'serial'` because
`effectClass: 'mutation'`. That row exists for a real reason (the comment above it documents
a permissions hole where `add_stock` fell to the `analysis` default and got advertised on the
question route). But one contract row governs **two operations with opposite requirements**:

- **acquire** — `net.fetch` a third-party file to disk. No project state. 7.9s–154s.
  Embarrassingly parallel. **All the latency lives here.**
- **commit** — register the asset, compute placement, place a clip via a reversible patch.
  Touches the turn's speculative working copy. Order-dependent. **Milliseconds.**

Serializing the commit is correct and must not change. Serializing the acquire costs 16
minutes.

---

## The invariant that shapes the design

`orchestrator.ts:4774-4782` enforces: **a call in a concurrent batch must return zero ops and
no `project`** (dev-throws, prod-logs). So the acquire phase must return
`{ ops: [], status: 'completed' }` carrying only the downloaded payload.

This is not bureaucratic. Placement is computed from the project at `orchestrator.ts:3401`
(`stockOpsFromPayload(ctx.project, …)`) and probed at `:3410`.
`buildAddStockOps` derives `nextLayerId` from `timeline.tracks.length`
(`editor-core/stock-placement.ts:122-130`) and deterministic clip ids
`${target.id}_${asset.id}_clip` (`:212`). **Two placements computed against the same stale
project both emit `layer_video_N` and colliding clip ids in one patch.**
`stockPlacementConflictReason` occupancy (`:271-286`) is likewise order-dependent.

**Therefore: placement, occupancy, and the probe all run in the serial commit against the
advanced `turnCtx` (`orchestrator.ts:4859`) — never at acquire time.** The host's
pre-download occupancy check (`stock-host.ts:86-94`) must be dropped from the acquire phase
or downgraded to advisory; it is computed against a project that will have moved by commit.

---

## Change 1 — a two-phase execution path

In `executeToolCalls`, before running a batch, collect the `add_stock`/`add_music` calls and
run their **acquires** through `mapBounded` (`concurrency.ts:96`) at the existing pool of 4.
Then run the commits serially, each against the advanced `turnCtx`, each computing its own
placement and probe.

Prefer this over splitting the tool into two model-visible tools. The model should not have
to orchestrate a two-phase download; the executor knows the batch and can do it invisibly.
The contract row stays `concurrency: 'serial'` — what changes is that the expensive half no
longer runs under it.

## Change 2 — bound the network

`apps/desktop/electron/media/stock-service.ts:590-679` (`streamToTemp`), called from
`download()` at `:524`. `net.fetch` is bound at `apps/desktop/electron/main.ts:526` — it is
Chromium's net stack, which is why failures read `net::ERR_QUIC_PROTOCOL_ERROR` and
`ERR_NAME_NOT_RESOLVED`.

Today there is **no wall-clock timeout** — only an inter-chunk stall timer re-armed per
`read()` (`:631-634`, `STOCK_DOWNLOAD_STALL_MS = 30_000`, `stock-types.ts:364`, whose comment
explicitly declines a total cap). **No retry anywhere.** **No concurrency limit.**

Add:

- **Pool 4** — reuse `DEFAULT_MAX_TOOL_CONCURRENCY` (`concurrency.ts:22`). `search_stock`
  already runs successfully at this bound, and it sits below Chromium's 6-socket-per-host cap.
- **180s per-download wall clock**, alongside the existing 30s stall timer. The largest
  _successful_ download observed was 154.0s; 180s bounds the tail without killing a legitimate
  4K pull. Peers: 10s search, 15s thumbnail (`stock-types.ts:360-362`).
- **~300s phase budget** for the whole acquire batch. Whatever landed, commits.
- **One retry with jittered backoff**, and only for `ERR_QUIC_PROTOCOL_ERROR` /
  `download_failed` / `timeout`. **Never** for `too_large` / `unauthorized` / `cancelled`.
  Force HTTP/1.1 (or `--disable-quic`) on the second attempt.

> The degradation ladder in the captured run — timeout → QUIC error → `ERR_NAME_NOT_RESOLVED`
> → `ERR_INTERNET_DISCONNECTED` in **74ms** — is Chromium session state, not Pexels being
> down. The final call never reached the network. A bounded pool plus a QUIC-specific retry
> targets the actual mechanism; unbounded parallelism would make it worse.

## Change 3 — make concurrent acquisition safe

Temp-then-rename is already correct: `${absolutePath}.${pid}.${uuid8}.tmp` → `rename`
(`:515`, `:525`), partial unlinked at `:545`, truncation/empty guards at `:674-677`. A
retried partial write is safe today.

Three things are not:

1. **Duplicate in-flight downloads.** Two concurrent acquires of the same
   `remoteId+variantId` both miss the ledger (written only post-rename, `:526`), `dedupeName`
   returns the same name for both (the real file does not exist yet, only `.tmp`s), and both
   `rename` onto the same path. Last writer wins, atomically — no corruption, but **doubled
   bandwidth**. Add an in-memory in-flight map keyed `provider|remoteId|variantId` returning
   the same promise.
2. **`appendLedger` is a read-modify-write with no lock** (`:913-934`). Concurrent
   completions **lose ledger entries**, costing redundant future downloads. Serialize it.
3. **`operationId` collides.** `agent_${remoteId}_${Date.now()}` (`stock-host.ts:102`) —
   same-millisecond duplicates collide in the `this.downloads` cancel map (`:461-463`). Make
   it unique.

Also: **no run-level abort signal is linked into `download()`** (unlike `search()`, which
links one at `:302`). Agent Stop does not abort an in-flight download — so a cancelled run
keeps pulling bytes. Link it.

## Change 4 — partial failure commits what landed

**If 12 of 18 acquire, commit the 12.**

Per-call failure already yields `{ ops: [], status: 'failed' }` and contributes only a note.
`applyAgentTurn` (`orchestrator.ts:4264`, `:4318`) folds all `turnOps` into **one patch,
applied atomically** via `assembleEdit` → `applyProjectPatch`.

The constraint that forces per-call probing is `orchestrator.ts:4265-4269`: **every op in
`turnOps` must already have passed its own probe against the exact speculative state the
whole-turn recombination replays against.** Violating it turns 6 acquire failures into an
18-call turn that lands nothing — which is strictly worse than today.

So: acquire failures drop out before commit; each surviving commit probes against the
advanced `turnCtx`; the turn's patch contains exactly the placements that probed clean.

## Change 5 — orphan disk state

An acquire that succeeds and whose commit is rejected leaves the file on disk. **Keep it** —
that is non-destructive invariant 1 (`editor-core/stock-placement.ts:151-153`), and it is
self-healing: a re-attempt hits the dedupe path (`stock-service.ts:486-504`) at zero bytes,
because the orchestrator's duplicate check (`:3395`) tests the **bin**, not disk.

Two genuine gaps to close:

- **Crash mid-download leaks `.tmp`** with no startup sweep. Add one, plus a ledger-vs-disk
  reconciliation.
- **`deduped` is dropped** by `stock-host.ts:108-131`, so no telemetry distinguishes a
  re-download from a free cache hit. Surface it — without it, Change 3's savings are
  unmeasurable.

---

## Verification

**Unit** — `concurrency.test.ts`, `sidecar-executor.test.ts`:

1. A turn of 8 `add_stock` calls issues 8 acquires at ≤4 in flight, then 8 commits in call
   order.
2. Acquire returns `{ ops: [], project: undefined }` — assert the `:4774-4782` invariant
   directly.
3. 3 of 8 acquires fail → the patch contains exactly 5 placements; the 3 failures carry
   reasons the model can read.
4. Two concurrent acquires of the same `remoteId` share one in-flight promise and one
   network fetch.
5. Concurrent completions do not lose ledger entries (this fails today).
6. A 180s download aborts; a 179s one completes.
7. Retry fires for `ERR_QUIC_PROTOCOL_ERROR`, does **not** for `unauthorized` / `too_large`
   / `cancelled`.
8. Run abort cancels in-flight downloads.

**Placement correctness** — `editor-core/stock-placement.test.ts`:

9. 8 commits against a sequentially advanced project produce **8 distinct layer ids and 8
   distinct clip ids** — the collision this design exists to prevent. Assert it fails when
   placement is computed against a stale project (a guard test).
10. Occupancy conflicts resolve in call order.

**Desktop-scale evidence** (required — `CLAUDE.md` §3 forbids supporting a long-form
performance claim with tiny fixtures):

11. Replay the captured run's 18 `remoteId`s against live Pexels. Record wall clock and
    failure count, before and after. **Target: ≈960s → ≈250s; failures below 33%.** Publish
    the numbers in `plan/PLAN.md`; if the failure rate does not fall, the QUIC hypothesis in
    Change 2 is wrong and must be re-examined rather than papered over.

**Commands:** `pnpm --filter @framepilot/ai-sdk test`, `pnpm --filter @framepilot/editor-core test`,
`pnpm --filter desktop test`, `pnpm typecheck`, `pnpm lint`.

---

## Risks

- **Parallel downloads could worsen the degradation ladder.** Mitigated by the bounded pool
  (4, the bound `search_stock` already survives), the wall clock, and the HTTP/1.1 retry.
  Step 11 is the falsification test — treat a flat failure rate as a real result.
- **Bandwidth contention with preview/proxy generation** on desktop. Measure during step 11;
  if the editor stutters, drop the pool to 3 rather than reverting the split.
- **Do not raise `DEFAULT_MAX_TOOL_CONCURRENCY`** globally. `concurrency.ts:18-22` warns that
  a sidecar thrashed by parallel ffmpeg probes is slower than a short queue. This work needs
  network parallelism, not sidecar parallelism.
- **Ask before changing the contract's `permissions`.** The `add_stock` row's comment
  documents a real permissions hole; `concurrency` is the only field this work touches.

## Definition of done

- [ ] Acquire runs bounded-parallel; commit runs serial against the advanced `turnCtx`.
- [ ] The `:4774-4782` zero-ops invariant is asserted, not assumed.
- [ ] Wall clock, phase budget, and targeted retry in place.
- [ ] In-flight dedupe, ledger serialization, unique `operationId`, run-abort linkage.
- [ ] Partial success commits what landed.
- [ ] `.tmp` startup sweep; `deduped` surfaced in telemetry.
- [ ] Step 11 numbers published in `plan/PLAN.md`.
- [ ] `pnpm verify` green; ADR for the two-phase execution model; `CHANGELOG.md` updated.
