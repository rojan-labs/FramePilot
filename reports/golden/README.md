# Golden evaluation results

Written by `packages/ai-sdk/scripts/mission-baseline.mjs` (see `docs/guides/golden-eval.md`).

- `<label>/cases/*.json` — one result per case+run (committed: they are the evidence).
- `<label>/summary.json` + `summary.md` — the run's metrics; hand `summary.json` back.
- `<label>/recordings/` — effect recordings for `--replay` (gitignored: megabytes).
- `<label>.json` — the merged run in the older mission-run shape.
- `floor.json` — the committed regression floor `golden-gate.mjs` compares against.
- `BASELINE.md` — the published baseline and its provenance.
