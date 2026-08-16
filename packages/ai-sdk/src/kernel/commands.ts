/**
 * @framepilot/ai-sdk/kernel/commands — the kernel's INPUT boundary
 * (plan/AI-ORCHESTRATION-REDESIGN.md §7, Phase K0.1).
 *
 * A {@link Command} is the ONLY way a host surface (web editor, Electron main,
 * MCP server) asks the orchestration engine to do work. It is plain, serialisable
 * data — no closures, no live objects beyond the optional {@link AbortSignal} the
 * transport owns — so the same command can be issued in-process, marshalled over
 * Electron IPC, or sent across HTTP without the kernel caring which wire it took
 * (design tenet 8: "one policy across surfaces").
 *
 * This module is deliberately tiny in K0: it introduces the boundary TYPE without
 * changing any behavior. Today there is exactly one command — submit a
 * conversation turn — and it maps 1:1 onto the orchestrator's existing streaming
 * modes. Later phases (K1+) add `cancel`/`resume`/`accept` as first-class commands
 * instead of transport-level signals.
 */
import type { ContextInput } from '../context-builder.js';
import type { AgentOptions } from '../agent.js';
import type { AiMode, StreamOptions } from '../orchestrator.js';

/**
 * Submit one user turn for a given orchestration {@link AiMode}. Carries the
 * bounded context the proposer(s) reason over, the turn/conversation identifiers
 * plus abort signal ({@link StreamOptions}), and — for `agent` mode — the run
 * bounds ({@link AgentOptions}). The kernel compiles this into an effect and
 * streams {@link AiEvent}s back through the {@link SessionGateway}.
 */
export interface SubmitTurnCommand {
  readonly kind: 'submit_turn';
  /** Which orchestration mode runs this turn (chat | plan | edit | agent | …). */
  readonly mode: AiMode;
  /** The bounded run context (project working copy, prompt, selection, history). */
  readonly input: ContextInput;
  /** Conversation/turn ids + optional {@link AbortSignal} for this run. */
  readonly stream: StreamOptions;
  /** Run bounds for `agent` mode (maxSteps, maxOps*, planFirst, resume, …). */
  readonly agentOptions?: AgentOptions;
}

/**
 * The kernel's command union. One member today ({@link SubmitTurnCommand}); the
 * union shape is what matters — it is the stable seam every host drives and every
 * future command (cancel/resume/accept) slots into without a transport change.
 */
export type Command = SubmitTurnCommand;
