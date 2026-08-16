# Security Policy

FramePilot is a **local-first** desktop application. The security model centers on three guarantees: user media is never destroyed, the AI agent can only act through sandboxed registered tools, and file access is confined to the active project.

## Reporting a vulnerability

Report suspected security issues privately through GitHub's **Report a vulnerability** / private security advisory flow when it is enabled for this repository. If that flow is unavailable, email **rojanacharya404@gmail.com**. Do not open a public issue or pull request for an undisclosed vulnerability, and do not include secrets or exploit details in public discussion. We aim to acknowledge reports within 72 hours.

## Automated repository guardrails

The public repository uses GitHub-native security automation where practical:

- CodeQL scans the JavaScript/TypeScript and Python code paths.
- Dependency Review checks dependency changes in pull requests.
- Dependabot monitors pnpm, uv, and GitHub Actions dependencies. Dependency PRs are never auto-merged by repository policy.
- Secret scanning and push protection are repository settings and should be enabled deliberately as described in `docs/runbooks/github-public-repository.md`.

These checks are defense in depth. They do not replace review of Electron privileges, path containment, release credentials, media handling, or agent tool authority.

## Security guarantees

### Local file safety

- Never delete or overwrite original assets.
- Never overwrite user files without explicit confirmation.
- Renders are written only inside the project's `renders/` folder.
- All paths go through safe resolution. Path traversal is rejected.

### Agent safety

- The agent cannot run arbitrary shell commands inside the app runtime.
- The agent may only call registered tools. Every tool input is schema-validated.
- File operations are sandboxed to the project directory (`FRAMEPILOT_PROJECTS_ROOT`).
- Render jobs have a hard timeout and are cancellable.

### Reliability

- Background jobs are resumable or retryable where the workflow requires it.
- Project saves are atomic.
- Timeline history supports undo and redo.
- The app recovers from a crash using the last valid project state.

## Secrets

- API keys live in `.env` (git-ignored) only. Never commit secrets.
- `.env.example` documents required variables.
- Keys are read at runtime. They are never written into `project.fp.json` or logs.

See `docs/runbooks/security-hardening.md`, `docs/runbooks/github-public-repository.md`, and `.agents/skills/security-hardening/SKILL.md` for operational checklists.
