# OpenCode — FramePilot

> Shared rules live in the root **`/AGENTS.md`** (canonical). OpenCode configuration
> is maintained in **`.agents/agents/opencode/agent.json`** and exposed through
> the **`.opencode/agent.json`** adapter. This file is just a pointer.

## Read first

- Root `/AGENTS.md` — mission, architecture, commands, coverage, safety, Definition of Done.
- `.agents/rules/*.mdc` — project conventions (security & correctness are PRIORITY rules).
- `plan/PLAN.md` — live build plan (read before work, update after).
- `PRD.md` — full product spec.

## Skills (`.agents/skills/<name>/SKILL.md`)

`timeline-editing` · `render-debugging` · `e2e-testing` · `ai-safety` ·
`media-pipeline` · `security-hardening` · `correctness-verification` ·
`plan-keeper` · `docs-maintainer`

## Invariants (never violate)

Non-destructive · every AI edit is a typed timeline op · validate before apply ·
check every render · AI edits only via schema-validated tools and returns reversible
patches (never raw `project.fp.json` mutation). Build the engine before the AI layer.
