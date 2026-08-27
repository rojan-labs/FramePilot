# 01 — Make the acceptance gate fire

**Status:** `[x]` done — 2026-08-27, commit `e952b77`

**What shipped.** The duration guard is span-local and `(?<![\d.])`-anchored, so a decimal's
fractional tail can no longer read as a count. Every stated count is read rather than the
first, marked floors beat aspirations, a range contributes its near end, and a search pool
is not a floor — the captured brief's `80-120 candidate clips` would otherwise have set the
criterion to 120 and failed a cut of 80 that did everything asked. Spec-style
`Minimum clips: 50` is read as well as `50 clips`. `checkShotCount` counts picture only (it
counted the music bed as a shot). A spec-length brief naming a count the reader cannot read
now warns rather than silently skipping.

**Verified.** The verbatim 9,885-char fixture from run `e36235cc` yields `50`; every
edge-case row passes; a 1-clip timeline against the brief reports
`2 check(s) failed, 1 warning(s)` with `ok = false`, which `conductor.ts` refuses to fold to
`complete`. 50 acceptance tests, 47 critic tests.
**Depends on:** nothing. **Blocks:** 02, 03 (they are unmeasurable until this lands).
**Blast radius:** `packages/ai-sdk/src/acceptance.ts`, `packages/ai-sdk/src/critic.ts`.
No schema change, no new subsystem, no new tool.

---

## Outcome

A run asked for 50 clips that delivers 1 **cannot report `completed`**. It reports
`failed` with `Deterministic acceptance checks still fail — 1 check(s) failed`, naming the
shot count, and the partial edits stay reviewable.

## Why this is first

`conductor.ts:1783` already enforces this:

```ts
const verificationPassed = r.ok && planReconciled && deliveredWork;
```

and `critic.ts:checkShotCount` already returns the right verdict. **Nothing needs to be
built.** One false-positive regex suppresses the criterion, so the check reports `skipped`
and `r.ok` stays true. The gate is correct and switched off.

---

## Change 1 — the duration guard must not match a decimal fragment

`acceptance.ts:118`, inside `explicitMinShotCount`:

```js
// current — `0.50s` in a beat-map example table kills a `50 clips` requirement
new RegExp(`\\b${match[1]}\\s*(?:s|sec|...|minutes)\\b`).test(normalized);
```

`\b` matches between `.` and `5` because `.` is a non-word character. The guard is meant to
reject _"30 second cuts"_; it also rejects any shot count whose digits appear as the
fractional tail of a decimal anywhere in the brief.

**Fix:** require the number not to be preceded by a decimal point or another digit, and
anchor the guard to the matched occurrence rather than to the whole document.

```js
const DECIMAL_TAIL = new RegExp(`[\\d.]${match[1]}\\s*(?:s|sec|...)`);
const guard = new RegExp(`(?<![\\d.])${match[1]}\\s*(?:s|sec|...|minutes)\\b`);
```

**Preferred, stronger form:** apply the guard **to the matched span only**, not to the
document. The bug is not really the `\b`; it is that a match at index 218 is invalidated by
text at index 4,900. `explicitMinShotCount` already knows where its match is — the guard
should ask "is _this_ occurrence a duration?", which is answerable from the match's own
neighbourhood.

### Edge cases this must handle

| Input                                                      | Expected            | Why                                                                                        |
| ---------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `50+ visually distinct clips` + a table containing `0.50s` | **50**              | the regression                                                                             |
| `30 second cuts`                                           | `undefined`         | the guard's real job — must still work                                                     |
| `use 30s clips`                                            | `undefined`         | same, no space                                                                             |
| `at least 50 separate video clips`                         | **50**              | `\s*s` must not eat `separate`                                                             |
| `0.5–1.0s per clip` (pacing table only, no count)          | `undefined`         | no count stated                                                                            |
| `**Minimum clips:** 50`                                    | 50 _or_ `undefined` | noun-then-number; see Change 2                                                             |
| `60–80 clips`                                              | 60                  | a range's near end is the minimum                                                          |
| `1000 subscribers`                                         | `undefined`         | `MAX_MEANINGFUL_SHOT_COUNT`                                                                |
| `2 clips`                                                  | `undefined`         | `MIN_MEANINGFUL_SHOT_COUNT`                                                                |
| `1080p` / `9:16` / `30fps`                                 | `undefined`         | no shot noun adjacent                                                                      |
| `50 clips` appearing only inside a quoted example          | 50                  | accepted; over-triggering here is safe because the Critic compares against a real timeline |

## Change 2 — read the strongest stated count, not the first

`explicitMinShotCount` uses `pattern.exec()` — **first match wins**. This brief states the
requirement six times (`50+ visually distinct clips`, `at least 50 separate video clips`,
`**Minimum clips:** 50`, `50+ clips minimum`, `Prefer 60–80`, `At least 50 genuinely
distinct clips`). First-match-wins is arbitrary; a brief that opens with a throwaway
_"a few 3-shot sequences"_ would set the target to 3.

