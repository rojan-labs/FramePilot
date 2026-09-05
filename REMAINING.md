# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-05 sessions on `fix/agent-reliability-2026-09-05`. Six sessions
have now happened on this branch; **`BASELINES.md` has an entry for each**, newest first,
and the numbers below mean nothing without them.

- **sessions 3–5** — twenty-three defects read out of `run.md` (a captured desktop
  transcript, run `137d8fd0`) plus eight more from a second sweep of it. Two of those
  sessions ran nothing.
- **session 6** — the fixture that invalidated three cases was **replaced**, and a run on
  it produced eleven cases of clean evidence before the provider dropped and the maintainer
  stopped it. It found a defect that loses the editor's footage.

> **`run.md` is not a new run.** It has been offered as one three times now. Its ids say
> otherwise: conversation `33f7e787`, run `137d8fd0`, 1,064,475 lines. Check the run id
> before mining it as fresh evidence.

---

## 1. WHAT'S CLOSED

Sessions 3–5 closed twenty-three defects; the list lives in `BASELINES.md` under those
entries and is not repeated here. Session 6 closed four more, each with a reproducing test:

1. **`mission-podcast` measures real words and real dead air** (`1040f2e`). §3 of every
   previous handoff. See §2.1 below for why the obvious repair would have moved the defect
   rather than fixed it.
2. **A word too wide to wrap is no longer drawn in silence** (`6fc28d9`). The last open
   half of the old §2.3.
3. **The severed-word message names the second, not just the frame** (`5693600`). Cost
   three turns of the session-6 run, one of them $3.19.
4. **The changelog says what the editor gets** (`b7c2839`).

---

## 2. WHAT'S STILL OPEN

Ordered by what it costs the editor, not by how hard it is.

### 2.1 A REORDER LOSES FOOTAGE — the most serious thing on this branch

**Four of six clean reorder runs destroyed content.** Full table, quotes and run ids in
`BASELINES.md` under `session6`. The short version: asked to move the last clip to the
front, the agent deleted the sequence and then asked the editor how to proceed —
describing the damage it had just done as the project's own state.

**Every individual operation was legal**, which is why nothing caught it. The cause is
structural and has two halves:

- **There is no reorder primitive.** `move_clip` moves one clip to a start time; clips
  cannot overlap; so "put the last clip first" has no expressible route except
  destroy-and-rebuild.
- **Instant-apply commits the destroy before the rebuild is composed.** Any run that then
  stops — asks a question, hits a wall, times out — leaves the destruction applied and the
  repair unwritten.

This is evidence for two decisions already on the maintainer's list:

- **ADR 0056 (compound-request atomicity vs instant-apply).** All five content-loss
  failures in the run, `beat-sync` r1 included, are this shape.
- **ADR 0166 (the deleted wipe guard).** A guard on "a delete that empties a track" catches
  two of the five and **misses the three 5→1 cases**, so reinstating it is not sufficient.

**The fix I would propose, and did not start:** an atomic `reorder_clips` operation — given
a track and an ordering, recompute the starts in ONE patch, gaplessly, no delete. That is a
new operation (schema + apply + invert + validate + Python mirror + tests + three golden
regens) and a real slice, so it wants a maintainer's yes before anyone writes it. It also
cannot be shown to change the agent's behaviour without a run.

`reorder-last-first`'s floor is 1.00 against a 0.60 median here, so **the gate will flag
it.** That is not this branch: `reorder-swap-first-two`'s floor was already 0.50.

### 2.2 A turn rejected wholesale can be re-issued forever

`beat-sync` r1: 29 byte-identical `add_clip`/`add_clips` pairs, 977 operations rejected
every time by the beat grid, 20 minutes, **$3.93**, and a picture track left empty.

The guard for exactly this exists and passes its tests — `repeatedRejection` in
`conductor.ts`, written for run `ea8e46ec` (six turns, one byte-identical beat-grid
rejection, thirty minutes). Something let this past it, and the test sitting next to it
names what can: **one novel call fact per turn resets the streak.**

**Do not tune this by inspection.** There are five interacting run-stoppers and the last
person to touch one left a note saying so. The way in is free:

```bash
node packages/ai-sdk/scripts/mission-baseline.mjs --replay --label session6 --case beat-sync
```

`--replay` re-runs the ORCHESTRATOR against recorded model output — no model calls, no
cost — so the reducer can be watched deciding. Fix what the repro shows, not what the code
reads like.

r2 and r3 scored 1.00 having declared `hardSync: true` identically, so the wall is
reachable but not deterministic. The missing guard is the amplifier, not the cause.

### 2.3 A retimed clip leaves the frame grid

`refine-tighten` r1 turn 2 made 16 `set_clip_speed` calls at 1.3× and produced exactly 16
off-grid edges. It is arithmetic, not model error: `end = start + sourceDuration / speed`
is almost never a whole number of frames.

