/**
 * @framepilot/ai-sdk/kernel/loop-detector — semantic loops, meaningful progress, and the
 * recovery that answers both (plan/AGENT-TASK-MEMORY.md §3.5, ADR 0075).
 *
 * ## Why the existing guards were not enough
 *
 * The stall guard catches a run making no progress, where progress includes "learned
 * something new". The diminishing-returns guard catches a run that has gone quiet. The
 * reported failure was neither: every turn was novel, expensive and verbose, and every
 * turn said the same thing in different words —
 *
 *   "Let me orient myself." / "Let me get the full picture." /
 *   "Let me first understand the project." / "Let me map the footage before editing."
 *
 * Those are one intent wearing four sentences. Detecting them needs to compare what turns
 * were FOR, not what they called or how much they wrote.
 *
 * ## Why the vocabulary is closed
 *
 * Intents are matched against a fixed set of purposes rather than free text. A
 * model-generated label drifts — "orienting", "getting my bearings", "building context"
 * are three strings and one intent — and a detector that compares drifting labels detects
 * nothing. A closed set is coarse, deterministic, testable, and costs no model call.
 *
 * ## Recovery is an action, never a plan
 *
 * When a loop trips, the answer is emphatically not another round of thinking. It is:
 * read the working state, find the first thing that is still owed, and say to do that.
 * {@link recoveryAction} returns exactly one imperative or `null` — it cannot return a
 * plan, because it cannot produce prose at all.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  type NextAction,
  type RunWorkingState,
  isExecutionStage,
  isRequestEcho,
  remainingObjectives,
} from './working-state.js';

const log = createLogger('ai-sdk:kernel:loop-detector');

/**
 * Consecutive turns sharing one intent, with no stage advance and no decision committed,
 * that mean the run is circling. Three rather than two: two turns of orientation is a
 * normal opening (get the shape, then get the detail), and cutting a legitimately
 * thorough run short is worse than one extra turn of it.
 *
 * "Consecutive" means consecutive STUCK turns. The conductor empties the window on any
 * turn that LEARNED SOMETHING NEW, so this counts turns that both repeated a purpose and
 * discovered nothing — never turns that merely described real work in consistent words.
 * See the window's construction in `conductor.ts#onTurnResult` for the run that proved
 * the difference matters, and for why the test there is novelty specifically rather than
 * progress in the broader sense.
 */
export const SEMANTIC_LOOP_TURNS = 3;

/**
 * Consecutive turns producing no meaningful progress before recovery takes over. Tighter
 * than the loop detector because it is a stronger signal: a semantic loop is a run
 * repeating itself, while this is a run achieving nothing at all.
 */
export const MAX_NO_PROGRESS_TURNS = 2;

/** The closed vocabulary of turn purposes. */
export const TURN_INTENTS = [
  'orient',
  'analyze',
  'plan',
  'execute',
  'verify',
  'report',
  'unknown',
] as const;

export type TurnIntent = (typeof TURN_INTENTS)[number];

/**
 * Phrases that mark each intent, most specific first. Matching is substring-based on
 * lowercased prose — crude on purpose. The job is to notice that four differently-worded
 * turns are the same turn, and for that, coarse and deterministic beats clever.
 */
const INTENT_MARKERS: readonly (readonly [TurnIntent, readonly string[]])[] = [
  [
    'orient',
    [
      'orient',
      'get the full picture',
      'understand the project',
      'get a sense',
      'get my bearings',
      'take stock',
      'see what we have',
      'start by understanding',
      'first understand',
      'build context',
      'familiarize',
    ],
  ],
  [
    'analyze',
    [
      'read the transcript',
      'get the transcript',
      'map the footage',
      'analyze',
      'analyse',
      'look for',
      'find the',
      'identify',
      'examine',
      'inspect',
      'review the footage',
    ],
  ],
  [
    'plan',
    ['plan', 'decide', 'work out', 'figure out', 'outline', 'ready to begin', 'ready to start'],
  ],
  [
    'execute',
    ['cut', 'trim', 'delete', 'apply', 'add ', 'place', 'insert', 'edit', 'remove', 'caption'],
  ],
  ['verify', ['verify', 'check the result', 'confirm', 'double-check', 'make sure the']],
  ['report', ['done', 'finished', 'summary', 'to summarize', 'in summary']],
];

