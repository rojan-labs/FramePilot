---
description: Run the docs-maintainer workflow — update docs/, author ADRs, and update CHANGELOG.md
---

Run the **docs-maintainer** workflow (`.agents/skills/docs-maintainer/SKILL.md`,
`.agents/rules/documentation.mdc`). Delegate to the `docs-maintainer` subagent for larger doc work.

1. Identify what changed and route docs correctly:
   - Guide (`docs/guides/`) for how-tos; API doc (`docs/api/`) for public interfaces
     (timeline ops, AI tools, schemas, CLI, IPC); ADR (`docs/adr/NNNN-title.md`) for
     decisions; architecture (`docs/architecture/`); runbooks (`docs/runbooks/`).
2. For a decision, author an **ADR** with the next sequential number using the template
   (Status, Date, Context, Decision, Consequences); link it from the relevant doc.
3. Update `CHANGELOG.md` (Keep a Changelog, under `[Unreleased]`) for user-facing changes.
4. Document **WHY**, keep docs in sync with code, and keep README ↔ docs cross-links valid.
5. Update `plan/PLAN.md` if this surfaces new tasks.
