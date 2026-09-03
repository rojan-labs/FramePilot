# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-03 session on `feat/golden-eval-harness` (PR #75).
18 commits, `c0ed08e..cc86cb0`, all pushed, CI green.

Read `goal.md` first, then this. The short version: **Phase 0's instrument was
measuring itself rather than the agent, and most of this session went into
fixing the instrument.** It is now trustworthy enough to trust a baseline from.
The baseline itself is still not finished.

---

## 1. THE ONE BLOCKING TASK — finish the baseline

Nothing that reports a delta can proceed until this lands. Everything in §4 is
parked behind it.

### Preconditions

```bash
# 1. sidecar, rooted at the fixtures, on :8799. There is NO `pnpm engine:serve`.
cd engine/python && FRAMEPILOT_PROJECTS_ROOT=/ABSOLUTE/path/to/tests/fixtures/mission/projects \
  uv run framepilot serve --host 127.0.0.1 --port 8799
curl -s http://127.0.0.1:8799/health          # {"status":"ok",…} before continuing

# 2. build — the runner imports dist/
cd /path/to/FramePilot && pnpm --filter @framepilot/ai-sdk build

# 3. fixture projects (already built on this machine; rebuild only if media changed)
cd packages/ai-sdk && FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 \
  node scripts/mission-fixture-projects.mjs
```

### The run

```bash
nohup env FRAMEPILOT_AI_PROVIDER=claude-agent-sdk \
  FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5 \
  FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 \
  node packages/ai-sdk/scripts/mission-baseline.mjs --runs 3 --label baseline --yes \
  > /tmp/baseline.log 2>&1 &
```

21 cases × 3 runs. Roughly 1–3 hours and $20–40 of Sonnet at observed rates.

**Then, and only then:**

```bash
pnpm eval:golden:gate reports/golden/baseline.json --write   # accept as the floor
```

`--write` now warns if the floor it records gates nothing. **Read that warning.**
If it names any metric, the run is not a floor — find out why before accepting.

### Four traps that each cost real time in this session

1. **Run it detached, on an idle machine, and do not build or test while it runs.**
   The runner was killed four times — silently, no stack trace, no exit line, the
   case in flight simply never finishing. Every death followed a local
   `pnpm build`, `tsc -b`, or `vitest run`. It holds 200k-token prompts for hours
   and loses to memory pressure. Per-case results are on disk, so re-invoking the
   same command resumes; the cost of a death is the case in flight.
2. **Never run two runners against one `--label` at once.** The final attempt
   produced an impossible case set (`refine-tighten-r3` and `memory-captions-r1`
   present while `remove-dead-air` was absent), which is two processes racing on
   `reports/golden/baseline/cases/`. `pkill -f mission-baseline` before starting.
3. **Exported shell env beats `.env`** — the runner only fills in what is
   undefined. A stray `FRAMEPILOT_AI_PROVIDER=mock` yields a complete, plausible,
   entirely meaningless run. Check `env | grep FRAMEPILOT` first.
4. **Quota exhaustion looks like a broken agent.** The first full run ran out
   after six cases; the remaining fifteen recorded "couldn't reach
   claude-agent-sdk". Those are now excluded and counted as `voidTurns` — if the
   summary reports any, re-run those cases before writing a floor.

### Where the last attempt got to

Killed deliberately, part-way. All three `montage-30s` runs scored **1.00,
first-pass**, at ~5 calls / ~100k tokens / ~75s. `podcast-highlight-60s` r1/r2
scored 0.75 with `intent=failed` — see §3, that case is invalid on current media.
Everything from `remove-dead-air` onward is unrun. Delete
`reports/golden/baseline/` and start clean rather than resuming that directory.

---

## 2. WHAT CHANGED, AND WHY YOU SHOULD RE-READ ANY EARLIER BASELINE

Any golden number recorded before this branch is wrong. Four of goal.md's ten
metrics were structurally dead and all four read as calm.

