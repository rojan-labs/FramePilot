# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-05 sessions on `fix/agent-reliability-2026-09-05`. Three sessions
have now happened on this branch; **`BASELINES.md` has an entry for each**, newest first,
and the numbers below mean nothing without them.

- **session 3** — thirteen defects read out of `run.md` (a captured desktop transcript,
  run `137d8fd0`) plus three of the previous session's open leads. No measurement.
- **session 4** — the first live baseline attempt since. It did not finish; the provider
  stalled ten cases in. Eight cases have clean evidence, and running it found **five more
  instrument defects**.
- **session 5** — no run. A second, systematic sweep of the same transcript (the full
  deduplicated inventory of its 44 failed and 42 warning tool calls, which session 3 did
  not read) plus the open items §2.2–§2.4 below. **Eight more defects closed**, one of
  which means four recorded scores must be read as upper bounds.

> **`run.md` is not a new run.** It has been offered as one twice. Its ids say otherwise:
> conversation `33f7e787`, run `137d8fd0`, 1,064,475 lines — the same file session 3 read.
> Check the run id before mining it as fresh evidence.

---

## 1. WHAT'S CLOSED

Thirty-six commits, each with a reproducing test. `pnpm typecheck` clean; ai-sdk 4,603,
editor-core 1,053 and engine 2,831 all green as of `118e7b1`.

Sessions 3 and 4 closed twenty-three defects — the list lives in `BASELINES.md` under
those entries and is not repeated here. Session 5 closed eight more:

1. **A refused duck named no track that would have worked** (`cb906ac`). `add_music` was
   given `layer_audio_5`, an audio track with no clips, and told "Place the dialogue
   first" — there is no dialogue in a snowboarding video. `v_main` was on the same
   timeline, full of clips, carrying the wind the bed was meant to duck. The guard was
   also stricter than the engine it protects: `_duck_intervals` reads clip intervals and
   never the track type, so a video track is a working sidechain. Every refusal now names
   the tracks that have clips.
2. **A rejected argument says which value it rejected** (`b738281`). Zod 4's enum message
   names every legal value and never the illegal one, and the finalized issue carries no
   input, so the value is read back out of the arguments. Near-misses (case, spacing,
   plural) get the option named; anything further apart is a different intention and is
   only quoted.
3. **A refused boundary says where the legal one is** (`1f29a5c`). `split_clip` on a
   boundary says the cut is already there and names the neighbour; outside the clip it
   names `get_clips`. The overlap rejection names the three moves that resolve it.
4. **The hook rubric stopped punishing the prompt it grades** (`f4cac2a`). See §2.1.
5. **A check that could not measure is no longer a check that passed** (`4c0cc0b`). See
   §2.2 — this one changes how four recorded scores read.
6. **An unattributed transcript stopped speaking through b-roll** (`d9ac392`). The third
   and last copy of the fabrication fixed in the Critic (`5d0dbab`) and the rubric
   (`a255687`); wired into `get_mapped_transcript`, which is the timing the model cuts on.
7. **The safe-area check had never looked at an overlay** (`70b8bfe`). It read `x`/`y` on
   a 0–1 scale; everything in this product writes `xPercent`/`yPercent` on 0–100. It
   answered "nothing positioned to check" on every project, forever.
8. **`duck_roles` can be reached at all** (`118e7b1`). `Track.role` shipped readable with
   exactly one writer — `add_layer`, at creation — so "Label the track you mean" named a
   move no surface could make. `set_track_flags` writes it now, in both runtimes.

---

## 2. WHAT'S STILL OPEN

### 2.1 The baseline still has not finished

Unchanged from session 4. Ten cases of twenty-one attempted, eight clean.
`reorder-last-first` and `reorder-swap-first-two` have **no clean run** — every one was
cut off by the harness timer while the provider answered at 122–660 seconds per call.
Their session-4 scores are not measurements and must not be read as a regression.

**Resuming is cheap**: per-case results are on disk, so re-invoking the same command (§4)
skips everything already recorded. Do it when the provider is answering normally — check
the first case's `wall`/`calls` ratio before letting it run unattended.

`hook-strongest-line`'s rubric contradiction is now REPAIRED (`f4cac2a`): the allowance is
the length of the opening the run added, which is exactly what a faithful prepend costs
and not a frame more. A restructure grows by nothing and passes as before; padding still
fails. The rubric is unit tested. **The case still cannot validate it** — it runs on
`mission-podcast` (§3).

### 2.2 Four recorded scores are upper bounds, not measurements

`checkNoMidWordCuts` said "unmeasurable, so it is not scored" and returned `ok: true`,
which `scored` counted in both the numerator and the denominator. Four rubrics carry it on
`mission-podcast`: `podcast-highlight-60s`, `remove-dead-air`, `compound-silence-captions`
and `hook-first`. Each was handed a free point on every run.

