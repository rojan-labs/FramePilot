# Skill: Docs Maintainer

Keep `docs/` and `CHANGELOG.md` current and accurate. Docs are part of Done.

## When to use

- Any change that adds/alters a feature, API, architecture, or user-facing behavior.

## What goes where

- **Guide** (`docs/guides/`) — how to use a feature / how-to workflows.
- **API doc** (`docs/api/`) — public interfaces: timeline ops, AI tools, schemas, CLI, IPC contract.
- **ADR** (`docs/adr/`) — an architectural decision (a choice with trade-offs/consequences).
- **Architecture** (`docs/architecture/`) — system/structure notes and diagrams.
- **Runbook** (`docs/runbooks/`) — operational/debug/security procedures.
- **CHANGELOG.md** — user-facing changes, Keep a Changelog format, under `[Unreleased]`.

## ADR workflow

1. Number sequentially: `docs/adr/NNNN-short-title.md` (next number after the highest existing).
2. Use the template below. Record context, the decision, and consequences.
3. Link it from the feature's guide/architecture doc where relevant.

### ADR template

```md
# NNNN. <Title>

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

<What problem/forces led to this decision?>

## Decision

<What we decided to do.>

## Consequences

<Trade-offs, follow-ups, what becomes easier/harder.>
```

## Rules

- Document **WHY**, not just WHAT. Keep docs **in sync with code** in the same change.
- Create folders/files proactively; keep README ↔ docs cross-links valid.
- Update `CHANGELOG.md` for every user-facing change.

## Definition of done

- Relevant guide/API doc updated or created; ADR added if a decision was made.
- `CHANGELOG.md` updated for user-facing changes; cross-links valid.
- `plan/PLAN.md` updated.
