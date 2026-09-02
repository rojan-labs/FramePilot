# Golden evaluation — the operator's guide

The golden harness measures whether the agent does **the right thing to the right footage
at the right time**, and what that costs, on a fixed set of real user requests over real
media. It is the instrument every prompt, tool, model and orchestration change reports its
delta against (goal.md Phase 0). Real-media runs are done by hand; this page is the whole
recipe.

## What it is made of

| Piece | Where | What it does |
| --- | --- | --- |
| Golden set | `packages/ai-sdk/src/eval/golden-cases.ts` | 17 cases, one per request category: trim, silence, reorder, captions, pacing, hook, b-roll, audio, compound, vague, impossible, guard (must confirm), clarify (must ask), plus the six mission scenarios. Each turn names its rubric and the intent the agent should form. |
| Rubric | `packages/ai-sdk/src/eval/mission-rubric.ts` | Checkable assertions on the resulting **edit state** — clip geometry, source ranges, captions, music, transcript words. Never a string match on prose. Checks are faceted `target` / `boundary` so the metrics can read them. |
| Metrics | `packages/ai-sdk/src/eval/golden-metrics.ts` | Intent accuracy, target resolution, boundary precision, operation validity, first-pass acceptance, silent successes, turns and tool calls, tokens and USD **per accepted edit**, latency to first progress and to done (p50/p95), reversibility (undo restores the prior project), failure quality. Pure functions over the event stream + applied patches. |
| Runner | `packages/ai-sdk/scripts/mission-baseline.mjs` | Real `Orchestrator.streamAgent`, real provider, real sidecar. One command per case. Per-case result files (resumable). Effect recordings for replay. Cost estimate before the run. |
| Gate | `packages/ai-sdk/scripts/golden-gate.mjs` | Compares a run's `summary.json` with `reports/golden/floor.json`; a regression is a non-zero exit. |

## One-time setup (maintainer's machine)

Media is not committed. Build the fixture projects once:

```bash
./tests/fixtures/mission/fetch-fixtures.sh                      # copies media from MISSION_MEDIA_DIR, records checksums
# in another terminal: the sidecar rooted at the fixtures
FRAMEPILOT_PROJECTS_ROOT=tests/fixtures/mission/projects pnpm engine:serve   # (or however you start it on :8799)
node packages/ai-sdk/scripts/mission-fixture-projects.mjs       # transcribes the two dialogue fixtures with local whisper
pnpm --filter @framepilot/ai-sdk build                          # the runner imports dist/
```

The runner reads `.env` for the provider (`FRAMEPILOT_AI_PROVIDER`, keys) and
`FRAMEPILOT_PYTHON_API_URL` for the sidecar (default `http://127.0.0.1:8799`).

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
reports/golden/<label>.json     the merged run in the shape mission-score.mjs / mission-efficiency-gate.mjs read
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
node packages/ai-sdk/scripts/golden-gate.mjs reports/golden/baseline/summary.json --write   # accept as the floor
node packages/ai-sdk/scripts/golden-gate.mjs reports/golden/after/summary.json              # compare; exit 2 on regression
```

Fails on: any rate (intent, target, boundary, validity, first-pass, reversibility) dropping
more than 5 points; any new silent success; tokens per accepted edit up more than 10%
without a first-pass gain. Latency and failure-explained share are reported, not gated.

The two older gates still run on the merged JSON:
`node packages/ai-sdk/scripts/mission-score.mjs reports/golden/baseline.json` and
`node packages/ai-sdk/scripts/mission-efficiency-gate.mjs reports/golden/baseline.json`.

## Adding a case

1. Add it to `GOLDEN_CASES` with a `why` (the failure it exists to catch) and a rubric id.
2. If no rubric fits, add checks to `mission-rubric.ts` — faceted `target` or `boundary`
   where they answer "right clip?" or "frame-exact?" — and a scenario branch.
3. `pnpm --filter @framepilot/ai-sdk exec vitest run src/eval/` — the shape test asserts
   every case is scorable and every required category is covered.

## What the fixture tests prove, and what only a real run proves

Fixture tests prove the **logic**: the rubric decides correctly on synthetic timelines, the
metrics read events correctly, undo of real editor-core patches is byte-identical. Only the
manual run proves the **experience**: that the agent, on this footage, with this provider,
forms the right intent and lands the right cut. A number in this repo that came from a
fixture is never presented as a real-media result.