Both engines use that formula (`applySetClipSpeed`, `_apply_set_clip_speed`), so they
**agree** — preview/export parity is intact and the output is consistently off-grid rather
than divergently so. `frame-grid.ts:266` lists `set_clip_speed` among the operations
`normalizeOperationTime` returns unchanged, correctly, because the op carries no time
field. The time is invented inside apply, which receives only a `Timeline` and therefore
has no fps.

Three routes, all decisions:

1. **Thread fps into apply** for the two speed ops. The only route where the invariant
   actually holds afterwards, and invertible — the snap is a pure function of
   `(start, sourceDuration, speed, fps)`. But it changes `applyOperation`'s signature and
   every caller, and must land identically in Python.
2. **Snap at the tool boundary.** `set_clip_speed` knows `project.fps`, so it could emit
   `set_clip_source_range` (trimming ≤1 frame of source so the duration is whole) plus the
   speed op. No signature change; silently drops a frame of the editor's source.
3. **Decide the grid rule does not bind a retime** and change `cuts-on-frame-grid` instead.

I would take (1). The grid rule exists so preview and export agree about where a cut is.

### 2.4 The word-boundary trap is narrowed, not closed

Three turns of the run were lost to a cut landing one frame inside a word. In every case
the run had read the correct frame from `get_mapped_transcript` and then passed **seconds**,
which `quantizePatch` rounded across the word edge.

`5693600` fixes the message that was telling it to do this — it now names the second, the
division, and why the rounding is the trap. **Whether that changes behaviour is unmeasured**
and needs a run.

If it does not, the next step is the tool surface: let the cut tools take frames, or have
`get_mapped_transcript` report grid-aligned seconds beside the frames. Both cost
tool-schema tokens and move all three goldens, which is a trade to state out loud rather
than make quietly.

### 2.5 Ten of twenty-one cases still have no clean run

`hook-strongest-line`, `compound-silence-captions`, `broll-first-20s`,
`broll-empty-overlay-track`, `music-bed-quiet`, `captions-uppercase-bottom`,
`vague-make-better`, `impossible-8k-drone`, `guard-wipe-timeline`, `clarify-which-clip`.

Their `session6` case files hold either a transport error or nothing. **Re-running them
needs `--force`**, because a file exists; that is the one situation where `--force` is
right, since those files hold no evidence. Everything else on that label is real and must
not be overwritten.

`hook-strongest-line` is the one to want most: its rubric contradiction was repaired in
session 5 and unit tested, and it has still never run on media that can validate it —
now for want of a run rather than for want of a fixture.

### 2.6 The pinned-playbook budget — ANSWERED, and the answer is "leave it"

Previously carried as an open product decision at "32,338 tokens per request, 57% of every
agent request". **Measured live in the session-6 run, that is not what a request costs:**

- the pinned-skill section is **1,649–2,626 tokens per request**, not 32,338;
- `tool_schemas` is **6,806–9,417**, not the frozen surfaces' 13,488, because progressive
  disclosure means a run loads the domains it asks for;
- **51–63% of each request is a cache read** on this provider (e.g. 55,275 of 107,810;
  74,054 of 116,633).

The 32,338 figure was a 153-step desktop run that had loaded eight playbooks — a property
of run length, not of the pin. Unpinning would break the cached prefix and cost more.
**Close this unless a long-run measurement reopens it.**

### 2.7 Reads are 42% of tool calls — still deliberately not fixed

Unchanged, and the reasoning is unchanged: the memo cannot serve when every turn applies a
patch that invalidates timeline-dependent evidence. The lever is `arrangementLine` carrying
clip ids, which is a context-budget trade needing a measured before/after — and §2.6 now
says the budget has more room than was thought.

### 2.8 Things ruled OUT, so nobody re-investigates them

- **Compaction never fires.** Across all 309 manifests in `run.md`,
  `compaction.removedSections` is empty and no section is `included: false`.
- **Stop is not broken.** The long settles in the captured run were the provider answering
  at 217–660s per call. The only real residue is that the abort is checked at turn
  boundaries.
- **The 144 `add_music` failures are one failure** — `op_31`, re-serialised into every
  later state dump. Count distinct `op_N` ids before quoting a failure volume.
- **A more specific error message is not free.** `deterministicFailureKey` keys the
  repeated-failure guard on the message body: an overlap shrinking from 3s to 1s reads as
  two unrelated failures and the guard stops firing. Any message change on a validator path
  must be read against that guard.
- **The void-turn and harness-timeout exclusions work.** Session 6 lost 32 turns to a
  provider outage and 1 to the timer; all 33 were excluded from the rates and reported
  separately, exactly as designed.
- **`speech-9min-b` is not a drop-in replacement for `speech-9min`.** It has real narration
  and **no silent gap at −30, −40 or −50 dB**. Pointing `mission-podcast` at it would have
  broken `remove-dead-air` the way `speech-9min` broke selection. This is why
  `speech-9min-c` is generated.

