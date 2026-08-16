# ADR 0057 — Bundled runtime skills (manifest + on-demand `load_skill`)

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR 0055 (never advertise a capability that does not exist),
  R2 B2 context budgeting (`CONTEXT_TIERS`), PRD §8 (AI tool layer).

## Context

The orchestrator had no way to be taught domain playbooks — e.g. "how keyframe
animation should be done" (easing choices, subtle scale ranges, timing to
speech). Baking every playbook into the system contract would blow the context
budget and pollute unrelated runs; leaving them out meant the agent re-derived
(or fumbled) editing craft on every run.

Claude Code solves this with **skills**: markdown playbooks whose compact
manifest (name + description) always rides in context, while the full body
loads on demand via a tool only when the model decides a skill is relevant.

Constraints specific to this SDK:

- `packages/ai-sdk` builds with plain `tsc -b` (no bundler) and must stay
  **filesystem-agnostic at runtime** — it runs in the browser, Electron
  renderer, and the MCP server alike. Skill markdown cannot be read from disk
  when the orchestrator runs.
- The Python engine mirrors the TS tool registry 1:1 (`ai_tools/registry.py`);
  a TS-only `load_skill` would break parity.

## Decision

1. **Skills are developer-authored, bundled with the SDK** — strict-markdown
   files in `packages/ai-sdk/skills/<name>.md`, no user-facing skills folders.
   They propagate to every consumer (desktop, web, MCP) automatically.
2. **Format:** strict YAML-ish frontmatter — `name` (kebab-case, unique),
   `description` (one line, model-facing, ≤ 300 chars), optional
   `tools: [a, b]` — then the markdown body. Caps: body ≤ 32 KB, ≤ 32 skills.
3. **Build-time codegen, committed output.** `scripts/generate-skills.mjs`
   (wired into `pnpm build` as a prestep) embeds each file's raw text into
   `src/skills/generated.ts` and a pre-parsed Python mirror
   `engine/python/framepilot_engine/ai_tools/skills_generated.py`, so both
   registries serve identical content with zero runtime fs. Both outputs are
   committed; a unit test re-reads `skills/*.md` and fails on drift.
4. **Defensive parsing, tested-strict bundle.** `parseSkillFile` never throws;
   a malformed file is skipped with a warning (memory-store precedent) so a bad
   skill can never break a run — while a unit test asserts every bundled skill
   parses cleanly, so a bad skill can never actually ship. `tools:` entries
   naming unregistered tools are dropped with a warning (ADR 0055 discipline).
5. **Manifest as a context tier.** `assembleContext` gains a `skills` tier —
   one line per skill plus the instruction to call `load_skill` before matching
   work. It sits below `memory` in `CONTEXT_TIERS`/`DROP_ORDER` (dropped after
   `timeline`, before `memory`): the manifest is an affordance the model can
   re-fetch via the tool, not ground truth about this project.
6. **`load_skill` read tool.** Synchronous, pure, no host round-trip — it looks
   up `ToolContext.skills` (an in-memory `ReadonlyMap`; the sandbox contract of
   no fs/network is unchanged) and returns the full skill, or an error naming
   the valid skills so the model self-corrects. Mirrored in the Python registry
   from the generated bundle.
7. **Zero-wiring default.** The orchestrator's agent paths default
   `ContextInput.skills` to `BUNDLED_SKILLS` and always hand `toolContext` the
   skills map; the MCP session wires the same bundle. Chat/edit modes stay
   manifest-free unless the caller opts in. `ContextInput.skills` remains an
   override for tests/host configuration.
8. **`tools:` frontmatter is validation-only in v1** — it documents which tools
   the skill uses (and is shown in the manifest). Dynamic tool re-scoping after
   a skill loads (`tool-scope.ts#selectTools`) is **deferred**.
9. **A loaded body is delivered whole, and pinned for the run** (amended
   2026-07-15 — see "Amendment" below). `load_skill`'s result bypasses the agent
   loop's generic read-preview and reaches the model verbatim; the run keeps a
   ledger (`HostCallContext.loadedSkills`) that pins each loaded body into every
   later turn's context (`agentSkillsBlock`), outside the rolling action log.
   A repeat `load_skill` is answered from the pinned copy. Pinning is bounded by
   `MAX_PINNED_SKILLS` (8) with an honest refusal — never a silent body cut.

## Amendment (2026-07-15) — delivery was silently truncated

Decision 6 ("returns the full skill") was true of the _tool_, but not of what
the **model** received. In the agent loop a read tool's result reaches the model
as a log _note_, built by `summarizeReadResult`. `load_skill` had no case there,
so it fell to the default `previewJson(value, ANALYSIS_PREVIEW_MAX)` — a
JSON-escaped 1200-char slice of a ~3 KB playbook (about a third, cut
mid-sentence).

The observed failure: the model asked for a playbook, got a fragment, could not
follow it, and re-called `load_skill` every turn trying again — until the
Conductor's `MAX_CONSECUTIVE_NO_PROGRESS` guard ended the run having applied
**zero edits** ("No changes were made"). The guard was not the bug; it was the
only thing reporting it honestly.

Two lessons, both encoded as tests:

- **The full-body contract must be asserted on the model's messages**, not on
  the tool's return value. The original test asserted the body reached the UI
  popup (`tool_result.result`) — which stayed true the entire time the model was
  being starved. A contract about what the model reads can only be tested by
  reading what the model reads.
- **A once-per-run cost must outlive the log window.** The action log keeps only
  the last `AGENT_LOG_RECENT` (6) steps, so a body left there ages out mid-run
  and the model must re-load craft it already paid a turn for. Pinning is what
  makes progressive disclosure _stick_.

## Consequences

- Editing craft lives in reviewable markdown, versioned with the SDK; adding a
  playbook is "drop an `.md` file, rebuild" — no schema or host changes.
- Context cost is one manifest line per skill until the model opts into a body,
  and the whole tier degrades gracefully under budget pressure.
- The generated modules must be regenerated after editing `skills/*.md`
  (`pnpm --filter @framepilot/ai-sdk generate:skills`); the drift test and the
  build prestep make forgetting this a loud failure, not a silent staleness.
- The Python mirror is pre-parsed (no frontmatter parser in Python), so parity
  is guaranteed by construction from the same source files.
