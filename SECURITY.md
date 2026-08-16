# Security Policy

FramePilot is a **local-first** desktop application. The security model centers on
three guarantees: user media is never destroyed, the AI agent can only act through
sandboxed registered tools, and all file access is confined to the active project.

## Reporting a vulnerability

Please report security issues privately. After the repository becomes public, use
GitHub's **Report a vulnerability** flow / private repository security advisory as the
preferred channel. As a fallback, email **rojanacharya404@gmail.com**. Do not open a
public issue or pull request for an undisclosed vulnerability, and do not include secrets
or exploit details in public discussion. We aim to acknowledge reports within 72 hours.

## Security guarantees (enforced + tested)

### Local file safety (PRD §18.1)

- Never delete or overwrite original assets.
- Never overwrite user files without explicit confirmation.
- Renders are written only inside the project's `renders/` folder.
- All paths go through safe resolution; **path traversal is rejected**.

### Agent safety (PRD §18.2)

- The agent **cannot** run arbitrary shell commands inside the app runtime.
- The agent may only call **registered tools**; every tool input is schema-validated.
- File operations are sandboxed to the project directory (`FRAMEPILOT_PROJECTS_ROOT`).
- Render jobs have a hard timeout and are cancellable.

### Reliability (PRD §18.3)

- Background jobs are resumable/retryable.
- Project saves are atomic.
- Timeline history supports undo/redo.
- The app recovers from a crash using the last valid project state.

## Secrets

- API keys live in `.env` (git-ignored) only. Never commit secrets.
- `.env.example` documents required variables.
- Keys are read at runtime; they are never written into `project.fp.json` or logs.

See `docs/runbooks/security-hardening.md` and
`.agents/skills/security-hardening/SKILL.md` for the operational checklist.
