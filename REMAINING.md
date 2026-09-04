# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-04 session on `feat/golden-eval-harness`, continuing the
2026-09-03 session this file used to describe. **The baseline now exists** —
`reports/golden/floor.json` is real, and three real defects it exposed have been
fixed and re-scored this session. Full history, every number, and exactly what
each run does and doesn't prove: **`BASELINES.md`**, newest entry first. Read
that before trusting any number below.

---

## 1. WHAT'S CLOSED THIS SESSION

All three fully diagnosed, fixed, tested, and re-scored — see `BASELINES.md`'s
"session 2" entry for the numbers and exact mechanism of each:

1. **`checkValidRefs` didn't know about the caption sentinel** — every caption
   clip was scored as a dangling asset ref, capping every captioning case and
   making `compound-silence-captions` look like it had a schema-integrity bug it
   never had. Fixed in `mission-rubric.ts`, regression test added.
2. **The Claude Agent SDK provider discarded correct edits as hard failures** —
   `maxTurns: 1` plus a parallel tool-call batch could exhaust the SDK's own
   turn budget after every tool call had already been deferred (never executed),
   and the SDK throws instead of yielding a result the adapter could read
   gracefully. This was the single largest scorer of false failures this
   session — 16 case+run files carried the exact same error. Fixed in
   `claude-agent-sdk.ts`, two regression tests added, confirmed live (not via
   replay — replay can't exercise this fix, see `BASELINES.md`).
3. **`guard-wipe-timeline` conformed to ADR 0166** — a decision, not a bug; the
   prior session deliberately left this failing pending a maintainer call. ADR
   0166 is accepted and shipped, so the case (and a new `checkTimelineWiped` /
   `'wiped'` rubric) were changed to match it, not goal.md's older line.
   Reversible — see the comment in `golden-cases.ts` if that line is reinstated.

`firstPassAcceptance` 33%→49%, `intentAccuracy` 68%→72%, `targetAccuracy`
76%→82%, all from removing false failures — no prompt or model change made.

---

## 2. WHAT'S STILL OPEN, WITH A KNOWN ROOT CAUSE

Diagnosed this session, not fixed — each for a stated, deliberate reason (risk,
cost, or genuinely out of this session's scope). Full detail in `BASELINES.md`.

1. **`captions-uppercase-bottom` r2**: `caption_the_edit` ran, the follow-up
   `set_track_caption_style` never happened, so captions landed unstyled. 1 of 3
   runs. Not traced further.
2. **`broll-first-20s`, post-maxTurns-fix**: the run's own Critic self-check
   (`checkWordSevered`) now correctly catches a word the agent's b-roll
   placement genuinely severed — confirmed NOT an instrument bug (`runVerify`
   already reconciles inherited-vs-new failures correctly). Real accuracy
   defect in b-roll placement near speech; the agent burned 19 calls / $2.07
   failing to resolve it before giving up. Not diagnosed further — reproducing
   it costs a live run.
3. **`reorder-last-first` r1's undo doesn't restore exactly.** Traced to the
   agent redundantly re-issuing `move_clip` on one clip four times, with one
   call passing a truncated value. Editor-core's invert/quantize logic checks
   out correct in isolation (`snapSecondsToFrame` collapses both values to the
   same frame), so the **production path likely does not reproduce this** —
   whether the eval harness's `checkReversibility` is scoring genuinely
   unquantized data (bypassing `commitProjectPatch`) is the open question.
   Needs a traced, from-scratch repro, not attempted this session.
4. **`clarify-which-clip` mutates while asking, 3/3 runs.** The agent correctly
   asks (`intent: ask` matches) but also applies unrelated edits in the same
   turn. Root cause is clear — nothing stops mutating tool calls batched
   alongside an `ask` call from executing — but the fix belongs in
   `orchestrator.ts` (~8,000 lines, dense incident-driven invariants) and
   needs live verification this session didn't spend the budget on. Fix
   shape: when a proposed batch includes an `ask`, do not apply the rest of
   that batch.

---

## 3. ONE THING THAT STILL NEEDS THE MAINTAINER

### `podcast-highlight-60s` measures nothing on current media

`speech-9min.mp4`'s transcript is **2384 of 2431 words = "I'll try to follow you
later." repeated 397 times**, from 21.7s to 575.5s. Real speech stops around
30s; whisper looped over quiet audio, cached by content hash, so re-transcribing
reproduces it every time. An agent that refuses the case — "only ~30 seconds of
genuinely distinct content" — is **correct**, and the rubric records it as
failing. Confirmed again this session (3/3 runs: `failed`/`failed`/`cancelled`,
timeline unchanged).

**Fix: replace the media with a recording that has continuous speech.** Not
something an agent can do unprompted — needs a real recording. Cases that cut
on silence (`remove-dead-air`) are unaffected; silence detection never reads
the transcript.

---

## 4. RUNNING THE BASELINE AGAIN

Read `BASELINES.md` first — it may already answer what you're about to spend
money confirming. When you do need a real run:

```bash
# 1. sidecar, rooted at the fixtures, on :8799. There is NO `pnpm engine:serve`.
cd engine/python && FRAMEPILOT_PROJECTS_ROOT=/ABSOLUTE/path/to/tests/fixtures/mission/projects \
  uv run framepilot serve --host 127.0.0.1 --port 8799
curl -s http://127.0.0.1:8799/health          # {"status":"ok",…} before continuing

# 2. build — the runner imports dist/
pnpm --filter @framepilot/ai-sdk build

# 3. the run — 21 cases x 3 runs, ~1-3 hours, ~$20-40 at observed rates
nohup env FRAMEPILOT_AI_PROVIDER=claude-agent-sdk \
  FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5 \
  FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 \
  node packages/ai-sdk/scripts/mission-baseline.mjs --runs 3 --label baseline --yes \
  > /tmp/baseline.log 2>&1 &
```

Then `node packages/ai-sdk/scripts/golden-gate.mjs reports/golden/baseline.json
--write` to accept a new floor — it warns if the floor it records gates
nothing; read that warning if it appears.

**A single case is much cheaper than a full baseline**, and is usually enough to
confirm a specific fix: `--case <id> --runs 1 --label <scratch-label> --force
--yes`. This is how both live checks in this session's fixes were done, at
$0.08 and $2.07 respectively, instead of re-running all 63 turns.

### Traps that have each cost real time

1. **Run it detached, on an idle machine, and do not build or test while it
   runs.** A local `pnpm build` / `tsc -b` / `vitest run` has silently killed
   the runner before, with the case in flight simply never finishing. Per-case
   results are on disk, so re-invoking the same command resumes.
2. **Never run two runners against one `--label` at once** — `pkill -f
   mission-baseline` before starting.
3. **Exported shell env beats `.env`.** Check `env | grep FRAMEPILOT` first — a
   stray `FRAMEPILOT_AI_PROVIDER=mock` yields a complete, plausible, entirely
   meaningless run.
4. **Quota exhaustion looks like a broken agent, and it is contagious to
   everything after it.** It ran out mid-run this session too (16 void turns,
   the last several cases entirely dark, all `calls=1 wall=2s usd=0`). Void
   turns are excluded and reported separately — re-run only those cases with
   `--case a,b,c --force`, then re-run the whole label with **no** `--case`
   filter to regenerate a merged `summary.json` (it only reflects the
   invocation's own case selection, not everything cached on disk).
5. **`--replay` cannot verify a provider-level fix.** It re-scores from
   already-parsed chunk recordings, downstream of provider code — if the bug is
   in how the provider parses the wire, a truncated recording replays the same
   truncation forever. Only a live call proves a provider fix; but see the
   single-case-cheap-check note above before reaching for a full re-run.

---

## 5. HOUSEKEEPING

- `tests/fixtures/mission/manifest.json` is modified in the working tree. **That
  is the maintainer's, from a `fetch-fixtures.sh` run.** Do not commit or
  revert it blindly.
- The sidecar and all runners were stopped at the end of this session. Nothing
  is running.
- Memory files worth reading before starting: `golden-eval-harness`,
  `mission-podcast-transcript-hallucinated`, `verification-judges-the-delta`,
  `never-git-add-all-framepilot` (fixture media is un-ignored — a blanket `git
  add -A` put 3.8 GB in history once).
- Formatting: only files you find prettier-clean at the branch point should be
  formatted. The rest are part of the repo's existing red `format:check`
  baseline — format only files you touch, or the diff drowns in unrelated
  churn.
