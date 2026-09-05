# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-05 session on `fix/agent-reliability-2026-09-05`. Two sessions
happened on this branch in one day; **`BASELINES.md` has an entry for each**, newest first,
and the numbers below mean nothing without them.

- **session 3** — thirteen defects read out of `run.md` (a captured desktop transcript,
  run `137d8fd0`) plus three of the previous session's open leads. No measurement.
- **session 4** — the first live baseline attempt since. It did not finish; the provider
  stalled ten cases in. Eight cases have clean evidence, and running it found **five more
  instrument defects**.

---

## 1. WHAT'S CLOSED

Twenty-seven commits, each with a reproducing test. `pnpm typecheck` clean across
`ai-sdk` and `web-editor`; every suite touching the changed code green.

### From the captured transcript (`run.md`, run `137d8fd0`)

1. **Stacked footage discarded the whole caption patch** — two clips over the same
   sequence seconds each produced a cue on frame 2, both deriving `caption_captions_70`.
   Ten calls, ~3,100 rejected operations, no captions at all. (`008cf0c`)
2. **`word_severed` failed a run on hallucinated words** — 416 applied changes reported as
   failed over words `transcript_reliable` had, in the same report, said not to trust.
   (`ebd66ea`)
3. **Selection-authored tools died at the agent's own first edit** (`506e55a`, +47
   tokens/request for the rewritten refusal).
4. **"Do not call it again" is now enforced** for tools with no route on this surface.
   (`1bd2f87`)
5. **An edit that changed nothing says so** (`95a9f03`).
6. **The reviewer could not parse the engine's own response** — FastAPI's explicit nulls
   against Zod `.optional()`; every perceptual review failed closed. (`09dd6d8`)
7. **`end` read as a length** now names the value that would have worked, on both the TS
   and Python boundaries. (`f51f4ee`)
8. **A caption style written in CSS spelling** is translated at the tool boundary.
   (`6099516`)
9. **Rejected arguments name the tool they belong to** (`8bc0328`).
10. **The budget notice says what actually happens next** (`dd09e3e`).
11. **An expired evidence handle says so**, instead of the answer a made-up id gets.
    (`5deae6d`)
12. **66 byte-identical repeats of an already-applied edit** are withheld when they also
    change nothing — both signals required. (`ed7839a`)
13. **The same shot, and the same title, twice** — nineteen video lanes for a sixty-second
    edit, the headline composited on itself. (`de9a12e`, `341c1b0`)
14. **52 of 416 edit cards were blank** — including all nine markers the user had asked
    for "so I can see what you picked". (`6c13939`)
15. **57% of every agent request was unattributed** — 32,338 tokens reported as `system`
    when the real contract is 135. Now `agent contract` / `committed plan` / `pinned
    playbooks (N)`. Proven not to change the payload: across all three frozen token
    surfaces, 66 opaque rows summing 157,225 tokens became 138 attributed rows summing
    157,225, and no `usedTokens` figure moved. (`ed7839a`, `7084fee`)

### From the previous session's open leads

16. **`clarify-which-clip` mutates while asking** — a turn that calls `ask_user` composed
    its edits before any answer existed. (`d482676`)
17. **`reorder-last-first` reversibility** — *not* the instrument gap that lead guessed.
    `applyMove` recomputes the clip's end from coordinates that already drifted, and
    `(toStart + d) - toStart` is not always `d`. Confirmed on real media in session 4:
    `ok — identical after 7 patch(es) undone`, three runs of three. (`bb8fb69`)
18. **`captions-uppercase-bottom` r2** — closed by fix 8.

### From running the baseline (session 4)

19. **`checkValidRefs` excluded `__caption__` and not `__text__`** (`a255687`).
20. **`refine-tighten` demanded a shorter programme for a prompt asking for a faster one**
    (`a255687`).
21. **`memory-captions` t1 asks for 45 seconds and was scored against 60** (`a255687`).
22. **`checkNoMidWordCuts` judged b-roll against the narration** (`a255687`).
23. **A turn the harness timed out was scored as the agent's behaviour** (`a8b58f7`) —
    this one changes how the whole session-4 comparison reads.

