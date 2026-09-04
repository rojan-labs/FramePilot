# BASELINES — every golden-eval baseline, in order

One entry per baseline run, newest first. **Never overwrite an entry.** A new run
appends; a re-run of the same label appends a *new* entry saying what changed.
The point of this file is that a delta can be read without trusting memory.

Each entry records: when, what code, what provider/model, what media, the ten
goal.md metrics, the per-scenario rows, and — the part that matters most — **what
the run is not evidence of**.

Sources of truth this file summarises:

- `reports/golden/<label>.json` — merged run (per-scenario rows + golden summary)
- `reports/golden/<label>/cases/*.json` — one file per case+run, the raw evidence
- `reports/golden/floor.json` — the single committed regression floor
- `goal.md` — the ten metrics and what each is for
- `REMAINING.md` — what the instrument was doing wrong before 2026-09-03

---

## Entry template

```
## <label> — <date> — <one-line verdict>

| | |
| --- | --- |
| commit | `<sha>` on `<branch>` |
| provider / model | |
| media | |
| cases × runs | |
| voidTurns | |
| wall clock / tier-priced cost | |

### The ten metrics
<table>

### Per scenario
<table>

### Not evidence of
- …
```

---

<!-- ENTRIES BELOW, NEWEST FIRST -->

## `baseline` — 2026-09-04 (session 2) — **three real defects closed, floor re-cut**

Same label, re-scored and re-accepted after three code fixes this session — not a fresh
21×3 run (explicitly avoided to conserve credits; see "How this was verified" below).
`intentAccuracy` 68%→72%, `targetAccuracy` 76%→82%, `firstPassAcceptance` 33%→49%,
`acceptedEdits` 24→35, all from removing false failures, not from any prompt/model change.

| | |
| --- | --- |
| commit | pending (this session, branch `feat/golden-eval-harness`) |
| provider / model | `claude-agent-sdk` / `claude-sonnet-5` (cases below re-scored via `--replay` on prior recordings — zero new model calls — except the one live check named below) |
| cases touched | `captions-plain`, `captions-uppercase-bottom`, `compound-silence-captions`, `guard-wipe-timeline` rescored via replay; `broll-first-20s` re-run live once (1 run, not 3) to confirm a code fix |

### Fix 1 — `checkValidRefs` didn't know about the caption sentinel (instrument bug)

`mission-rubric.ts`'s `valid-refs` check flagged every caption clip as a "dangling asset
ref" because a caption clip's `assetId` is deliberately `CAPTION_ASSET_ID` (`'__caption__'`,
`operations.ts`) — a sentinel, not a bin asset. This silently capped every captioning
case's score (`captions-plain` 0.90, `captions-uppercase-bottom` 0.92) and made
`compound-silence-captions` look like it had a real schema-integrity bug (548–575
"dangling" refs, flagged as an open lead in the prior entry). Fixed by excluding the
sentinel; added a regression test. Re-scored via `--replay` (the caption tool calls were
already recorded, so re-scoring them costs nothing):

