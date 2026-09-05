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
6. **The motion domain can build the speed ramp it advertised** (`7853985`). Zero
   `set_clip_speed_ramp` in 1,064,476 lines against a brief that asked for one, six times.
7. **`measure_color` is a look at the edit, and a stage refusal says which kind it is**
   (`6b41ff4`). +141 tokens/request, measured.
8. **A turn the timeline already matched is not progress** (`6d52298`).
9. **"Silent" says what level it means** (`bf60c39`).
10. **A human can reorder shots too** (`e56cf01`, GOLDEN-C.7).
11. **A refusal no edit can fix survives the edits** (`617b427`). From `runs.jsonl`, not
    `run.md`: `render_preview` refused eight times in one 86-minute desktop run because
    every landed edit wiped the memory of the refusal.

Cost of all of it on the frozen token surfaces: **+169 tokens per request**
(`tool_schemas` 7,027 → 7,196), entirely from the `reorder_clips` tool. A first draft of
its description cost +250 and was tightened for the same discovery signal. Nothing else
this session moved a golden.

---

## 1b. `run.md` — which axes are exhausted, and which was not

Session 7 first declared this transcript exhausted after four sweeps and recorded a table
of leads that look open and are closed. **That verdict was wrong, and the reason is worth
more than the table.** All four axes were FAILURE-shaped — distinct error strings,
non-completed tool outcomes, warnings and notices, failed recalls — and each re-derived
defects already closed by fixes whose docstrings cite this run by name. Then a fifth axis,
PROMISE-shaped — walk the brief's seven explicit asks against the 416 applied operations —
found four defects in one pass, none of which had failed: the run simply never did the
thing, or did it and reported it in words that meant something else.

**Exhausted (do not re-mine):** error strings · tool outcomes by name · warnings/notices ·
failed recalls. The leads they produce and where each is closed:

| looks like a defect | actually | where it is closed |
| --- | --- | --- |
| `add_music` refused on an empty duck target | closed — names the tracks that DO carry sound | `music-placement.ts#duckCandidateSentence` |
| 27 recalls answered "no such handle" for issued ids | closed — invalidated handles leave a tombstone | `evidence-store.ts#expired` |
| caption / audio / render failure clusters | closed in sessions 3–5 | `BASELINES.md` "session 3" |
| `load_tools` failed once | one refusal, remedy stated, obeyed next call | — |
| 144 `add_music` failure lines | ONE failure re-serialised | — |

**Walked once, and it yielded (brief-vs-delivery):** the ramp (`7853985`), the colour
measurement (`6b41ff4`), the level re-sets (`6d52298`), the silence answer (`bf60c39`).
Markers-before-cuts, the music bed and the punch-in were honoured; the second deliverable
(a horizontal 60 s beside the vertical) is a single-project aspect limit, not an agent
fault. `BASELINES.md` "continued sweep" has the table.

**Walked, and it confirms §2.6 rather than adding to it (the cost axis):** attribute the
12.36M estimated context tokens across the 309 requests by manifest section. The answer:
`system`-tier "additional request content" is **8.22M — 67%** — p50 28,190/request, growing
385 → 34,742. That row is the manifest's REMAINDER (`manifest.ts#withRemainder`), not the
action log and not the state briefing — I misread it as each in turn before measuring — and
`orchestrator.ts#agentStableInstructionSections` already names this exact run and number:
"32,338 tokens: 57% of every request … it is eight pinned playbooks." The attribution fix
(`ed7839a`) landed the day after the run, which is why the run's manifests show only the
fifteen generic labels and the remainder. Everything else the axis surfaced is bounded by a
considered design: the action log is capped at ≤ 24k tokens (`FINDINGS_BUDGET_CEILING_TOKENS`,
window-as-floor per `compactAgentLog`); compaction fired 0 of 309 times because the peak
request was 59,172 tokens — 46% of an ASSUMED 128k window (`limitAssumed: true` on all 309)
— so a window-fraction trigger could not fire; the 24 byte-identical `get_timeline` results
(17 same-turn, 7 cross-turn) cost digest-size in context, not the 74 KB the transcript
shows, because the model reads `summarizeReadResult`/`EvidenceStore.preview` (900 chars),
not the card payload. **No new defect. All axes on this transcript are now exhausted.**

