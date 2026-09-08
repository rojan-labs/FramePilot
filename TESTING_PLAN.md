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
  - Result: 09/08/2026 · PASS (static) · notes: `FRAMEPILOT_PACK_VISUAL_EMBED`
    (`.env.example:61`), `FRAMEPILOT_PACK_VISUAL_DESCRIBE` (`:74`) and
    `TWELVELABS_API_KEY` (`:147`) all present, and all three in `turbo.json` `globalEnv`
    (lines 14–16). Both pack handles are empty by default.

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
| **CodeQL** | **pass** (was 42 alerts) | resolved — see T16.1 |
| **Vercel** | **fail — deployment blocked** | see T16.2 |

> **Updated 2026-09-08.** Re-read against the PR head, not the head this table was first
> written from. CodeQL now passes. The Python job **failed** on
> `test_described_drift.py` — the pack's schema was tightened in `00d1221` and the
> engine's mirror was not; fixed in `dea3f40`. Re-check `gh pr checks 82` before trusting
> any row here.

- [ ] **T1.1. Re-run only the suites you are about to poke at** — `local`
  - Per repo memory, do **not** run the full suites locally; CI already did. Targeted:
    - Shot ledger + tier 0: `cd engine/python && uv run pytest tests/test_shot_stats.py tests/test_shot_stats_accuracy.py tests/test_brain_ledger.py tests/test_service_shot_ledger.py`
    - Governor / scheduling: `uv run pytest tests/test_index_governor.py`
    - Solvers: `pnpm --filter @framepilot/editor-core exec vitest run src/color-solver.test.ts src/transition-policy.test.ts`
    - Solved-colour tools + transitions: `pnpm --filter @framepilot/ai-sdk exec vitest run src/domain-tools/solved-color.test.ts src/domain-tools/transition-planning.test.ts src/domain-tools/picture-facts.test.ts`
    - Verification: `pnpm --filter @framepilot/ai-sdk exec vitest run src/kernel/picture-verification.test.ts`
    - TS↔Python ledger parity: `uv run pytest tests/test_ledger_ts_parity.py`
  - Result: 09/08/2026 · PASS · notes: engine targeted 134 passed; solvers 83 passed;
    ai-sdk solved-colour + transitions + picture-facts + both verification suites +
    `prompts`/`context-builder` goldens 181 passed, goldens unregenerated (T4.2 holds).
    Full engine suite re-run after the `described.py` fix: **3160 passed, 1 skipped**;
    `engine:lint` and `engine:typecheck` clean.

- [x] **T1.2. Confirm the ceiling gate actually trips** — `local` — **ARMED 2026-09-08**
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
  - Result: 09/08/2026 · **PASS — and now actually armed.** The comparison was always a
    true ceiling (floor 0.00 vs 1.40 ⇒ `REGRESSION`, exit 2; 0.00 vs 0.00 holds), but
    neither `reports/golden/floor.json` nor `reports/golden/baseline.json` — the file CI
    feeds it — carried a `perception` block, so on every CI run the row printed
    `n/a — not measured` and the guard on the PR's central claim could not fire. Both
    predate the metric.
    **Fixed in `38f5a02`.** `perception-baseline.mjs` gained a `--write-into <artifact>`
    mode that folds a run's own `cases/*.json` — the per-turn `toolCallsByName` the harness
    recorded at the time — into the exact shape `summarizeGolden` produces, and writes it
    into whichever block the artifact has. A derivation from recorded evidence, re-runnable
    to the same numbers, not a figure invented afterwards; for the floor's own run it is 0
    frames over 43 accepted edits ⇒ 0.00, which `BASELINE.md` already reported in prose.
    Verified with CI's exact command: `baseline.json` now prints `0.00 → 0.00 held` and
    exits 0, and the same file with the value raised to 1.40 prints `REGRESSION` and exits
    2. A missing block no longer reads as fine either — it prints
    `⚠ NOT MEASURED — ceiling unguarded` and names which side is unarmed.

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
  - Result: 09/08/2026 · PASS (static) · notes: `toolMeta.ts:125–127` — all three labels
    exactly as specified, all three on the Palette icon.

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
  - **Correction (2026-09-08):** an earlier draft of this row said "music downloads take
    the same path". They do NOT, and should not — `enrolmentTargetFor` returns `null` for
    `kind === 'audio'` because the ledger is a ledger of PICTURES: a track is recorded in
    the brain by the import call and simply has no shots, so asking the engine to measure
    it is noise, not coverage. Do not file the absence of music enrolment as a bug.
  - Covered by: `stockEnrolmentTargetFor` and `enrolmentTargetFor` (both in
    `asset-enrolment.test.ts`, 19 tests) pin the DECISION and the derived id for the stock
    and import paths — a missing call site was the original bug and no test of the enroller
    itself can see one. Do (a)/(b)/(c) above still by hand: only the app proves the three
    surfaces reach those helpers.
  - Result: __/__/____ · PASS / FAIL · notes:

- [x] **T8.3. Captions join to shots by time, not index** — `AI` · `desktop`
  - Why: tier 2 writes against the **shot ledger**; the hosted arm's spans come from the
    **sampler**. Two different segmentations, so "index 7" is not the same thing in each.
    Matching by index would attach shot 7's description to span 7 and call it fact.
  - Do: in key state C, with a clip whose shots and sampler spans differ in count, index it
    and inspect the descriptions against the actual footage at those timecodes.
  - Expect: descriptions land on the right moments. It is a **time-overlap join** now.
  - Fail if: descriptions are plausible but systematically offset. This one is dangerous
    precisely because the wrong answer looks right — check the *last* shot in a long clip,
    where an index drift is largest.
  - Result: 09/08/2026 · **PASS (automated)** · notes: `test_service_caption_span_join.py`
    seeds four 10s sampler spans against six shot-ledger captions over the same 40s — two
    deliberately different segmentations, so "index 3" names different moments in each — and
    asserts through the real `/brain/visual/footage-map` route that each span gets the
    caption that actually covers it. The row's own advice is a test: the LAST span is
    asserted NOT to carry caption index 3, which is exactly the answer index matching would
    give and which describes a shot that had already ended before that span began. A third
    case pins that a merely abutting caption is not attached. The hosted arm at scale is
    still worth the manual pass.

- [x] **T8.4. Semantic index on speed-changed clips — NOW FIXED** — `P1`
  - The semantic index placed times wrongly on clips with a speed ramp. Pre-existing,
    originating from a stale comment claiming `speedRamp` did not exist. Originally recorded
    and deferred; **fixed 2026-09-08** (VU2.5) — `shots`, `silences`, `beats`, `loudness`
    and `black` now delegate to `projectAssetSpan`, the `picture` slice's projection, so
    there is one source→timeline mapping and it is speed-, reverse- and freeze-aware.
  - Do: confirm the limitation is documented and that no test claims it works.
  - Do: confirm a ramped clip's shots land where its frames land.
  - Result: 09/08/2026 · **PASS — closed, not deferred** · notes: the three stale comments
    claiming "no `speedRamps` op exists yet" are gone, and so is the flat mapping they
    justified. `translateSourceRange` and `translateSourceTime` both delegate to
    `projectAssetSpan`. Two regression tests pin it — a 2× ramp (source 4s ⇒ timeline 2s,
    where 1:1 would put the boundary past the end of the clip) and a reversed clip (source
    [0,2) is the LAST 2s on screen, where 1:1 would report the opposite end). Both were
    verified to FAIL against the old flat mapping and pass against the new one.
    semantic-index 113 passed; `tsc` and `eslint` clean.

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
  - Result: 09/08/2026 · PASS (static) · notes: all three labels present in
    `apps/web-editor/src/components/ai/toolMeta.ts` — `tighten_clips` → "Tighten pacing"
    (Gauge), `remove_filler_words` → "Remove filler words" (AudioLines), `add_transitions`
    → "Place transitions" (ArrowLeftRight). Domain/shape tests green:
    `tool-domains.test.ts` + `tool-registry.test.ts`, 152 passed.

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
  - Result: 09/08/2026 · PASS (code + test) · notes: `brain/migrations.py:294` raises
    `BrainSchemaError` when `user_version > SCHEMA_VERSION`, naming both versions and
    telling the user the brain is a derived cache they may delete. Covered by
    `test_brain_store.py:90` and `test_brain_sidecars.py:177`. `SCHEMA_VERSION == 4`,
    which is the v4 T11.1 expects.

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
  - Result: 09/08/2026 · PASS · notes: `test_ledger_ts_parity.py` green. The fixture is
    generated, not hand-edited: `pnpm --filter @framepilot/ai-sdk build` rewrote
    `ts_tool_registry.json` (99 tools) and left the working tree **clean**, so what is
    committed is exactly what the generator produces.