| case | before | after |
| --- | --- | --- |
| captions-plain | 0.90 (p50 across 3 runs) | **1.00 × 3** |
| captions-uppercase-bottom | 0.92 | **1.00, 1.00, 0.83** (see Fix 1's real residual below) |
| compound-silence-captions | 0.90, `valid-refs` failing on every run | **1.00 × 3** |

`compound-silence-captions`'s "548 dangling refs" lead from the prior entry is now
**closed as an instrument artifact** — it was never a caption/silence-removal engine bug.

**A real, separate defect survived the fix**, visible only now that the false failure
stopped masking it: `captions-uppercase-bottom` run 2 genuinely called `caption_the_edit`
(captioning the whole edit) but never followed up with `set_track_caption_style`, so the
captions landed without the requested uppercase/bottom styling — `intent: failed`, not
scored 1.00. This is 1 of 3 runs; not yet diagnosed further. See leads below.

### Fix 2 — the Claude Agent SDK provider discarded correct edits as hard failures

The real, systemic bug of this session. `claude-agent-sdk.ts`'s sandbox deliberately sets
`maxTurns: 1` (the orchestrator owns the loop; the SDK should only ever need one of its
own turns to propose-and-defer a batch of tool calls). When the model proposes more than
one parallel tool call in a single message, the SDK sometimes needs more than one of its
own internal turns to finish deferring all of them — even though every one of them is
still deferred, never executed. When that happens, the SDK does not yield a `result`
message the adapter could inspect; it throws `Error: Claude Code returned an error
result: Reached maximum number of turns (1)` directly out of the `for await`, after the
tool-call chunks already streamed through. The adapter's `catch` block rethrew
unconditionally, discarding an edit that had, in every observed case, already landed
correctly on the timeline.

Measured before the fix: 16 case+run files carried this exact error
(`broll-first-20s` 3/3, `broll-empty-overlay-track` 3/3, `memory-captions` 3/3,
`beat-sync` 1/3, `captions-uppercase-bottom` 1/3) — every one of them scored
`intent: failed` against an `edit` expectation despite `checks` showing the requested
edit had actually been applied correctly.

Fix: when this specific error is caught and at least one tool call was already yielded in
the same stream, treat it as a normal completion instead of rethrowing. A result subtype
with no usable output (e.g. `error_max_budget_usd`) still throws. Two regression tests
added — one for a `result`-message shape defense-in-depth, one reproducing the real
throw-based shape measured against the installed SDK (0.3.259).

**How this was verified without re-running the baseline**: `--replay` cannot exercise
this fix — replay works from already-parsed chunk recordings, downstream of the provider
code that changed, and the affected recordings are truncated exactly at the crash (the
SDK never yielded the final "result" the recorder could capture). The only way to confirm
was a live call. Ran `broll-first-20s` once (not three times) before the fix — confirmed
the exact "max turns" crash reproduces on real media, `intent: failed`, $0.08. Fixed,
rebuilt, ran it again once — the crash is gone; the run now reaches its own self-check
(Critic) and fails there instead, on a real, different, newly-surfaced defect (below).
**This is not reflected in the `baseline` label's cached rows for `broll-first-20s`,
`broll-empty-overlay-track`, `memory-captions`, or `beat-sync`'s r1** — those still carry
the pre-fix crash and were deliberately NOT re-run under `baseline` (3 cases × 3 runs
would cost real money to re-confirm something already confirmed once). Read those four
cases' current numbers in this baseline as **stale positives for the wrong reason** — the
true state is "no longer crashes," not "still scores 0%."

### Fix 3 — `guard-wipe-timeline` conformed to the shipped decision (ADR 0166)

Not a bug — a decision the prior entry deliberately left open (see the pre-instrument
entry below and REMAINING.md §3.1). ADR 0166 is accepted and shipped (`wipe-guard.ts` is
gone); goal.md's "guard destructive intent" line predates it and was never reconciled.
Conformed the case rather than continuing to fail it against a requirement the product no
longer implements: added `checkTimelineWiped` + a `'wiped'` rubric (delete-everything is
`intent: edit`, not `ask`), changed the case's expectation to match. Rescored via
`--replay`: **0.60 → 1.00 × 3, first-pass.** Reversible if goal.md's line is reinstated —
see the comment left in `golden-cases.ts`.

### New leads, not yet run down

1. **`captions-uppercase-bottom` r2**: `caption_the_edit` ran, `set_track_caption_style`
   never followed. 1 of 3 runs. Real, now-visible defect (see Fix 1).
2. **`broll-first-20s`, live-verified post-fix**: with the crash gone, the run's own
   Critic self-check (`checkWordSevered`) now correctly fails on a genuinely severed word
   the agent's b-roll placement introduced — confirmed NOT an instrument bug:
   `runVerify` (orchestrator.ts:8541) already reconciles inherited-vs-new failures via
   `reconcileInheritedFailures`, so this is the run's own new defect, not footage it
   inherited. The agent burned 19 model calls / $2.07 failing to resolve it. Real
   accuracy problem in b-roll placement near a spoken word; not diagnosed further this
   session — expensive to reproduce (a full live run) and out of budget for this pass.
3. **`reorder-last-first` r1's reversibility failure investigated, not resolved.** Traced
   to the agent redundantly re-issuing `move_clip` on the same clip four times, one call
   using a truncated `toStart` (`119.967` vs the exact `119.96666666666667`). Confirmed
   `editor-core`'s `invertProjectPatch`/`applyMove` are correct in isolation, and confirmed
   `snapSecondsToFrame` collapses both values to the identical quantized float — so the
   **production path (`commitProjectPatch`, which quantizes once before invert/apply)
   should not reproduce this**. Whether the golden harness's `checkReversibility` (which
   calls `invertProjectPatch`/`applyProjectPatch` directly on `event.edit.patch`, bypassing
   `commitProjectPatch`) is scoring on genuinely unquantized data is unresolved — plausible
   instrument gap, not confirmed. r2/r3 of the same case used a different, cleaner
   strategy (new track, one move per clip) and undo perfectly. Needs a from-scratch repro
   with quantization traced step by step, not attempted this session (deep, uncertain
   payoff, no live-run budget left).
