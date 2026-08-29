# FramePilot full-system mission — engineering report

**Branch:** `feat/system-mission` · **Head:** `dfaead4` · **Date:** 2026-08-29
**Scope:** `plan/system-mission/` phases 0–10 · **Brief:** `PROMPT.md`

Every number below is measured, with the command that produced it. Where a number is
missing it says so and names the command that would produce it — nothing is estimated,
and no claim is made from memory.

---

## 1. Architecture before — the real problems

The system was not slow because it was doing too much. It was expensive because it was
**failing and retrying**, and the failures were invisible in the aggregate numbers.

Four root causes, all found by measurement (`docs/reports/system-mission/00-baseline.md`):

1. **The output window was the ceiling on correctness.** Agent requests were sent with no
   `maxTokens`, so every response was capped at the provider default of 8,192. A run that
   tried to emit ~110 silence ranges, or a 30-second montage's clip list, was truncated
   mid-JSON, retried, and truncated again. This is why 2 of 3 montage runs and **3 of 3**
   dead-air runs never reached a terminal state, and why the dead-air scenario landed
   **zero operations** across every baseline run.
2. **The tool block was 18.6k tokens on every request** — larger than everything the
   prompt said about the user's actual video. The stage gate only dropped the `analysis`
   role, so ≥ 70 % of it rode every single call.
3. **The same facts were stated three times in three phrasings.** A prose project header,
   a droppable "Selected range" block, and the editor-interaction summary each restated
   the revision, playhead and selection — and only one of the three could be budgeted
   away, so a tight turn could lose the selection in one place and keep it in another.
4. **Sub-systems that were declared but never wired.** `verify → repair → verify` existed
   in the stage machine and nothing ever entered `repair`. The `referencesAnalyze` IPC
   channel was declared in the contract, the preload and the renderer bridge — and
   handled by nothing in main, so every desktop reference attachment could only fail.

---

## 2. Root causes found, and what was done about each

| # | Root cause | Structural fix | Evidence |
| --- | --- | --- | --- |
| 1 | No `maxTokens` on agent requests → truncation loops | `outputRoomFor` sizes the output window from what is left of the context; `truncationRetryHint` tells a retry what happened | `orchestrator.output-room.test.ts`; podcast 25 → 5 calls |
| 2 | A ~110-range silence list echoed through the model | `remove_silences`: the host measures once, the orchestrator turns ranges into ripple deletes (breath kept, last-to-first, frame-snapped) in one reversible patch | `remove-silences.test.ts`, `silence-cut.test.ts`; 0 → 54 ops |
| 3 | Caption style schema inlined three times (3,134 tokens) | `auto_emphasize_captions` lost its duplicate `style` block; `set_caption_style` points at `discover_caption_styles` instead of listing 45 template names | −959 tokens/request on the golden sessions |
| 4 | Per-turn facts stated three times in three phrasings | One fixed-key-order `STATE` block; the three duplicates deleted, not kept alongside | ADR 0158, `state-block.test.ts` |
| 5 | 38 of 73 shared tool descriptions had drifted from the Python mirror | Descriptions generated from the TS registry; a stale file fails a test | `tool-descriptions-generated.test.ts` |
| 6 | `repair` stage declared, never entered | A failed self-check on a run that landed work buys one findings-scoped model turn | ADR 0159, `conductor.test.ts` |
| 7 | `referencesAnalyze` declared everywhere, handled nowhere | Handler in main (sandboxed path, sidecar analyzer, typed result) + a test that scans every main-process source for unserved channels | `main-channel-registration.test.ts` |
| 8 | Engine death was terminal for the session | `SidecarManager` recovers: bounded restarts with backoff, cause and attempt in `status.detail` | 6 tests in `manager.test.ts` |
| 9 | Identical concurrent analyses each spawned their own ffmpeg | `singleflight.py` coalesces in-flight duplicates on `/asset-media`, `/analyze-silence`, `/detect-beats` | 6 callers → 1 derivation (test) |
| 10 | Readiness claimed a provider worked because a key existed | `providerHealth` records the only evidence that settles it — a run that finished without a provider failure | UX-11, 6 tests |

---

## 3. Orchestration: before → after

`mission-baseline.mjs --runs 3`, real desktop sidecar, real media, p50, scored by
`eval/mission-rubric.ts`. Full table and caveats: `docs/reports/system-mission/01-after.md`.