**Fix:** collect **all** matches, drop those the (repaired) duration guard rejects, and take
the **maximum** of the surviving minimums — a brief that says both "at least 50" and
"prefer 60–80" has a floor of 50, and the floor is what the Critic checks. Take the max of
the _stated minimums_, not of every number: `60–80` contributes 60, not 80. This mirrors the
round-2 rule already recorded in `plan/PLAN.md` ("a range's far end … refused").

Also add `noun-then-number` order (`Minimum clips: 50`, `Clip count: 50`) — currently only
`number-then-noun` is matched, and spec-style briefs use both.

## Change 3 — make a skipped criterion visible

`checkShotCount` returning `skipped — "No shot count was asked for"` is indistinguishable,
in the run record, from a brief that genuinely stated no count. In this run that line was
the only trace of the failure and nothing surfaced it.

**Fix:** when a brief is long (say >1,500 chars) and contains a shot noun adjacent to a
number, but `minShotCount` came back `undefined`, emit a `warn`-level Critic check —
`"A clip count was mentioned but could not be read as a requirement."` This is a
self-diagnosing instrument for exactly the class of bug being fixed, and it degrades safely:
a warning does not block a run (`r.ok` counts only `fail`).

## Change 4 — the same guard shape elsewhere

Audit every reader that validates a number by testing a pattern against the **whole**
normalized prompt. Known: `explicitMinShotCount` (this bug), `explicitDurationTargetSeconds`
in `critic.ts` (round 2's bug, same family). Confirm the round-2 repair used a
span-local test and not a document-wide one; if it did not, it is the same latent bug.

---

## Verification

**Unit** — `packages/ai-sdk/src/acceptance.test.ts`:

1. A regression fixture holding the **verbatim 9,885-char objective** from run `e36235cc`
   (extract from `run.md`, store under `packages/ai-sdk/src/__fixtures__/`) →
   `explicitMinShotCount` returns `50`. This is the test that would have caught it.
2. Each row of the edge-case table above.
3. `acceptanceCriteria()` on that fixture includes
   `The cut uses at least 50 distinct shots.`

**Unit** — `packages/ai-sdk/src/critic.test.ts`:

4. `minShotCount: 50` against a timeline with 1 picture clip + 1 music clip →
   `checkShotCount` = `fail`, and the audio clip is **not** counted as a shot
   (`isOverlayClip` excludes overlays; confirm audio-backed clips are excluded too — round 2
   item 3 fixed exactly this for `picture_present` and the same rule must hold here).
5. `minShotCount: 50` with 50 picture clips → `pass`.
6. A failing `checkShotCount` drives `critique().ok === false`.

**Integration** — `packages/ai-sdk/src/orchestrator.test.ts` or `completion-gate.test.ts`:

7. A run whose final timeline has 1 clip against a 50-clip brief folds to **`failed`**, with
   `VERIFICATION_INCONCLUSIVE` carrying
   `Deterministic acceptance checks still fail — 1 check(s) failed.`
8. The partial edits remain in the diff and remain reviewable (the gate must not discard
   work — `conductor.ts` already keeps them; assert it).

**Commands:** `pnpm --filter @framepilot/ai-sdk test`, `pnpm typecheck`, `pnpm lint`.
Note `turbo run test:coverage` is the CI gate, not plain vitest.

---

## Edge cases and risks

- **False failures are worse than missed ones.** `acceptance.ts`'s own header says a wrong
  criterion "fails runs that did the work." Change 2 raises the target (max instead of
  first), so it can only make the gate stricter. Mitigate by requiring the number to sit
  next to a shot noun (already true) and by keeping `MAX_MEANINGFUL_SHOT_COUNT`.
- **A brief that mentions a count rhetorically** ("don't just throw 50 clips at it") would
  now set a 50-shot floor. Accepted: the Critic failure is informative, recoverable, and
  strictly better than the current silent pass. Change 3's warning covers the inverse.
- **Runs already in flight** are unaffected — acceptance is derived per run at interpret.
- **Do not** extend this to taste/rhythm. `acceptance.ts`'s header is explicit that
  inventing mechanical proxies for taste lets runs pass or fail on a measurement nobody
  asked for. Shot count is checkable; "hypnotic" is not.

## Definition of done

- [ ] The `e36235cc` objective fixture yields `minShotCount === 50`.
- [ ] Every edge-case row passes.
- [ ] A 1-clip timeline against a 50-clip brief reports `failed`, not `completed`.
- [ ] Partial edits survive the failure and stay reviewable.
- [ ] `pnpm verify` green.
- [ ] `docs/` + `CHANGELOG.md` updated; `plan/PLAN.md` snapshot records round 5.
