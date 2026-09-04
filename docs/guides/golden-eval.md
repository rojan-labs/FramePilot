# Golden evaluation — the operator's guide

The golden harness measures whether the agent does **the right thing to the right footage
at the right time**, and what that costs, on a fixed set of real user requests over real
media. It is the instrument every prompt, tool, model and orchestration change reports its
delta against (goal.md Phase 0). Real-media runs are done by hand; this page is the whole
recipe.

## What it is made of

| Piece | Where | What it does |
| --- | --- | --- |
| Golden set | `packages/ai-sdk/src/eval/golden-cases.ts` | 21 cases — one per request category plus a second phrasing of each core verb (trim, reorder, captions): trim, silence, reorder, captions, pacing, hook, b-roll, audio, compound, vague, impossible, guard (must confirm), clarify (must ask), plus the six mission scenarios. Each turn names its rubric and the intent the agent should form. |
| Rubric | `packages/ai-sdk/src/eval/mission-rubric.ts` | Checkable assertions on the resulting **edit state** — clip geometry, source ranges, captions, music, transcript words. Never a string match on prose. Checks are faceted `target` / `boundary` so the metrics can read them. |
| Metrics | `packages/ai-sdk/src/eval/golden-metrics.ts` | Intent accuracy, target resolution, boundary precision, operation validity, first-pass acceptance, silent successes, turns and tool calls, tokens and USD **per accepted edit**, latency to first progress and to done (p50/p95), reversibility (undo restores the prior project), failure quality. Pure functions over the event stream + applied patches. |
| Runner | `packages/ai-sdk/scripts/mission-baseline.mjs` | Real `Orchestrator.streamAgent`, real provider, real sidecar. One command per case. Per-case result files (resumable). Effect recordings for replay. Cost estimate before the run. |
| Gate | `packages/ai-sdk/scripts/golden-gate.mjs` | The one gate: rubric score, calls/tokens per turn, and the goal.md metrics against `reports/golden/floor.json`; a regression is a non-zero exit. |

## One-time setup (maintainer's machine)

Media is not committed. Build the fixture projects once:

```bash
./tests/fixtures/mission/fetch-fixtures.sh                      # copies media from MISSION_MEDIA_DIR, records checksums

# in another terminal: the sidecar, rooted at the fixtures, on :8799.
# There is no `pnpm engine:serve`; the entry point is the engine's own CLI.
cd engine/python && FRAMEPILOT_PROJECTS_ROOT=/abs/path/to/tests/fixtures/mission/projects \
  uv run framepilot serve --host 127.0.0.1 --port 8799
# the root must be ABSOLUTE: the CLI resolves it against its own cwd, not the repo.
curl -s http://127.0.0.1:8799/health                            # {"status":"ok",…} before continuing

pnpm --filter @framepilot/ai-sdk build                          # the runner imports dist/ — build BEFORE the next line
cd packages/ai-sdk && FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 \
  node scripts/mission-fixture-projects.mjs                     # transcribes the dialogue fixtures with local whisper (content-hash cached)
```

The runner reads `.env` for the provider (`FRAMEPILOT_AI_PROVIDER`, keys) and
`FRAMEPILOT_PYTHON_API_URL` for the sidecar (default `http://127.0.0.1:8799`). Values already
exported in the shell WIN over `.env` — the runner only fills in what is undefined — so pass
the provider on the command line rather than editing `.env`, and check what is exported before
blaming the file. A stray `FRAMEPILOT_AI_PROVIDER=mock` in the environment silently produces a
complete, plausible, meaningless run.

On a Claude subscription the provider needs no API key at all (ADR 0171):

```bash
FRAMEPILOT_AI_PROVIDER=claude-agent-sdk \
FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5 \
FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8799 \
  node packages/ai-sdk/scripts/mission-baseline.mjs --runs 3 --label baseline --yes
```

**Run it on an otherwise idle machine, and detach it** (`nohup … &`). A full baseline holds
200k-token prompts in memory for hours; a concurrent `vitest run` over the whole package was
enough to get the runner killed twice — silently, with no stack trace, no exit line, and the
last case simply never finishing. Per-case results are already on disk, so re-invoking the
same command resumes; the cost of the crash is the case in flight, not the run.

Note that the `usd` column is priced from `cost-meter.ts`'s per-tier table, not from what the
provider actually billed. It is a comparable unit across runs, not an invoice — and for a
model outside the catalogue, or one that is free, it is not even the right order of
magnitude.

### The fixture projects, and the shape each one is for

| Project | Shape | Why it exists |
| --- | --- | --- |
| `mission-montage` | 5 raw clips end to end on `video_1`, two beat tracks in the bin, 9:16 | Open-ended selection over raw footage |
| `mission-podcast` | one 9.6-minute dialogue clip + transcript | Transcript-grounded cuts, silence |
| `mission-talk` | one 8.8-minute narration clip, music in the bin, transcript | Captions, music bed, the plain cutaway |
| `mission-overlay` | the same narration gapless on `video_1`, an **empty** second video track `b_roll` above it, two b-roll clips in the bin, transcript | Run `369e8c82`'s shape: with picture covering the whole sequence, ADR 0140 refuses every placement on `b_roll`, so the empty track is a trap. Reuses `mission-talk`'s narration, so whisper hits its content-hash cache and the pair of b-roll cases differ in one variable only |
| `mission-photos` | 60 stills + music | Stills pacing (no golden case yet) |

