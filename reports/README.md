# Reports

Generated artifacts live here (git-ignored contents, tracked structure):

- `coverage/` — TS + Python coverage reports
- `test/`     — unit/integration test result outputs (JUnit/JSON)
- `render/`   — render-validation outputs and golden-test diffs
- `e2e/`      — Playwright HTML report, traces, screenshots, videos

CI uploads these as build artifacts. Do not commit generated files.
