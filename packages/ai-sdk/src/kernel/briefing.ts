/**
 * @framepilot/ai-sdk/kernel/briefing — distillation, and the state briefing built from it
 * (plan/AGENT-TASK-MEMORY.md §3.3/§3.4, ADR 0075).
 *
 * ## Distillation
 *
 * A read produces a payload; the run needs a CONCLUSION. The old design kept the payload
 * in the prompt until compaction deleted it, which meant the one moment the data was
 * definitely available — right after the call settled — was the moment nothing was
 * extracted from it. {@link distil} runs there instead: it turns "here are 400 words" into
 * "the run has read 0:22–0:23 of the transcript, 8 words, filed at ev_3".
 *
 * That statement is a conclusion about WHAT IS KNOWN and where the evidence for it lives,
 * not a compressed copy of the payload — which is what keeps the briefing flat in project
 * duration. It is deterministic: no model call, no clock. Semantic distillation (the
 * strongest hook, the story beats) is a separate, later concern; inventing it here with a
 * heuristic would produce confident, wrong facts, which is worse than none.
 *
 * ## The briefing
 *
 * Replaces the rolling note window as the model's memory of its own run. Ordered so the
 * run-stable head stays byte-identical across turns (E3.2 prompt-prefix caching) and only
 * the tail varies.
 */
import {
  type Fact,
  type FactKind,
  type FactScope,
  type RunWorkingState,
  committedDecisions,
} from './working-state.js';
import { type ToolRole } from './stage-policy.js';

/** Characters of a distilled statement — one line, never a payload. */
const STATEMENT_CHARS = 180;

/** What a distilled conclusion carries back to the reducer. */
export interface Distillation {
  readonly statement: string;
  readonly kind: FactKind;
  readonly scope: FactScope;
  readonly evidenceId?: string;
}

/** Map a tool's role onto the kind of knowledge it produces. */
function kindFor(role: ToolRole, toolName: string): FactKind {
  if (role === 'inspection') return toolName.includes('asset') ? 'asset' : 'project';
  if (toolName === 'get_transcript') return 'transcript';
  if (toolName === 'analyze_silence' || toolName === 'get_audio_levels') return 'audio';
  if (role === 'analysis') return 'footage';
  return 'derived';
}

/**
 * Distil one settled read into a conclusion, or `undefined` when there is nothing to
 * conclude.
 *
 * Nothing is concluded from a failure (there is no finding), from a recall (the run
 * already knows it), or from a memo hit (already recorded the first time) — recording
 * those would inflate the briefing with restatements, which is the failure mode this
 * whole design exists to end.
 */
export function distil(args: {
  readonly toolName: string;
  readonly role: ToolRole;
  readonly descriptor: string;
  readonly summary: string;
  readonly scope: FactScope;
  readonly status: string;
  readonly fromCache: boolean;
  readonly evidenceId?: string;
}): Distillation | undefined {
  if (args.status !== 'completed' && args.status !== 'warning') return undefined;
  if (args.fromCache) return undefined;
  if (args.role === 'recall' || args.role === 'other' || args.role === 'mutation') {
    return undefined;
  }
  // The FIRST line of a read digest is its conclusion ("timeline map, 46 clips,
  // sequence duration 21.87s, revision 701"); the rest is the records themselves, which
  // belong in the evidence store and not in a briefing that has to stay flat in project
  // duration. Flattening the whole digest here and cutting it at 180 characters would
  // put four of forty-six clips into the fact and call it what the run knows.
  const headline = args.summary.split('\n', 1)[0] ?? '';
  const finding = headline.replace(/\s+/g, ' ').trim();
  // A read whose digest says nothing beyond its own label ("Reading the timeline →
  // Reading the timeline") is not a fact. Recording it taught a run that its memory was
  // noise; omitting it lets the caller see the gap instead of a restatement.
  if (finding === '' || finding === args.descriptor.trim()) return undefined;
  const statement = `${args.descriptor} → ${finding}`.slice(0, STATEMENT_CHARS);
  return {
    statement,
    kind: kindFor(args.role, args.toolName),
    scope: args.scope,
    ...(args.evidenceId ? { evidenceId: args.evidenceId } : {}),
  };
}

/** Render one fact with its evidence handles, so any claim can be checked. */
function renderFact(fact: Fact): string {
  const cites = fact.evidenceIds.length > 0 ? ` [${fact.evidenceIds.join(', ')}]` : '';
  return `- ${fact.statement}${cites}`;
}

/**
 * The state briefing: what this run knows, decided, did, and must do next.
 *
 * Returns '' for a run that has established nothing yet, so a first turn is not handed an
 * empty scaffold of headings — the contract and the request are enough there, and an
 * empty briefing would only teach the model that the section is noise.
 */
