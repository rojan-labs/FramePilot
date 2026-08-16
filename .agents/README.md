# FramePilot Agent Assets

`.agents/` is the canonical home for machine-consumable agent assets in this
repo. Harness-specific folders should reference these files instead of carrying
separate copies.

## Layout

- `skills/` - reusable `SKILL.md` workflows for planning, docs, security,
  correctness, timeline editing, media, testing, and source commands.
- `rules/` - project rules shared by Cursor and other harnesses. The always-on
  `product-discipline.mdc` rule protects finished-edit quality and scope discipline.
- `commands/` - Claude slash command definitions for FramePilot workflows,
  including `/review-product-scope` for pre-implementation scope review.
- `agents/claude/` - Claude Code subagent definitions, including the read-only
  `product-scope-reviewer`.
- `agents/codex/` - Codex subagent definitions, including the read-only
  `product-scope-reviewer`.
- `agents/opencode/agent.json` - OpenCode agent configuration.

## Harness Adapters

- `.cursor/rules` references `.agents/rules`.
- `.claude/commands` references `.agents/commands`.
- `.claude/agents` references `.agents/agents/claude`.
- `.codex/agents` references `.agents/agents/codex`.
- `.opencode/agent.json` references `.agents/agents/opencode/agent.json`.

Because `.claude/commands`, `.claude/agents`, and `.codex/agents` are adapters,
adding a canonical command or subagent under `.agents/` updates the harness-visible
surface without duplicating files inside each adapter directory.

Keep `AGENTS.md` and `CLAUDE.md` at the project root as human-readable entry
points. When adding or changing a rule, command, skill, or agent, edit the
canonical file under `.agents/` first and update root entrypoints and relevant
plan/docs/changelog material in the same change.

## Product discipline

Before major feature, architecture, or plan expansion:

1. Read `.agents/rules/product-discipline.mdc`.
2. Tie the work to a concrete current user outcome or measured gap.
3. Identify the minimum usable vertical slice and the existing primitives to reuse.
4. Explicitly defer tempting adjacent scope.
5. Define the evidence required to call the work complete.
6. Use `product-scope-reviewer` or `/review-product-scope` for broad scope changes.

A schema, backend, worker, tool, ADR, or plan is not a shipped editing capability
by itself. The relevant user path must work end to end before the plan calls it done.
