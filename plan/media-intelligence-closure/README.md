# Media intelligence — closure plan

> **Sub-plan of `plan/PLAN.md`.** Scope: everything between "media lands in a project"
> and "the AI editor places a precise cut because of what it read". Indexing,
> preparation lifecycle, backend routing, the footage map, coverage accounting, the
> LLM-consumption contract, performance, and the Settings surface that reports it.

**Last updated:** 2026-08-28
**Trigger:** a 61-photo project reported `0/61 assets prepared · 0%` with a blue
"running" badge and never produced a footage map. Diagnosed against the user's own
brain databases, not a synthetic repro — see `00-DIAGNOSIS.md`.

---

## Status snapshot

| Phase | Title                                                                | State                    |
| ----- | -------------------------------------------------------------------- | ------------------------ |
| 1     | Preparation correctness — stills, head-of-line blocking, job honesty | `[x]` shipped 2026-08-28 |
| 2     | Time base and the LLM-consumption contract                           | `[x]` shipped 2026-08-28 |
| 3     | Parallel preparation                                                 | `[x]` shipped 2026-08-28 |
| 4     | Per-asset outcomes and the panel state matrix                        | `[ ]` not started        |
| 5     | Removals                                                             | `[ ]` not started        |

Phase 1 is the root-cause fix and it is complete and tested. Phases 2–5 are the
closure work the diagnosis exposed. **Phase 2 outranks Phase 3**: a fast index the
model reads with the wrong time base produces fast wrong cuts.

---

## Scope gate (`.agents/rules/product-discipline.mdc` §3)

**User outcome.** The editor drops raw footage — including photos — into a project
and the AI can immediately say what is in it, where, and cut to it accurately. Today
a photo project produced nothing at all, and a mixed project hands the model chapter
times in the wrong frame of reference.

**Current gap.** Four measured failures, each cited in `00-DIAGNOSIS.md`:

1. still photos were routed to a backend that cannot index them, and the resulting
   error froze the whole project's preparation at the first asset — permanently
   (fixed in Phase 1);
2. the footage map injected into every agent run carries **asset seconds labelled as
   timeline seconds**, because the auto-read sends no project document;
3. preparation is serialized end to end — one asset per HTTP call, one embed batch at
   a time, one API key at a time — and 98% of measured wall clock is network wait;
4. per-asset outcomes are returned once over HTTP and then dropped, so a project that
   indexed nothing at all leaves a journal full of `done` jobs and no reason anywhere.

**Minimum vertical slice per phase.** Each phase below ships a user-visible change
with its own evidence. No phase is "schema only" or "backend only".

**Reuse.** Everything here extends what exists: the journaled `visual-index` job, the
`visual_spans`/`visual_vectors`/`analysis_results` brain tables, `FootageMapResponse`,
the `VisualIndexClient` paced loop, the `KeyRing`, and the existing Settings group.
**No new subsystem, store, protocol, or provider layer is proposed.**

**Deferred.** Named with reasons in `05-REMOVE-AND-DEFER.md` — notably: no new
understanding provider, no shot-quality ML, no re-architecture of backend selection
beyond the per-asset capability routing already shipped.

**Evidence.** Each phase states the test, fixture, or measurement that closes it.
Performance phases require a measured before/after on the user's own project scale
(60+ assets), never a tiny fixture.

---

## Files

| File                               | What it holds                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `00-DIAGNOSIS.md`                  | Root cause with live evidence; the full subsystem audit; what is missing, what must be removed |
| `01-PREPARATION-CORRECTNESS.md`    | Phase 1 — shipped. What changed, why, and what it deliberately left open                       |
| `02-TIME-BASE-AND-LLM-CONTRACT.md` | Phase 2 — the exact index/map contract the AI editor consumes, and the time-base defect        |
| `03-PARALLEL-PREPARATION.md`       | Phase 3 — measured baselines, budgets, the concurrency design, regression guards               |
| `04-OBSERVABILITY-AND-PANEL.md`    | Phase 4 — per-asset outcomes, the panel state matrix, recovery without a manual index button   |
| `05-REMOVE-AND-DEFER.md`           | Removals with blast radius, deferred scope with reasons, risk register                         |

---

## The one product decision already taken

**Stills are understood on-device even when TwelveLabs is configured.** TwelveLabs'
index is a video/audio index; a photo cannot be attached to it. The maintainer chose
per-asset capability routing over leaving photo projects unsupported (2026-08-28).
The cost is that image embedding requests reach NVIDIA for hosted-backend users; the
Settings copy now says so. Recorded here so a later agent does not silently reverse it.
