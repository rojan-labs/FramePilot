/**
 * @framepilot/ai-sdk/kernel/proposers — the four schema-validated proposers
 * (plan/AI-ORCHESTRATION-REDESIGN.md §6, Phase K3.3).
 *
 * The demoted-LLM roster: IntentParser · Planner · EditProposer · Critic. Each is a pure,
 * stateless "role" — a prompt + an output schema + a model tier — that builds an inert
 * model-call description and validates the reply against a Zod schema. The kernel
 * disposes; the proposer never performs I/O or calls another proposer (§6, §10).
 */
export * from './types.js';
export * from './intent-parser.js';
export * from './planner.js';
export * from './edit-proposer.js';
export * from './critic.js';
