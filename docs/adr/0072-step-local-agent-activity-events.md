# ADR 0072 — Step-local agent activity events

- Status: Accepted
- Date: 2026-07-23
- Amends: ADR 0033 (streaming sidebar architecture), ADR 0042 (Conductor event parity)

## Context

An agent run contains several model/tool steps but shares one event `turnId`. The
stream previously used that turn id for both its reasoning node and its plan node.
As a result, all reasoning updated one accordion, while an unplanned run appended a
new row to one checklist for every step. Long runs therefore hid earlier thinking and
left a permanently growing to-do list at the top of the activity stream.

## Decision

- Reasoning events may carry a stable step key. An unkeyed chat or edit turn keeps
  `${turnId}:reasoning`; agent steps use `${turnId}:reasoning:${stepKey}`. Each step
  opens and settles its own reasoning event before its tool activity, including when
  the provider returns no visible reasoning tokens.
- The event reducer continues to order nodes by first appearance, so no separate UI
  grouping model or persisted schema is needed. The sidebar presents the resulting
  reasoning and tool rows on a shared, neutral activity rail.
- A `plan` event is emitted only for a real, up-front drafted plan. The reducer keeps
  its bounded ledger for execution status, but unplanned runs do not project that
  internal state as a checklist.

## Consequences

- A multi-step run reads chronologically: thinking, narration, tools, and proposed
  edits remain at the step where they happened. Existing persisted conversations with
  a single legacy reasoning id still render normally.
- Plan-first users retain a fixed checklist; ordinary agent runs avoid unbounded UI
  growth. No timeline/project schema, patch path, or IPC contract changes.
- Event-stream snapshots and sidebar tests must treat reasoning ids and plan presence
  as intentional behavioral contract changes.