/**
 * Classify a turn's prose into one of the fixed purposes. Unrecognised prose is
 * `'unknown'`, which never contributes to a loop — an intent the detector cannot read is
 * not evidence of repetition.
 */
export function normalizeIntent(text: string): TurnIntent {
  const prose = text.toLowerCase();
  if (!prose.trim()) return 'unknown';
  for (const [intent, markers] of INTENT_MARKERS) {
    if (markers.some((marker) => prose.includes(marker))) return intent;
  }
  return 'unknown';
}

/**
 * Is the run circling? True when the last {@link SEMANTIC_LOOP_TURNS} turns share one
 * readable intent AND the run neither advanced a stage nor committed a decision across
 * them.
 *
 * The two conjuncts matter. Repeating an intent while advancing is just a long stage
 * (three turns of cutting are three turns of cutting); repeating it while standing still
 * is the failure. A third guard sits outside this function: the caller only ever puts a
 * turn that discovered nothing into `recentIntents`, so a full window is already three
 * turns of standing still before either conjunct is consulted.
 */
export function isSemanticLoop(
  recentIntents: readonly TurnIntent[],
  args: { readonly stageAdvanced: boolean; readonly decisionCommitted: boolean },
): boolean {
  if (args.stageAdvanced || args.decisionCommitted) return false;
  if (recentIntents.length < SEMANTIC_LOOP_TURNS) return false;
  const window = recentIntents.slice(-SEMANTIC_LOOP_TURNS);
  const [first] = window;
  if (!first || first === 'unknown') return false;
  return window.every((intent) => intent === first);
}

/**
 * Why there is no novelty cap here.
 *
 * An earlier pass at this capped consecutive novelty-only turns, on the reasoning that
 * round 3's first-time-recall credit let gathering satisfy this test forever. The reasoning
 * was right and the lever was wrong: `RESEARCH_BUDGET_TURNS` in `conductor.ts` already
 * bounds exactly that — "this turn gathered without attempting an edit, so it spends
 * research budget" — and it is tuned, tested, and reached through `actionRecoveryPending`.
 * A second cap at a lower number silently pre-empted it, and with it the diminishing-returns
 * guard, so runs stopped for a reason that was no longer the true one.
 *
 * The real gap was in that budget's REFUND, not in its absence: it refunded on
 * `turnOpCount > 0`, and stocking the media bin produces ops. See
 * `conductor.ts#researchStreak`.
 */

/** What a turn is credited with, for the progress test. */
export interface TurnProgress {
  readonly learnedSomethingNew: boolean;
  readonly attemptedEdit: boolean;
  readonly appliedEdit: boolean;
  readonly recordedVerification: boolean;
  readonly advancedStage: boolean;
  readonly committedDecision: boolean;
  readonly satisfiedObjective: boolean;
}

/**
 * Did this turn move the task forward?
 *
 * Everything counted here changes the run's state. Everything NOT counted — reasoning
 * text, stream events, status updates, restated summaries, memo hits — is a run
 * describing itself rather than progressing, which is exactly what filled 3,430 events
 * while the timeline stayed untouched.
 */
export function madeMeaningfulProgress(p: TurnProgress): boolean {
  return (
    p.learnedSomethingNew ||
    p.attemptedEdit ||
    p.appliedEdit ||
    p.recordedVerification ||
    p.advancedStage ||
    p.committedDecision ||
    p.satisfiedObjective
  );
}

/**
 * The smallest valid next execution step, derived from the working state alone.
 *
 * Deliberately deterministic and prose-free. The recovery path must not be another
 * opportunity to think — it exists precisely because thinking is what the run cannot stop
 * doing — so this reads what is owed and names one thing to do about it. Returns `null`
 * only when the state genuinely offers nothing actionable, which the caller must then
 * report as a blocker rather than paper over.
 */
