# Intelligent Silence Handling — speech-aware detection & cut synthesis

> **Sub-plan of [`plan/PLAN.md`](./PLAN.md).**
> **Status:** `[ ]` proposed (2026-07-15) — audited against the code on branch `feat/project-brain-b0` (post Project Brain B0–B7, PR #90).
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
> **Last updated:** 2026-07-15

## 0. The problem (why naive silence removal breaks)

Every dB-threshold silence remover shares one failure mode: **quiet speech below
the configured noise floor is classified as silence and cut.** A whispered
aside, a soft-spoken sentence, a trailing "…and that's the point" delivered at
-38 dB against a -30 dB floor — all reported as `SilentRange`s and rippled out.
The user hears their own words deleted.

FramePilot's raw detector (`analysis/silence.py`) is exactly such a threshold
gate — ffmpeg `silencedetect`, RMS vs `noiseFloorDb` (default -30 dB). That is
the *correct* primitive (fast, deterministic, no ML dependency), but it must
never be the *sole* authority on what gets cut.

**The key insight this plan builds on:** the engine already has a second,
independent sensor that is immune to the decibel problem — the **word-level
transcript**. whisper.cpp transcribes quiet speech far below any sane silence
floor, and `audio/asr.py` produces real per-word timestamps (token-level DTW,
never interpolated). *If a word overlaps a "silent" range, that range is not
silence.* The transcript is ground truth for "someone is talking here",
independent of level. Loudness (EBU R128, unlocked as a first-class analyzer in
Brain B1) gives a third signal: the *measured* level of this footage, from
which a per-footage noise floor can be derived instead of guessing -30.

Intelligence = **cross-checking the three signals deterministically**, not an
ML VAD dependency (none is added by this plan).

---

## 1. Current state (audited 2026-07-15)

**What exists and is good:**

- Detector: `engine/python/framepilot_engine/analysis/silence.py` — pure
  parser + injectable runner, `noiseFloorDb`/`minSilenceSeconds` params,
  trailing-open-silence closure, negative-start clamp. Solid primitive.
- ASR: `engine/python/framepilot_engine/audio/asr.py` — real per-word
  timestamps, validated `TranscriptWord`s, content-hash cached.
- Transcript in the project doc: `Project.transcript` =
  `TranscriptWordSchema[]` (`packages/timeline-schema/src/index.ts:340,389`)
  — word/start/end, available to every recipe leaf via `ctx.project`.
- Loudness: `analysis/loudness.py` (B1) — `integratedLufs`, `loudnessRangeLu`,
  `truePeakDbfs`; persisted + cached in the brain keyed by
  `(content_sha256, kind, params_hash, analyzer_version)`.
- Agent-path guidance: `packages/ai-sdk/skills/silence-and-filler-cutting.md`
  already instructs the model to cross-reference `get_transcript`, cut at word
  boundaries with ~0.05–0.08 s padding, and keep intentional pauses.
- Brain warmup (B1.4): `brain-client.ts` warms the `AnalysisResultsBag` so
  silence + transcript + loudness are in context together at plan time.

**The gaps** (each with evidence):

| # | Gap | Evidence |
|---|---|---|
| SG1 | **The deterministic `remove_silence` recipe has no speech guard.** `synth_ripple_deletes` converts every detected range straight into `ripple_delete`s — zero transcript consultation. The exact naive-cutter failure mode ships on this path today. | `packages/ai-sdk/src/kernel/plan-compiler.ts:113`, `packages/ai-sdk/src/kernel/recipe-leaves.ts:159` |
| SG2 | **Time-base conflation.** `analyze_silence` measures the *asset's* audio (asset time); `synthRippleDeletes` uses the ranges as *timeline* coordinates unmapped (`recipe-leaves.ts:162-169`). Correct only for the accidental case (one clip, placed at 0, `in` = 0, speed 1). A trimmed or offset clip gets its cuts displaced. The project transcript is timeline-scoped (captions burn from it), so the guard also needs the mapping to compare like with like. | `recipe-leaves.ts:159-172` |
| SG3 | **Recipe threshold param is dropped on the floor.** The recipe passes `{ track, maxSilenceSeconds }` as the `analyze_silence` host-tool args, but the executor forwards only `noiseFloorDb`/`minSilenceSeconds` (`sidecar-executor.ts:77,123-125`) — so a user's "remove silences longer than 0.8s" runs detection at the 0.5 s default and *verifies* against a goal string nothing enforced. | `plan-compiler.ts:115,120`, `sidecar-executor.ts:77` |
| SG4 | **Fixed noise floor.** -30 dB regardless of footage. A hot-mic'd studio VO and a laptop-mic room recording get the same gate; the skill tells the *model* to retune, but the deterministic path and first-run agent path start blind — even though the brain now has measured LUFS for the asset. | `analysis/silence.py:34`, `analysis/loudness.py` |
| SG5 | **Verify can't see the damage.** The recipe's `verify` leaf runs the structural/`critique()` battery — nothing checks "did this patch delete spoken words?". A bad cut list validates and verifies green. | `recipe-leaves.ts:228-249`, `kernel/critic.ts` |
| SG6 | **Agent path is prompt-guarded only.** The skill says cross-check the transcript, but nothing *enforces* it; a model that skips `get_transcript` can still emit `ripple_delete`s over speech and pass validation. | `skills/silence-and-filler-cutting.md` (guidance, not invariant) |

**Design stance:** keep `silencedetect` as the sole level-sensor (no new
dependency, no ML VAD). Add the intelligence as **pure, deterministic,
100%-covered functions** at the two choke points every cut already flows
through — analysis annotation (engine) and patch synthesis/validation (TS
kernel) — so *both* the recipe path and the agent path are protected by
construction, not by prompt discipline. Honest-degradation discipline
throughout: no transcript ⇒ the guard reports itself skipped; it never fakes
a check it didn't run.

---

## 2. Architecture of the fix

```
                       ┌────────────────────────────────────────────┐
   asset audio ──────► │ silencedetect (RMS gate)   [existing]       │──► raw SilentRanges (asset time)
                       └────────────────────────────────────────────┘
   brain loudness ───► noise floor derivation (S3): floor = f(integratedLufs)   [engine, pure]
   ASR word cache ───► speech annotation (S4): per-range overlapsSpeech flags   [engine, pure]
                                        │
                                        ▼
                       ┌────────────────────────────────────────────┐
   Project.transcript ►│ SPEECH GUARD (S1, pure TS)                  │
   clip source in/out ►│  asset→timeline mapping (S2)                │──► guarded cut list
                       │  subtract padded word intervals             │
                       │  drop sub-min remnants                      │
                       └────────────────────────────────────────────┘
                                        │
                                        ▼
                          ripple_delete ops → assemble_patch
                                        │
                                        ▼
                       ┌────────────────────────────────────────────┐
                       │ speech_integrity critique check (S5)        │──► verify fails if any
                       │  (runs on recipe verify AND agent critique) │    word interval was deleted
                       └────────────────────────────────────────────┘
```

Two independent layers on purpose (defense in depth):

1. **The guard (S1/S2)** makes the *deterministic* path safe and gives the
   agent path a safe primitive.
2. **The critique check (S5)** catches *any* producer of a bad cut list —
   including a model that hand-rolls `ripple_delete`s and never called
   `analyze_silence` at all (closes SG6 as an enforced invariant, not prose).

---

## 3. Phases

### S1 — Speech-guard core (pure TS, the deterministic heart) `[ ]`

New module `packages/ai-sdk/src/kernel/speech-guard.ts` (pure functions, no
I/O, 100% coverage — this is a "core deterministic module" under AGENTS.md).

- [ ] **S1.1** `guardSpansAgainstWords(spans, words, opts): GuardedSpans`
  — subtract padded word intervals from candidate silent spans:
  - Each word `[start, end)` is inflated by `paddingSeconds` (default
    **0.06 s**, the skill's 0.05–0.08 s made a named constant) on both sides —
    cutting flush to a word clips consonants.
  - A span fully inside a padded word ⇒ dropped. A span overlapping a word's
    edge ⇒ trimmed. A span containing a word ⇒ **split** around it.
  - Remnants shorter than `minRemnantSeconds` (default = the detection
    `minSilenceSeconds`) are dropped — a 0.1 s sliver between two words is an
    inter-word gap, not dead air; cutting it reads as a glitch (the skill's
    §4/§5 rules, made deterministic).
  - Returns `{ spans, report }` where `report` is typed and honest:
    `{ checked: true, input: n, kept, trimmed, split, dropped }` **or**
    `{ checked: false, reason: 'no-transcript' }`. The report is never
    inferred — `checked: false` whenever `words` is empty/absent.
- [ ] **S1.2** Property-based edge coverage (table-driven, no fuzz dep):
  word straddling a span boundary; word exactly at span edge ± padding;
  adjacent words whose padded intervals merge; span identical to a padded
  word; zero-length degenerate inputs; unsorted input words (must not assume
  ASR ordering); overlapping words (ASR repair artifacts).
- [ ] **S1.3** Export from `kernel/index.ts`; JSDoc states the invariant in
  one sentence: *"No span returned by the guard overlaps any padded
  transcript word."* — the sentence S5's test enforces end-to-end.

**Gate:** `pnpm --filter @framepilot/ai-sdk test` green; new module at 100%
statements/branches; `pnpm typecheck && pnpm lint`.

**Failure-direction note (why this is safe to ship first):** whisper
hallucinations (phantom "thank you" in noise) make the guard *keep* a gap it
could have cut — under-cutting, the recoverable direction. The dangerous
direction (cutting real speech) requires a *missing* word, which is exactly
the case today's behavior already has; the guard is strictly no-worse.

### S2 — Correct time bases + wire the guard into `remove_silence` `[ ]`

- [ ] **S2.1** `mapAssetSpansToTimeline(spans, clips): TimelineSpan[]` (pure,
  same module or `editor-core` if clip math already lives there — decide at
  implementation against `editor-core`'s existing source-time helpers; do not
  duplicate one if it exists): for each clip on the target track referencing
  the analyzed asset, intersect each asset-time span with the clip's source
  window (`in`/`out`) and translate by the clip's timeline offset (respecting
  `speed` if the clip schema carries it — audit while implementing). Spans
  falling outside every clip's source window are discarded — silence in
  footage that isn't on the timeline is not a cut. Fixes SG2.
- [ ] **S2.2** Wire into `synthRippleDeletes` (`recipe-leaves.ts:159`):
  detected ranges → `mapAssetSpansToTimeline` → `guardSpansAgainstWords`
  (against `ctx.project.transcript`, which is timeline-scoped) → existing
  latest-first sort → ops. The leaf's `summary` reports the guard honestly:
  `"Synthesized 12 ripple deletes (speech guard: 3 trimmed, 1 split, 2
  dropped)"` or `"… (speech guard skipped: no transcript)"` — the user sees
  which regime they got, per the honesty discipline.
- [ ] **S2.3** Fix SG3: the recipe's `maxSilenceSeconds` must actually reach
  detection — map it to the tool's `minSilenceSeconds` in the recipe args
  (`plan-compiler.ts:120`), and add the executor-side forward if the arg name
  audit shows it silently dropped (write the failing test first — the test
  that would have caught SG3: recipe with `maxSilenceSeconds: 0.8` ⇒ the
  sidecar body carries `min_silence_seconds: 0.8`).
- [ ] **S2.4** Behavior tests: offset/trimmed clip gets correctly displaced
  cuts; quiet-word-inside-silence fixture produces a split, not a deletion of
  the word; no-transcript project behaves exactly as today **plus** the
  skipped-guard summary.

**Gate:** ai-sdk suite green incl. new tests; `plan-driver`/recipe golden
snapshots updated deliberately (not blindly); `pnpm verify`.

### S3 — Adaptive noise floor from measured loudness (engine) `[ ]`

- [ ] **S3.1** Pure derivation in `analysis/silence.py`:
  `derive_noise_floor(loudness: LoudnessAnalysis) -> float` — floor =
  `clamp(integratedLufs - SPEECH_TO_FLOOR_DROP_DB, MIN_FLOOR_DB, MAX_FLOOR_DB)`
  with named constants (starting values: drop **18 dB** below integrated
  programme loudness, clamped to **[-60, -25] dB**; calibrate against real
  desktop-scale fixtures in S3.4 before freezing — the constants are the
  tunable, the shape is the decision). WHY: R128 integrated loudness tracks
  the *speech* level of the footage, so "floor = speech − drop" adapts to the
  room instead of assuming -30 fits every mic.
- [ ] **S3.2** `POST /analyze` silence analyzer accepts
  `noise_floor_db: float | "auto"`. `"auto"` resolves via the asset's cached
  brain loudness row (running loudness first if absent — it's cached, so this
  is one-time per content hash); **the brain cache key's `params_hash` must
  hash the *resolved* numeric floor**, never the string `"auto"` — otherwise
  two different footages' auto-runs would collide or a retune would false-hit.
  No loudness available (no audio decoded) ⇒ honest fallback to the -30
  default **and** the response says so
  (`"noiseFloorDb": {"value": -30.0, "source": "default-no-loudness"}` vs
  `"source": "auto-r128"` / `"source": "explicit"`).
- [ ] **S3.3** TS surface: `analyze_silence` registry schema (TS Zod +
  Python Pydantic mirror + MCP, all three in lockstep — B7's parity guards
  will catch a miss) accepts `noiseFloorDb: number | 'auto'`; the
  `remove_silence` recipe passes `'auto'` by default.
- [ ] **S3.4** Golden test against real ffmpeg fixtures (existing golden
  harness): a quiet-speech fixture where the -30 default mislabels speech as
  silence and the derived floor does not — this fixture **is** the user
  story; calibrate S3.1's constants against it and at least one desktop-scale
  real-camera file (CLAUDE.md: reproduce against desktop-scale media).

**Gate:** `pnpm engine:test`, `engine:lint`, `engine:typecheck` green;
100% on touched analysis modules; golden updated with WHY note.

### S4 — Engine-side speech annotation (belt-and-braces, feeds every client) `[ ]`

The S1 guard lives in the TS kernel; MCP clients and the raw tool surface
also deserve a warning. Cheap because both inputs are already brain-cached.

- [ ] **S4.1** Silence analyzer (unified `/analyze` route) cross-references
  the asset's cached ASR words (asset-time — same time base, no mapping
  needed here) and annotates each returned range:
  `overlapsSpeech: bool`, `speechChecked: bool` (false + absent flags when no
  transcript is cached — honest, not fabricated). Persisted with the result;
  provenance `machine`.
