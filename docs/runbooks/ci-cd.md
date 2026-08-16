# Runbook: CI/CD

Every pull request must pass the quality gates below before it can merge (PRD §17). CI is
defined in [`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml). The point of
these gates is to keep the editing engine deterministic, validated, and reversible at all
times — the foundation the AI layer depends on.

CI runs automatically for every pull request and every push to `main`. It can also be dispatched
manually from GitHub → **Actions** → **CI** → **Run workflow** (or with
`gh workflow run ci.yml --ref <branch>`). All jobs are blocking: reviewer outages, missing visual
baselines, a failed desktop build, or an unverified professional operation fail the workflow.

---

## Gates (every PR)

| Gate                 | Command(s)                                                                  | Notes                                                                                  |
| -------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| TypeScript typecheck | `pnpm typecheck`                                                            | Across all packages/apps.                                                              |
| Python typecheck     | `uv run mypy .`                                                             | Engine.                                                                                |
| Lint                 | `pnpm lint` · `uv run ruff check .`                                         | Prettier/ESLint + Ruff.                                                                |
| Unit tests           | `pnpm test` · `uv run pytest`                                               | Vitest + pytest.                                                                       |
| Integration tests    | (same runners)                                                              | Import → patch → render preview → export.                                              |
| Coverage             | `pnpm test:coverage` · `uv run pytest --cov`                                | Reported, not gated — no percentage threshold blocks a run.                            |
| E2E smoke            | `pnpm test:e2e`                                                             | Playwright; critical flows ([../guides/writing-tests.md](../guides/writing-tests.md)). |
| License scan         | (CI step)                                                                   | Flags disallowed/unknown licenses.                                                     |
| Desktop build        | `pnpm desktop:build`                                                        | Electron app builds.                                                                   |
| Render fixture       | `pytest test_render_pipeline.py::test_export_video_completes_and_validates` | Performs a real MoviePy/FFmpeg export and requires render validation to pass.          |
| Professional evals   | `pnpm eval:professional:rendered`                                           | Requires all 33 registered professional operations to acquire and pass real evidence.  |

`pnpm verify` is the local release-equivalent aggregate. For a faster development loop, use
`pnpm verify:core`, then run the affected specialized gate after each edit.

---

## Blocking rules (PRD §17)

A PR is blocked if any of these are true:

- ❌ Any failing test.
- ❌ A skipped test **without a linked issue**.
- ❌ An **unvalidated timeline operation** can reach `apply`.
- ❌ A **new dependency without license review**.
- ❌ A **render change without a golden-test update**.
- ❌ A **breaking schema change without a migration** (see
  [../api/timeline-schema.md](../api/timeline-schema.md)).

These mirror the agent working agreements in `.codex/AGENTS.md` and the standing tasks in
[../../plan/PLAN.md](../../plan/PLAN.md).

---

## Where reports land

CI writes generated artifacts into the repo-root **`reports/`** tree (git-ignored content,
kept directories):

```
reports/
  test/        unit/integration test output
  coverage/    coverage reports
  e2e/         Playwright results, screenshots/videos on failure
  render/      render + render-validation output for fixture renders
```

Human-written summaries of these artifacts live in
[../reports/](../reports/README.md) (see that folder's README for the distinction). The
release runbook ([release.md](release.md)) consumes these on release readiness.