## Running

```bash
pnpm eval:golden -- --list                                   # the cases
pnpm eval:golden -- --estimate                               # cost + duration, no run
pnpm eval:golden -- --case trim-first-clip-10s               # one case, one run
pnpm eval:golden -- --category guard,clarify,impossible      # the "should not edit" trio
pnpm eval:golden -- --runs 3 --label baseline --yes          # the whole set, three runs each
pnpm eval:golden -- --replay --label baseline                # re-score from recordings, zero model calls
```

Before anything runs, the harness prints the estimated USD and minutes per case (from the
last summary of the same cases) and asks for confirmation; `--yes` skips the prompt. A
case with no prior run is reported as **unknown**, and the total is then not a total.

### What a run writes

```
reports/golden/<label>/
  cases/<case>-r<n>.json        one result per case+run — the resume unit
  recordings/<case>-r<n>-t<k>.json   every effect the run executed (gitignored; large)
  summary.json                  the machine-readable result (metrics + per-case table)
  summary.md                    the short human summary
reports/golden/<label>.json     the merged run: per-scenario rows + the golden summary — what the gate reads
```

**Hand back `summary.json` (or the whole `<label>/` folder).** It is the single artifact;
prose about what you saw is welcome but not required.

### Resuming and re-running

A case whose `cases/<case>-r<n>.json` exists is skipped and folded into the summary from
disk. So after a fix, re-run only what the fix touched:

```bash
pnpm eval:golden -- --case remove-dead-air --label baseline --force   # redo one case
pnpm eval:golden -- --label baseline                                  # rebuild the summary from every cached case
```

Sidecar analysis (silence, transcript, frames) is cached on its side, so a re-run does not
re-bill the paid analyzers either.

### Reading a case result

`cases/<case>-r<n>.json` → `turns[k]`:

- `golden.intent` — `expected` vs `observed` (`edit` / `ask` / `decline` / `failed` / `silent`).
- `checks[]` — every rubric check with the number that decided it (`✗` rows are also printed live).
- `golden.reversibility.detail` — where the project differed after undo, if it did.
- `asked[]` — the exact questions the agent asked and the options it offered.
- `assistantText` — the first 600 characters of its final reply.
- `metrics` — calls, tokens, USD, tool calls by name, repeated tool calls, errors, final status.
- `recording` — the file `--replay` will use.

## Gating

```bash
pnpm eval:golden:gate reports/golden/baseline.json --write   # accept a run as the floor
pnpm eval:golden:gate reports/golden/after.json              # compare; exit 2 on regression
```

One gate, one floor (`reports/golden/floor.json`), three families of numbers:

- **rubric** — per scenario, the p50 outcome score may not drop more than 0.05;
- **efficiency** — per scenario, p50 model calls and tokens per turn may not rise more
  than 10% unless the rubric score improved (paying more for a better edit is allowed);
- **goal.md metrics** — run-wide: intent, target, boundary, validity, first-pass and
  reversibility may not drop more than 5 points; no new silent success; tokens per
  accepted edit may not rise more than 10% without a first-pass gain. Latency and the
  failure-explained share are reported, never gated.

The input is either a run JSON (`reports/golden/<label>.json`) or a `summary.json`; a
family the input cannot supply is reported as n/a, never failed.

`--write` warns when the floor it just recorded **gates nothing** on a metric. A rate only
fails on a drop, so a floor of 0% can never regress, and a null one is always n/a — both
print reassuringly ("held", "n/a") while checking nothing. That is how a broken measurement
becomes permanent, so read the warning before trusting the gate: a zero is occasionally
honest, but far more often it means the harness, not the agent, is what scored zero. CI runs the gate on the
committed `reports/golden/baseline.json`; the nightly runs the six mission scenarios
(`pnpm --filter @framepilot/ai-sdk eval:mission:real`) and gates the fresh run.

## Adding a case

1. Add it to `GOLDEN_CASES` with a `why` (the failure it exists to catch) and a rubric id.
2. If no rubric fits, add checks to `mission-rubric.ts` — faceted `target` or `boundary`
   where they answer "right clip?" or "frame-exact?" — and a scenario branch. Prefer a new
   scenario id over more checks on an existing one: adding checks changes what the cases
   already on that rubric measure, and their floor in `reports/golden/floor.json` was
   written against the old set.
3. If no fixture has the project *shape* the failure needs, add a `DEFS` entry to
   `packages/ai-sdk/scripts/mission-fixture-projects.mjs` and reuse media the other
   fixtures already pull, then regenerate on the maintainer's machine. A case whose
   fixture is missing stops the run before it costs anything.
4. `pnpm --filter @framepilot/ai-sdk exec vitest run src/eval/` — the shape test asserts
   every case is scorable and every required category is covered.

## What the fixture tests prove, and what only a real run proves

Fixture tests prove the **logic**: the rubric decides correctly on synthetic timelines, the
metrics read events correctly, undo of real editor-core patches is byte-identical. Only the
manual run proves the **experience**: that the agent, on this footage, with this provider,
forms the right intent and lands the right cut. A number in this repo that came from a
fixture is never presented as a real-media result.