- [ ] **S4.2** Tool description updates (registry TS + Python + MCP): state
  that ranges may carry `overlapsSpeech: true` and such ranges must not be
  cut without listening/looking. Prompt-surface change ⇒ keep it one
  sentence (token budget, lead-prompt-engineer conventions).
- [ ] **S4.3** Tests: annotation correctness incl. the boundary cases from
  S1.2 mirrored in Python (keep the two implementations' semantics aligned —
  add a small shared JSON fixture both suites consume, like the existing
  TS↔Python parity tests).

**Gate:** engine suite green; parity fixture consumed by both suites.

### S5 — `speech_integrity` critique check (the enforced invariant) `[ ]`

- [ ] **S5.1** New deterministic check in `kernel/critic.ts` battery:
  given the working (post-patch) project, every `Project.transcript` word
  interval must still be covered by remaining timeline content on the track
  that carries the dialogue. A word whose interval was fully removed by
  `ripple_delete`/`delete_range` ops in this patch ⇒ **fail** with the word
  and timestamp named (`Cut deleted spoken words: "actually" at 12.4s`).
  Words removed alongside an *intentional* clip removal (the user asked to
  cut a section) must not false-positive — scope the check to patches whose
  ops came from silence-removal intent (the recipe's verify args carry the
  goal; the agent path's critique gets a `checkSpeechIntegrity` option the
  orchestrator sets when the turn's tool calls included silence analysis or
  the router matched a silence intent). Precision rule: **the check must
  never fire on a patch that contains no delete ops.**
