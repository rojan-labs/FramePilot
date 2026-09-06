# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-05/06 sessions. Eight sessions have now happened; **`BASELINES.md`
has an entry for each**, newest first, and the numbers below mean nothing without them.

- **sessions 3–5** — thirty-one defects read out of `run.md` (a captured desktop
  transcript, run `137d8fd0`). Two of those sessions ran nothing.
- **session 6** — the fixture that invalidated three cases was **replaced**, and a run on
  it produced eleven cases of clean evidence before the provider dropped.
- **session 7** — **no new run.** The four open engine defects closed with reproducing
  tests; one measured shut by `--replay` (free). Then eight more sweeps of `run.md`.
- **session 8** (this one) — **no new run.** A ninth axis on `run.md` — the timeline's
  FINAL STATE — found the worst thing on the transcript (37 of 48 picture clips never
  visible, every riding clip among them; one music file playing twice). Closed with tests:
  `23cddd2` (GOLDEN-C.20) and `afd2671` (GOLDEN-C.19, deterministic half). Branch
  `fix/agent-reliability-s8`, worktree `../FramePilot-reliability-s8`.

> **`run.md` is not a new run.** It has been offered as one FIVE times now. Its ids say
> otherwise: conversation `33f7e787`, run `137d8fd0`, 1,064,475 lines, created
> 2026-09-04T18:12; mtime 2026-09-05 02:11. `framepilot.runs.jsonl` has nothing after
> 2026-09-05T12. Check both before mining. Session 8 spent its first hour re-deriving five
> closed defects from the failure-shaped axes before the final-state axis paid — the list is
> in §1b so the next session does not.

---

## 1. WHAT'S CLOSED

Sessions 3–7 closed forty-eight defects; those lists live in `BASELINES.md` under their
entries and are not repeated here. **Session 8 closed four — two from the final-state axis of `run.md`, one from replaying `session6`, one in the instrument:**

1. **A lift that buries a cutaway is refused; a same-frames duplicate is refused; the
   Critic reports hidden picture** (`23cddd2`, GOLDEN-C.20). ADR 0169's placer lifted every
   occupied placement onto a fresh `video_cutaway_N` front lane — thirteen times at t=0 —
   and each lift buried the cutaway placed just before it, reporting `completed`. Now:
   `hides_a_cutaway` refuses a lift that would leave a still-visible cutaway with nothing of
   it ever seen (covering the A-roll stays legal — that is what a cutaway is); the
   duplicate rule keys on the source PIN rather than the exact span, for picture and sound
   (the doubled music bed); `hidden_picture` warns with the first three buried clips. No
   tool description changed: **0 tokens on every frozen surface.** First-order accounting
   on the run's sixteen stacked placements: 3 were already exact duplicates, 1 is now a
   same-frames duplicate, 5 now bury a cutaway, 7 partial covers are still lifted.
2. **A run getting THROUGH the wall is not stuck at it** (`f84e564`, GOLDEN-C.21). Found by
   replaying `session6`'s recordings, which session 7 had only done for `beat-sync` r1: r3
   went from 40 ops / 1.00 to 5 ops / 0.56 because the same-wall guard finalized a run that
   was converging (off-grid 12 → … → 2) one model call before its edit. A refusal now
   carries a scale; a new low at the wall is progress. r3 back to 1.00; r1 pays one extra
   turn ($0.571 → $0.709) and still completes. `BASELINES.md` "s8-replay" has the table.
3. **Every case file keeps a per-call ledger** (`6c4a15f`): `calls: [{tool, status, args}]`,
   so a C.16-shaped question is answerable from committed evidence, recording or not.
4. **The completion report says what was NOT done** (`afd2671`, GOLDEN-C.19, half). A
   `**Not done:**` block after "Skipped": drafted plan steps left uncompleted, and tools
   called at least once, failed every time, never afterwards successful, with the LAST
   reason. Zero prompt tokens. Two goldens moved by exactly that block on a planned run that
   failed with a step pending — an OUTPUT change, regenerated deliberately.

---

## 1b. `run.md` — nine axes walked; what each re-derives if you walk it again

**Failure-shaped axes are exhausted (do not re-mine):** error strings · tool outcomes by
name · warnings/notices · failed recalls · cost · the run's own outstanding list · tool wall
clock/thinking/announce-vs-act. Session 8 re-derived all of these before checking; each is
closed by a fix whose docstring cites this run:

| looks like a defect | actually | where it is closed |
| --- | --- | --- |
| `caption_the_edit` rejected 11× on `caption_captions_70` | duplicate cue id inside one proposal | `captions.ts#seenIds` |
| `professional_audio` rejected 10× (`target: "music_1"`) | id where a referent belongs; the sentence now says which tool takes an id | `audio-controller.ts#targetHint` |
| `stale_context …@56 but the project is …@100` ×3 | the agent's own first edit staled the selection | `interaction-context.ts#rebaseEditorInteractionContext` |
| `add_clip requires end > start` (`start: 44, end: 6`) ×3 | `end` read as a length; the hint names it | `tool-input-contract.ts#durationHint` |
| eight `v_main` clips re-sent → `video_cutaway_5` | exact duplicate placement | `timeline.ts#existingPlacement` |
| `add_music` refused on an empty duck target | names the tracks that DO carry sound | `music-placement.ts#duckCandidateSentence` |
| 27 recalls "no such handle" | invalidated handles leave a tombstone | `evidence-store.ts#expired` |
| 62 `adjust_audio` calls, five rounds over the same ten clips | `gainDb` is ABSOLUTE (`applyAdjustAudio` replaces the effect), so hunting is churn, not accumulation; identical re-sets are C.12 | `6d52298` |
| 96 captions on a "no dialogue" brief | the fixture project carries a transcript for `raw_skating.mp4`; the model captioned what the project said, not what the user said | fixture, not code |

**The final-state axis (session 8) — walked once, yielded C.20.** Read the last
`get_timeline` the run made (line 1,049,912) and replay z-order over it. Count of the
remaining leads on it: the 5 s hole in `v_main` at 53–58 s is covered by stock on other
lanes (coverage passes honestly); three empty tracks (`captions`, `cutaways_stock`,
`layer_audio_5`) are the model's own `add_track` calls — untidy, not a defect;
`v_vertical_reframe` holds landscape stock cover-cropped to 0.75 width for a vertical
deliverable that was never built as its own project. **Nothing else on this axis.**

**A tenth axis nobody has walked:** the model's `💬` narration against the timeline it
was narrating (154 thinking blocks, 123 messages). Session 7's C.19 note found one case by
hand (the sharpness lift). A systematic pass — every "I will now X" against the next
turn's ops — is the only unwalked seam. Expect narration habits, not runtime defects.

**Operational loss to know about:** the `s7-*` golden RECORDINGS are gone — gitignored,
they lived only in the worktree that was removed after the merge. Case files are intact;
`--replay` of those runs is not possible. Copy `recordings/` out before removing a
worktree. **This applies to `../FramePilot-reliability-s8` too.**

---

## 2. WHAT'S STILL OPEN

### 2.1 GOLDEN-C.19, the other half — a brief-level ask the run never attempted

"Lift the sharpness" has no plan step and no failed call, so nothing deterministic knows
it was asked for. The runtime's objective ledger is one objective with a catch-all
criterion (`acceptance.ts#checkableAcceptance` derives only duration and reference
criteria from the prompt). **With "Plan first" ON — the sidebar's default,
`AiSidebar.tsx#loadPlanFirst` — the drafted steps ARE the decomposition, and the new
block lists whichever were left.** Run `137d8fd0` had it off (its state at version 2
shows a plan committed straight from the request text). Two ways forward, both the
maintainer's: make the plan turn non-optional in agent mode (one model call per run), or
have the model emit a final "not done" sentence (a prompt-surface change, +tokens on all
three goldens). Neither is a patch.

### 2.2 GOLDEN-C.16 — `set_track_caption_style` ×13 on `captions-uppercase-bottom`

Unchanged: the s7 recording is gone; the case file holds counts only. **Needs a run.** Cheapest
route when credits allow: `--case captions-uppercase-bottom --runs 1` under a NEW label and
read the recording's `argsSummary` per call.

### 2.3 What is measured and what is not

**Measured by replay (free):** `beat-sync` ×3, `montage-30s` ×3, `reorder-swap-first-two` ×3
under the s8 code — the same-wall guard (`0c9f195` + `f84e564`) on the three runs that have
recordings. **Run the sidecar when replaying a beat case**: the scorer's `cuts-on-beats`
falls back to the nominal grid without it and reads 0.78 for a 1.00 edit.