**The instrument (fixed here):**

| Defect                                                                                                                        | Effect on the numbers                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixture builder hand-laid clips at raw media durations, bypassing `quantizePatch` — the boundary every real placement crosses | `cuts-on-frame-grid` failed on **every** case regardless of the agent → `boundaryPrecision` 0%, `firstPassAcceptance` 0%, `tokensPerAcceptedEdit` null                                                                                                                                                 |
| `cuts-on-frame-grid` and `no-mid-word-cuts` scored end state, not the delta                                                   | Inherited defects charged to the run (`mission-podcast` has one mid-word edge from whisper rounding the last word past the media end)                                                                                                                                                                  |
| `cuts-on-beats` scored against a nominal 0.6s grid                                                                            | The detector reads the fixture as 99.4 BPM; the runtime snaps to _detected_ onsets. A run hitting exactly what it aimed at could not score above ~60%                                                                                                                                                  |
| Provider transport failures scored as agent decisions                                                                         | 15 void cases dragged a run that was 83% intent / 100% target down to a reported 14% / 53%                                                                                                                                                                                                             |
| **Memory Store leaked between runs**                                                                                          | Run 1's answers persisted into runs 2 and 3 via a fixed project id. `decisions.md` accumulated "Follow this on later turns unless they change it", so run 3 of `refine-tighten` opened by refusing to edit — "the editor has now been asked three separate times". Three runs were never three samples |
| Gate accepted a floor of 0/null silently                                                                                      | A dead metric would print "held" forever                                                                                                                                                                                                                                                               |
| Summary header took the provider from the _current_ invocation                                                                | A regenerated Sonnet run was labelled `provider mock`                                                                                                                                                                                                                                                  |

**The product (fixed here):**

| Defect                                                                                                    | Effect                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failure card printed the check's _label_ — a positive assertion — not its detail                          | "the run could not finish: **Reframing is consistent.**" on 30 correct edits                                                                                                                           |
| `checkReframeCoverage` asked "has a crop?" instead of "fills the frame?"                                  | Failed a montage over the one clip that correctly needed none. Fixing it turned the case from failure into first-pass and cut cost ~73% — the agent had been burning verify-fix turns on a non-problem |
| Same proxy in `checkTreatmentCoverage`                                                                    | "no black bars" scored by counting crops                                                                                                                                                               |
| `explicitDurationTarget` could not read "cut this down to 45 seconds", "the best 60 seconds", "highlight" | A stated length became no target, so nothing ever checked it                                                                                                                                           |
| `readsAsDuration` was blind to hyphens (pre-existing, on main)                                            | **"use 30-second cuts" read as a floor of thirty shots**                                                                                                                                               |
| No ASR-loop detection anywhere                                                                            | A hallucinated transcript silently grounded every transcript-based edit                                                                                                                                |

---

## 3. TWO THINGS THAT NEED THE MAINTAINER, NOT AN AGENT

Neither is a bug to fix. Both are decisions, and both currently depress metrics.

### 3.1 `guard-wipe-timeline` cannot pass as written

`goal.md` asks for confirmation of scope before a wipe. **ADR 0166 removed the
wipe guard outright and explicitly refuses to replace it with "a confirmation
prompt, a threshold, or an opt-out flag"** — the measured cost was three requests
burned routing around a refusal on a rebuild the user had asked for.

Under the accepted ADR, the right answer to "Delete everything on the timeline."
is to delete everything. The case fails twice over (`intent: ask`,
`rubric: unchanged`) and holds down `intentAccuracy` for behaviour the project
decided is correct.

Left as written and annotated in `golden-cases.ts` rather than quietly conformed
to the ADR — erasing goal.md's stated requirement is as much a decision as
ignoring it. **Change goal.md or change ADR 0166; do not "fix" the agent.**

### 3.2 `podcast-highlight-60s` measures nothing on current media

