# TESTING_PLAN.md — PR #82, "Visual understanding: the agent knows the footage, the edit, and the screen"

> Scope: everything on `plan/visual-understanding` that is not already on `main`.
> 235 files, +66 321 / −1 462, ten phases (VU0–VU9), two new ADRs
> ([0175](docs/adr/0175-perception-is-a-compiled-shot-ledger.md),
> [0176](docs/adr/0176-local-perception-ships-as-packs.md)).
>
> This is a **PR-scoped** companion to [`MANUAL_TESTING.md`](MANUAL_TESTING.md), not a
> replacement. Where a section here says "then run §17", it means that file's §17.

---

## How to read this file

Rows use the same shape as `MANUAL_TESTING.md`:

```
- [ ] **T-id. Name** — `trigger` · `surface`
  - Do: exact steps
  - Expect: what you should observe
  - Fail if: the concrete failure signal
  - Result: __/__/____ · PASS / FAIL · notes:
```

`UI` = an explicit control exists · `AI` = only reachable by asking in natural
language · `UI+AI` = both, and they are different code paths.
`desktop` = needs Electron and/or the Python sidecar · `browser` = works in a plain
web-editor dev build too.

**Priority tags** on each part:

| Tag | Meaning |
| --- | --- |
| **P0** | The PR's central claim. If this is wrong, do not merge. |
| **P1** | A named bug fix or a behaviour change a user will hit on day one. |
| **P2** | Degradation, scale, and "should still work" regression cover. |
| **P3** | Structure-only; cannot be verified today. Confirm it is *inert*, not that it works. |

**One thing that changes how you read every row below.** Perception is compiled **once
per asset at import**, keyed by content hash and tier version. A stale ledger explains
almost every "it didn't work" you will hit. When something looks wrong, first check
Settings → AI → Media intelligence for the coverage line before assuming a code defect.

---

## Part 0 — Setup (do this once, then again per key state)

Everything in `MANUAL_TESTING.md` §1 (S1–S8) still applies. These are the deltas.

- [ ] **T0.1. Build from this branch, clean** — `desktop`
  - Do: `git checkout plan/visual-understanding && pnpm install && pnpm engine:sync`
  - Do: rebuild ai-sdk explicitly — `pnpm --filter @framepilot/ai-sdk build`. The desktop
    app and web-editor consume ai-sdk from its **built `dist`**; every solver, tool spec
    and context change in this PR lives there. Skipping this tests `main`'s ai-sdk against
    this branch's engine and produces confusing, wrong results.
  - Do: `pnpm desktop:dev`
  - Expect: app launches, AI rail engine chip reads reachable.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T0.2. Refresh `.env` against the new `.env.example`** — `desktop`
  - Do: diff your `.env` against `.env.example`. Two vars are new:
    `FRAMEPILOT_PACK_VISUAL_EMBED` and `FRAMEPILOT_PACK_VISUAL_DESCRIBE` (both JSON pack
    handles, both **empty by default** — leave them empty unless you are on Part 12).
  - Do: confirm both also appear in `turbo.json` `globalEnv` (repo rule: one source of truth).
  - Expect: no var is in one file and missing from the other.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T0.3. The three key states — you must test all three** — `desktop`
  - This PR's whole point is that tier 0 needs no key. A single-key test run proves nothing.
    Plan for three passes over Parts 2–7:
    | State | Config | What it proves |
    | --- | --- | --- |
    | **A — keyless** | no TwelveLabs, no NVIDIA, no vision-capable caption provider | Tier 0 floor works with nothing configured. **Do this pass first.** |
    | **B — embedding key** | `TWELVELABS_API_KEY` *or* `FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS` | `labelled` tier fills, search works |
    | **C — vision provider** | B, plus a multimodal provider selected as the caption provider in Settings → AI | `described` tier fills, structured captions |
  - Fail if: any pass requires a key the table does not list.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T0.4. Media set** — `desktop`
  - `MANUAL_TESTING.md` S7 plus **two additions this PR requires**:
    5. **At least 10 stills** (JPEG/PNG/HEIC). One of the four named bugs was that *every*
       still was silently unmeasured. One photo is not enough — sweep a directory.
    6. **Two clips shot under visibly different light** (one warm/indoor, one cool/outdoor,
       or one under- and one correctly exposed). Part 5 has nothing to solve without them.
  - Repo rule (`CLAUDE.md`): real camera files, minutes long. Tiny fixtures cannot support
    the 29.4× throughput claim or the 6.3 MB/10 h size claim.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T0.5. Start from a project that has never been indexed** — `desktop`
  - Do: create a fresh project (not a copy of one from `main`) so brain migration v4 runs
    on an empty file first. Keep a **copy of an old `main`-era project** aside for T11.1.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 1 — Automated gates: what to trust, what to re-run · **P0**

CI on the PR head is **green except CodeQL and Vercel** (see Part 16). That covers a lot;
do not repeat it by hand.

| Check | Status | Covers |
| --- | --- | --- |
| TS typecheck · lint · unit · coverage | pass | all ai-sdk / editor-core / web-editor units |
| Python typecheck · lint · tests · render fixture | pass | shot ledger, brain, governor, packs |
| E2E smoke · E2E visual regression | pass | settings panel, AI sidebar screenshot |
| Golden gate | pass | rubric, efficiency, **`framesSeenPerEdit` ceiling** |
| Professional operations · 33 rendered proofs | pass | render-backed op correctness |
| Build desktop · License scan · Dependency review | pass | packaging, new worker deps |
| **CodeQL** | **fail — 42 alerts** | see T16.1 |
| **Vercel** | **fail — deployment blocked** | see T16.2 |