| scenario | model calls | prompt tokens | cache | wall | USD | rubric | did not complete |
| --- | --- | --- | --- | --- | --- | --- | --- |
| podcast-highlight-60s | **25 → 5** | **804k → 173k** | 0.99 → 1.00 | **1200s → 253s** | **$1.54 → $0.32** | 1.00 → 1.00 | **3/3 → 0/3** |
| montage-30s | 10 → 31 | 332k → 963k | 0.99 → 0.99 | 424s → 1070s | $0.57 → $1.52 | **0.25 → 1.00** | 2/3 → 1/3 (a cancel at the harness's own 1200s cap) |
| remove-dead-air | 1 → 7 | 0 → 180k | — → 0.97 | 0s → 584s | $0.00 → $0.94 | **0.25 → 0.75** | 3/3 → 1/1 (settled `failed` *after* landing 54 edits) |
| beat-sync | 1 → 18 | 0 → 497k | — → 0.98 | 0s → 882s | $0.00 → $1.37 | **0.22 → 0.78** | **3/3 → 0/3** |

All three montage runs scored **1.00** with 30–44 operations, the cancelled one included:
that cancellation is the harness's clock, not the edit's quality. The dead-air run reports
`failed` because the bounded verify loop could not clear its last rubric finding (a
mid-word cut) and settled honestly instead of claiming success — the designed behaviour.
Prompt-cache share held throughout (0.97–1.00); none of this was bought by giving up cache.

**Read the last two columns first.** The baseline was cheap because it was failing: every
baseline row has runs that never completed, and two of three scenarios landed **zero**
operations. montage costs 3x more now and produces a montage that exists; comparing its
token count without its outcome would have been the easiest wrong conclusion available.

Prompt-side reductions independent of the scenarios: **−959 tokens on every request**
(caption tool dedupe) and the `STATE` block replacing three prose restatements.

---

## 4. Editing quality

- **Dead air**: 0 → 54 operations, rubric 0.25 → 0.75. The run still ends `failed`: the
  verify loop could not clear the last finding (a mid-word cut) and said so rather than
  claiming success. Breath-padding tuning, not structure.
- **Montage**: 0 → 35 operations, rubric 0.25 → **1.00** on all three runs.
- **Bounded verify loop** (ADR 0159): a deterministic finding that survives the runtime's
  repair pass now buys one model turn scoped to the findings, with the FAIL lines in the
  briefing, before the run is settled. Bounded to one; a finding that survives both
  attempts reaches the editor as a list rather than a third guess.
- **Quality gate**: `pnpm --filter @framepilot/ai-sdk eval:mission` reduces a run to one
  p50 score per scenario and fails against a committed floor (tolerance 0.05). The floor is
  committed — montage 1.00, podcast 1.00, beat-sync 0.78, dead-air 0.75 — and the gate is
  proven in both directions: it exits 0 with every row `held`, and exits 2 with
  `REGRESSION` when a recorded score is lowered past the tolerance.

---

## 5. UI/UX

Audited against the P0.6 walkthrough (`00-ux-findings.md`), triaged in P8.1. Fixed:

- **The timeline answers the wheel** (UX-06). A bare vertical wheel reached the browser,
  found no vertical overflow on a horizontally-scrolling surface, and moved nothing —
  eight wheel steps left the viewport byte-identical. A pure `wheelIntent` now routes it,
  and never steals the gesture from a track stack tall enough to scroll.
- **Every track is a row** (UX-05). Empty tracks were filtered out, so a project's own
  audio lane had no drop target and "Add track" was the only way to find one.
- **The playhead comes back into view** (UX-07). Follow ran only during playback, so a
  seek could park the playhead off-screen and leave it there.
- **Readiness stopped lying** (UX-11). See root cause 10.
- **References show what was learned** (P3.6). The chip is a disclosure: the profile's
  constraints verbatim — the exact lines the planner reads — the analysis time, a role
  selector, and Re-analyze. A failed analysis states its reason there, not in a toast.
- **The AI sidebar shows what it remembers** (P8.2), and removing a chip *forgets* the
  decision rather than hiding it for one turn. "Show on timeline" reveals what a run
  touched.
- **UX-10 was a measurement artifact, not a bug.** The "translucent modal" screenshot was
  the 0.14 s fade caught mid-flight — the app behind it was not dimmed either. Fixed in
  the capture (`animations: 'disabled'`); no CSS was changed, because none was wrong.

---

## 6. Workers, lifecycle, memory and resources

- **Process lifecycle**: render subprocesses run in their own session and a cancel or
  timeout SIGTERMs the whole group; the sidecar is spawned detached and `stop()` kills the
  group. The engine now restarts itself when it dies mid-session (bounded, with backoff).
- **Backpressure**: concurrency caps already existed (asset-media, temporal evidence,
  visual index, one encode); what was missing was duplicate suppression, now added.
- **Renderer caches**: the real caches were already LRU-bounded with close-on-evict; what
  was missing was the project-close path, so a previous project's bitmaps stayed resident.
  Both now clear when a different project opens.
- **Engine resource hygiene**: the whole engine suite runs green under
  `pytest -W error::ResourceWarning` — **2,728 passed, 0 ResourceWarnings**.
- **A resource gate** (`RESOURCE_GATE=1`) asserts heap, listeners, nodes, documents, open
  files and ffmpeg count stay flat across a scripted session.

---

## 7. Export

CapCut-style and platform-free: resolution / frame rate / quality / codec / format derived
from the project's own aspect, with the exact output frame, a size estimate and an upscale
warning. Every platform preset and `/export-reels` is gone; the only remaining platform
names in the tree are content-style targets, orientation hints and catalog tags.

- **Hardware encode**: VideoToolbox / NVENC / QSV with x264/x265 fallback.
- **Measured**: 30 s 4K → 1080p, 94.2 s → 92.6 s, ffmpeg CPU **146 % → 48 %**. The
  headline finding is what it *disproves*: **the encoder was never the bottleneck**;
  MoviePy's per-frame Python compositing is. That is P7.5, and it is not done.
- **Progress** carries stage and fraction from the render subprocess, plus "about N s left"
  derived from the render's own measured pace — never shown before there is a rate to
  derive it from.
- **Failures** say one plain sentence (encoder / disk full / permission / missing source /
  out of memory) and keep the ffmpeg stderr tail behind "Details".
- **History**: the last ten exports per project, each with Reveal.

---

## 8. Validation performed

- `pnpm verify` on the branch (typecheck · lint · test:coverage across every package).
- **ai-sdk**: 3,784 tests. **engine**: 2,728 (and green under `-W error::ResourceWarning`).
  **desktop**, **web-editor**, **editor-core**, **timeline-schema**, **mcp-server**: green.
- Goldens regenerated after every prompt/tool change; the diff *is* the measured token
  delta. TS ↔ Python ↔ MCP parity is generated and drift-tested.
- Desktop e2e: smoke, UX walkthrough, resource baseline, AI journey (`MISSION_AI=1`), and
  the new UC-15 failure paths.
- Orchestration measured against real minutes-long camera media on the desktop host, not
  fixtures.

---

## 9. Remaining issues

These are genuinely unresolved and each names what would close it.

1. **Two scenarios have no after-numbers.** `refine-tighten` and `memory-captions` were
   not re-measured: the provider bridge 429s after roughly $4-8 of traffic, and two
   attempts hit that wall. `beat-sync` was recovered on the second attempt (0.22 → 0.78);
   `refine-tighten`'s first turn measured 0.63 with 22 operations before the wall. The
   exact command is in `01-after.md` and P1.6. **This still blocks P1.4's evidence**
   (refinement reuse is what `refine-tighten` measures).
2. **Export's real bottleneck is untouched.** P7.5 (dependency analysis, stream-copy
   passthrough, single final encode) is not started; the measurement that motivates it is.
   The progress-accuracy (< 5 %) and cancel-leaves-no-partial-file proofs are also pending.
3. **Repeated tool calls are still high** — 51 of 66 on the montage. Nothing in this work
   attacked repetition directly; the stage-scoped tool set and the action-log window are
   the levers, and both sit in Phase 5.
4. **Phase 5 specialisation (P5.1/P5.2) was deliberately not built.** The measurement did
   not justify new model workers, and the mission's own rule is that workers exist only
   where they earned it. Recorded as a decision, not an omission.
5. **P10.2 (a day of adversarial use) has not been performed.** It needs a human at the
   desktop app; every automated failure path that could stand in for it is in
   `failure-paths.spec.ts`.
6. **Open UX findings**: UX-08 (clip context menu breadth) and UX-14 (preview fit/crop
   indication) are triaged and unfixed; the cosmetic findings (UX-03/09/12/13/15) are
   explicitly deferred with reasons in P8.1.

Phase-by-phase task state, with the residual and its unblocking step on each, is in
`plan/system-mission/README.md`.