**Not measured:**

`reorder_clips`, the frame-grid retime, the same-wall guard, and now `hides_a_cutaway` and
the pin-keyed duplicate have no run. The cases that would exercise the first three already
hold `session6` evidence and must not be re-run to satisfy curiosity. The two new rules are
exercised by any b-roll/montage case (`broll-*`, `beat-sync`) — a NEW label over those, as
its own decision. `reorder-last-first`'s floor is 1.00 against a 0.60 median, so the gate
will flag it whatever happens; that is not this branch.

### 2.4 Deferred, and stated rather than done

- **The web-editor reorder gesture is DONE** (session 7). The professional `EditorCommand`
  `reorder` intent was deliberately NOT added — vocabulary with no consumer.
- **ADR 0056 (compound-request atomicity vs instant-apply)** is still open on its own merits.
- **ADR 0166 (the deleted wipe guard)** stays deleted; ADR 0173 records why.
- **A partial same-frames duplicate BETWEEN two entries of one `add_clips` batch** is not
  caught: the batch's `booked` set is still an exact key. It is caught when it buries; a
  non-burying partial overlap within one call slips. Small, and touches both tools' shared
  set — do it when something is seen to need it.
- **`hidden_picture` is warn-only and not in `FIXABLE_CHECKS`.** Which copy survives is
  editorial. If a run is ever seen to END with buried picture it placed itself, promote the
  check to `fail` when `requestWantsPicture` — the same gate `picture_coverage` uses.

### 2.5 Reads are 42% of tool calls — still deliberately not fixed

Unchanged: the memo cannot serve when every turn applies a patch that invalidates
timeline-dependent evidence. The lever is `arrangementLine` carrying clip ids, a
context-budget trade needing a measured before/after.

### 2.6 Things ruled OUT, so nobody re-investigates them

Everything the previous handoffs listed still holds — compaction never fires, stop is not
broken, the 144 `add_music` failures are one failure, the void-turn and harness-timeout
exclusions work, `speech-9min-b` is not a drop-in, the pinned-playbook budget is closed.
Two corrections to the last handoff:

- **"Extend the `rejectionKey` separation to `deterministicFailureKey`" is ALREADY DONE** —
  `AgentCallOutcome.failureKeyText` (see its doc comment). Session 7's §2.6 was stale when
  written. A refusal whose sentence names moving things sets `failureKeyText`; nothing else
  to do.
- **`professional_audio` cannot be aimed by clip id, and that is by design**
  (`audio-controller.ts`: `target` names what the EDITOR selected; `adjust_audio` takes the
  id). In agent mode with nothing selected, EQ/compression/automation are unreachable by
  construction. Not a defect to fix; a product boundary to know.

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

### `--replay` is free, and session 7 is the argument for reaching for it first

`--replay` re-executes the ORCHESTRATOR against recorded model output — zero model calls,
zero host calls, zero cost — so it measures a reducer change directly. It is how §2.2 was
diagnosed and how its fix was proved.

```bash
# Copy the recordings under a NEW label so the real evidence cannot be overwritten.
mkdir -p reports/golden/<new>/ && cp -R reports/golden/<label>/recordings reports/golden/<new>/
env -u FRAMEPILOT_AI_PROVIDER node packages/ai-sdk/scripts/mission-baseline.mjs \
  --replay --label <new> --case beat-sync --yes
```

Two things that cost time in session 7:

- **`recordings/` is gitignored.** A worktree checkout has the committed `cases/` and no
  recordings; copy them from the checkout that ran the baseline.
- **The mission fixture projects and media are gitignored too.** Replay still needs the
  `.fp.json` — symlink `tests/fixtures/mission/projects` and `.../media` into the worktree.

### Traps that have each cost real time

1. **`FRAMEPILOT_AI_PROVIDER=mock` is exported in this shell.** `env | grep FRAMEPILOT`
   first. `env -u` in the recipe is why it is there.
2. **The "do not build or test while it runs" trap is about MEMORY, not CPU.** A full
   `vitest run` of ai-sdk was OOM-killed mid-run in session 4. `tsc --noEmit` and targeted
   `vitest run <paths> --no-file-parallelism --maxWorkers=1` at `nice -n 19` are fine;
   never sweep. **Never rebuild `dist/` mid-run** — the runner imports it.