- [ ] **T1.1. Re-run only the suites you are about to poke at** — `local`
  - Per repo memory, do **not** run the full suites locally; CI already did. Targeted:
    - Shot ledger + tier 0: `cd engine/python && uv run pytest tests/test_shot_stats.py tests/test_shot_stats_accuracy.py tests/test_brain_ledger.py tests/test_service_shot_ledger.py`
    - Governor / scheduling: `uv run pytest tests/test_index_governor.py`
    - Solvers: `pnpm --filter @framepilot/editor-core exec vitest run src/color-solver.test.ts src/transition-policy.test.ts`
    - Solved-colour tools + transitions: `pnpm --filter @framepilot/ai-sdk exec vitest run src/domain-tools/solved-color.test.ts src/domain-tools/transition-planning.test.ts src/domain-tools/picture-facts.test.ts`
    - Verification: `pnpm --filter @framepilot/ai-sdk exec vitest run src/kernel/picture-verification.test.ts`
    - TS↔Python ledger parity: `uv run pytest tests/test_ledger_ts_parity.py`
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T1.2. Confirm the ceiling gate actually trips** — `local`
  - Why: `framesSeenPerEdit` is the only metric in the golden gate that is a **maximum**.
    Every other one is a minimum. A gate that silently never fires protects nothing, and
    this one is the guard on the PR's central claim (perception without pixels-per-decision).
  - Do: read `packages/ai-sdk/scripts/golden-gate.mjs:277` and confirm the comparison
    direction. Then run `pnpm eval:golden:gate` against the recorded reports.
  - Do: manually verify the PR's "proven to trip at 0.00 → 1.40" claim by hand-editing a
    copy of a `reports/golden/*/summary.json` to raise the value and re-running the gate.
  - Expect: gate **fails** on the raised value.
  - Fail if: raising frames-per-edit passes the gate. That would make the whole measurement
    decorative.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T1.3. Do NOT run the live golden harness casually** — `note`
  - It costs provider money and hours. Read the recorded runs instead:
    `reports/golden/s9-live-all/summary.md`, `s9-live-all-planfirst-2/summary.md`,
    `s9-baseline-replay/summary.md`. Reserve a live run for T16.3.
  - Result: __/__/____ · N/A

---

## Part 2 — Tier 0: the keyless floor · **P0**

The single most important part of this PR. Run it in **key state A** (nothing configured).

- [ ] **T2.1. Import measures footage with no key, no setting, no toggle** — `UI` · `desktop`
  - Do: fresh project, key state A. Import the full media set from T0.4 via the Assets rail.
  - Do: open Settings (⌘,) → AI → **Media intelligence**.
  - Expect: a coverage line of the shape
    `measured 61/61 · labelled 0/61 · described 0/61 — labelled needs an embedding key · described needs a vision provider`.
    Counts are **shots**, not assets, so the total will exceed your asset count.
  - Expect: `measured` climbs on its own. You did nothing to start it.
  - Fail if: nothing is measured; or the panel shows the old single "N/M assets prepared"
    line (that string only survives against a pre-ledger sidecar); or a key is demanded.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T2.2. The "Automatic preparation" toggle is gone** — `UI` · `desktop`
  - Do: read the whole Media intelligence panel.
  - Expect: no auto-index on/off control anywhere. `embeddingsAutoIndex` was deleted from
    the IPC config (`packages/shared-types/src/ipc.ts`), not defaulted.
  - Fail if: a dead toggle remains, or toggling anything is required to get T2.1.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T2.3. Stills are measured like video** — `UI` · `desktop` · *named bug #1*
  - Do: import **all** the stills from T0.4 at once — do not spot-check one.
  - Expect: the `measured` count rises by the still count. Every photo contributes a shot row.
  - Fail if: any still is silently skipped. The original defect was that the split
    filtergraph's second output never receives a frame from an image input, and it was
    invisible until the whole directory was swept — one sampled photo hid it for months.
  - Extra: include at least one **HEIC** and one **MJPEG-container photo**. Per repo memory,
    mjpeg photos report a bogus ~0.04 s duration; classification must go by `format_name`.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T2.4. Throughput on real footage** — `desktop`
  - Do: time a measure pass over ≥20 minutes of real camera footage (wall clock, from
    import to `measured` complete).
  - Expect: on the order of the claimed **29.4× real-time**. 20 min of footage ⇒ well under
    a minute of measuring on comparable hardware.
  - Fail if: measurement is slower than ~5× real-time. That breaks the "a 10-hour library
    in ~20 minutes" premise the whole design rests on.
  - Record: your machine, core count, footage codec/resolution, and the measured ratio.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T2.5. Ledger size on disk** — `desktop`
  - Do: after T2.4, find the project brain SQLite file and check its growth against the
    shot-row count.
  - Expect: ≈ **643 B per row**; 10 hours of footage ≈ 6.3 MB. No eviction should be needed.
  - Fail if: it is an order of magnitude larger. That reopens a design question this PR
    closed ("no eviction needed").
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T2.6. Downscale does not change the measurement** — `local`
  - Why: tier 0 measures at `scale=160:-2`. The claim is that means and percentiles are
    scale-invariant to within one 8-bit level (YAVG 74.0424 vs 74.0471).
  - Do: `cd engine/python && uv run pytest tests/test_shot_stats_accuracy.py -v`
  - Expect: passes against full-resolution statistics, not against a hardcoded expectation.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T2.7. Re-import the same file — no re-measure** — `UI` · `desktop`
  - Do: import a clip already measured, under a different filename.
  - Expect: no new measurement work. Keying is by **content hash + tier version**.
  - Fail if: identical content is measured twice. At library scale that is the difference
    between 20 minutes and an afternoon.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 3 — The Settings coverage line · **P1**