- [ ] **S5.2** Wire into both verify tiers: the recipe `verify` leaf
  (`recipe-leaves.ts:228`) and the orchestrator's per-turn `critique()` call
  — same function, one policy (the codebase's one-policy invariant).
- [ ] **S5.3** Tests: a hand-built bad patch that deletes a word fails with
  the named word; the same patch on a transcript-less project yields
  `skipped` (honest), never `ok`; a user-intent section cut does not trip it.

**Gate:** ai-sdk suite green; critic module coverage stays 100%.

### S6 — Surfaces, docs, plan hygiene `[ ]`

- [ ] **S6.1** Skill update (`skills/silence-and-filler-cutting.md` + its
  generated Python mirror): §1 gains "start with `noiseFloorDb: 'auto'`";
  note that `analyze_silence` ranges carry `overlapsSpeech` and that the
  deterministic guard/critique will reject word-deleting cuts (the skill
  stops being the only line of defense and says so).
- [ ] **S6.2** Docs: `docs/guides/silence-handling.md` (detection → guard →
  verify flow, the three signals, honest-degradation matrix: with/without
  transcript × with/without loudness); ADR
  `docs/adr/00xx-speech-aware-silence-guard.md` (why transcript-as-ground-
  truth + deterministic guard beats an ML VAD dependency; why the guard is
  TS-side but annotation is engine-side); `CHANGELOG.md` entry
  (user-facing: "silence removal no longer cuts quiet speech").
- [ ] **S6.3** `plan/PLAN.md`: check off the linked entry; record discovered
  tasks (candidates already visible: the `speed`-aware source-time mapping if
  the clip schema carries speed at S2.1; per-utterance vs per-word brain FTS
  granularity if S4 wants utterance fallback).
- [ ] **S6.4** e2e: extend the existing agent-flow e2e with a
  remove-silence-over-quiet-speech scenario **if** the sidecar-booting
  harness from B7.4 has landed; otherwise cover at integration level and
  note it here (same honest deferral B7.4 recorded — do not fake an e2e).

**Gate:** `pnpm verify` green from cold; docs build; CHANGELOG entry present.

---

## 4. What this plan deliberately does NOT do (non-goals)

1. **No ML VAD / no new dependency** (webrtcvad, silero, etc.). The
   transcript already *is* a speech detector of higher quality than any
   lightweight VAD, it's already cached per content hash, and CLAUDE.md §5
   gates new deps behind ASK. If a future case demands VAD-without-ASR,
   that's its own ASK-gated plan.
2. **No aesthetic pause judgment in the deterministic path.** "Keep the
   dramatic pause before the punchline" is editorial, stays model-side (the
   skill's §2). The guard's job is only *never cut words*; the S1 API takes
   an optional `protectedRanges` param so the agent path can pass
   model-chosen keeps through the same pure function, but nothing synthesizes
   them deterministically.
3. **No schema change.** `TranscriptWord`, `SilentRange`, the project doc —
   all untouched. New fields ride on analysis *responses* and brain rows
   (derived, rebuildable), so no migration. If implementation discovers a
   schema need, stop and ASK (CLAUDE.md §5).
4. **No always-on auto-removal.** Detection+guard only produce a *patch*;
   preview-first review and undo stay exactly as they are.

## 5. Risks & mitigations

| Risk | Direction | Mitigation |
|---|---|---|
| Whisper hallucinated words protect fake speech | Under-cut (safe) | Acceptable; S1 report makes it visible; user can rerun with `speechGuard: false` escape hatch (S2.2 arg, default on) |
| Whisper *missed* a real quiet word | Over-cut (today's status quo) | S3's adaptive floor makes the *detector* less likely to flag quiet speech at all; S4 annotation gives the model a second look; strictly no-worse than current behavior |
| Transcript stale after earlier edits this session | Guard uses wrong times | Transcript is timeline-scoped and patched alongside edits (caption flow already depends on this); S2.4 adds a regression test; if audit finds a desync path, record it in PLAN.md as its own task — do not paper over |
| Auto floor wrong on music-bed footage (music ≫ room tone) | Under-cut (safe) | R128 integrated tracks the mix, floor lands high, fewer ranges — safe direction; skill §1 already covers manual retune |
| Golden churn from `params_hash` now hashing resolved floor | CI noise | S3.2 hashes resolved params by design; goldens updated once, with WHY note (ci-stricter-than-local: run coverage on touched packages before push) |

## 6. Definition of Done (whole plan)

- The quiet-speech fixture (S3.4) survives `remove_silence` end-to-end on the
  **deterministic** path with zero words deleted — the user story, as a test.
- A hand-built word-deleting patch is rejected by verify on **both** paths.
- No transcript ⇒ behavior identical to today plus honest "guard skipped"
  reporting at every surface (leaf summary, analysis response, critique
  `skipped`).
- 100% coverage on `speech-guard.ts`, touched critic/recipe-leaf branches,
  and touched Python analysis modules; `pnpm verify` + engine suites green;
  ADR + guide + CHANGELOG shipped; PLAN.md reconciled.