export function recoveryAction(state: RunWorkingState): NextAction | null {
  const pending = remainingObjectives(state);
  const first = pending[0];
  if (first) {
    log.debug('recovery → outstanding objective', { objectiveId: first.id });
    // An objective that is only the request said back is not a step, and restating it is
    // the least useful thing this heading can do — recovery fires precisely because the
    // run is not progressing, and "do this now: [everything you were asked for]" tells it
    // nothing it is not already holding. Name the act instead; the request is the last
    // thing in the model's context either way.
    const action = isRequestEcho(first.description, state.objective.request)
      ? 'Make the next edit the request calls for, using what this run has already ' +
        'gathered. Do not read anything else first.'
      : `Do this now: ${first.description}. Everything you need is in the run state above.`;
    return { stage: first.stage, action, objectiveId: first.id };
  }

  // A failed operation is the next most concrete thing owed: the run tried, lost the
  // work, and the reason is recorded.
  const failed = state.operations.find((op) => op.status === 'failed');
  if (failed) {
    log.debug('recovery → unresolved failure', { operationId: failed.id });
    return {
      stage: isExecutionStage(state.stage) ? state.stage : 'apply',
      action: `Fix the cause of this failed edit and make it land: ${failed.intent}${
        failed.failureReason ? ` (it failed because: ${failed.failureReason})` : ''
      }.`,
    };
  }

  // Nothing has been applied and nothing is enumerated, but the run has been researching
  // — so the outstanding work IS the edit the creator asked for.
  if (state.operations.every((op) => op.status !== 'succeeded')) {
    log.debug('recovery → nothing applied yet');
    return {
      stage: 'apply',
      action:
        'Make the edit the creator asked for now, using the evidence already listed ' +
        'above. Commit to the best version your current findings support — a good edit ' +
        'you can refine beats a better one you never make.',
    };
  }

  log.debug('recovery → nothing actionable remains');
  return null;
}

/**
 * Has this run banked sourcing candidates it has not spent?
 *
 * The commit-only scope (02) turns on this and nothing else. Deliberately narrow: the run's
 * pathology in captured run `e36235cc` was not that it re-read what it held — it was that it
 * kept fetching MORE while holding 600 unspent candidates and one clip on the timeline.
 * Nineteen searches, twelve downloads, zero picture placed.
 *
 * @param bankedSearches - Evidence handles whose source is a catalogue search.
 * @param placementsApplied - Picture clips this run has actually put on the timeline.
 *   Counting *assets added to the bin* here would release the latch on the very act the
 *   latch exists to distinguish from an edit.
 */
export function shouldWithholdCatalogueSearch(args: {
  readonly bankedSearches: number;
  readonly placementsApplied: number;
}): boolean {
  // Never before a search has landed: on an empty project there is no `remoteId` to add BY,
  // and the only thing that mints one is the search this would refuse (ADR 0147).
  if (args.bankedSearches === 0) return false;
  // Released by the first real placement, and it is a one-way latch per run — a later
  // failed placement must not re-engage it and strand a run mid-edit.
  return args.placementsApplied === 0;
}

/**
 * The refusal an editor and a model can both act on.
 *
 * Names the legal moves, because a refusal that only says "no" is how ADR 0143's recovery
 * turn left a run with no move at all. `ask_user` is deliberately NOT offered: no `askUser`
 * host is wired, so naming it would advertise an escape that does not exist.
 */
export function catalogueSearchRefusal(bankedSearches: number): string {
  return (
    `This run already has ${String(bankedSearches)} search result(s) it has not used, and ` +
    'nothing on the timeline yet. Searching again is not available until something is ' +
    'placed. Use `recall_evidence` to re-open a result you already have, then place a clip ' +
    'from it. Reading the timeline and the media bin is still available.'
  );
}
