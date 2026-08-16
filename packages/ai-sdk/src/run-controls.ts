/**
 * @framepilot/ai-sdk/run-controls — live, non-serialisable execution-side hooks for
 * an in-flight agent run (plan/AGENT-NATIVE-COMPLETION-PLAN.md P11.3 plan-approval
 * gate, P11.4 mid-run steering).
 *
 * These are deliberately NOT part of {@link Command}/{@link AgentOptions}: the
 * kernel's command boundary is plain, marshallable data (`kernel/commands.ts` — "no
 * closures, no live objects beyond the optional AbortSignal") so it can cross
 * Electron IPC or HTTP with no host caring which wire it took. A Promise-resolving
 * approval gate or a live message queue cannot survive that boundary, so they are
 * threaded as a separate, execution-only parameter straight into
 * {@link Orchestrator.streamAgent}'s handler closures — never touching the pure
 * Conductor reducer, which only ever sees the serialisable
 * `AgentOptions.requirePlanApproval` boolean (the DECISION to gate stays pure; the
 * live RESOLUTION mechanism does not).
 *
 * Browser/dev uses these in-process adapters directly. Electron main now adapts
 * durable protocol commands and persisted wait gates into the same execution-side
 * interface (`durable-run-controls.ts`); the renderer never owns these objects.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:run-controls');

/** A guidance message the run folds in at the NEXT turn boundary (not mid-step). */
export type SteeringMessage = string;

/**
 * Non-blocking, single-consumer FIFO for mid-run steering messages (P11.4). The
 * host UI `push`es while a run is in flight; the running turn's handler `take`s at
 * its next per-turn boundary (the same boundary the existing `signal.aborted`
 * check already polls) — so this is a QUEUED, next-boundary interjection, never an
 * instant mid-step redirect.
 */
export interface SteeringQueue {
  /** Queue a message. Empty/whitespace-only messages are ignored. */
  push(message: SteeringMessage): void;
  /** Pop the oldest queued message, if any (consumed once — FIFO, depth 1 in practice). */
  take(): SteeringMessage | undefined;
}

/** Construct an empty {@link SteeringQueue}. */
export function createSteeringQueue(): SteeringQueue {
  const queue: SteeringMessage[] = [];
  return {
    push: (message) => {
      const trimmed = message.trim();
      if (trimmed) {
        queue.push(trimmed);
        log.action('SteeringQueue.push → queued', { message: trimmed });
      }
    },
    take: () => {
      const message = queue.shift();
      if (message) log.action('SteeringQueue.take → consumed', { message });
      return message;
    },
  };
}

/** The creator's decision on a gated up-front plan (P11.3). */
export type PlanApprovalDecision = 'approved' | 'cancelled';

/** Awaits the creator's approve/cancel decision for a plan the gate paused on. */
export interface PlanApproval {
  /** Resolves once the host UI calls the matching {@link PlanApprovalGate.resolve}. */
  requestApproval(planSteps: readonly string[]): Promise<PlanApprovalDecision>;
}

/** A {@link PlanApproval} plus the resolver the host UI calls once the creator decides. */
export interface PlanApprovalGate extends PlanApproval {
  /** Resolve the currently pending request, if any (no-op when none is pending). */
  resolve(decision: PlanApprovalDecision): void;
}

/** Construct a fresh, single-use {@link PlanApprovalGate} (one pending request at a time). */
export function createPlanApprovalGate(): PlanApprovalGate {
  let pending: ((decision: PlanApprovalDecision) => void) | undefined;
  return {
    requestApproval: (planSteps) => {
      log.action('PlanApprovalGate.requestApproval → awaiting decision', {
        steps: planSteps.length,
      });
      return new Promise<PlanApprovalDecision>((resolve) => {
        pending = resolve;
      });
    },
    resolve: (decision) => {
      log.action('PlanApprovalGate.resolve → decision received', {
        decision,
        hadPending: Boolean(pending),
      });
      pending?.(decision);
      pending = undefined;
    },
  };
}

/** One choice offered by an {@link AskUser} question (mirrors `events.ts#AskOption`). */
export interface AskUserOption {
  readonly label: string;
  readonly description?: string;
}

/** What the editor did with a question: picked/typed an answer, or stopped the run. */
export type AskUserAnswer =
  | { readonly kind: 'answered'; readonly answer: string }
  | { readonly kind: 'cancelled' };

/**
 * Awaits the editor's answer to a question the MODEL wrote (P12).
 *
 * Deliberately text-in/text-out: the question and options are whatever the model
 * authored, and the answer goes straight back to it. Nothing here enumerates the
 * situations that may come up — that is the point, since the useful ones are the ones
 * nobody predicted.
 */
export interface AskUser {
  /** Resolves once the host UI calls the matching {@link AskUserGate.resolve}. */
  requestAnswer(
    toolCallId: string,
    question: string,
    options?: readonly AskUserOption[],
  ): Promise<AskUserAnswer>;
}

/** An {@link AskUser} plus the resolver the host UI calls once the editor answers. */
export interface AskUserGate extends AskUser {
  /**
   * Resolve the question with this `toolCallId`, if it is the pending one. Keyed rather
   * than blind (unlike the plan gate's single anonymous slot) so a late answer to an
   * abandoned question can never satisfy the current one.
   */
  resolve(toolCallId: string, answer: AskUserAnswer): void;
}

/**
 * Construct a fresh {@link AskUserGate}. One pending question at a time, because the
 * turn that asked is blocked on the answer.
 */
export function createAskUserGate(): AskUserGate {
  let pending: { id: string; resolve: (answer: AskUserAnswer) => void } | undefined;
  return {
    requestAnswer: (toolCallId, question, options) => {
      log.action('AskUserGate.requestAnswer → awaiting the editor', {
        toolCallId,
        options: options?.length ?? 0,
        question,
      });
      return new Promise<AskUserAnswer>((resolve) => {
        pending = { id: toolCallId, resolve };
      });
    },
    resolve: (toolCallId, answer) => {
      if (!pending || pending.id !== toolCallId) {
        // A stale answer (the question it belongs to is gone) must not resolve whatever
        // happens to be pending now — that would feed the model an answer to a question
        // it never asked.
        log.warn('AskUserGate.resolve → no matching pending question', { toolCallId });
        return;
      }
      log.action('AskUserGate.resolve → answered', { toolCallId, kind: answer.kind });
      pending.resolve(answer);
      pending = undefined;
    },
  };
}

/**
 * Live execution-side hooks for one streaming agent run (see module doc for why
 * these are not part of {@link Command}). All are optional and independent: a
 * caller can wire steering without approval-gating, or vice versa.
 */
export interface AgentRunControls {
  readonly steering?: SteeringQueue;
  readonly planApproval?: PlanApproval;
  /** Answers the model's own questions (P12); absent ⇒ `ask_user` degrades honestly. */
  readonly askUser?: AskUser;
}
