/**
 * A new run starts where the last one finished (context-management P5.1).
 *
 * Run memory used to die at the run boundary. `historyFromEvents` keeps only the user and
 * assistant TEXT of prior turns, and `initialWorkingState` builds an empty ledger for
 * every command — so turn 1 ("find the best moments") could spend six turns reading the
 * transcript and distilling forty facts, and turn 2 ("now tighten the middle") started
 * knowing the prose of what was said and nothing about what was found. The only restore
 * path was `agentOptions.resume`, which is a within-run crash checkpoint.
 *
 * Two rules make carrying safe, and both are asserted here: only what is still TRUE
 * crosses (`FactScope` decides), and only when the conversation AND project match.
 */
import { describe, expect, it } from 'vitest';
import {
  CARRIED_FACT_PREFIX,
  carryForwardWorkingState,
  commitDecision,
  initialWorkingState,
  recordDecision,
  recordFact,
  type RunWorkingState,
} from './kernel/working-state.js';
import { buildStateBriefing } from './kernel/briefing.js';

const IDENTITY = { conversationId: 'conv_1', projectId: 'proj_1' } as const;

function freshFor(over: Partial<typeof IDENTITY> = {}): RunWorkingState {
  return initialWorkingState({
    runId: 'run_2',
    request: 'now tighten the middle',
    conversationId: over.conversationId ?? IDENTITY.conversationId,
    projectId: over.projectId ?? IDENTITY.projectId,
    attemptId: 'turn_2',
    projectRevision: 7,
  });
}

/** A finished run that learned two things about the footage and one about the cut. */
function previousRun(): RunWorkingState {
  let state = initialWorkingState({
    runId: 'run_1',
    request: 'find the best moments in this recording',
    conversationId: IDENTITY.conversationId,
    projectId: IDENTITY.projectId,
    attemptId: 'turn_1',
    projectRevision: 1,
  });
  state = recordFact(state, {
    kind: 'asset',
    statement: 'asset_3 runs 8:42; speech starts at 0:04.',
    scope: 'revision_independent',
    evidenceIds: ['ev_2'],
  });
  state = recordFact(state, {
    kind: 'transcript',
    statement: 'The strongest claim is at 4:12: "we shipped it in a week".',
    scope: 'revision_independent',
    evidenceIds: ['ev_5'],
  });
  state = recordFact(state, {
    kind: 'project',
    statement: '46 clips, sequence duration 21.87s.',
    scope: 'timeline_dependent',
    evidenceIds: ['ev_9'],
  });
  state = recordDecision(state, {
    decision: 'Vertical 9:16, no music.',
    reconsiderIf: 'The editor asks for a different aspect.',
  });
  const decision = state.decisions.at(-1)!;
  state = commitDecision(state, decision.id);
  state = recordDecision(state, {
    decision: 'Maybe open on the walk-in shot.',
    reconsiderIf: 'A better hook is found.',
  });
  return state;
}