`RubricCheck.skipped` fixes it going forward. **Nothing in `BASELINES.md` was edited** —
read those four cases' recorded scores as upper bounds until a new run says otherwise.
That new run is the only thing that closes this.

### 2.3 A word too wide to wrap still overflows silently

The geometric half of §2.4-as-was is closed: `checkSafeArea` now warns when a box runs off
the side or a glyph height runs off the top or bottom, which is arithmetic on values the
project already carries and cannot raise a false alarm.

What remains is the case that needs font metrics. `wrap_lines` (`render/captions.py`) and
its preview twin (`overlay-painter.ts`) never split mid-word by design, so a single word
wider than the box overruns it. Both engines agree, so preview/export parity is intact —
the output is consistently wrong rather than divergently wrong. The two candidate repairs
are unchanged and both still carry risk worth measuring first: a glyph-width
approximation at the tool boundary can produce false refusals, and auto-shrinking in the
renderer would have to produce the *same* size in PIL and in canvas or it trades a wrap
bug for a parity bug.

### 2.4 The pinned-playbook budget is a product decision, not a defect

Unchanged. With the stable head attributed, the figure is **32,338 tokens per request —
57% of every agent request**, of which the system contract is 135. The rest is eight
pinned playbooks, and the cap of 8 did fire (the run was refused a ninth and a tenth).
ADR 0057 pins deliberately, so a playbook loaded at step 3 is still carried at step 153.
On a caching provider it is a cached prefix and costs a fraction of face value; the
transcript's run used OpenRouter, where it likely was not.

Session 5 added **+130 tokens per request** to the tool-schema section on top of that
(13,358 → 13,488), measured identically across all three frozen surfaces: +35 for
`add_music`'s ducking description, +95 for `set_track_flags`'s role. That is the price of
making two unreachable capabilities reachable, and it is the one number in this file that
a future session should weigh before adding more description text.

### 2.5 Reads are 42% of the run's tool calls

Unchanged, and still deliberately not fixed. 78 `get_timeline`, 19 `get_project_state`, 15
`get_timeline_summary`, 12 `get_mapped_transcript`, 11 `list_assets` — and **zero memo
hits across the whole run**. The store invalidates timeline-dependent evidence on every
applied patch and this run applied one almost every turn, so the memo genuinely could not
serve. The lever is `arrangementLine`, which the run receives after every applied turn and
which carries counts and ranges but **no clip ids**. Widening it is a context-budget trade
needing a measured before/after, not a fix — and §2.4's +130 is a reminder that the budget
is already moving in the other direction.

### 2.6 Things ruled OUT, so nobody re-investigates them

- **Compaction never fired.** Across all 309 manifests in `run.md`,
  `compaction.removedSections` is empty and no section is `included: false`.
- **Stop is not broken.** Five turns took 12–15 minutes to settle after the abort, which
  looks like it. The case files say the provider was answering at 217–660 seconds per call
  while another turn of the same case did ten calls in seventy-five seconds. The only real
  residue is that the abort is checked at turn boundaries.
- **The 144 `add_music` failures are one failure.** `op_31`, re-serialised into every
  subsequent run-state dump. The distinct-op count in that run is 421. Count distinct
  `op_N` ids before quoting a failure volume out of a state ledger.
- **A more specific error message is not free.** The overlap rejection was first written
  with its magnitude and the suite caught what that costs:
  `orchestrator.ts#deterministicFailureKey` keys the repeated-failure guard on the message
  body, and its contract is that the values a validator names ARE the defect's identity.
  An overlap shrinking from 3s to 1s then reads as two unrelated failures and the guard
  stops firing. **Any future message change on a validator path must be read against that
  guard.**

---

## 3. STILL NEEDS THE MAINTAINER — unchanged, and still the biggest single item

### `mission-podcast`'s transcript invalidates three cases

`speech-9min.mp4`'s transcript is **2,384 of 2,431 words = "I'll try to follow you later."
repeated 397 times**, from 21.7s to 575.5s. Five cases use that project:

| case | reads the transcript? | verdict |
| --- | --- | --- |
| `podcast-highlight-60s` | yes — selection | measures nothing |
| `hook-strongest-line` | yes — "the strongest line" | measures nothing; its rubric is now repaired but unvalidatable |
| `compound-silence-captions` | the caption half does | passes for the wrong reason: the cues it scores are 397 repeats of a sentence nobody said, and the rubric checks they are well-FORMED, not true |
| `remove-dead-air` | no — silence detection | its own work is unaffected; its `no-mid-word-cuts` check is now correctly SKIPPED rather than passed |
| `impossible-8k-drone` | no — refuses regardless | unaffected |