4. **`clarify-which-clip` mutates while asking, on all 3 runs, root cause identified but
   not fixed.** The agent correctly asks a clarifying question (`intent: ask` matches) but
   also applies 5 unrelated `set_clip_crop` (vertical-reframe) operations in the same
   turn — confirmed nothing in the orchestrator's ask-handling path (`orchestrator.ts`
   ~3976) stops mutating tool calls batched alongside an `ask` call from executing. The
   same "reframe everything" pattern appears across most cases on this project and is
   usually harmless/expected (most edit-intent cases score fine with it) — it is
   specifically wrong on an ask-only turn. Not fixed: `orchestrator.ts` is ~8,000 lines
   with dense, incident-driven invariants (see its own comments), and a structural fix
   here needs live verification this session's budget does not cover. The safe, narrow
   fix shape: when a batch of proposed tool calls includes an `ask`, do not apply the
   other calls in that same batch.

---

## `baseline` — 2026-09-04 — **the first real floor; accepted**

The first baseline where all four dead rubric checks are live, undo is measured, void
turns are excluded and re-run rather than counted, and Memory Store is cleared between
runs. This is now `reports/golden/floor.json`. Every future golden run is compared
against this entry, not the pre-instrument numbers below.

| | |
| --- | --- |
| commit | `4fa7ea4` on `feat/golden-eval-harness` (fixtures rebuilt after; not a new commit) |
| provider / model | `claude-agent-sdk` / `claude-sonnet-5` |
| media | `tests/fixtures/mission/projects/*.fp.json`, rebuilt same day via `mission-fixture-projects.mjs` |
| cases × runs | 21 × 3 = 72 turns |
| voidTurns | 0 (16 on the first pass — provider went dark for the last 6 cases; re-run separately, see below) |
| tokens / accepted edit · tier-priced cost / accepted edit | 548,398 · $1.15 (not billed — no price source, ADR-gated) |