describe('carryForwardWorkingState', () => {
  it('carries what is still true about the FOOTAGE across the boundary', () => {
    const seeded = carryForwardWorkingState(previousRun(), freshFor());
    const statements = seeded.facts.map((f) => f.statement);
    expect(statements.some((s) => s.includes('asset_3 runs 8:42'))).toBe(true);
    expect(statements.some((s) => s.includes('we shipped it in a week'))).toBe(true);
  });

  it('drops what the intervening edits invalidated', () => {
    // A fact about the ARRANGEMENT does not survive a revision bump, and `FactScope` is
    // the field that exists so this distinction can be made.
    const seeded = carryForwardWorkingState(previousRun(), freshFor());
    expect(seeded.facts.some((f) => f.statement.includes('46 clips'))).toBe(false);
  });

  it('carries committed decisions and leaves tentative ones behind', () => {
    const seeded = carryForwardWorkingState(previousRun(), freshFor());
    const decisions = seeded.decisions.map((d) => d.decision);
    expect(decisions).toContain('Vertical 9:16, no music.');
    expect(decisions).not.toContain('Maybe open on the walk-in shot.');
  });

  it('says a carried fact is carried, because its evidence cannot be recalled', () => {
    // The handles address the previous run's in-memory EvidenceStore, which is gone.
    // Carrying an address that cannot be dereferenced is exactly the broken promise
    // `clearedWithHandle` exists to end — so the citations go and the fact says so.
    const seeded = carryForwardWorkingState(previousRun(), freshFor());
    const carried = seeded.facts.find((f) => f.statement.includes('asset_3 runs 8:42'))!;
    expect(carried.statement.startsWith(CARRIED_FACT_PREFIX)).toBe(true);
    expect(carried.evidenceIds).toEqual([]);
    expect(seeded.evidence).toEqual([]);
  });

  it('does not double-mark a fact carried twice', () => {
    const once = carryForwardWorkingState(previousRun(), freshFor());
    const twice = carryForwardWorkingState(once, freshFor());
    const carried = twice.facts.find((f) => f.statement.includes('asset_3 runs 8:42'))!;
    expect(carried.statement.startsWith(`${CARRIED_FACT_PREFIX}${CARRIED_FACT_PREFIX}`)).toBe(
      false,
    );
  });

  it('carries nothing at all from another conversation or another project', () => {
    // A ledger from somewhere else is not stale, it is about something else.
    const otherConversation = freshFor({ conversationId: 'conv_other' });
    expect(carryForwardWorkingState(previousRun(), otherConversation)).toEqual(otherConversation);
    const otherProject = freshFor({ projectId: 'proj_other' });
    expect(carryForwardWorkingState(previousRun(), otherProject)).toEqual(otherProject);
  });

  it('carries nothing when there is no previous run', () => {
    const fresh = freshFor();
    expect(carryForwardWorkingState(null, fresh)).toBe(fresh);
  });

  it('never inherits the previous run’s objective, plan, stage or next action', () => {
    // Inheriting those is how a run ends up executing the previous turn's plan.
    const seeded = carryForwardWorkingState(previousRun(), freshFor());
    const fresh = freshFor();
    expect(seeded.objective).toEqual(fresh.objective);
    expect(seeded.plan).toEqual(fresh.plan);
    expect(seeded.stage).toBe(fresh.stage);
    expect(seeded.nextAction).toBe(null);
    expect(seeded.operations).toEqual([]);
    expect(seeded.verifications).toEqual([]);
    expect(seeded.blockedOn).toBe(null);
  });

  it('re-stamps a carried fact to the new run’s revision', () => {
    // The fact is true of the source material, so it is true here — leaving revision 1 on
    // it would make the briefing read as though it were observed in this run.
    const seeded = carryForwardWorkingState(previousRun(), freshFor());
    for (const fact of seeded.facts) expect(fact.observedAtRevision).toBe(7);
  });

  it('mutates neither input', () => {
    const previous = previousRun();
    const fresh = freshFor();
    const beforePrevious = JSON.stringify(previous);
    const beforeFresh = JSON.stringify(fresh);
    carryForwardWorkingState(previous, fresh);
    expect(JSON.stringify(previous)).toBe(beforePrevious);
    expect(JSON.stringify(fresh)).toBe(beforeFresh);
  });

  it('puts the inherited knowledge in the briefing the next turn reads', () => {
    // The surface that matters: turn 2 must be able to SEE what turn 1 found, or none of
    // this saved anything.
    const briefing = buildStateBriefing(carryForwardWorkingState(previousRun(), freshFor()));
    expect(briefing).toContain('asset_3 runs 8:42');
    expect(briefing).toContain('Vertical 9:16, no music.');
    expect(briefing).not.toContain('46 clips');
  });
});

/**
 * The claim the phase actually makes, through the real Conductor: run 1 reads the
 * transcript and files a fact; run 2 issues a follow-up and is BRIEFED with it.
 */
describe('two runs, one session', () => {
  it('threads the previous run’s ledger into the next run’s prompt', async () => {
    const { Orchestrator } = await import('./orchestrator.js');
    const { makeProject } = await import('./__fixtures__/project.js');
    const previous = previousRun();

    const requests: { messages: { role: string; content: string }[] }[] = [];
    const provider = {
      name: 'mock' as const,
      async complete(request: { messages: { role: string; content: string }[] }) {
        requests.push(request);
        return { text: 'Done.', toolCalls: [] };
      },
    };
    const orchestrator = new Orchestrator(provider as never);
    for await (const _event of orchestrator.streamAgent(
      { project: makeProject(), userPrompt: 'now tighten the middle' },
      { conversationId: IDENTITY.conversationId, turnId: 'turn_2', now: () => 1_000 },
      // The host hands over the last run's persisted ledger, exactly as it comes off disk.
      { carriedForward: JSON.parse(JSON.stringify(previous)) as unknown, maxSteps: 1 },
    )) {
      void _event;
    }

    const prompt = requests.flatMap((r) => r.messages.map((m) => m.content)).join('\n');
    // What run 1 learned about the FOOTAGE is in run 2's prompt…
    expect(prompt).toContain('asset_3 runs 8:42');
    expect(prompt).toContain('Vertical 9:16, no music.');
    // …marked as inherited rather than presented as this run's own observation…
    expect(prompt).toContain(CARRIED_FACT_PREFIX.trim());
    // …and what the intervening edits invalidated is not.
    expect(prompt).not.toContain('46 clips');
  });

  it('ignores a ledger the host cannot vouch for, without failing the run', async () => {
    const { Orchestrator } = await import('./orchestrator.js');
    const { makeProject } = await import('./__fixtures__/project.js');
    const provider = {
      name: 'mock' as const,
      async complete() {
        return { text: 'Done.', toolCalls: [] };
      },
    };
    const events: unknown[] = [];
    for await (const event of new Orchestrator(provider as never).streamAgent(
      { project: makeProject(), userPrompt: 'tighten this' },
      { conversationId: 'conv_1', turnId: 'turn_2', now: () => 1_000 },
      // Rubbish off disk. `parseWorkingState` returns null rather than throwing, so this
      // costs the run its inherited facts and never its correctness.
      { carriedForward: { not: 'a ledger' }, maxSteps: 1 },
    )) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });
});
