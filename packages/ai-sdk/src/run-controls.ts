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
import type { LedgerSnapshot } from './ledger.js';
import type { TimerApi } from './reliability/timeout.js';

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
  { readonly kind: 'answered'; readonly answer: string } | { readonly kind: 'cancelled' };

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
 * This run's perceptual reviews, as the agent loop sees them when the model says it is done.
 *
 * Wired by `Orchestrator.streamEditorRun` when review is on; the loop itself holds no review
 * state. It exists because the loop only ever collected reviews that had ALREADY finished at
 * an edit boundary, and waited only once the agent had stopped — so the review of the LAST
 * edit could never steer anything (run d8d2e445: "The review of the last edit came back
 * after the run had finished, so nothing was done about it").
 */
export interface LateReviewControl {
  /** True while any review of this run is queued or rendering. */
  hasPending(): boolean;
  /**
   * Wait until every pending review settles or `signal` aborts, publish what they found,
   * and queue the steerable findings on the run's steering channel (the same path a
   * mid-run finding takes). Reviews still running when `signal` aborts keep running and
   * are reported at the end of the run as before (ADR 0187).
   *
   * @param signal - Bounds the wait.
   * @returns True when at least one finding was queued for the model to act on.
   */
  settle(signal: AbortSignal): Promise<boolean>;
}

/**
 * Live execution-side hooks for one streaming agent run (see module doc for why
 * these are not part of {@link Command}). All are optional and independent: a
 * caller can wire steering without approval-gating, or vice versa.
 */
export interface AgentRunControls {
  readonly steering?: SteeringQueue;
  /**
   * Pending perceptual reviews, awaited (bounded) once when the model declares itself done
   * so the last edit's findings can still buy one steering turn. Absent ⇒ no wait.
   */
  readonly lateReviews?: LateReviewControl;
  /**
   * Timer API backing the run's wall-clock deadline (`reliability/deadline.ts`).
   *
   * Live, host-supplied, and non-serialisable like everything else here. Only tests pass
   * one: a run that hangs inside a model call cannot be made to stop on time by a clock
   * alone — `options.now` is read, never awaited — so the deadline needs a timer, and a
   * deterministic test needs to be the thing that fires it. Absent ⇒ real timers.
   */
  readonly timers?: TimerApi;
  readonly planApproval?: PlanApproval;
  /** Answers the model's own questions (P12); absent ⇒ `ask_user` degrades honestly. */
  readonly askUser?: AskUser;
  /**
   * Records something worth outliving this run in the project's durable memory.
   *
   * The one thing that MUST outlive a run is an answer the editor gave it: the model asked
   * about the framing, the editor chose "full-bleed vertical crop", and the very next run
   * re-cut the whole montage with no crop at all — because the answer lived only in the
   * action log of the run that asked. A durable note reaches every later run through the
   * session-context digest.
   *
   * Fire-and-forget by contract: recording is a side-benefit of what the editor just did, so
   * an unreachable brain must degrade to no note rather than fail the run. Absent ⇒ nothing
   * is recorded (the plain browser build has no brain, the same honest gap as proxies).
   */
  readonly rememberDecision?: (note: { readonly title: string; readonly body: string }) => void;
  /**
   * Re-reads the shot ledger for footage placed mid-run that the run's snapshot has no rows for.
   *
   * A run's understanding of the footage is fixed for the whole `runAiStream` call, and in
   * agent mode that call spans the entire multi-turn run — half an hour and sixty turns in
   * run `19e20922`. That is deliberate: the ledger renders into the prompt prefix, and
   * re-reading it every turn would spend the cache on facts that did not move. It is wrong
   * for two kinds of asset. One the run downloaded itself: enrolment measures it about ninety
   * seconds later, and the run reasons about it with `picture: undefined` for the rest of
   * its life — no shot words in its row, nothing in the digest, and `match_color` /
   * `add_transitions` declining on it for want of measurements. And any bin asset placed by
   * a run that started on an EMPTY timeline: the host scopes its initial read to what the
   * timeline references, so that run started with no snapshot at all (run `d8d2e445`).
   *
   * So the trade is made narrowly: called only when an asset the TIMELINE references has no
   * rows and was either acquired by this run or never yet asked about, at a turn boundary,
   * in one request, and at most a few times (see `MAX_LEDGER_REFRESHES`). One cache miss,
   * in exchange for the facts about the footage the run is actually cutting.
   *
   * Fire-and-forget in spirit like `rememberDecision`: a host that cannot read returns
   * `null`/`undefined` and the run carries on with what it has. Absent ⇒ the ledger stays
   * fixed for the run, exactly as before (the browser build has no brain).
   *
   * @param assetIds - The placed, unmeasured assets to re-read; the host re-reads the whole run's
   *   asset set and refreshes these entries (`LedgerClient.snapshot`'s `refresh`).
   * @param signal - The run's abort signal.
   * @returns A fresh snapshot, or `null` when nothing could be read.
   */
  readonly refreshLedger?: (
    assetIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<LedgerSnapshot | null>;
}
