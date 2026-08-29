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
| 11 | **A 4K export spent 69 % of its wall time in one line** | The decode cap sized to the frame's longest edge, so a landscape 4K source was decoded at 2400 px and then shrunk to its real displayed size (1080×608) by PIL, per frame. `fitted_decode_size` asks ffmpeg for the displayed size directly | **48.2 s → 11.5 s**, `07-after.md` |
| 12 | A `delete_clip` could leave an undeletable sub-frame husk | Frame-grid quantisation rounds to *nearest*, so a clip whose end sat off-grid had its delete range rounded back inside itself — the clip survived 8 ms wide, the card reported success, and the retry hit "end must be greater than start". **29 of 48 failed delete calls carry exactly that message** | `delete-clip-grid.test.ts` |
| 13 | An engine that stopped answering was never noticed | The manager watched its direct child, but `uv run framepilot serve` makes the server a **grandchild** — kill it and the wrapper lives on, no exit event, `ready` forever. Six green unit tests; the e2e found it | liveness probe, 4 tests |
| 14 | Four context chips had a remove button that removed nothing | Timeline/Project/Transcript/Assets are always in the snapshot; the control implied otherwise | `ContextItem.removable` |
| 15 | The "Show details" disclosure on a failed run was never fed | Both catch blocks put the raw provider body in the headline instead | `ai/runFailure.ts` |
| 16 | Preview dispose leaked a detached canvas and decoded images | `dispose()` was documented as clearing its image map and did not | `8ff1f8a` |

---

## 3. Orchestration: before → after

`mission-baseline.mjs --runs 3`, real desktop sidecar, real media, p50, scored by
`eval/mission-rubric.ts`. Full table and caveats: `docs/reports/system-mission/01-after.md`.

| scenario | model calls | prompt tokens | cache | ops | rubric |
| --- | --- | --- | --- | --- | --- |
| podcast-highlight-60s | **25 → 5** | **804k → 173k** | 0.99 → 1.00 | 1 → 1 | 1.00 → 1.00 (1200s → 253s, $1.54 → $0.32) |
| montage-30s | 10 → 31 | 332k → 963k | 0.99 → 0.99 | **0 → 35** | **0.25 → 1.00** |
| beat-sync | 1 → 18 | 0 → 497k | — → 0.98 | **0 → 34** | **0.22 → 0.78** |
| remove-dead-air | 1 → 6 | 0 → 109k | — → 0.95 | **0 → 54** | **0.25 → 0.75** |
| refine-tighten t1 / t2 | 1 → 18 / 12 | 0 → 516k / 321k | — → 0.98 | **0 → 18 / 4** | **0.25 → 0.63** / **0.50 → 0.88** |
| memory-captions t1 / t2 / t3 | 1 → 10 / 61 / 2 | 0 → 289k / 1.91M / 0 | — → 0.87 | **0 → 7 / 83 / 0** | **0.38 → 0.63** / **0.29 → 0.71** / 0.29 → 0.43 |

**All six scenarios improved. Seven of nine turns went from zero operations to a real
edit.** Prompt-cache share held throughout (0.87–1.00) — none of this was bought by giving
up cache. Coverage is uneven and `01-after.md` states it per row: four scenarios have three
runs, remove-dead-air two, memory-captions one.

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
- **Measured, and then fixed**: hardware encode cut ffmpeg CPU **146 % → 48 %** and moved
  wall time 94.2 s → 92.6 s — which *disproved* the encoder as the bottleneck. Profiling
  found 69 % of the export inside one line (`PIL ImagingCore.resize`, 901 calls at 37 ms).
  Decoding straight to the displayed size took the same export **48.2 s → 11.5 s, 4.2×**.
  The 360p fixture is unchanged at 3.7 s — correctly, since there is nothing to downscale.
- **Progress accuracy**: max error 5.9 pp → **4.8 pp** (budget 5), by reporting preparation
  as work rather than a flat 0.05 for 13 % of the run.
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

**52 of 69 plan tasks are `[x]`, 16 are `[~]`, 1 is `[!]`, none unstarted.** Each remainder
below names what would close it.

1. **Nothing has been run green against a real provider end to end.** `ai-journey.spec.ts`
   (UC-01 → 08 → 09 → 06 → 07 → preview → 13) and four `failure-paths` rows are written and
   wired into the nightly lane; they need a billed key. A spec that compiles is not
   evidence, and P9.1 / P9.2 / P3.7 stay `[~]` for exactly that reason.
2. **The app does not yet recover from a killed engine.** The liveness probe is in and
   unit-tested, and it fixed the diagnosis — but the e2e row moved from failing fast to
   timing out rather than passing. Two candidates are recorded in P5.5; claiming it on the
   unit tests would repeat the mistake the e2e already caught once.
3. **P6.1's aggregate evidence.** Every renderer primitive is proven to release in
   isolation; "counters flat across open → edit → close ×3" needs the desktop harness. The
   unit tests do not prove the aggregate and the plan says so.
4. **No 4K 20-minute fixture exists** (UC-16), so that row skips with its measured reason
   rather than passing on a stand-in.
5. **The export matrix has no Linux runner** — the fixtures are uncommitted camera files,
   so it runs only where the media lives.
6. **P10.2 — a day of adversarial hands-on use** cannot be automated. What could be is:
   eight `failure-paths` rows run anywhere.
7. **Deliberate non-goals, recorded as decisions rather than gaps**: no new model workers
   (the ledger rejected two of three candidates and the third was already shipped); the
   `main.ts` split (127 KB, "no behaviour change", three workstreams editing concurrently);
   "disable clip" (needs a schema migration, which CLAUDE.md §5 says to raise, not slip
   into a menu task).

## 10. What this work actually changed

The single most useful result is not a speed-up. It is that **three separate subsystems
were reporting success while doing nothing**, and each was found by measuring rather than
reading:

- agent runs that truncated at 8,192 tokens and retried into the same wall — two of three
  scenarios landing **zero** operations;
- an export spending 69 % of its time discarding pixels it had just decoded;
- an IPC channel declared in three places and handled in none.

Each of those looked healthy from the inside. The mission's habit — measure, then fix the
cause, then measure again — is what turned them up, and the same habit is why two of the
numbers in this report are corrections of earlier numbers in this report.