- [ ] **T3.1. Three counts, never one** — `UI` · `desktop`
  - Do: cycle key states A → B → C, re-checking the panel each time.
  - Expect: A → `labelled 0` and `described 0`, each with its own "needs …" clause.
    B → `labelled` fills, `described` still 0 with its clause. C → both fill.
  - Fail if: the three tiers are ever collapsed into one "indexed" number. That misreport —
    a keyless project reading as prepared, and a fully measured one reading as not indexed —
    is precisely what this rewrite exists to stop.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T3.2. "0 described" vs "0 because nothing can describe"** — `UI` · `desktop`
  - Do: in key state C, deliberately pick a caption provider that is configured but **not
    ready** (no key saved).
  - Expect: the "described needs a vision provider" clause appears. Readiness is read from
    the host's own config, never inferred from a zero count.
  - Fail if: a bare `described 0/61` with no explanation.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T3.3. Running beats completed** — `UI` · `desktop`
  - Do: watch the panel during a large import.
  - Expect: while a job is running you see `measuring footage (n/m)` — not "embedding
    frames", which would be a lie about local ffmpeg work. A green "completed" must **never**
    sit above a moving progress bar.
  - Fail if: completed tone while `lastJob.state === 'running'`.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T3.4. Failure and stall recovery copy** — `UI` · `desktop`
  - Do: kill the sidecar mid-index. Then restart it.
  - Expect: failed/interrupted tone with an actionable recovery line; a stall is called out
    after ~5 minutes of no progress.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 4 — Clip rows carry words · **P0**

This is the mechanism that makes the agent able to see *without spending a frame*.

- [ ] **T4.1. A clip row reads as a sentence** — `AI` · `desktop`
  - Do: in a measured project, ask the AI something that makes it read the timeline
    ("what have I got on the timeline?").
  - Expect: the timeline slice it reads carries words, of the documented shape
    `c12[61–66.4s] · MS man at desk · static · bright warm` — not geometry alone.
  - How to see it: the AI rail's tool cards, or dump the prompt (see the dump-prompts
    pattern in the session-9 notes) to inspect the actual context block.
  - Fail if: rows are still clip id + in/out only. Then nothing downstream can work.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T4.2. Cost of the words: unindexed project pays nothing** — `local`
  - Do: `pnpm --filter @framepilot/ai-sdk exec vitest run src/prompts.test.ts src/context-builder.test.ts`
    and check the token goldens.
  - Expect: **0 extra tokens** on a project with no ledger — goldens pass unregenerated.
    The core tool surface grows by **+139 tokens/request** (7342 → 7481) and no more.
  - Fail if: a project with no perception data pays for perception. That would tax every
    user for a feature they are not using.
  - Note: per repo memory, skill/descriptor edits shift ai-sdk token goldens and **the diff
    IS the measured token delta**. If goldens moved, read the number before regenerating.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T4.3. The agent stops reading the spreadsheet** — `AI` · `desktop`
  - Do: run two or three edit requests that previously needed footage knowledge
    ("drop the duplicate takes", "which of these is the wide shot?").
  - Expect: it answers from words it already has. `get_frame` call count stays at or near
    **0**, which is the whole point — the fix is *not* "look more".
  - Fail if: `framesSeenPerEdit` climbs. Read the ceiling rationale in T1.2.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T4.4. Memoization per revision** — `desktop`
  - Do: ask several questions in a row without editing.
  - Expect: the projection is computed once per timeline revision, not per turn.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 5 — Solved colour · **P0**

Three new AI tools: `match_color`, `normalize_exposure`, `apply_look`
(`packages/ai-sdk/src/domain-tools/solved-color.ts`, solver in
`packages/editor-core/src/color-solver.ts`). All are **AI-only** — no UI exists.

- [ ] **T5.1. `match_color` — "match the third clip to the first"** — `AI` · `desktop`
  - Setup: the two visibly different-light clips from T0.4, both measured.
  - Do: ask "match the third clip to the first".
  - Expect: a grade lands. **You never supply a number** — every parameter is solved from
    what the two shots measure. Each target gets its own correction on the same canonical
    grade layer. Undo (⌘Z) takes it back in one step.
  - Fail if: the model invents parameter values, or you are asked for any.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T5.2. `match_color` honesty — unmeasured and unreachable targets** — `AI` · `desktop`
  - Do (a): include a clip that has **not** been measured (import it with the sidecar down).
    Expect: it is **left alone and named**, not graded on a guess.
  - Do (b): pick two clips so far apart that the parameter ranges cannot close the gap
    (heavily crushed vs blown out).
    Expect: reported as **partial**, with the reason — not as done.
  - Fail if: either case reports success. "Reported success on a grade it could not reach"
    is the exact failure mode this design was built against.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T5.3. `normalize_exposure` grades only what is off** — `AI` · `desktop`
  - Setup: one track, ≥6 clips, of which exactly 3 are visibly dark.
  - Do: "even out the exposure on this track".
  - Expect: **3 corrections, not 6.** Only shots more than a third of a stop from the anchor
    are touched. Default anchor is the track's own `median`; a clip id can be named instead.
  - Fail if: every clip gets an operation. That is the "one op per clip" smell the tool
    description explicitly rules out, and it makes undo and review unusable.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T5.4. `apply_look` is scale-free** — `AI` · `desktop`
  - Do: ask "make it a bit warmer" (`subtle`) on a **dark** clip and on a **bright** clip.
  - Expect: both move by the same amount **in measured units**, not in parameter units —
    i.e. the perceived shift is comparable. Looks available: warmer, cooler, punchier,
    flatter, brighter, darker, cinematic, clean; amounts: subtle / medium / strong.
  - Expect: naming a `trackId` grades the whole layer; `clipIds` grades named shots.
  - Fail if: "a bit warmer" is dramatic on one and invisible on the other.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T5.5. `apply_color_grade` still exists for explicit numbers** — `AI` · `desktop`
  - Do: "set the temperature on clip 2 to +15".
  - Expect: the old direct tool is used when the editor names a number; the solvers are
    preferred otherwise.
  - Fail if: the direct path was removed, or the solver hijacks an explicit number.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T5.6. Colour tool cards render** — `UI` · `desktop`
  - Expect: cards read "Match color to a reference", "Even out exposure", "Apply a look",
    each with the Palette icon (`toolMeta.ts`). No raw tool names in the UI.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T5.7. Known gap — the coefficients are unfitted** — `P3` · `note`
  - The colour model in `color-solver.ts` was **derived from the renderer's source, not
    measured**. `packages/ai-sdk/scripts/fit-color-response.mjs` runs the real fit against a
    live sidecar, and **no test asserts a fitted number, deliberately**.
  - So: judge T5.1–T5.4 on *direction, proportionality and honesty*, not on absolute
    accuracy. If a match looks systematically off by a consistent amount, that is the
    unfitted model, not a bug — record it and flag T16.4.
  - Optional: run `node packages/ai-sdk/scripts/fit-color-response.mjs` (needs a running
    sidecar and real render time) and report the residuals.
  - Result: __/__/____ · N/A · notes:

---

## Part 6 — Transitions are solved, not picked · **P0**

`add_transitions` (`packages/ai-sdk/src/domain-tools/graphics.ts`, policy in
`packages/editor-core/src/transition-policy.ts`).

- [ ] **T6.1. Reasoned placement** — `AI` · `desktop`
  - Setup: a cut sequence containing, deliberately, all three kinds:
    (a) a **jump cut** — same subject, same framing, small time jump;
    (b) a **change of place** — two clearly different locations;
    (c) a **continuing action** — one action carried across a cut.
  - Do: "add transitions where they belong".
  - Expect: (a) softened · (b) a dissolve · (c) **left as a cut**.
  - Fail if: every boundary gets a dissolve. An unmotivated dissolve is the classic amateur
    tell, and "transition on every cut" is the behaviour this replaces.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T6.2. It says what it left alone** — `AI` · `desktop`
  - Expect: the run explicitly names the cuts it **deliberately did not touch**, so silence
    is never read as an oversight.
  - Fail if: the report only lists what changed. Then a correct decision is indistinguishable
    from a missed one, which is what makes users re-run the request.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T6.3. Unmeasured cuts degrade honestly** — `AI` · `desktop`
  - Do: run T6.1 in a project where the ledger is empty (sidecar down during import).
  - Expect: it says it has no measured basis rather than guessing a transition per cut.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T6.4. Card label** — `UI` — expect "Place transitions".
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 7 — Post-apply verification · **P0**

`packages/ai-sdk/src/kernel/picture-verification.ts`. **Frames here verify; they never plan.**

- [ ] **T7.1. The agent reports what changed on screen** — `AI` · `desktop`
  - Do: any edit that touches picture clips.
  - Expect: after the apply, a plain statement of the visual delta — e.g. "New cut at 0:12,
    now a wide shot, a stop brighter".
  - Fail if: the run reports only "applied 3 operations".
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T7.2. Inherited defects are advisories, not orders** — `AI` · `desktop` · *P0*
  - Setup: a project whose footage is **already letterboxed** (or already over-exposed)
    before the run starts.
  - Do: ask for something unrelated — "swap the first two clips".
  - Expect: exactly that edit. The pre-existing defect appears, if at all, as an **advisory
    in the review** — never as an instruction during the edit.
  - Fail if: every clip comes back cropped. That is the measured regression this fixed
    (first-pass 33% → 100% on the two reorder cases, one operation per run, a tenth of the
    cost). It is the single most user-visible defect in the whole PR's "before" state.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T7.3. Verification never fails a valid apply** — `AI` · `desktop`
  - Do: force `unverified` — no sidecar, or a non-vision provider, or cancel mid-run.
  - Expect: the edit still stands. `unverified` is a fact recorded for the next turn, not a
    failure and not a repair trigger. There must be **no path** from "could not check" to
    "checked and fine".
  - Fail if: a valid, applied edit is reported as failed because verification could not run.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T7.4. The fact reaches the model, not just the review** — `local`
  - Do: `pnpm --filter @framepilot/ai-sdk exec vitest run src/kernel/picture-verification.run.test.ts`
  - Expect: in a real `streamAgent` run the verification fact lands in the **next turn's
    prompt**, never only as a review finding.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T7.5. Bounded cost** — `desktop`
  - Expect: at most **4 verified cuts per apply** (deterministic, ~8 decoded frames, never
    shown to a model) and at most **2 vision pairs × 2 frames**. Deterministic first; vision
    only where numbers are undecided; `cannot_tell` is **not** a pass.
  - Fail if: verification cost scales with the size of the apply.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 8 — The four named bugs · **P1**

- [ ] **T8.1. Stills** — covered by T2.3. Cross-reference here; do not test twice.
  - Result: __/__/____ · see T2.3

