# Skill: Security Hardening (PRIORITY)

Keep FramePilot safe: file safety, path sandboxing, agent sandbox, Electron hardening,
secrets, and dependency/license review. (PRD §18.)

## When to use

- Any change touching file paths, IPC, the agent's capabilities, the Electron shell, render job control, dependencies, or secrets.
- Security reviews before merging risky changes.

## Rules / steps

1. **Path traversal prevention** — never trust a path. Resolve against `FRAMEPILOT_PROJECTS_ROOT`, then verify the real (symlink-resolved) path stays inside the sandbox. Reject `..` and absolute escapes. Use the shared safe-path helper everywhere (UI, IPC, AI tools).
2. **Local file safety** — never delete/overwrite originals; renders go to `renders/`; confirm before overwriting any user file.
3. **Secrets handling** — secrets in `.env` only; never hardcode or log keys; never commit `.env`/media/renders.
4. **Electron hardening** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; renderer↔main only via a minimal typed preload bridge; validate all IPC payloads; restrict navigation/`window.open`.
5. **Agent sandbox** — no arbitrary shell/eval/process spawn from the agent runtime; AI acts only through registered, schema-validated tools.
6. **Render job control** — every render has a timeout (`FRAMEPILOT_RENDER_TIMEOUT_SECONDS`) and cancellation.
7. **Dependency/license review** — run `pnpm license:scan`; quick supply-chain sanity check; no new dep without review.

## Threat checklist (run before merge of risky changes)

- [ ] Every new path goes through safe-path resolution; traversal rejected.
- [ ] No new shell/eval/process-spawn reachable by the agent.
- [ ] IPC payloads validated; preload surface minimal and allow-listed.
- [ ] Electron flags intact (`contextIsolation`/`sandbox` on, `nodeIntegration` off).
- [ ] Render timeout + cancellation present.
- [ ] No secrets in code/logs/commits; `.gitignore` covers media/renders/.env.
- [ ] `license:scan` passes for any new dependency.

## Definition of done

- Threat checklist passes; tests cover the security-relevant behavior (e.g. traversal rejection).
- `docs/runbooks/` security notes and `plan/PLAN.md` updated.