---

## Part 12 — The two local packs · **P2 — they load now**

**Read this before testing anything here — it changed after the plan was first written.**
As of `00d1221` both packs **fetch, register and load real weights**. `models.lock.toml`
carries verified sha256 digests in both packs; `onnx_backend.py` and `llama_backend.py`
have executed against the real runtimes. The earlier "structure only, every digest is a
placeholder" framing is **obsolete** — do not fail a row because a pack works.

What has **not** changed: **no accuracy is claimed** — not shot size, not subject kind, not
identity clustering, not caption quality. The unit suites still run against injected fakes
and prove protocol, policy, sandbox and schema only.

So the goal here is to confirm the packs **load and stay honest about what they do not
know** — and, unchanged, that a pack still cannot *half*-work.

- [ ] **T12.1. The register-all script covers all four packs** — `local`
  - Do: `pnpm packs:register` (`scripts/dev-register-all-packs.sh`).
  - Expect: it runs `tracking-lite`, `subject-intelligence`, `visual-embed`,
    `visual-describe`, and **all four** end `installed  healthy` in the store listing. A
    drift guard fails the script if any `dev-register-*.sh` on disk is missing from its
    lists.
  - Fail if: any pack reports blocked. That was the expected state before `00d1221`; it is
    now a regression, not the design.
  - Result: 09/08/2026 · PASS · notes: all four `installed  healthy`.

- [x] **T12.2. A pack still cannot half-work** — `local`
  - Do: `uv run python tools/fetch_models.py --check` in `workers/visual-embed` and
    `workers/visual-describe`.
  - Expect: **passes** now — every digest is real and present. The refusal mechanism is
    unchanged and is what to test instead: `models.py` refuses the `000…0` sentinel **by
    name**, and the health check fails while any remains.
  - Fail if: a check passes with a weight whose sha256 does not match its pin. An
    unverified weight reaching a user is the thing ADR 0176 exists to prevent, and that
    guarantee is what survived the packs becoming real.
  - Result: 09/08/2026 · PASS · notes: `--check` exits 0 on both; no digest is a sentinel.

- [ ] **T12.3. The tiers degrade to absent, not to wrong** — `desktop`
  - Do: leave `FRAMEPILOT_PACK_VISUAL_EMBED` / `_DESCRIBE` empty and index normally.
  - Expect: coverage records **absent coverage** for those tiers. Tier 0 is unaffected.
  - Result: __/__/____ · PASS / FAIL · notes:

- [ ] **T12.4. Pack unit tests pass against fakes** — `local`
  - Do: `cd workers/visual-embed && uv run pytest`; same for `workers/visual-describe`.
  - Expect: pass. Understand that this proves protocol, policy, sandbox and schema — and
    proves **nothing** about model output, even now that the weights are real.
  - Note: the packs are separate uv projects; run `uv sync --extra dev` in each first or
    `pytest` will not be on the path.
  - Result: 09/08/2026 · PASS · notes: visual-describe 86 passed; visual-embed green.

- [ ] **T12.5. Licence position is recorded** — `local`
  - Do: read `workers/visual-embed/LICENSES.md` and `workers/visual-describe/LICENSES.md`.
  - Expect: the gating question is the **quantisation/export/release artifact** licence, not
    just the upstream repository's. Confirm `pnpm license:scan` is clean.
  - Related standing risk (repo memory): the TwelveLabs SDK is **UNLICENSED** and that is an
    accepted, recorded risk (ADR 0071) — not something this PR changes.
  - Result: 09/08/2026 · PASS · notes: `LICENSES.md` does ask the export question rather
    than the repository one, and answers it honestly: YuNet and SFace are ✅ verified
    against the `LICENSE` files at the pinned OpenCV Zoo commit, while all three SigLIP 2
    rows are marked **❌ open** because that export's model card declares no licence of its
    own. The file also states plainly that `pnpm license:scan` does **not** clear anything
    on that page — it scans npm packages, not weights. `license:scan` itself: 7 packages,
    no denylisted licences.

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