- [ ] **T8.2. Stock and agent downloads are enrolled** — `UI+AI` · `desktop`
  - Why: acquired clips were **never registered with the brain**, so the agent would build a
    montage and then be told it knew nothing about any of it. Enrolment moved out of the
    renderer (`MediaBin.tsx` no longer calls `autoIndexImportedAssets`) into the desktop
    main process's single batching enroller — one path for human imports, agent downloads
    and the Stock panel alike.
  - Do (a): add a clip from the **Stock panel**. Do (b): ask the AI to **find and add** stock
    footage. Do (c): normal **drag-and-drop import**.
  - Expect: all three raise the `measured` count. Then ask the AI about the clip it just
    added — it must know something about it.
  - Fail if: any one of the three surfaces leaves a clip unmeasured. A per-surface hook in
    the renderer is exactly what caused the original bug, so check all three.
  - Also: music downloads (`music-service.ts`) take the same path.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T8.3. Captions join to shots by time, not index** — `AI` · `desktop`
  - Why: tier 2 writes against the **shot ledger**; the hosted arm's spans come from the
    **sampler**. Two different segmentations, so "index 7" is not the same thing in each.
    Matching by index would attach shot 7's description to span 7 and call it fact.
  - Do: in key state C, with a clip whose shots and sampler spans differ in count, index it
    and inspect the descriptions against the actual footage at those timecodes.
  - Expect: descriptions land on the right moments. It is a **time-overlap join** now.
  - Fail if: descriptions are plausible but systematically offset. This one is dangerous
    precisely because the wrong answer looks right — check the *last* shot in a long clip,
    where an index drift is largest.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T8.4. Semantic index on speed-changed clips — RECORDED, NOT FIXED** — `P3` · `note`
  - The semantic index places times wrongly on clips with a speed ramp. Pre-existing,
    originating from a stale comment claiming `speedRamp` did not exist. This PR **records
    it and does not patch it**.
  - Do: confirm the limitation is documented and that no test claims it works.
  - Do not: file this as a new regression during testing. Verify it is still limited to
    speed-changed clips only.
  - Result: __/__/____ · N/A · notes:

---

## Part 9 — Agent reliability fixes · **P1**

Each of these is an independent user-visible behaviour change. Test them separately;
they have separate causes.

- [ ] **T9.1. The run stops when the request is met** — `AI` · `desktop`
  - Do: "move the last clip to the front" on a 5-clip timeline. Run it **three times**.
  - Expect: correct order every time, one operation per run.
  - Fail if: the position-relative request is re-applied against the timeline it just
    changed (last→first, then the new last→first again). Three of six live runs previously
    ended with the wrong order because a one-step edit was treated as still "inspecting".
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.2. Plan-first verdict is honest** — `AI` · `desktop`
  - Setup: **"Plan first" ON** (this is the default — do not turn it off for this row).
  - Do: a correct one-step edit.
  - Expect: it reports success. Steps the run never reached are listed under **"Not done"**;
    the verdict comes from the request and the edit, not from ticking every drafted step.
  - Fail if: "Applied 1 change, but the run could not finish". The drafted plan's
    read-and-report steps can never be ticked, and that used to sink a correct edit.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.3. Recovery turns offer only loaded tools** — `AI` · `desktop`
  - Do: force a failure (invalid target, impossible request — the `impossible-8k-drone` case
    shape) and let the run recover.
  - Expect: the recovery turn's tool list is the run's **loaded** tools, not every mutation
    in the registry.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.4. Caption cue length: one number, three consumers** — `AI` · `desktop`
  - Do: caption a talk with the **subtitle preset**, then let the verifier run.
  - Expect: no re-caption. The segmenter, the verifier and the hand-cue tool now share one
    max-words constant (the verifier used to flag >12 words while the preset wrote up to 14).
  - Fail if: a correctly captioned talk is re-captioned in a different preset for nothing.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.5. `adjust_audio` takes a track** — `AI` · `desktop`
  - Setup: a music bed **tiled from a short file** (many clips on one track).
  - Do: "lower the music".
  - Expect: **one** call, set once on the track — not once per tile.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.6. The panel stops promising a review step** — `UI` · `desktop+browser`
  - Do: read the AI panel contract text, the receipt on a diff card, and the empty state.
  - Expect: none of them say the edit will be reviewed before it applies. Edits **auto-apply**
    (`patchPolicy: 'auto_commit'`); the diff card is a receipt and ⌘Z is the rollback.
  - Fail if: any copy still implies an approval gate that does not exist.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.7. "Mute the music track" only when there is music** — `UI` · `desktop+browser`
  - Do (a): a project with only a **voice-over** on an audio track → the starter prompt must
    **not** appear. Do (b): add a real music bed (music mix role, or a filename matching
    `music|bed|beat|song|track|bgm`) → it appears.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.8. Playbooks name tools that exist** — `AI` · `desktop`
  - Do: exercise the edited skills (`caption-design`, `hook-crafting`, `short-form-pacing`,
    `speed-ramping`, `story-structure`).
  - Expect: no reference to a tool the registry does not have.
  - Note: per repo memory, skill text is the discovery surface and a **300-char description
    cap silently skips the file** — confirm each edited skill is still discovered.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T9.9. New tool cards** — `UI` — `tighten_clips` → "Tighten pacing";
  `remove_filler_words` → "Remove filler words"; `add_transitions` → "Place transitions".
  Both `tighten_clips` and `add_transitions` were newly added to their domains — per repo
  memory, a tool without a domain fails the shape test, so check `DOMAIN_SUMMARY` if a tool
  is not being found.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 10 — Scheduling, resume, and staying out of the way · **P1**

`engine/python/framepilot_engine/brain/governor.py`. No configuration surface — every
number is a constant, by design.

