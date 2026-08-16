# Reports (human-written summaries)

This folder holds **living, human-/agent-written status and QA reports** — the
*narrative* layer over the project's quality signals. Examples:

- project status snapshots ([STATUS.md](STATUS.md)),
- test-run summaries and coverage snapshots,
- render-validation reports (what passed/failed and why),
- audit findings (security, performance, accessibility),
- release-readiness write-ups.

Current focused audit report:

- [UI system audit closure](ui-system-audit-closure.md) — 2026-08-10 presentation-system,
  accessibility-ergonomics, shared-control, and residual source-debt status.

Agents keep these current as part of the documentation workflow (the `update-docs` skill /
`.agents/skills/docs-maintainer/`).

---

## `docs/reports/` vs. the repo-root `/reports/` tree — know the difference

| | `docs/reports/` (here) | [`/reports/`](../../reports/README.md) (repo root) |
| --- | --- | --- |
| Content | Human-written **summaries / narrative** | **Generated artifacts** from CI |
| Format | Markdown | JUnit/JSON, coverage HTML, Playwright traces, render diffs |
| Committed? | Yes (these are docs) | No — contents git-ignored, only structure tracked |
| Audience | Humans reading "what's the state of things" | Tooling + drill-down evidence |

The generated artifacts live under the root tree:

```
reports/
  test/        unit/integration test result outputs (JUnit/JSON)
  coverage/    TS + Python coverage reports
  render/      render-validation outputs and golden-test diffs
  e2e/         Playwright HTML report, traces, screenshots, videos
```

When you write a summary here, **link to the underlying generated artifact** in
`/reports/` (or the CI run) rather than pasting raw output. Keep summaries short, dated,
and current. See [../runbooks/ci-cd.md](../runbooks/ci-cd.md) for how artifacts are
produced.
