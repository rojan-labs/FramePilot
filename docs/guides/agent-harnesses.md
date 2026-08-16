# Agent Harness Layout

FramePilot supports multiple coding-agent harnesses, but the project keeps one
canonical asset tree: [../../.agents/](../../.agents/). This avoids drift between
Claude Code, Cursor, Codex, OpenCode, and future adapters.

## Canonical Source

Use these locations for the actual maintained content:

| Asset            | Canonical path                             |
| ---------------- | ------------------------------------------ |
| Shared skills    | `../../.agents/skills/<name>/SKILL.md`     |
| Shared rules     | `../../.agents/rules/*.mdc`                |
| Slash commands   | `../../.agents/commands/*.md`              |
| Claude subagents | `../../.agents/agents/claude/*.md`         |
| Codex subagents  | `../../.agents/agents/codex/*.toml`        |
| OpenCode config  | `../../.agents/agents/opencode/agent.json` |

Root [../../AGENTS.md](../../AGENTS.md) remains the shared human-readable
contract for all agents. Root [../../CLAUDE.md](../../CLAUDE.md) keeps the
Claude Code-specific working rules.

## Adapter Paths

Harness folders keep the expected discovery paths, but they reference canonical
`.agents` assets:

| Harness path                 | References                                 |
| ---------------------------- | ------------------------------------------ |
| `../../.cursor/rules`        | `../../.agents/rules`                      |
| `../../.claude/commands`     | `../../.agents/commands`                   |
| `../../.claude/agents`       | `../../.agents/agents/claude`              |
| `../../.codex/agents`        | `../../.agents/agents/codex`               |
| `../../.opencode/agent.json` | `../../.agents/agents/opencode/agent.json` |

Harness-local settings still stay in their native folders, for example
`../../.claude/settings.json`, `../../.codex/config.toml`, and
`../../.opencode/AGENTS.md`.

## Maintenance Rules

- Add or edit canonical content under `.agents/` first.
- Keep harness adapters thin; do not fork full instructions into a harness folder.
- Update references in `AGENTS.md`, `CLAUDE.md`, `docs/`, `CHANGELOG.md`, and
  `plan/PLAN.md` when the agent layout changes.
- Validate adapter targets after any move with `find`/`test -e` checks so broken
  symlinks do not silently disable a harness.
