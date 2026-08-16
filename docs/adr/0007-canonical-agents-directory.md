# 0007. Canonical Agents Directory

- Status: Accepted
- Date: 2026-06-18

## Context

FramePilot is designed for multiple AI coding harnesses. Before this decision,
agent assets were split across `agents/skills`, `.cursor/rules`, `.claude`,
`.codex`, `.opencode`, and `.agents/skills`. That made it easy for rules,
skills, commands, and subagent roles to drift apart even though they describe one
project contract.

## Decision

Use `.agents/` as the canonical repository for shared and harness-specific agent
assets:

- `.agents/skills` for reusable skills.
- `.agents/rules` for shared rules.
- `.agents/commands` for task commands.
- `.agents/agents/<harness>` for subagent/config definitions that a specific
  harness needs.

Harness-native locations remain as adapters that reference the canonical files,
so existing tools can still discover their expected paths while maintainers edit
one source of truth.

## Consequences

The agent system has a clear ownership model and less instruction drift. New
harnesses can be added by creating a small adapter to `.agents` instead of
copying the full rule set. Contributors must keep symlink/reference targets
valid when reorganizing files, and any harness that cannot follow references may
need a generated adapter as a compatibility shim.