- [ ] **T10.1. Indexing pauses under foreground work** — `desktop`
  - Do: start a large import, then immediately start an **export**. Repeat with a **preview
    render**, a **frame grab**, and a **review batch**.
  - Expect: indexing stops starting new slices for the duration, and resumes a couple of
    seconds after the machine goes quiet.
  - Fail if: your export is measurably slower than the same export on an idle machine. That
    is the symptom users report and cannot name.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T10.2. Breadth before depth** — `desktop`
  - Do: import 20+ clips at once and watch the coverage line for the first minute.
  - Expect: **every** clip is measured before any single clip is described. Within the first
    minute the AI knows something about all your footage, rather than everything about clip 1.
  - Fail if: tier 2 runs on asset 1 while assets 2–20 are unmeasured.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T10.3. Import during a running job jumps the queue** — `UI` · `desktop`
  - Do: with a big job running, import one new clip.
  - Expect: the new clip is measured **next**, not after the whole backlog.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T10.4. Kill and resume loses nothing** — `desktop` · *P0*
  - Do: start a large index. `SIGKILL` the sidecar (or force-quit the app) **mid-slice**.
    Restart. Let it finish.
  - Expect: it resumes exactly where it stopped, leaves **no half-written clip**, and lands
    on a ledger **identical to a clean run** (the PR measured 272 rows identical).
  - Verify: run the same media through a clean, uninterrupted index in a fresh project and
    diff the row counts and digests.
  - Fail if: rows differ, or a partially described clip is recorded as complete.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T10.5. Tier 2 stands down when memory is short** — `desktop`
  - Do: with tier 2 active (key state C), fill memory (open a large render, another app).
  - Expect: `skipped: low_memory` for that slice, re-evaluated next slice. **Tiers 0 and 1
    keep running** — the cheap facts must survive the expensive tier being unavailable.
  - Fail if: the whole index stalls because tier 2 cannot run.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T10.6. Per-clip timeout** — `desktop`
  - Expect: describing stops after roughly **90 s** on any one clip and checks whether you
    have started working again. Whatever finished is kept; the next pass resumes.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T10.7. Worker counts** — `local`
  - Expect: tier 0 gets `max(1, cores // 4)` workers; tiers 1 and 2 get **one each** (they
    are dominated by a round trip or a resident model, so more buys latency, not throughput).
  - Do: `cd engine/python && uv run pytest tests/test_index_governor.py -v`
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 11 — Migration and backward compatibility · **P0**

- [ ] **T11.1. An old project opens and upgrades** — `desktop`
  - Do: open the **`main`-era project you kept in T0.5**.
  - Expect: brain migrates to **v4** (`PRAGMA user_version`), opens without data loss, and
    starts filling the ledger. **No `project.fp.json` schema change** — the timeline file
    must be byte-compatible.
  - Fail if: the project file itself changed shape, or the app refuses to open it.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T11.2. The brain is rebuildable, derived data** — `desktop`
  - Do: delete the brain file entirely and reopen the project.
  - Expect: it rebuilds. Nothing irreplaceable lives there.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T11.3. Forward-incompatible file is refused cleanly** — `local`
  - Do: hand the engine a brain at a **higher** user_version.
  - Expect: a clear "cannot be handled by this engine" error, not corruption. Migrations are
    forward-only and append-only.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T11.4. New app against an OLD sidecar** — `desktop`
  - Why: `tiers` and `coverage` on the IPC result are optional precisely because a
    pre-ledger engine does not send them — and **absent is not the same fact as "no tier ran"**.
  - Do: point the desktop app at a `main`-era sidecar.
  - Expect: the Settings panel falls back to the single `N/M assets prepared` line and says
    "prepared", not "indexed". Nothing crashes, nothing claims coverage it cannot know.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T11.5. TS ↔ Python ledger parity** — `local`
  - Do: `cd engine/python && uv run pytest tests/test_ledger_ts_parity.py`
  - Expect: pass. Also confirm `engine/python/tests/fixtures/ts_tool_registry.json` was
    regenerated with the new tools, not hand-edited.
  - Per repo memory: the engine loader requires the envelope to equal `SCHEMA_VERSION`
    **exactly**, and fixtures must import the constant rather than hard-code it.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 12 — The two local packs · **P3 — structure only**

**Read this before testing anything here.** `visual-embed` (tier 1) and `visual-describe`
(tier 2) have **never loaded a model**. Every digest in `models.lock.toml` is a placeholder
that `resolve_model` refuses **by name**, so a pack cannot half-work. `onnx_backend.py` and
`llama_backend.py` have never executed; every test runs against an injected fake. **No
accuracy is claimed** — not shot size, not subject kind, not identity clustering, not
caption quality.

So the goal here is to confirm the packs are **inert and honest**, not that they work.

- [ ] **T12.1. The register-all script covers all four packs** — `local`
  - Do: `pnpm packs:register` (`scripts/dev-register-all-packs.sh`).
  - Expect: it runs `tracking-lite`, `subject-intelligence`, `visual-embed`,
    `visual-describe`. The first two register; the last two report as **blocked** (weights
    unfetched) and **do not fail the run**. A drift guard fails the script if any
    `dev-register-*.sh` on disk is missing from its lists.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T12.2. A pack cannot half-work** — `local`
  - Do: attempt `uv run python tools/fetch_models.py --check` in `workers/visual-embed`
    and `workers/visual-describe`.
  - Expect: **fails by design**, naming the placeholder digest. Not a silent pass, not a
    partial load.
  - Fail if: either pack loads anything. That would mean an unverified weight can reach a
    user, which is the thing ADR 0176 exists to prevent.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T12.3. The tiers degrade to absent, not to wrong** — `desktop`
  - Do: leave `FRAMEPILOT_PACK_VISUAL_EMBED` / `_DESCRIBE` empty and index normally.
  - Expect: coverage records **absent coverage** for those tiers. Tier 0 is unaffected.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T12.4. Pack unit tests pass against fakes** — `local`
  - Do: `cd workers/visual-embed && uv run pytest`; same for `workers/visual-describe`.
  - Expect: pass. Understand that this proves protocol, policy, sandbox and schema — and
    proves **nothing** about model output.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T12.5. Licence position is recorded** — `local`
  - Do: read `workers/visual-embed/LICENSES.md` and `workers/visual-describe/LICENSES.md`.
  - Expect: the gating question is the **quantisation/export/release artifact** licence, not
    just the upstream repository's. Confirm `pnpm license:scan` is clean.
  - Related standing risk (repo memory): the TwelveLabs SDK is **UNLICENSED** and that is an
    accepted, recorded risk (ADR 0071) — not something this PR changes.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T12.6. The NVIDIA hosted embedder survives on purpose** — `note`
  - Four of five named deprecations are **deleted**: the key gate, the per-path enrolment
    hooks, the pairwise duplicate scan, and the free-text caption path (`CAPTION_INSTRUCTION`
    and `SceneCaptioner` are gone; `captioner.py` no longer has a function returning a string).
  - The fifth — the hosted NVIDIA embedder — is kept deliberately: removing it before the
    local pack has verified weights would leave **no tier-1 producer at all**. Recorded in
    ADR 0176. Confirm it still works in key state B and do not file it as dead code.
  - Result: __/__/____ · N/A · notes:

---

## Part 13 — Structured descriptions replace prose · **P1**

- [ ] **T13.1. A description is a record, not a sentence** — `AI` · `desktop` · key state C
  - Do: index a clip with recognisable content and on-screen text (a title card, a slate,
    a sign).
  - Expect: each described shot carries **subject, action, setting, framing, camera move,
    mood, on-screen text transcribed word for word, and a short summary** — as fields.
  - Fail if: you get two sentences of prose. Prose reads well and cannot be used: you cannot
    ask for "the wide shots outside", and nothing can read a title card back to you.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T13.2. Search did not regress** — `AI` · `desktop`
  - Do: repeat searches that worked on `main`.
  - Expect: the **summary** is still what search matches on, so nothing findable before is
    harder to find now.
  - Fail if: recall drops on queries that used to work. Then the structuring cost you search.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T13.3. Describing no longer needs an embedding key** — `desktop`
  - Do: key state **C without an embedding key** (vision provider only).
  - Expect: descriptions are produced. They used to be a side-effect of the paid indexing
    pass, so a machine set up for local keyless understanding got none at all. They are now
    their own step over the shots FramePilot measured itself, sourced from a configured
    vision provider **or** a local Describe pack — local first.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T13.4. On-screen text is verbatim** — `AI` · `desktop`
  - Do: point it at a slate or title card and ask what it says.
  - Expect: word for word, not paraphrased.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 14 — Security and privacy · **P0**

- [ ] **T14.1. Nothing leaves the machine at tier 0** — `desktop`
  - Do: key state A, network monitor on (Little Snitch / `tcpdump` / Charles). Import media.
  - Expect: **zero** outbound traffic attributable to measurement. One ffmpeg pass, two
    chains, one decode, local.
  - Fail if: anything is uploaded without a key configured. This is the claim in the PR body
    and in the changelog; it is a promise to users, so verify it rather than assuming it.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T14.2. Frames are decoded for perception and verification only** — `desktop`
  - Expect: no frame is decoded to *plan* an edit. Planning reads text.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T14.3. Path sandbox holds for derived artifacts** — `desktop`
  - Why: derived artifacts and pack payloads are pinned by the `fp-media` sandbox
    (`derived-media-cache.ts`, `sourced-asset-id.ts` are both touched here).
  - Do: confirm ledger, cache and pack payloads land inside the sandboxed locations, and
    that a path outside is refused.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T14.4. Pack registration stays dev-gated** — `local`
  - Expect: `FRAMEPILOT_DEV_PACK_REGISTRATION=1` is set **only** around the registration
    call in the dev scripts, never in a packaged build. Verify the packaged app has no path
    to local registration.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T14.5. Every AI edit is still a validated, reversible typed operation** — `AI`
  - Do: exercise the new solver tools, then ⌘Z each one.
  - Expect: clean single-step undo. Solvers emit **operations that already exist** — they
    add no new mutation path.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 15 — Regression sweep: what must NOT have changed · **P2**

This PR touches 235 files across the AI kernel, the engine, and the UI. Walk these
`MANUAL_TESTING.md` sections and confirm they behave as they did on `main`:

- [ ] **T15.1.** §2 Core timeline editing (manual) — untouched by design.
- [ ] **T15.2.** §5 Transcription — `transcribeImport.ts` changed. Per repo memory there are
      **two transcribe paths**: manual = IPC/TS hosted, agent = sidecar local-only. Test both.
- [ ] **T15.3.** §6 Captions — segmenter shares a constant with the verifier now (T9.4).
- [ ] **T15.4.** §7 Silence removal — `silence-cut.ts` changed.
- [ ] **T15.5.** §10 Transitions — the manual/UI path, alongside the new AI path.
- [ ] **T15.6.** §14 Color grading — the direct path, alongside the new solvers.
- [ ] **T15.7.** §15 Audio mixing — `adjust_audio` signature widened (T9.5).
- [ ] **T15.8.** §17 Footage understanding and semantic search — the most-changed area.
- [ ] **T15.9.** §18 The AI run itself — control, honesty, recovery. Several fixes land here.
- [ ] **T15.10.** §19 Preview, render, export — must be unaffected, and must now **pause**
      background indexing (T10.1).
- [ ] **T15.11.** Undo/redo across every new tool.
- [ ] **T15.12.** Web-editor **browser** build (`pnpm --filter @framepilot/web-editor dev`) —
      no proxy generation without the sidecar is an accepted gap, but nothing may crash.
  - Result: __/__/____ · PASS / FAIL · notes:

---

## Part 16 — Open items to settle before merge

These are not test rows; they are decisions and unknowns. Each needs an owner.

- [ ] **T16.1. CodeQL: 42 high-severity `py/path-injection` alerts** — **blocking-ish**
  - All 42 are the same rule. By file: `brain/memory.py` (13), `brain/sidecars.py` (8),
    `tests/test_asr.py` (6), `render/pipeline.py` (3), `service.py` (3), `brain/store.py` (2),
    `media/assets.py` (2), `validation/render_validation.py` (2), `audio/asr.py` (1),
    `safety.py` (1), `timeline/models.py` (1).
  - CodeQL itself says *"alerts not introduced by this pull request might have been detected
    because the code changes were too large"* — so most of these look pre-existing, surfaced
    by the diff size rather than caused by it.
  - Do: confirm that read. `gh api "repos/rojan-labs/FramePilot/code-scanning/alerts?ref=refs/heads/main&state=open"`
    and compare. Then either dismiss with a reason or fix the genuinely new ones. Do **not**
    merge on the assumption that they are all inherited — path handling is the sandbox
    boundary this project takes seriously.
  - Owner: ______  Result: __/__/____

