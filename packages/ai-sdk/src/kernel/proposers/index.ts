/**
 * @framepilot/ai-sdk/kernel/proposers — the four schema-validated proposers
 * (plan/AI-ORCHESTRATION-REDESIGN.md §6, Phase K3.3).
 *
 * The roster: Critic. It is a pure, stateless "role" — a prompt + an
 * output schema + a model tier — that builds an inert model-call description and validates
 * the reply against a Zod schema. The kernel disposes; the proposer never performs I/O or
 * calls another proposer (§6, §10).
 *
 * IntentParser, Planner and EditProposer were removed with the `planned_edit` route they
 * existed to serve (ADR 0126): they only ever fed the second mutating execution universe.
 * The agent runtime derives the same understanding from the request itself and proposes
 * edits through the schema-validated tool surface instead of a scoped proposer call.
 */
export * from './types.js';
export * from './critic.js';
