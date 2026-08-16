# GitHub Copilot repository instructions

FramePilot's canonical agent instructions are `AGENTS.md` and `.agents/`. Read them before making changes. `CLAUDE.md`, `.claude/`, `.codex/`, `.cursor/`, and `.opencode/` are harness adapters and must not become competing sources of truth.

Hard requirements:

- Preserve the six invariants in `AGENTS.md`, especially non-destructive media handling, typed validated timeline operations, reversible patches, and deterministic render validation.
- Read `.agents/rules/product-discipline.mdc` before non-trivial feature or architecture work. Prefer the smallest end-to-end improvement over speculative infrastructure.
- Read the matching skill under `.agents/skills/` for security, correctness, timeline, render, media, testing, docs, or plan work.
- TypeScript is strict and must not introduce `any`. Python uses typed `pathlib`-first code with Ruff and mypy.
- Never expose secrets, weaken the project-path sandbox, enable arbitrary shell execution from the in-app agent, or bypass Electron IPC boundaries.
- Do not modify original media. Do not mutate `project.fp.json` directly from AI code.
- Add focused tests for changed behavior and error paths. Run affected validation before claiming a change is complete.
- Keep docs and changelog material proportional to the change. Do not claim tests or CI passed unless they actually ran.

For repository automation changes, keep `GITHUB_TOKEN` permissions least-privilege, avoid secrets on pull-request workflows, set `persist-credentials: false` on checkout unless a job truly needs Git credentials, and prefer GitHub-native security features over new third-party bots.
