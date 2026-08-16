# ADR 0077 — Layered prompt and editing-knowledge architecture

- **Status:** Accepted
- **Date:** 2026-07-26

## Context

FramePilot had accumulated strong but overlapping model instructions. The stable
agent contract mixed authority, run control, visual-retrieval procedure, editing
taste, tool recovery, and completion checks. Skills varied from short recipes to a
2,300-word beat-sync manual. Because loaded skills stay pinned for a run, this
duplication consumed context and encouraged a long-running agent to re-orient even
after its task-memory briefing already named the current stage and next action.

## Decision

Use a layered model contract:

1. The immutable system prefix owns identity and the five editing invariants only.
2. Mode instructions own their output and mutation boundary.
3. The run-stable agent contract owns continuity, evidence discipline, tool recovery,
   source/sequence timing, dependency order, and completion claims. It obeys the
   stage-aware run briefing and inspects only missing evidence.
4. The agent's trailing message is ordered as a run-stable head (contract, committed
   plan, pinned skill bodies), then the volatile working-state briefing,
   steering/recovery, and bounded action continuity. The stable head is rebuilt only
   when the plan identity or loaded-skill ledger changes.
5. Deterministic verification alone owns correctness; model criticism is advisory.
6. Bundled skills own editing craft. Every skill has one decision boundary and a
   consistent professional knowledge-module structure. Tool frontmatter names only
   registered capabilities, and related craft is routed rather than duplicated.
7. Model wire prompts also have one responsibility each: the command classifier routes,
   the intent parser normalizes the requested outcome, the planner builds evidence and
   verification dependencies, and the edit proposer realizes one plan step. Each
   abstains rather than inventing missing scope, evidence, tool names, ids, or timings.

## Consequences

The stable prefix is smaller and more cacheable, task memory can advance a run without
fighting an unconditional orientation instruction, and craft evolves independently of
orchestration policy. Loaded skills are more uniform and substantially smaller. Authors
must maintain the structure and regenerate both TS/Python mirrors; bundled-skill tests
enforce the required headings, the below-8,000-character authoring bound, registered tool
names, and generated-source synchronization.
The architecture deliberately keeps critical behavioral rails global even when a craft
skill discusses the same domain, because source/sequence mapping, no-restart recovery,
real transition boundaries, and applied-versus-verified claims are execution safety.

The separation has explicit limits. The first agent turn may omit a working-state
briefing because no durable conclusions exist yet. Chat and edit modes do not advertise
bundled skills unless their caller opts in. Context budgeting can drop the skills
manifest, while loaded bodies live outside that tier in the run-stable head; therefore
the runtime separately caps pinned bodies at eight and first-party modules below 8,000
characters. Skill `tools` frontmatter remains descriptive and validation-only in v1; it
does not re-scope tool permissions. Model criticism remains advisory and cannot replace
deterministic timeline or render verification.