**A second source, freshly mined:** `framepilot.runs.jsonl` (the desktop's per-call log)
held 497 calls from 2026-09-05 nobody had read. It yielded one defect — a `render_preview`
refusal that no edit can fix, forgotten on every edit (`617b427`) — and one open lead
(GOLDEN-C.16, the 13× caption-style loop). `BASELINES.md` "runs.jsonl" has the table. Its
≥ 2026-09-05 slice is now exhausted; older entries were covered by the earlier pass.

**Operational loss to know about:** the `s7-*` golden RECORDINGS are gone — gitignored,
they lived only in the worktree that was removed after the merge. Case files are intact;
`--replay` of those runs is not possible. Copy `recordings/` out before removing a
worktree.

---

## 2. WHAT'S STILL OPEN

### 2.1 CLOSED — the ten cases have evidence, and nine of them score 1.00

Run as `s7-gapfill`, 10 × 1, `claude-agent-sdk`/`claude-sonnet-5`, $3.31, 8.5 min. Full
metrics and per-case table in `BASELINES.md`. Headline: intent 90%, target 89%, boundary
100%, validity 100%, first-pass 80%, silent successes 0, reversibility 100%.
`hook-strongest-line` scored 1.00 on real media for the first time.

**What it found, and this is now the worst adherence failure on the branch:**
`clarify-which-clip` asked exactly the right question, was told "make no change to the
timeline", and then put a 0.49-width centre crop on **all five clips**. Same shape as the
reorder failure — a drastic unrequested whole-timeline action while nominally waiting —
and worse in one respect, because the instruction was unambiguous.

### 2.2 CLOSED — a decline is a dismissal, and the evidence says so

The runner used to settle a decline as a real ANSWER (the sentence "No answer — stop here
and make no change"), so the runtime recorded a standing decision, returned `completed`,
and the run continued. `ask_user` already had `{ kind: 'cancelled' }`, which
`orchestrator.ts` turns into a stop **before any op is applied**, and the harness was not
using it.

I first measured the fix, misread the result, and reverted it. The correction is in
`BASELINES.md` under "CORRECTION to `s7-gapfill`". The short version: the two runs of
`guard-wipe-timeline` differ in what the AGENT did, not in what the instrument scored —
`asked: []` in one, `asked: ["Clear all 5 clips…?"]` in the other. Asking for wipe
confirmation is precisely what ADR 0166 refused, and under the prose answer that violation
scored **1.00 with a non-empty `asked`**. The case's purpose was defeated by the harness
answering.

Landed. A case with no `answer` of its own now dismisses; a case that supplies one is
unaffected. This also closes the `clarify-which-clip` finding mechanically: the run stops
at the dismissal, so an agent that would have edited afterwards cannot.

**What remains unmeasured about it:** the model's disposition to over-edit after a decline
is unchanged — the runtime just no longer lets it act. And whether the agent asks for wipe
confirmation often enough to matter is two samples, one each way.

### 2.3 The session-7 code changes are still unmeasured against the model

`s7-gapfill`'s ten cases exercise captions, b-roll, music, hooks and guards — **none of
them reorders, retimes, or touches the beat grid.** So `reorder_clips`, the frame-grid
retime and the same-wall rejection guard remain unsampled. The eleven cases that would
exercise them already have `session6` evidence and must not be re-run to satisfy curiosity;
measuring the change means a NEW label over those cases, deliberately, as its own decision.

`reorder-last-first`'s floor is 1.00 against a 0.60 median, so **the gate will flag it**
whatever happens. That is not this branch: `reorder-swap-first-two`'s floor was already
0.50.

### 2.4 Deferred, and stated rather than done

- **The web-editor reorder gesture is DONE** — right-click a clip → "Move earlier / later
  in sequence", built on `reorder_clips` so the track re-lays gaplessly and one undo
  restores the order. The professional `EditorCommand` `reorder` intent was deliberately
  NOT added: the web editor builds raw ops and nothing converges on that layer, so an entry
  there would be vocabulary with no consumer. Revisit only if a resolver-gated caller
  appears.
- **ADR 0056 (compound-request atomicity vs instant-apply)** is still open on its own
  merits. `reorder_clips` removes the reason the reorder cases reached for
  destroy-and-rebuild; it does not make instant-apply transactional for every other
  compound request.
- **ADR 0166 (the deleted wipe guard)** stays deleted. ADR 0173 records why: the guard
  catches two of the five content-loss failures and misses the three 5→1 cases.

### 2.5 Reads are 42% of tool calls — still deliberately not fixed

Unchanged, and the reasoning is unchanged: the memo cannot serve when every turn applies a
patch that invalidates timeline-dependent evidence. The lever is `arrangementLine` carrying
clip ids, a context-budget trade needing a measured before/after.

### 2.6 Things ruled OUT, so nobody re-investigates them

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
- Session 7 worked in a worktree (`../FramePilot-reliability-s7`, branch
  `fix/agent-reliability-s7`), leaving the main checkout on its own branch.
- Formatting: only files prettier-clean at the branch point should be formatted. The rest
  are the repo's existing red `format:check` baseline. `BASELINES.md` and `REMAINING.md`
  are both in it — do not reformat them.
- Memory files worth reading first: `golden-eval-harness`, `verification-judges-the-delta`,
  `agent-progress-guards-layered`, `never-git-add-all-framepilot`,
  `never-git-stash-framepilot`, `golden-manifests-track-prompt-text`,
  `baseline-run-operational-traps`, `error-message-text-is-a-guard-key`.
