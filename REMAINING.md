# REMAINING — golden eval + AI precision work

Handoff from the 2026-09-05 sessions. Seven sessions have now happened; **`BASELINES.md`
has an entry for each**, newest first, and the numbers below mean nothing without them.

- **sessions 3–5** — thirty-one defects read out of `run.md` (a captured desktop
  transcript, run `137d8fd0`). Two of those sessions ran nothing.
- **session 6** — the fixture that invalidated three cases was **replaced**, and a run on
  it produced eleven cases of clean evidence before the provider dropped. It found a
  defect that loses the editor's footage.
- **session 7** (this one) — **no new run.** The four open engine defects were closed with
  reproducing tests, and the most expensive one was measured shut by `--replay` (free).
  Branch `fix/agent-reliability-s7`, `3ec8a54..3d2364f`.

> **`run.md` is not a new run.** It has been offered as one FOUR times now. Its ids say
> otherwise: conversation `33f7e787`, run `137d8fd0`, 1,064,475 lines, created
> 2026-09-04T18:12. Only its mtime is recent. Check the run id before mining it — session
> 7's sweep re-derived several already-closed defects before finding a new one, including
> the `add_music` empty-duck refusal whose fix cites this exact run in its docstring.

---

## 1. WHAT'S CLOSED

Sessions 3–6 closed thirty-five defects; those lists live in `BASELINES.md` under their
entries and are not repeated here. **Session 7 closed all four remaining engine defects,
each with a reproducing test, plus one new find:**

1. **A reorder no longer destroys footage** (`a080900`, ADR 0173). The old §2.1 — the most
   serious thing on the branch. `reorder_clips` recomputes a track's starts in ONE patch:
   no delete, no add, clip set invariant. See §3.1 below for what is still unproven.
2. **A turn refused at the same wall twice is not progress** (`0c9f195`). The old §2.2.
   Two independent holes, both closed; **measured by replay**: 121 tool calls → 25, $3.93
   → $0.571, `cancelled` → `completed`.
3. **A retime lands on the frame grid** (`1a49f98`). The old §2.3. Route (1) of the three
   the last handoff named — `ApplyContext.fps` threaded by `applyProjectPatch`, mirrored
   in Python, with the same-shape inverse kept only where it is provably exact.
4. **One answer to "when does this word begin"** (`eb50cbc`). The old §2.4.
   `get_mapped_transcript` reports the edit point in seconds AND frames naming the same
   instant, so the quantizer cannot round a cut across the boundary it was aimed at.
5. **A catalogue id finds its own bin asset** (`3d2364f`). New, from the `run.md` sweep.

Cost of all of it on the frozen token surfaces: **+169 tokens per request**
(`tool_schemas` 7,027 → 7,196), entirely from the `reorder_clips` tool. A first draft of
its description cost +250 and was tightened for the same discovery signal. Nothing else
this session moved a golden.

---

## 2. WHAT'S STILL OPEN

### 2.1 Ten of twenty-one cases still have no clean run — THE ONLY THING A RUN CAN FIX

`hook-strongest-line`, `compound-silence-captions`, `broll-first-20s`,
`broll-empty-overlay-track`, `music-bed-quiet`, `captions-uppercase-bottom`,
`vague-make-better`, `impossible-8k-drone`, `guard-wipe-timeline`, `clarify-which-clip`.

Their `session6` case files hold either a transport error or nothing, and their recordings
are **14 bytes**, so `--replay` cannot reach them either. **Re-running them needs
`--force`**, because a file exists; that is the one situation where `--force` is right.
Everything else on that label is real and must not be overwritten.

`hook-strongest-line` is the one to want most: its rubric contradiction was repaired in
session 5 and unit tested, and it has still never run on media that can validate it.

### 2.2 Nothing from session 7 is measured against the model