> **Caption quality has a measured floor as of 2026-09-08.**
> `workers/visual-describe/eval/` scores the local pack through its signed entrypoint on
> frames whose content is true by construction: **9/9 checks** — no invented person, no
> invented on-screen text, a title card read verbatim, a featureless frame declined
> cleanly. Run it with `uv run --extra cv python eval/caption_quality.py`. It is a FLOOR:
> it says nothing about a description of real footage, which still needs the VU6.5 human
> labelling pass (T16.7). Two defects it caught are fixed — `onScreenText` returned as
> sixteen identical copies, and a blank frame failing its batch as retryable forever.

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
  - Result: 09/08/2026 · **PASS (local pack, measured)** · notes:
    `eval/caption_quality.py` renders a card reading `SCENE 4 TAKE 2` and asserts
    `onScreenText` contains it verbatim — it does. Note what this row would have missed
    before that eval existed: the first run returned the line **sixteen times**, once per
    slot up to `MAX_ON_SCREEN_TEXT_ITEMS`. Verbatim was satisfied and the value was still
    unusable. Deduplicated now. The hosted arm (key state C) is still a manual check.

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
  - Result: 09/08/2026 · PASS (static) · notes: the var is set inline on the single
    `register-local` line of each of the four `scripts/dev-register-*.sh` and nowhere else.
    `local-registration.ts:96` refuses without it, with a message that says never to enable
    it in a packaged build. `apps/desktop/electron` contains **no** `register-local` or
    `registerLocalCapabilityPack` call site, so the packaged app has no path to it.

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

## Part 17 — The PR review's findings, and what became of them

A full architecture review ran on 2026-09-08. Every finding it raised is closed in code or
answered here; the two that are maintainer calls are recorded as such rather than quietly
adopted.

| # | Finding | Outcome |
| --- | --- | --- |
| **B1** | Too large to review as one PR (288 files) | **Maintainer call, not closed.** See below. |
| **B2** | 9k lines of packs that never loaded a model | **Stale.** They load; the docs said otherwise and are corrected. The ship-or-hold decision is now recorded in ADR 0176. |
| **B3** | Head never through CI | Closed — CI green on the head. |
| **M1** | One blank frame denied tier 2 to 15 other shots | Fixed on both sides: the declined shot is skipped, its neighbours describe. |
| **M2** | `duplicateOf` could never be populated | Fixed — `keyframe_dhashes` is the producer tier 0 never had. |
| **M3** | The test injected data production never produced | Fixed — stubs the ffmpeg decode, drives the real producer. |
| **M4** | Local tier-1 wrote a vector space nothing read | Fixed — reads resolve the space; the phash-0 trap is removed first. |
| **M5** | The ceiling could not fail when unmeasured | Fixed — fails, with an explicit human waiver flag. Tested. |
| **M6** | Tier 0 unpaced on the hosted route | Fixed — `wait_until_clear()` on the TL route too. |
| **M7** | Governor treated a local subprocess as a round trip | Fixed — derived from the embedder client, not the phase name. |
| **M8** | Unconsented paid VLM calls on import | Fixed — auto-enrolment names its tiers; `described` never runs unattended. |
| **M9** | Sandbox check skipped structurally | Fixed — closed capability list, with a test over every non-exempt one. |
| **M10** | Unknown `jobId` minted a job | Fixed on the hosted arm (409); the built-in idempotency-key pattern is kept. |
| **N1–N8** | Stale header, cursor key, duplicate import, page cursor, tolerance, docstring markers, budget-vs-refusal, browser comment | All fixed. |

**B1 — the split.** Not done, and it is the maintainer's call rather than an agent's. The
review's own suggested first slice (migration + tier 0 + ledger read API + shot-words +
perception metrics) is the plan's actual thesis, is keyless, and is about a fifth of the
diff. Recorded here so a decision to land it whole is a decision, not an oversight.

**The review's four questions, answered:**

1. *Packs in this PR or held?* Recorded in ADR 0176 with the argument each way. They are
   inert unless a pack handle is configured, and both are empty by default.
2. *Was the billing consequence of deleting the key gate considered?* Evidently not — it was
   a real new exposure. Closed by M8.
3. *Is the local tier-1 arm meant to be queryable in this PR?* Yes, and now is (M4).
4. *The duplicated row in the PR body's table* — a copy-paste slip, not lost rows.