**Fix: replace the media with a recording that has continuous speech.** Not something an
agent can do unprompted. Until then, three of twenty-one cases are not measuring what
their names say.

---

## 4. RUNNING THE BASELINE AGAIN

Read `BASELINES.md` first. **Check the provider is answering before letting it run
unattended** — session 4 lost five turns and two whole cases to a stall it could not
detect, and the first case's `wall`/`calls` ratio tells you within two minutes (7–30
seconds per call is healthy; 120+ is not).

```bash
# 1. sidecar, rooted at the fixtures, on :8799. There is NO `pnpm engine:serve`.
cd engine/python && FRAMEPILOT_PROJECTS_ROOT=/ABSOLUTE/path/to/tests/fixtures/mission/projects \
  uv run framepilot serve --host 127.0.0.1 --port 8799
curl -s http://127.0.0.1:8799/health          # {"status":"ok",…} before continuing

# 2. build — the runner imports dist/, so it measures the code as of the BUILD
pnpm --filter @framepilot/ai-sdk build

# 3. the run. Use a NEW label; never --force an existing one.
nohup env -u FRAMEPILOT_AI_PROVIDER FRAMEPILOT_AI_PROVIDER=claude-agent-sdk \
  FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5 \
  FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 \
  node packages/ai-sdk/scripts/mission-baseline.mjs --runs 3 --label <new> --yes \
  > /tmp/<new>.log 2>&1 &
```

**What the next run is worth more than usual for:** it is the first that can say what the
four cases in §2.2 actually score, now that a check which could not measure stops awarding
a point. Expect those four to come DOWN, and that is the instrument getting more honest,
not a regression.

### Traps that have each cost real time

1. **`FRAMEPILOT_AI_PROVIDER=mock` is exported in this shell.** `env | grep FRAMEPILOT`
   first. `env -u` in the recipe above is why it is there — without it you get a complete,
   plausible, entirely meaningless run.
2. **The "do not build or test while it runs" trap is about MEMORY, not CPU.** A full
   `vitest run` of ai-sdk was OOM-killed mid-run in session 4. `tsc --noEmit` and targeted
   `vitest run <paths> --no-file-parallelism --maxWorkers=1` at `nice -n 19` are fine;
   never sweep.
3. **Never `--force` an existing label** — it overwrites per-case evidence in place.
4. **`--replay` is NOT a re-score.** Recordings hold `model_stream` and `host_tool`
   effects only, so replay re-executes the ORCHESTRATOR with current code.
5. **Quota exhaustion and provider stalls look like a broken agent.** Void turns
   (`tokens.prompt === 0`) and harness timeouts (`harnessTimedOut`) are both excluded from
   the rates and reported separately — read those two rows before reading anything else.

### Three frozen token surfaces, three regen commands

Any change to a tool description, a skill, or the system contract moves all three. They
are not interchangeable and a partial regen leaves a red suite:

```bash
FRAMEPILOT_GOLDEN_UPDATE=1 pnpm --filter @framepilot/ai-sdk test golden-corpus
pnpm --filter @framepilot/ai-sdk test src/kernel/streamAgent-golden.test.ts -- -u
FRAMEPILOT_GOLDEN_UPDATE=1 pnpm --filter @framepilot/ai-sdk test langchain-session-parity
```

The diff those produce **is the measured token delta** — read it before committing, and
put the number in the commit message.

---

## 5. HOUSEKEEPING

- `tests/fixtures/mission/manifest.json` is modified in the working tree. **That is the
  maintainer's, from a `fetch-fixtures.sh` run.** It was committed by accident once and
  backed out in `88ea280`. **Never `git add -A`, `git add .`, or `git add -u` in this
  repo** — stage by explicit path.
- **Never `git stash` in this repo**, including `--keep-index`. The user keeps long-lived
  stashes and a stray stash silently empties the working tree; it happened again in
  session 5 and was recovered with `git stash pop`. Check `git stash list` if the tree
  ever looks unexpectedly clean.
- Nothing is running. No runner and no sidecar were started this session.
- Memory files worth reading first: `golden-eval-harness`,
  `mission-podcast-transcript-hallucinated`, `unattributed-transcripts-lie`,
  `verification-judges-the-delta`, `never-git-add-all-framepilot`, `never-git-stash-framepilot`,
  `golden-manifests-track-prompt-text`.
- Formatting: only files prettier-clean at the branch point should be formatted. The rest
  are the repo's existing red `format:check` baseline. `BASELINES.md` and `REMAINING.md`
  are both in it — do not reformat them.
