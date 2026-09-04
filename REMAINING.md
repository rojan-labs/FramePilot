# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-05 session on `fix/agent-reliability-2026-09-05`, continuing the
2026-09-04 session this file used to describe. **The baseline still exists and is
unchanged** — `reports/golden/floor.json` is the same floor; this session ran nothing.
Full history, every number, and exactly what each run does and doesn't prove:
**`BASELINES.md`**, newest entry first, now with a "session 3" entry. Read that before
trusting any number below.

The work this session came from two places: `run.md` — a real desktop agent transcript the
maintainer captured (1,064,475 lines, run `137d8fd0`, 49 minutes, $27.76, final status
**failed**) — and the four leads the previous session left open.

---

## 1. WHAT'S CLOSED THIS SESSION

Sixteen commits on `fix/agent-reliability-2026-09-05`, each with a reproducing test that
fails without it. See `BASELINES.md`'s "session 3" entry for the mechanism of each.

**From `run.md`:**

1. **`caption_the_edit` discarded its whole patch on stacked footage** — the same asset on
   two video tracks over the same sequence seconds made two cues share one clip id. Ten
   calls, ~3,100 rejected operations, no captions at all. (`008cf0c`)
2. **`word_severed` failed the run on hallucinated words** — the transcript-loop detector
   said "do not cut on them" and the severed-word check failed the run for doing so.
   416 applied changes reported as failed. (`ebd66ea`)
3. **Selection-authored tools died at the agent's own first edit** — the interaction
   snapshot is captured once, so `stale_context` refused every `professional_audio` and
   `track_subject_automatically` call from step two onward. Plus `target`'s refusal, which
   read as a typo for what is a category error. (`506e55a`, +47 tokens/request)
4. **"Do not call it again" is now enforced** for tools with no route on this surface.
   (`1bd2f87`)
5. **An edit that changed nothing now says so** — 65 `adjust_audio` calls, seven of them
   no-ops answered as successes. (`95a9f03`)
6. **The reviewer could not parse the engine's own response** — FastAPI's explicit nulls
   against Zod `.optional()`; every perceptual review on this path failed closed, seven in
   this run. (`09dd6d8`)
7. **`end` read as a length** now names the value that would have worked, on both the TS
   and Python boundaries. (`f51f4ee`)
8. **A caption style written in CSS spelling** (`fontWeight: "bold"`) is translated at the
   tool boundary. (`6099516`)
9. **Rejected arguments name the tool they belong to** — the run sent `track_object` what
   `track_subject_automatically` takes and read back a bare key list. (`8bc0328`)
10. **The budget notice says what actually happens next.** The run announced "$26.61 spent"
    against a $26.50 budget and finished at $27.76; both halves of that gap are structural,
    so the sentence changed rather than the behaviour. (`dd09e3e`)
11. **An expired evidence handle says so.** `recall_evidence` was 103 of 561 tool calls and
    27 came back "no such handle" for ids the run had issued and then invalidated.
    (`5deae6d`)

**From the previous session's open leads (§2 of the old file):**

12. **§2.4 `clarify-which-clip` mutates while asking** — a turn that calls `ask_user`
   composed its edits before any answer existed, so `applyAgentTurn` withholds them.
   (`d482676`)
13. **§2.3 `reorder-last-first` reversibility** — *not* an instrument gap, as that lead
    guessed. `applyMove` recomputes the clip's end from coordinates that already drifted,
    and `(toStart + d) - toStart` is not always `d`. Proven with a one-ULP repro.
    (`bb8fb69`)
14. **§2.1 `captions-uppercase-bottom` r2** — the follow-up `set_track_caption_style` was
    almost certainly refused for CSS spelling, the same refusal `run.md` shows verbatim.
    Closed by fix 8. **Unverified against that case** — see §2.1 below.

One housekeeping commit: `88ea280` backs `tests/fixtures/mission/manifest.json` out of
`95a9f03`, where a `git add -u` swept it in. It is the maintainer's; it is unstaged in the
working tree exactly as it was found. **Do not use `git add -u` or `git add -A` in this
repo** — see the `never-git-add-all-framepilot` memory.

---

## 2. WHAT'S STILL OPEN

### 2.1 `captions-uppercase-bottom` r2 is fixed in theory, unverified in fact

The CSS-spelling refusal (`6099516`) is the only mechanism found that
matches "`caption_the_edit` ran, `set_track_caption_style` never landed, captions came out
unstyled". `run.md` shows exactly that refusal on exactly that tool. But the golden case's
own recording was not re-scored, so this is inference, not measurement.

**Cheapest confirmation**: `--case captions-uppercase-bottom --runs 3 --label
scratch-captions --force --yes`. If a run still ends unstyled, read the
`set_track_caption_style` result in its case file — the refusal will now name the field.

### 2.2 `broll-first-20s` — the failure was the instrument, and one more like it is open

This was closed after the section was first written (`5d0dbab`), and it retracts a
claim the previous session made. The severed word was **not** a real b-roll placement
defect: every fixture transcript is schema ≤ v11 and carries no `assetId`, so every word
applied to every clip — including the b-roll clip's own in and out points, on footage with
no speech on it. An unattributed transcript can only have come from an asset long enough to
contain it, and `word_severed` now says so.

**The same gap is still open one layer down, and it is not fixed.** `bestSpanFor` in
`editor-core/src/captions/derive.ts` carries the identical rule — "an unattributed word
matches any asset — the v11 behavior" — so on a project with b-roll, a caption cue can be
attributed to, and timed through, a cutaway that was never speaking. Nothing has been
observed failing on it, which is why it was not changed blind: the fix needs
`buildTimelineMap` to see the asset list, which it deliberately does not today, and it
needs a case that exercises it.