This is the honest headline. Five defects closed, 32 tests, every suite green, **and not
one sample of intent accuracy, target resolution, first-pass acceptance, accepted edits,
or tokens per accepted edit.** `reorder_clips` in particular is a capability the agent did
not have, so its effect on the reorder cases is entirely unknown.

`reorder-last-first`'s floor is 1.00 against a 0.60 median, so **the gate will flag it**
whatever happens. That is not this branch: `reorder-swap-first-two`'s floor was already
0.50.

### 2.3 Deferred, and stated rather than done

- **No `reorder` intent in the professional `EditorCommand` layer**, and no web-editor
  reorder gesture. `editor-capabilities.ts` maps intents to `commandType`s that must
  exist; adding one is a second slice. The AI route is where the footage was being lost,
  which is why it went first.
- **ADR 0056 (compound-request atomicity vs instant-apply)** is still open on its own
  merits. `reorder_clips` removes the reason the reorder cases reached for
  destroy-and-rebuild; it does not make instant-apply transactional for every other
  compound request.
- **ADR 0166 (the deleted wipe guard)** stays deleted. ADR 0173 records why: the guard
  catches two of the five content-loss failures and misses the three 5→1 cases.

### 2.4 Reads are 42% of tool calls — still deliberately not fixed

Unchanged, and the reasoning is unchanged: the memo cannot serve when every turn applies a
patch that invalidates timeline-dependent evidence. The lever is `arrangementLine` carrying
clip ids, a context-budget trade needing a measured before/after.

### 2.5 Things ruled OUT, so nobody re-investigates them

Everything the previous handoff listed here still holds — compaction never fires, stop is
not broken, the 144 `add_music` failures are one failure, the void-turn and
harness-timeout exclusions work, `speech-9min-b` is not a drop-in. Two updates:

- **"A more specific error message is not free" is now half-solved.** It remains true of
  `deterministicFailureKey` (the per-CALL guard, keyed on the message body). It is no
  longer true of the per-TURN guard: producers supply a stable `rejectionKey` and the
  message is free to name whatever the model needs. Extending the same separation to
  `deterministicFailureKey` is the obvious next step and was not taken this session.
- **The pinned-playbook budget stays closed.** Session 6 answered it; nothing since
  reopens it.

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
- **The desktop export matrix skips on this machine, and always has.** `UC-13 export
  matrix` needs `mission-export-30s.fp.json` and `mission-export-60s.fp.json`, and neither
  exists in `tests/fixtures/mission/projects` in ANY checkout here — only the five
  `mission-*` projects do. So the full desktop e2e reports **13 passed, 0 failed, 19
  skipped**, and the nineteen include every real-render assertion. Session 7's frame-grid
  and `reorder_clips` claims are therefore backed by **deterministic cross-runtime
  evidence** (the shared `cross-runtime-operation-behavior` fixture plus 2,843 engine
  tests), not by a render. If you want a rendered check of the retime grid, those two
  fixture projects have to exist first.
- **A cold Electron launch in a fresh worktree can exceed the 180s e2e timeout.** Session
  7 lost an hour to reading that as a regression; it passes in ~31s on the second launch.
  Warm the binary with one spec before trusting a desktop e2e failure.
- Nothing is running. No sidecar, no runner.
- Session 7 worked in a worktree (`../FramePilot-reliability-s7`, branch
  `fix/agent-reliability-s7`), leaving the main checkout on its own branch.
- Formatting: only files prettier-clean at the branch point should be formatted. The rest
  are the repo's existing red `format:check` baseline. `BASELINES.md` and `REMAINING.md`
  are both in it — do not reformat them.
- Memory files worth reading first: `golden-eval-harness`, `verification-judges-the-delta`,
  `agent-progress-guards-layered`, `never-git-add-all-framepilot`,
  `never-git-stash-framepilot`, `golden-manifests-track-prompt-text`,
  `baseline-run-operational-traps`, `error-message-text-is-a-guard-key`.