3. **`--force` overwrites per-case evidence in place.** The one exception is a case whose
   file holds only a transport error (§2.1).
4. **A provider outage looks like a fast, complete run.** Read the void-turn and
   harness-timeout rows first.
5. **A killed run writes no merged summary.** Compute from
   `reports/golden/<label>/cases/*.json` and say so.
6. **`eslint` on `packages/ai-sdk` OOMs locally.** Push and read CI instead.

### Three frozen token surfaces, three regen commands

Any change to a tool description, a skill, or the system contract moves all three. A
partial regen leaves a red suite:

```bash
FRAMEPILOT_GOLDEN_UPDATE=1 pnpm --filter @framepilot/ai-sdk test golden-corpus
pnpm --filter @framepilot/ai-sdk test src/kernel/streamAgent-golden.test.ts -- -u
FRAMEPILOT_GOLDEN_UPDATE=1 pnpm --filter @framepilot/ai-sdk test langchain-session-parity
```

**Read the diff before regenerating — it IS the measured token delta**, and put the number
in the commit message. Session 7 read +250, tightened the copy, and committed +169.

### Adding an operation touches more places than it looks

`reorder_clips` needed, in one change: the `Operation` union, apply, invert, the operation
contract, `validation-scope.ts`, the validator's `SUPPORTED_OPERATIONS`,
`normalizeOperationTime`'s pass-through list, the tool registry, `tool-domains.ts`,
`tool-classification.ts`, `autonomous-patch-proposal.ts`, the web editor's `toolMeta.ts`,
and the whole Python mirror (model, union, apply, invert, dispatch table, handler, args
model, registry spec, validator's supported set and error-code map). The last one to bite
was `toolMeta.ts` — only the full `pnpm test` catches it.

---

## 4. HOUSEKEEPING

- **No floor was written from `session6` or session 7.** `reports/golden/floor.json` is
  still the `baseline` one.
- **Never `git add -A`, `git add .`, or `git add -u` in this repo** — mission fixture media
  is un-ignored and a blanket add put 3.8 GB in history. Stage by explicit path.
- **Never `git stash` here**, including `--keep-index`.
- **`ruff format` will reformat GENERATED Python** (`skills_generated.py`,
  `autonomous_contract.py`) into churn the next build undoes. Format only the files you
  wrote, or `git checkout` the generated ones afterwards.
- **A repo-wide `sed` on an ADR number is a bad idea.** Session 7 renumbered eleven files'
  pre-existing ADR 0170 references before catching it. Match on the sentence, not the
  number.
- **The desktop export matrix was skipping, and the fix is one command.** `UC-13 export
  matrix` needs `mission-export-30s.fp.json` and `mission-export-60s.fp.json`, which no
  checkout here had — so the full desktop e2e reported 13 passed / 19 skipped and every
  real-render assertion was among the skips. **`node packages/ai-sdk/scripts/mission-export-projects.mjs`
  generates both from the existing fixtures** (they are derived timelines over the same
  media, not new footage). With them present, `export-matrix.spec.ts` runs **8 passed, 0
  failed**, ffprobe asserting on the real exported files — which is how session 7's
  frame-grid change got render-backed rather than only deterministic evidence. Run that
  script before concluding the matrix "cannot" run.
- **A cold Electron launch in a fresh worktree can exceed the 180s e2e timeout.** Session
  7 lost an hour to reading that as a regression; it passes in ~31s on the second launch.
  Warm the binary with one spec before trusting a desktop e2e failure.
- Nothing is running. No sidecar, no runner.
- Session 8 worked in a worktree (`../FramePilot-reliability-s8`, branch
  `fix/agent-reliability-s8`, pushed), leaving the main checkout on
  `fix/agent-reliability-2026-09-05`. The worktree has `node_modules` and built
  workspace deps; it has NO `run.md`, no mission fixtures and no recordings.
- Formatting: only files prettier-clean at the branch point should be formatted. The rest
  are the repo's existing red `format:check` baseline. `BASELINES.md` and `REMAINING.md`
  are both in it — do not reformat them.
- Memory files worth reading first: `golden-eval-harness`, `verification-judges-the-delta`,
  `agent-progress-guards-layered`, `never-git-add-all-framepilot`,
  `never-git-stash-framepilot`, `golden-manifests-track-prompt-text`,
  `baseline-run-operational-traps`, `error-message-text-is-a-guard-key`.