---

## 2. WHAT'S STILL OPEN

### 2.1 The baseline did not finish

Ten cases of twenty-one attempted, eight clean. `reorder-last-first` and
`reorder-swap-first-two` have **no clean run** — every one was cut off by the harness
timer while the provider answered at 122–660 seconds per call. Their session-4 scores are
not measurements and must not be read as a regression.

**Resuming is cheap**: per-case results are on disk, so re-invoking the same command
(§4) skips everything already recorded. Do it when the provider is answering normally —
check the first case's `wall`/`calls` ratio before letting it run unattended.

### 2.2 `hook-strongest-line`'s prompt and rubric contradict each other

Prompt: *"Start the video with the strongest line from the recording, **then continue from
the beginning as before**."* Rubric: `checkNotLonger`. Prepending a hook and then playing
the original from its beginning is longer than the original, by the length of the hook. The
committed baseline's `575.87s → 577.80s` is the agent obeying the prompt exactly.

Not fixed **because the case cannot validate a fix**: it runs on `mission-podcast` (§3).
Two faithful repairs for whoever replaces that media — change the prompt to "…then
continue from there", making it a genuine restructure; or allow growth up to the length of
the prepended hook, which is what a faithful prepend costs, and still catch real padding.

### 2.3 The same unattributed-word rule is still live in the caption pipeline

`bestSpanFor` (`editor-core/src/captions/derive.ts`) says "an unattributed word matches any
asset — the v11 behavior". Every mission fixture transcript is schema ≤ v11 with no
`assetId`, so on a project with b-roll or a music bed a caption cue can be attributed to,
and timed through, a clip that was never speaking. The same fabrication was fixed twice
this week in the Critic (`5d0dbab`) and the rubric (`a255687`); the third copy needs
`buildTimelineMap` to see asset durations, which it deliberately does not, and no case
currently exercises it. **Do not fix it blind** — captions are the most incident-heavy
area in this repo, and the tie-break there is already deterministic since `008cf0c`.

### 2.4 A text overlay too big for the frame overflows it silently

`wrapLines` deliberately does not split mid-word, so a headline whose longest word cannot
fit is drawn overflowing the box and, at a large enough `fontSizePercent`, the frame.
`add_text_layer`'s own description invites it: "18+ is a headline that dominates the
frame", and 18% of frame HEIGHT on a vertical project is ~345px glyphs. Both candidate
fixes carry risk worth measuring first: a glyph-width approximation at the tool boundary
can produce false refusals, and auto-shrinking in the renderer is a preview/Python parity
change the caption renderers would want too.

### 2.5 The pinned-playbook budget is now a visible number, not a bug

With the stable head attributed, the figure the manifest was hiding is **32,338 tokens per
request — 57% of every agent request**, of which the system contract is 135. The rest is
eight pinned playbooks, and the cap of 8 did fire (the run was refused a ninth and a
tenth). ADR 0057 pins deliberately, so a playbook loaded at step 3 is still carried at step
153. On a caching provider it is a cached prefix and costs a fraction of face value; the
transcript's run used OpenRouter, where it likely was not. **This is a product decision,
not a defect** — and the point of the attribution fix is that someone can now make it.

### 2.6 Reads are 42% of the run's tool calls

78 `get_timeline`, 19 `get_project_state`, 15 `get_timeline_summary`, 12
`get_mapped_transcript`, 11 `list_assets` — and **zero memo hits across the whole run**.
The store invalidates timeline-dependent evidence on every applied patch and this run
applied one almost every turn, so the memo genuinely could not serve. Not a bug; the cost
is real. The lever is `arrangementLine`, which the run receives after every applied turn
and which carries counts and ranges but **no clip ids** — and every mutating tool needs
one. Widening it is a context-budget trade needing a measured before/after, not a fix.

### 2.7 Two things ruled OUT, so nobody re-investigates them