export function buildStateBriefing(state: RunWorkingState): string {
  const sections: string[] = [];
  // Is this text just the editor's request back again?
  //
  // The conductor seeds the objective, its single acceptance criterion, the committed
  // plan's single decision and the run's single objective ALL from `userPrompt`, before
  // any turn runs. So a briefing rendered naively printed the same sentence five times
  // under five headings — WHAT DONE LOOKS LIKE, DECIDED, OBJECTIVES, DO THIS NOW, and the
  // request itself. Repetition is the mild cost. The real one is that "DECIDED" listing
  // the request tells the model that nothing has been decided while claiming something
  // has, and "OBJECTIVES 0/1" restates the request as an unmet checkbox no tool can tick.
  // A heading with nothing behind it is worse than an absent heading: the run reads its
  // own memory as noise and re-derives what it should be carrying forward.
  //
  // Suppressing the echoes is not a substitute for a real interpretation — that needs a
  // seam for the model to write one, tracked separately. It is the honest rendering of
  // the state that exists: the request is known, nothing else is.
  const echoesRequest = (text: string): boolean =>
    text.trim() === state.objective.request.trim();

  if (state.objective.outcome && !echoesRequest(state.objective.outcome)) {
    const criteria = state.objective.acceptance
      .filter((c) => !echoesRequest(c.description))
      .map((c) => `- ${c.description}`)
      .join('\n');
    sections.push(
      `WHAT DONE LOOKS LIKE\n${state.objective.outcome}${criteria ? `\n${criteria}` : ''}`,
    );
  }

  const completed = state.completedStages.length
    ? ` (finished: ${state.completedStages.join(' → ')})`
    : '';
  sections.push(`STAGE\nYou are at "${state.stage}"${completed}. Continue from here.`);

  if (state.facts.length > 0) {
    sections.push(`ESTABLISHED — do not gather again\n${state.facts.map(renderFact).join('\n')}`);
  }

  const decisions = committedDecisions(state).filter((d) => !echoesRequest(d.decision));
  if (decisions.length > 0) {
    sections.push(
      `DECIDED — keep unless the stated trigger fires\n${decisions
        .map((d) => `- ${d.decision} (revisit only if: ${d.reconsiderIf})`)
        .join('\n')}`,
    );
  }

  const objectives = state.objectives.filter((o) => !echoesRequest(o.description));
  if (objectives.length > 0) {
    const done = objectives.filter((o) => o.status === 'satisfied').length;
    sections.push(
      `OBJECTIVES (${done}/${objectives.length} satisfied)\n${objectives
        .map((o) => `- [${o.status === 'satisfied' ? 'x' : ' '}] ${o.description}`)
        .join('\n')}`,
    );
  }

  const succeeded = state.operations.filter((o) => o.status === 'succeeded');
  const failed = state.operations.filter((o) => o.status === 'failed');
  if (succeeded.length > 0) {
    sections.push(
      `ALREADY APPLIED — do not repeat\n${succeeded.map((o) => `- ${o.intent}`).join('\n')}`,
    );
  }
  if (failed.length > 0) {
    sections.push(
      `FAILED — fix the cause, do not retry unchanged\n${failed
        .map((o) => `- ${o.intent}: ${o.failureReason ?? 'no reason recorded'}`)
        .join('\n')}`,
    );
  }

  if (state.verifications.length > 0) {
    sections.push(
      `VERIFIED\n${state.verifications
        .map(
          (v) =>
            `- ${v.passed ? 'PASS' : 'FAIL'} ${v.criterion}${v.detail ? ` — ${v.detail}` : ''}`,
        )
        .join('\n')}`,
    );
  }

  if (state.blockedOn) {
    sections.push(
      `BLOCKED\n${state.blockedOn.reason}${
        state.blockedOn.missing ? ` (missing: ${state.blockedOn.missing})` : ''
      }`,
    );
  }

  if (state.nextAction) {
    sections.push(
      `DO THIS NOW\n${state.nextAction.action}${
        state.nextAction.toolHint ? ` (use ${state.nextAction.toolHint})` : ''
      }`,
    );
  }

  // Nothing established yet — say nothing rather than print empty headings.
  if (sections.length <= 1 && state.facts.length === 0 && !state.objective.outcome) return '';

  return [
    '',
    '',
    'RUN STATE — this run is already in progress. Continue it; do not restart your',
    'analysis, and do not repeat anything listed as established or applied.',
    '',
    ...sections.join('\n\n').split('\n'),
  ].join('\n');
}