`speech-9min.mp4`'s transcript is **2384 of 2431 words = "I'll try to follow you
later." repeated 397 times**, from 21.7s to 575.5s, built from seven distinct
tokens. Real speech stops around 30s. The media is real; whisper looped over the
quiet audio, and it is cached by content hash so re-transcribing reproduces it.

An agent that refuses the case — "only ~30 seconds of genuinely distinct content"
— is **correct**, and the rubric records it as failing.

**Fix: replace the media with a recording that has continuous speech.** Cases
that cut on silence (`remove-dead-air`) are unaffected; silence detection never
reads the transcript. Until then, do not read `podcast-highlight-60s` as a
measure of highlight selection. `detectTranscriptLoop` now flags this at fixture
build time, in the Critic (`transcript_reliable`), and in the rubric.

---

## 4. PARKED BEHIND THE BASELINE

Per goal.md, no prompt / tool-description / model change can report a delta until
the floor exists. Do not start these first.

- **Prompt and tool-description work.** Note `golden-manifests-track-prompt-text`:
  skill and descriptor edits shift the ai-sdk token goldens, and the diff _is_ the
  measured token delta. Three separate regen commands.
- **Model tiering** (`FRAMEPILOT_TIER_*`, currently opt-in). Cost work must be
  proven neutral-or-positive on accuracy — priorities 1–3 are never traded for 5.
- **Cost per accepted edit is not measurable in dollars.** `cost-meter.ts` prices
  from a per-tier table; the vendored catalogue has `cost: null` for all 279
  models. The summary row is named "tier-priced cost / accepted edit (not
  billed)" for that reason. Real spend needs a price source, which is a
  dependency decision — ask before adding one.

---

## 5. LEADS NOT YET RUN DOWN

Real signals seen in partial runs, none diagnosed. Confirm each against a clean
baseline before acting — several earlier "agent failures" turned out to be the
instrument.

1. **The agent confabulates prior conversation.** Most instances traced to the
   memory leak (§2) and should be gone. But `podcast-highlight-60s` r2/r3 said
   "the editor already told us to stop here" on a **single-turn** case, and it is
   worth re-checking whether anything besides the Memory Store carries state
   across runs. If it recurs on a clean baseline, it is a real honesty defect.
2. **Beat alignment.** The rubric now scores against detected onsets, so re-run
   `beat-sync` before concluding anything. If it still fails, the question is
   whether the agent sets `hardSync` on `detect_beats` — the tool description
   asks for it on "cut to the beat", and the runtime only _enforces_ alignment
   when it is declared.
3. **`remove-dead-air` sat at 0.88** across three runs, failing only
   `no-mid-word-cuts` — which was scoring against the hallucinated transcript and
   is now reported as not measurable. Expect this to clear; verify.
4. **`refine-tighten` turn 2** failed once with `ops: 3` and `intent=failed`
   under the memory contamination. Unknown whether anything remains underneath.
5. **The `usd` column is not spend** (§4). Do not quote it to anyone.

---

## 6. HOUSEKEEPING

- `tests/fixtures/mission/manifest.json` is modified in the working tree. **That
  is the maintainer's, from a `fetch-fixtures.sh` run — it predates this session
  and was deliberately left alone.** Do not commit or revert it blindly.
- `reports/golden/baseline/` and `reports/golden/baseline.json` are untracked
  partial output from the killed run. Safe to delete; see §1.
- The sidecar and all runners were stopped at the end of this session. Nothing is
  running.
- Memory files worth reading before starting: `golden-eval-harness`,
  `mission-podcast-transcript-hallucinated`, `verification-judges-the-delta`,
  `never-git-add-all-framepilot` (fixture media is un-ignored — a blanket `git
add -A` put 3.8 GB in history once).
- Formatting: only three files on this branch were prettier-clean at the branch
  point and were formatted. The rest are part of the repo's existing red
  `format:check` baseline — **format only files you find clean**, or the diff
  drowns in unrelated churn.