- **Compaction never fired.** Across all 309 manifests in `run.md`,
  `compaction.removedSections` is empty and no section is `included: false`. Nothing was
  dropped to fit; the context problem was attribution and repetition, both closed.
- **Stop is not broken.** Five turns took 12–15 minutes to settle after the abort, which
  looks like it. The case files say the provider was answering at 217–660 seconds per call
  while another turn of the same case did ten calls in seventy-five seconds. The
  conductor's own handling is correct: `r.aborted → cancelFinalize` skips the verify
  phase, so no repair pass runs after a cancel. The only real residue is that the abort is
  checked at turn boundaries, which matters only on a provider that is not throttling.

---

## 3. STILL NEEDS THE MAINTAINER — and it is worse than recorded

### `mission-podcast`'s transcript invalidates THREE cases, not one

`speech-9min.mp4`'s transcript is **2,384 of 2,431 words = "I'll try to follow you later."
repeated 397 times**, from 21.7s to 575.5s. Five cases use that project:

| case | reads the transcript? | verdict |
| --- | --- | --- |
| `podcast-highlight-60s` | yes — selection | measures nothing (already recorded) |
| `hook-strongest-line` | yes — "the strongest line" | **measures nothing (newly recorded)** |
| `compound-silence-captions` | the caption half does | **passes for the wrong reason**: the cues it scores are 397 repeats of a sentence nobody said, and the rubric checks they are well-FORMED, not true |
| `remove-dead-air` | no — silence detection | unaffected |
| `impossible-8k-drone` | no — refuses regardless | unaffected |

**Fix: replace the media with a recording that has continuous speech.** Not something an
agent can do unprompted. Until then, three of twenty-one cases are not measuring what
their names say, and `hook-strongest-line`'s rubric contradiction (§2.2) cannot be
validated either.

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

### Traps that have each cost real time

1. **`FRAMEPILOT_AI_PROVIDER=mock` is exported in this shell.** `env | grep FRAMEPILOT`
   first. `env -u` in the recipe above is why it is there — without it you get a complete,
   plausible, entirely meaningless run.
2. **The "do not build or test while it runs" trap is about MEMORY, not CPU.** A full
   `vitest run` of ai-sdk (4,500 tests) was OOM-killed mid-run this session. `tsc
   --noEmit` and targeted `vitest run <paths> --no-file-parallelism --maxWorkers=1` at
   `nice -n 19` ran a dozen times with no effect on the runner. Verify incrementally;
   just never sweep.
3. **Never `--force` an existing label** — it overwrites per-case evidence in place. A new
   label costs nothing and keeps the history.
4. **`--replay` is NOT a re-score.** Recordings hold `model_stream` and `host_tool`
   effects only, so replay re-executes the ORCHESTRATOR with current code: this session's
   behaviour fixes would all fire during one. That is a useful counterfactual ("these
   exact model outputs under the fixed code") and it is neither a re-score nor a
   prediction of what the model would do with the new refusals in front of it.
5. **Quota exhaustion and provider stalls look like a broken agent.** Void turns
   (`tokens.prompt === 0`) and harness timeouts (`harnessTimedOut`) are both excluded from
   the rates now and reported separately — read those two rows before reading anything
   else.

---

## 5. HOUSEKEEPING

- `tests/fixtures/mission/manifest.json` is modified in the working tree. **That is the
  maintainer's, from a `fetch-fixtures.sh` run.** It was committed by accident once and
  backed out in `88ea280`. **Never `git add -A`, `git add .`, or `git add -u` in this
  repo** — stage by explicit path.
- Nothing is running. The runner and the sidecar were both stopped at the end of the
  session.
- Memory files worth reading first: `golden-eval-harness`,
  `mission-podcast-transcript-hallucinated`, `unattributed-transcripts-lie`,
  `verification-judges-the-delta`, `never-git-add-all-framepilot`,
  `golden-manifests-track-prompt-text`.
- Formatting: only files prettier-clean at the branch point should be formatted. The rest
  are the repo's existing red `format:check` baseline. `BASELINES.md` and `REMAINING.md`
  are both in it — do not reformat them.