Separately and still unmeasured: whether the agent's b-roll placement is *good*. The
instrument was lying about it, so nothing yet says either way.

### 2.3 The transcript's remaining small refusals

Each is one or two calls in `run.md`, each a real rough edge, none diagnosed further:

- ~~`track_object` given `subject` and `intent`~~ — closed by `8bc0328`.
- **`track_subject_automatically` given `subject: "object"`** — legal values are
  `point|region|plane|silhouette`.
- **`search_stock` given a `kind` outside `photo|video`** (2 calls).
- **`load_tools` asked for more than 4 domains** (1 call). The refusal is already correct
  and actionable.
- **`auto_emphasize_captions` given a keyword nobody said** ("strap"). The refusal is
  correct and already says to read `get_mapped_transcript`.

### 2.4 Cost and control, from `run.md` — measured, not fixed

- ~~The run overshot its own budget~~ — explained and the notice corrected in `dd09e3e`.
  The overshoot is structural (the turn that crosses the line is already paid for, and the
  self-check the notice promises costs its own calls) and deliberately not "fixed", because
  holding the number would mean deleting the verdict.
- **`recall_evidence` was 103 of 561 tool calls** — 18% of every call the run made was
  re-reading its own memory. `5deae6d` closed the worst 27 of those (real handles the run
  had invalidated, answered as if they never existed), but **the other ~76 are untouched**:
  see the `agent-log-payload-window` memory — only the two freshest log entries keep
  payloads, so the run must buy back what it already knew. This is still the single largest
  line item in the run's token bill.
- **95 more calls were state reads** (`get_timeline` ×61, `get_project` ×19,
  `skim_timeline` ×15). Two were already refused as "Skipped redundant get_timeline call",
  so a guard exists; it is not catching most of them.
- **8 playbooks is the `load_skill` ceiling** and the run hit it, losing the finishing and
  motion-design playbooks. Whether 8 is the right number is a product question.

---

## 3. ONE THING THAT STILL NEEDS THE MAINTAINER

### `podcast-highlight-60s` measures nothing on current media

Unchanged from the last two sessions. `speech-9min.mp4`'s transcript is **2384 of 2431
words = "I'll try to follow you later." repeated 397 times**, from 21.7s to 575.5s. Real
speech stops around 30s; whisper looped over quiet audio, cached by content hash, so
re-transcribing reproduces it every time. An agent that refuses the case is **correct**,
and the rubric records it as failing.

**Fix: replace the media with a recording that has continuous speech.** Not something an
agent can do unprompted. Cases that cut on silence (`remove-dead-air`) are unaffected.

Note that this session's fix 2 makes the *product* behave correctly on such a transcript —
it no longer fails a run over a fabricated word — but the *case* still measures nothing,
because there is no real speech in it to select from.

---

## 4. RUNNING THE BASELINE AGAIN

Read `BASELINES.md` first — it may already answer what you're about to spend money
confirming, and its "session 3" entry states in advance what this session's changes should
move, so the next run is a test rather than a rationalisation.

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

Then `node packages/ai-sdk/scripts/golden-gate.mjs reports/golden/baseline.json --write` to
accept a new floor — it warns if the floor it records gates nothing; read that warning if
it appears.

**A single case is much cheaper than a full baseline**, and is usually enough to confirm a
specific fix: `--case <id> --runs 1 --label <scratch-label> --force --yes`.

### Traps that have each cost real time

1. **Run it detached, on an idle machine, and do not build or test while it runs.** A local
   `pnpm build` / `tsc -b` / `vitest run` has silently killed the runner before, with the
   case in flight simply never finishing. Per-case results are on disk, so re-invoking the
   same command resumes.
2. **Never run two runners against one `--label` at once** — `pkill -f mission-baseline`
   before starting.
3. **Exported shell env beats `.env`.** Check `env | grep FRAMEPILOT` first — a stray
   `FRAMEPILOT_AI_PROVIDER=mock` yields a complete, plausible, entirely meaningless run.
4. **Quota exhaustion looks like a broken agent, and it is contagious to everything after
   it.** Void turns are excluded and reported separately — re-run only those cases with
   `--case a,b,c --force`, then re-run the whole label with **no** `--case` filter to
   regenerate a merged `summary.json`.
5. **`--replay` cannot verify a provider-level fix.** It re-scores from already-parsed
   chunk recordings, downstream of provider code. Nor can it verify most of *this*
   session's fixes: five of them are in the engine/reviewer/editor-core path that replay
   re-executes, but `506e55a` (interaction rebase) and `1bd2f87` (surface refusal) need a
   live call.

---

## 5. HOUSEKEEPING

- `tests/fixtures/mission/manifest.json` is modified in the working tree. **That is the
  maintainer's, from a `fetch-fixtures.sh` run.** Do not commit or revert it blindly — it
  was committed by accident once this session and backed out in `88ea280`.
- Nothing is running. No sidecar was started this session.
- Memory files worth reading before starting: `golden-eval-harness`,
  `mission-podcast-transcript-hallucinated`, `verification-judges-the-delta`,
  `never-git-add-all-framepilot`, `golden-manifests-track-prompt-text` (any change to a
  tool descriptor shifts three separate frozen token manifests, and the diff IS the
  measured token delta — `506e55a`'s +47 was read straight off it).
- Formatting: only files you find prettier-clean at the branch point should be formatted.
  The rest are part of the repo's existing red `format:check` baseline — format only files
  you touch, or the diff drowns in unrelated churn.