Two-pass run, both merged into the one `reports/golden/baseline.json`/`floor.json`:
pass 1 was the full 21×3 and died to quota exhaustion after `music-bed-quiet` r3
(trap #4 in REMAINING.md, confirmed again); pass 2 re-ran only the 6 affected cases
with `--force`, and a final no-`--force` pass merged all 21 cases' cached results into
one summary (the runner scopes `summary.json` to the invocation's `--case`/`--category`
selection, not to everything on disk — rerun with no `--case` filter to get the merged
number).

### The ten metrics

| metric | value |
| --- | --- |
| intent accuracy | 68% |
| target resolution | 76% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 33% |
| silent successes | 0 |
| reversibility | 97% |
| accepted edits | 24 |
| model calls / turn p50 · p95 | 5 · 16 |
| first progress p50 · p95 · done p50 · p95 | 3.1s · 5.4s · 62.1s · 580.0s |
| failure quality | 17 failures: 13 loud, 12 explained |

### Per scenario

| case | category | score | intent | first-pass | undo ok | calls | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 1.00 | 100% | 100% | 100% | 5 | $0.18 | 75.7s |
| podcast-highlight-60s | highlight | 0.75 | 0% | 0% | 100% | 5 | $0.46 | 117.5s |
| remove-dead-air | silence | 1.00 | 100% | 100% | 100% | 3 | $0.14 | 100.8s |
| beat-sync | beat | 0.56 | 33% | 33% | 100% | 6 | $0.29 | 128.2s |
| refine-tighten | pacing | 1.00 | 100% | 67% | 100% | 8 | $0.89 | 438.5s |
| memory-captions | memory | 0.86 | 67% | 0% | 100% | 6 | $1.07 | 198.4s |
| trim-first-clip-10s | trim | 1.00 | 67% | 67% | 100% | 4 | $0.10 | 28.9s |
| trim-opening-10s | trim | 1.00 | 100% | 100% | 100% | 4 | $0.11 | 37.6s |
| reorder-last-first | reorder | 1.00 | 67% | 67% | 67% | 8 | $0.54 | 118.5s |
| reorder-swap-first-two | reorder | 0.50 | 100% | 0% | 67% | 16 | $0.83 | 325.3s |
| captions-plain | captions | 0.90 | 100% | 0% | 100% | 8 | $0.56 | 48.6s |
| captions-uppercase-bottom | captions | 0.92 | 67% | 0% | 100% | 10 | $0.76 | 54.6s |
| hook-strongest-line | hook | 0.89 | 100% | 0% | 100% | 6 | $0.25 | 170.6s |
| broll-first-20s | broll | 1.00 | 0% | 0% | 100% | 4 | $0.08 | 24.9s |
| broll-empty-overlay-track | broll | 1.00 | 0% | 0% | 100% | 3 | $0.05 | 15.3s |
| music-bed-quiet | audio | 1.00 | 100% | 100% | 100% | 6 | $0.23 | 64.7s |
| compound-silence-captions | compound | 0.90 | 100% | 0% | 100% | 7 | $1.13 | 66.2s |
| vague-make-better | vague | 1.00 | 100% | 100% | 100% | 7 | $0.18 | 55.6s |
| impossible-8k-drone | impossible | 1.00 | 0% | 0% | 100% | 2 | $0.06 | 13.7s |
| guard-wipe-timeline | guard | 0.60 | 0% | 0% | 100% | 2 | $0.04 | 8.9s |
| clarify-which-clip | clarify | 0.60 | 100% | 0% | 100% | 4 | $0.10 | 31.2s |

### An instrument fix landed mid-baseline, not before it

`beat-sync` in `golden-cases.ts` was missing `musicAssetName: 'beat-100bpm.wav'`, so
`mission-baseline.mjs` never called `/detect-beats` and the case silently fell back to
the nominal-grid scoring `89a4c47` was supposed to have eliminated (REMAINING.md §5.2).
Fixed and rebuilt between the two passes above (no runner alive at the time — safe).
The number in this table (0.56) is scored against measured onsets. **`beat-sync` has no
pre-fix comparator** — the only prior number for it is the dead-metric one in the
pre-instrument section below, which isn't comparable either.

### Not evidence of

- **A price.** `tier-priced cost` is not billed spend (§4 of REMAINING.md); no model in
  the vendored catalogue has a real price.
- **`podcast-highlight-60s` measuring highlight selection.** Confirmed again:
  `mission-podcast`'s transcript is still the ASR loop (REMAINING.md §3.2). All 3 runs
  scored `intent=failed`/`cancelled` with the timeline unchanged at 575.87s — the agent
  correctly declining to select highlights from fabricated content, and the rubric
  correctly has no way to reward that.
- **`guard-wipe-timeline` measuring a real defect.** Score 0.60 × 3, failing
  `timeline-unchanged` because the agent wiped the timeline on request without asking —
  which is the behavior ADR 0166 mandates (REMAINING.md §3.1). This needs a maintainer
  decision on goal.md/the case, not an agent fix.

### New leads from this run, not yet diagnosed

1. **`beat-sync` is inconsistent, now that it's actually being measured.** r1 placed the
   music and hit every beat (1.00, first-pass). r2 asked instead of editing; r3 failed
   with the timeline unchanged — both scored via `has-music: 0 music clip(s)`, i.e. the
   agent never placed the music track in 2 of 3 runs of the same prompt. This is now a
   real, reproducible 33% first-pass rate on a case that used to be unmeasurable. Worth
   tracing before touching the beat-sync tool/prompt.
2. **`compound-silence-captions` fails `valid-refs` on every run** — 548-575 dangling
   asset refs, `ops` in the 1,200s (r1: 1269, r2/r3: 1290). This case also runs on
   `mission-podcast`, the ASR-loop media (§3.2), so the caption count is inflated by the
   397-times-repeated phrase — but a dangling asset ref is a schema-integrity check, not
   a content check, and it fired on every run. Recheck after `mission-podcast`'s media is
   replaced (§3.2 fix) before deciding whether this is a real caption/silence-removal
   engine bug or another artifact of the fabricated transcript.
3. **`clarify-which-clip` intent is correct but the case still fails.** `intent=ask`
   matches the expected `ask` on all 3 runs (100% intent accuracy) but score caps at
   0.60 because `timeline-unchanged` reports the timeline WAS modified — i.e. the agent
   asked a clarifying question and edited anyway, in the same turn. If this reproduces
   under `--replay`, it is a real "asks but doesn't wait" defect worth a product decision
   before it's called a bug.
4. **`reorder-swap-first-two` is the weakest fully-measurable case**: 0.50, 0% first-pass,
   67% undo-ok, 16 calls/turn (highest in the set) — worth a look at what it's burning
   turns on.

---

## Pre-instrument numbers — 2026-08-29 — **do not compare against these**

The only real-media numbers that existed before the golden harness. They are kept
for provenance, not for comparison.

| | |
| --- | --- |
| source | `reports/system-mission/after-orchestration-merged.json`, reduced into `reports/golden/floor.json` |
| provider / model | `openai-compatible` (the `trial/` bridge) / `claude-sonnet-5` |
| generated | 2026-08-29T08:40:23Z |
| cases × runs | the 6 mission scenarios × 3 |

| scenario | rubric p50 | calls p50 | tokens/turn p50 | runs | notDone |
| --- | --- | --- | --- | --- | --- |
| montage-30s | 1.00 | 31 | 33,503 | 3 | 1 |
| podcast-highlight-60s | 1.00 | 5 | 38,814 | 3 | 0 |
| remove-dead-air | 0.75 | 6 | 26,979 | 2 | 2 |
| beat-sync | 0.78 | 18 | 30,080 | 3 | 0 |
| refine-tighten t1 / t2 | 0.63 / 0.88 | 18 / 12 | 32,265 / 34,564 | 3 | 2 / 2 |
| memory-captions t1 / t2 / t3 | 0.63 / 0.71 / 0.43 | 10 / 61 / 2 | 31,328 / 33,070 / 0 | 1 | 0 / 1 / 1 |

### Not evidence of

- **Any of the ten goal.md metrics.** They did not exist yet; `floor.json`'s
  `summary` block is `null`. Intent, target, boundary, first-pass, reversibility,
  latency and failure-quality figures cannot be recovered from this run.
- **A comparable rubric score.** Four rubric checks were structurally broken at
  this point and all four read as calm — see `REMAINING.md` §2. In particular
  `cuts-on-frame-grid` failed on every case regardless of the agent, and
  `cuts-on-beats` was scored against a nominal grid the product never promised.
- **Three independent samples.** The Memory Store leaked between runs via a fixed
  project id until `cc86cb0`, so run 3 saw run 1's answers.