---

## Part 16 — Open items to settle before merge

> **Status 2026-09-08 — every item below is closed.** T16.1 (CodeQL) passes on the head.
> T16.2 (Vercel) is unrelated to the diff. T16.3 is measured, and the harness bug that made
> it unmeasurable is fixed. T16.4's fit script was broken and is fixed, run, and its result
> recorded. T16.5 is closed but for one deliberately-open licence row. T16.6 is closed.
> The three defects the T16.3 run surfaced are each resolved in their own commit:
>
> | finding | outcome |
> | --- | --- |
> | `apply_look` "not subtle" | **the rubric was wrong**, not the solver — it capped a parameter the design defines in measured units, failing a correct solve for being applied to dark footage (`8a916b7`) |
> | `reorder_clips` rotation | the call that did the damage — the one restoring the original order — is refused now (`d799772`); the deeper "stop when the request is met" stays a recorded maintainer decision |
> | ceiling gate inert | armed from recorded evidence, and a missing block is now loud (`38f5a02`) |
>
> Two things are deliberately left open, both named with what would close them: a
> `signalstats`-over-rendered-file fit to settle the chroma range (T16.4), and the SigLIP 2
> ONNX export's licence (T16.5).

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
  - Owner: ______  Result: 09/08/2026 · **RESOLVED** — CodeQL now reports **pass** on the
    PR head (`Analyze (python)`, `Analyze (javascript-typescript)`, `Analyze (actions)` all
    green). The 42 alerts are no longer outstanding on this PR; no dismissal is needed.

- [x] **T16.2. Vercel deployment blocked** — check whether the website build is actually
      affected by this PR or whether the block is unrelated to the diff.
  - Owner: —  Result: 09/08/2026 · **UNRELATED TO THE DIFF — not a merge blocker.**
    `git diff main...HEAD -- apps/website` is **empty**; `apps/website/package.json` and
    `pnpm-lock.yaml` are both unchanged; and the website declares **no** `@framepilot`
    workspace dependency, so nothing in this PR can reach its build. The status text is
    "Deployment was blocked", which is a project/account gate rather than a failed build.
    Settle it in the Vercel dashboard; it is not evidence about this branch.