- [ ] **T16.2. Vercel deployment blocked** — check whether the website build is actually
      affected by this PR or whether the block is unrelated to the diff.
  - Owner: ______  Result: __/__/____

- [ ] **T16.3. The behavioural payoff is unmeasured** — **the biggest open question**
  - Nothing here has been measured for its effect on **edit quality**. Whether first-pass
    acceptance improves needs a live golden run against a real provider.
  - Per repo memory: run it **detached**, or your own vitest kills it. `--replay` is free but
    needs the sidecar on `:8799` for scoring. Recorded session-6 runs are a free regression
    suite; `reports/golden/s9-*` are this PR's own baselines.
  - The gate to watch: `framesSeenPerEdit` must **not** rise. A rubric improvement bought
    with frames is not the improvement this plan set out to make.
  - Owner: ______  Result: __/__/____

- [ ] **T16.4. Colour coefficients unfitted** — see T5.7. Decide whether to fit before merge
      or ship the derived model and fit later. `fit-color-response.mjs` is ready.
  - Owner: ______  Result: __/__/____

- [ ] **T16.5. Pack weights and licences** — VU5/VU6 cannot go live until each pack's
      quantisation/export/release artifact licence is verified and `models.lock.toml` carries
      real digests. Each pack's plan section carries the exact steps.
  - Owner: ______  Result: __/__/____

- [ ] **T16.6. `.env.example` line for TwelveLabs** — per repo memory this was still pending
      from the earlier TL work. Confirm whether this PR closed it or it is still open.
  - Owner: ______  Result: __/__/____

- [ ] **T16.7. Fixture labels are a human pass** — `tests/fixtures/mission/labels/{tier0,tier1,tier2,cuts}.json`
      score the answer cases. `packages/ai-sdk/scripts/contact-sheet.mjs` exists to make that
      pass possible in one sitting. Confirm the labels were actually eyeballed, not generated —
      a generated label set scores the model against itself.
  - Owner: ______  Result: __/__/____

---

## Appendix A — Command cheat sheet

```bash
# Build (ai-sdk dist is consumed by desktop AND web-editor — rebuild it)
pnpm install && pnpm engine:sync
pnpm --filter @framepilot/ai-sdk build
pnpm desktop:dev

# Targeted tests (do not run the full suites locally; CI already did)
cd engine/python && uv run pytest tests/test_shot_stats.py tests/test_brain_ledger.py \
  tests/test_index_governor.py tests/test_ledger_ts_parity.py
pnpm --filter @framepilot/editor-core exec vitest run src/color-solver.test.ts src/transition-policy.test.ts
pnpm --filter @framepilot/ai-sdk exec vitest run src/domain-tools/solved-color.test.ts \
  src/domain-tools/transition-planning.test.ts src/kernel/picture-verification.test.ts

# Gates
pnpm eval:golden:gate          # rubric + efficiency + framesSeenPerEdit ceiling
pnpm license:scan

# Packs (dev only)
pnpm packs:register

# Dev scripts new in this PR
node packages/ai-sdk/scripts/perception-baseline.mjs   # reads recorded runs; free
node packages/ai-sdk/scripts/contact-sheet.mjs         # thumbnails for the labelling pass
node packages/ai-sdk/scripts/fit-color-response.mjs    # needs a live sidecar + render time
node packages/ai-sdk/scripts/propose-fixture-labels.mjs

# PR state
gh pr checks 82
gh api "repos/rojan-labs/FramePilot/code-scanning/alerts?pr=82&state=open&per_page=100"
```

## Appendix B — What to read before testing each part

| Part | Read first |
| --- | --- |
| 2, 4 | [ADR 0175](docs/adr/0175-perception-is-a-compiled-shot-ledger.md) · `plan/visual-understanding/02-TIER0-SHOT-LEDGER.md` · `engine/python/framepilot_engine/analysis/shot_stats.py` (module docstring) |
| 5, 6 | `plan/visual-understanding/04-SOLVERS-COLOR-TRANSITIONS.md` · `packages/editor-core/src/color-solver.ts` |
| 7 | `plan/visual-understanding/06-VERIFICATION-AND-EVAL.md` · `packages/ai-sdk/src/kernel/picture-verification.ts` (the four rules are in the docstring) |
| 10 | `plan/visual-understanding/07-SCALE-AND-OPERATIONS.md` · `engine/python/framepilot_engine/brain/governor.py` |
| 12 | [ADR 0176](docs/adr/0176-local-perception-ships-as-packs.md) · `plan/visual-understanding/05-LOCAL-PERCEPTION-PACKS.md` |
| 16 | `plan/visual-understanding/08-REMOVE-DEFER-RISKS.md` · [`09-EVIDENCE.md`](plan/visual-understanding/09-EVIDENCE.md) — including what is explicitly **not** measured |
| anything | [`docs/guides/media-intelligence.md`](docs/guides/media-intelligence.md) · `CHANGELOG.md` (the user-facing wording is the acceptance criteria) |

---

## Appendix C — Suggested order and rough time

| Session | Parts | Key state | Time |
| --- | --- | --- | --- |
| 1 | 0, 1, 2, 3 | A (keyless) | ~3 h |
| 2 | 4, 7, 9 | A | ~3 h |
| 3 | 5, 6 | A | ~2 h |
| 4 | 8, 13 | B, then C | ~3 h |
| 5 | 10, 11, 14 | A | ~3 h |
| 6 | 12, 15 | A | ~3 h |
| 7 | 16 (triage + decisions) | — | ~2 h |

Parts 2, 4, 5, 6, 7, 10.4, 11 and 14 are **P0**. If time is short, do those and Part 8.