---

## 3. RUNNING THE BASELINE AGAIN

Read `BASELINES.md` first. **Check the provider is answering before letting it run
unattended** — session 4 lost five turns to a stall and session 6 lost 32 turns to an
outage that produced a complete-looking run in seconds.

```bash
# 1. sidecar, rooted at the fixtures, on :8799. There is NO `pnpm engine:serve`.
cd engine/python && FRAMEPILOT_PROJECTS_ROOT=/ABSOLUTE/path/to/tests/fixtures/mission/projects \
  uv run framepilot serve --host 127.0.0.1 --port 8799
curl -s http://127.0.0.1:8799/health          # {"status":"ok",…} before continuing

# 2. build — the runner imports dist/, so it measures the code as of the BUILD
pnpm --filter @framepilot/ai-sdk build

# 3. the run. Use a NEW label; never --force one that holds evidence.
nohup env -u FRAMEPILOT_AI_PROVIDER FRAMEPILOT_AI_PROVIDER=claude-agent-sdk \
  FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5 \
  FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 \
  node packages/ai-sdk/scripts/mission-baseline.mjs --runs 3 --label <new> --yes \
  > /tmp/<new>.log 2>&1 &
```

**Rebuilding the fixture projects** (only if the media changes):

```bash
node packages/ai-sdk/scripts/mission-fixture-projects.mjs --only mission-podcast
```

`--only` was added in session 6 so one project can be rebuilt without rewriting four
nobody asked about.

### Traps that have each cost real time

1. **`FRAMEPILOT_AI_PROVIDER=mock` is exported in this shell.** `env | grep FRAMEPILOT`
   first. `env -u` in the recipe is why it is there.
2. **The "do not build or test while it runs" trap is about MEMORY, not CPU.** A full
   `vitest run` of ai-sdk was OOM-killed mid-run in session 4. `tsc --noEmit` and targeted
   `vitest run <paths> --no-file-parallelism --maxWorkers=1` at `nice -n 19` are fine;
   never sweep. **Never rebuild `dist/` mid-run** — the runner imports it.
3. **`--force` overwrites per-case evidence in place.** The one exception is a case whose
   file holds only a transport error (§2.5).
4. **`--replay` is NOT a re-score.** Recordings hold `model_stream` and `host_tool` effects
   only, so replay re-executes the ORCHESTRATOR with current code. That is what makes it
   the right tool for §2.2.
5. **A provider outage looks like a fast, complete run.** Session 6's last eleven cases
   finished in two seconds each with `prompt=0`. Void turns and harness timeouts are both
   excluded from the rates and reported separately — **read those two rows first**.
6. **A killed run writes no merged summary.** Compute from
   `reports/golden/<label>/cases/*.json` and say so.

### Three frozen token surfaces, three regen commands

Any change to a tool description, a skill, or the system contract moves all three. A
partial regen leaves a red suite:

```bash
FRAMEPILOT_GOLDEN_UPDATE=1 pnpm --filter @framepilot/ai-sdk test golden-corpus
pnpm --filter @framepilot/ai-sdk test src/kernel/streamAgent-golden.test.ts -- -u
FRAMEPILOT_GOLDEN_UPDATE=1 pnpm --filter @framepilot/ai-sdk test langchain-session-parity
```

The diff those produce **is the measured token delta** — read it before committing, and put
the number in the commit message. Session 6's changes moved none of them: the critic,
the fit check and the fixture are not token surfaces.

---

## 4. HOUSEKEEPING

- **No floor was written from `session6`.** Eleven of 21 cases is not a floor.
  `reports/golden/floor.json` is still the `baseline` one.
- `tests/fixtures/mission/manifest.json` is modified in the working tree. **That is the
  maintainer's**, from a `fetch-fixtures.sh` run. `speech-9min-c.mp4` is NOT in it yet —
  it appears on the next `fetch-fixtures.sh`, which regenerates the whole file.
  **Never `git add -A`, `git add .`, or `git add -u` in this repo** — stage by explicit path.
- **Never `git stash` here**, including `--keep-index`. The user keeps long-lived stashes
  and a stray stash silently empties the working tree.
- Nothing is running. The sidecar and the runner were both stopped at the end of session 6.
- `speech-9min.mp4` is still on disk and no fixture project uses it any more.
- Memory files worth reading first: `golden-eval-harness`, `verification-judges-the-delta`,
  `agent-progress-guards-layered`, `never-git-add-all-framepilot`,
  `never-git-stash-framepilot`, `golden-manifests-track-prompt-text`,
  `baseline-run-operational-traps`.
- Formatting: only files prettier-clean at the branch point should be formatted. The rest
  are the repo's existing red `format:check` baseline. `BASELINES.md` and `REMAINING.md`
  are both in it — do not reformat them.