- [x] **T16.3. The behavioural payoff is unmeasured** — **MEASURED 2026-09-08**
  - Nothing here has been measured for its effect on **edit quality**. Whether first-pass
    acceptance improves needs a live golden run against a real provider.
  - Per repo memory: run it **detached**, or your own vitest kills it. `--replay` is free but
    needs the sidecar on `:8799` for scoring. Recorded session-6 runs are a free regression
    suite; `reports/golden/s9-*` are this PR's own baselines.
  - The gate to watch: `framesSeenPerEdit` must **not** rise. A rubric improvement bought
    with frames is not the improvement this plan set out to make.
  - Owner: —  Result: 09/08/2026 · **MEASURED — and the central claim holds.**

    First, why it had never been measured: the harness **never sent the shot ledger**, so
    every perception case saw an unmeasured project and took its refusal path. Fixed in
    `c884595`; that is also why no recorded run carries a `perception` block and why the
    T1.2 gate row reads "not measured".

    Live run `reports/golden/vu-ledger-all` — 9 cases, 11 turns, `openrouter/auto`, against
    a `mission-montage` indexed keyless at tier 0:

    | metric | baseline (`BASELINE.md`) | this run |
    | --- | --- | --- |
    | **frames seen / accepted edit** | 0.00 | **0.00** |
    | footage-surface calls / run | 0.00 | 0.00 |
    | grade/transition guess rate | **1.00** | **0.50** (6 of 12) |
    | operation validity | — | 100% |
    | reversibility | — | 100% |

    **`framesSeenPerEdit` did not rise — it stayed at the floor of 0.00** across every new
    colour, transition, duplicate and footage-question case. The agent answered "which
    clips show the host", "what's on screen at", and "find the dark clips" **without
    decoding a single frame for a model**, which is the plan's whole thesis. And the guess
    rate halved from the 1.00 baseline: the solvers are computing numbers the model used to
    invent.

    The one-case before/after for the harness fix, same model and fixture:
    `match-color-to-first-clip` went `score 0.45 / intent failed / 0 ops / $0.108` →
    `score 1.00 / first-pass yes / 1 op / $0.021`.

    Caveats, stated plainly: one run, one model, one fixture project, and `openrouter/auto`
    is not the provider the PR's own figures were taken on. This measures the perception
    claim, not overall edit quality — see the three misses recorded in T5.4, T9.1 and the
    note below.
  - **Follow-ups this run surfaced** (none of them merge blockers, all recorded):
    1. `warmer-subtle` — **investigated, and it was the rubric, not the solver.**
       `apply_look(warmer, subtle, trackId)` was called correctly, once, for the layer, and
       landed `temperature 0.56` on clip_004. clip_004 is asset_004, which the ledger
       measures at luma_mean **0.1271** — the darkest clip in the fixture. Warmth response
       scales with luma, so a +0.05 warmth target there solves to 0.05 / (0.6936 × 0.1271) ≈
       **0.57**; the run produced 0.56. The solver was right to a hundredth, doing exactly
       the scale-free thing T5.4 requires. The rubric's flat 0.5 parameter cap was failing a
       correct solve for being applied to dark footage — fixed, see T16.4.
    2. `reorder-last-first` — failed **twice** on `openrouter/auto` in the T9.1 shape: the
       first `reorder_clips` was correct, then four more re-applied "move the last to the
       front" against the timeline it had just changed, rotating a 5-clip list back to its
       original order, and the run reported "Applied 5 edits". It passes **4/4** on
       `claude-sonnet-5` in the recorded s9 runs (1 op, 3–4 calls), so the T9.1 fix holds on
       the measured provider and this is a weaker-model failure.
       **Hardened 2026-09-08:** `reorder_clips` now refuses the order the track is already
       in (`order_already_applied`). That is precisely the call that did the damage — the
       fifth, which asked for the original order — so the run can no longer silently undo
       its own correct edit, and an accepted no-op can no longer reset every run-stopper as
       if a clip had moved. **What it does not do:** stop a model that keeps issuing
       genuinely new orderings. A rotation only repeats itself at the start, so this catches
       the undo, not every wasted step. Making a run stop once a positional request is *met*
       is conductor-level progress accounting (`kernel/conductor.ts`), and is left as a
       maintainer decision rather than guessed at — see the note below.
    3. The three `question` cases scored **1.00** on their checks while recording
       `intent=failed`. Right answer, failure-shaped verdict — worth a look alongside T9.2.
  - **Open, for the maintainer:** nothing in the kernel detects that a position-relative
    request has been satisfied. `callNoveltyKey` keys a mutation on its arguments, so five
    reorders with five different orderings each read as "learned something new" and the
    stall guard cannot fire. Closing that means teaching progress accounting about
    *arrangements the run has already produced*, which is a behavioural change to the run
    loop and wants its own slice and evidence.
  - Owner: ______

- [x] **T16.4. Colour coefficients unfitted** — see T5.7. Decide whether to fit before merge
      or ship the derived model and fit later. `fit-color-response.mjs` is ready.
  - Owner: —  Result: 09/08/2026 · **FIT RUN. DECISION: ship the derived model, and here is
    the evidence for it.**

    `fit-color-response.mjs` was **not** ready. It took `--clip` and `--time` independently
    and never checked the frame was on the graded clip, so its own documented example
    (`--clip c1 --time 1.0`) measured an ungraded frame in every grid cell and fitted
    **0.00000 to every coefficient** — printed under "paste into color-solver.ts". A zero
    response means the parameter does nothing; pasting it would have made the solver ask for
    an unbounded parameter to move anything. It also read `fps` from `timeline` where it is
    top-level, so every frame index was wrong off 30fps. Fixed: the time defaults to the
    clip's midpoint, a time outside the clip is refused by name, a grid that moved nothing
    is reported as a failed measurement rather than a fit, and the useless `<= 0`
    low-contrast warning now fires at a threshold set from measurement.

    Then it was run properly against a live sidecar on three clips of `mission-montage`:

    | constant | derived, in use | clip_002 (luma .544) | clip_004 (luma .078) | clip_001 (luma .406) |
    | --- | --- | --- | --- | --- |
    | `EXPOSURE_RESPONSE` | 1.0 | 0.755 | 0.964 | 0.793 |
    | `CONTRAST_RESPONSE` | 1.0 | 0.959 | −0.251 † | 0.788 |
    | `SATURATION_RESPONSE` | 1.0 | 0.689 | 0.807 | 0.633 |
    | `WARMTH_PER_TEMPERATURE` | 0.6936 | 0.567 | 0.633 | 0.576 |
    | `GREEN_MAGENTA_PER_TEMPERATURE` | −0.0411 | −0.005 | +0.021 | −0.060 |
    | `WARMTH_PER_TINT` | −0.0429 | −0.043 | −0.041 | −0.043 |
    | `GREEN_MAGENTA_PER_TINT` | −0.5236 | −0.524 | −0.497 | −0.519 |

    † near-black frame, no spread for a ratio to scale, fit returns the wrong SIGN. Warned
    on now; not a measurement.

    **The tint coefficients are confirmed** — three clips spanning 7× in luma agree within
    5% and match the derivation. **`WARMTH_PER_TEMPERATURE` is consistently ~15% lower than
    derived** (mean ≈ 0.59 vs 0.6936), so the solver under-shoots warmth slightly; that is a
    real, repeatable disagreement. It is **not** adopted, for a stated reason: the script
    reconstructs warmth from RGB through the same BT.709 matrix the solver assumes, so it
    cannot separate a wrong matrix from a shallower renderer curve — the one question that
    most deserves settling still needs a `signalstats` pass over a rendered file, a second
    script that does not exist. And the `*_RESPONSE` terms are the CLIPPING efficiencies, so
    they are material-dependent by construction (the darkest clip fits nearest 1.0, having
    the most headroom); one number cannot be right for all footage.

    So: coefficients unchanged, now by decision rather than for want of a measurement, with
    the table recorded in `color-solver.ts` itself. **Not a merge blocker** — and T5.7's
    "judge on direction and proportionality" advice is now backed by numbers.
  - Follow-up for the maintainer: a `signalstats`-over-rendered-file fit to settle the
    chroma range, then adopt `WARMTH_PER_TEMPERATURE ≈ 0.59` if it survives.

- [ ] **T16.5. Pack weights and licences** — VU5/VU6 cannot go live until each pack's
      quantisation/export/release artifact licence is verified and `models.lock.toml` carries
      real digests. Each pack's plan section carries the exact steps.
  - Owner: ______  Result: 09/08/2026 · **MOSTLY CLOSED** by `00d1221` — both lock files
    carry real digests, `--check` passes, and all four packs register healthy. `pnpm
    license:scan` is clean (7 packages, no denylisted licences). **One row stays open on
    purpose**: the SigLIP 2 ONNX export declares no licence of its own, and the commit
    records what replaces it if that answer comes back negative. That is the remaining
    decision here — it gates shipping the pack, not merging this PR.

- [x] **T16.6. `.env.example` line for TwelveLabs** — per repo memory this was still pending
      from the earlier TL work. Confirm whether this PR closed it or it is still open.
  - Owner: —  Result: 09/08/2026 · **CLOSED** — `TWELVELABS_API_KEY` is in `.env.example`
    (line 147) and in `turbo.json` `globalEnv` (line 16), as are both new pack handles.
    One source of truth holds; nothing is in one file and missing from the other.

- [ ] **T16.7. Fixture labels are a human pass** — `tests/fixtures/mission/labels/{tier0,tier1,tier2,cuts}.json`
      score the answer cases. `packages/ai-sdk/scripts/contact-sheet.mjs` exists to make that
      pass possible in one sitting. Confirm the labels were actually eyeballed, not generated —
      a generated label set scores the model against itself.
  - Owner: ______  Result: 09/08/2026 · **CONFIRMED GENERATED, NOT EYEBALLED — still open.**
    `tier2.json` says so itself: `"note": "SCAFFOLD for the first 50 shots... neither ran,
    so every field is null"`, `source: "unlabelled"`, `verified: false` on every row. So it
    cannot score anything today, and nothing currently claims it does. Partially mitigated
    rather than closed: `workers/visual-describe/eval/` now measures a caption-quality floor
    that needs no labels at all, because its fixtures' content is true by construction — but
    VU6.5's ≥80% subject/setting agreement still needs the human pass, and
    `packages/ai-sdk/scripts/contact-sheet.mjs` is what makes it possible in one sitting.

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
