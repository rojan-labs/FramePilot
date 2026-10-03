/**
 * Task-memory regression suite (plan/AGENT-TASK-MEMORY.md M0 — "failing evidence").
 *
 * These tests reproduce, without a live model, the deadlock that made a real run
 * re-orient itself for 3,430 events and apply nothing:
 *
 *  1. Log compaction replaces read payloads older than `AGENT_LOG_PAYLOAD_FRESH` turns
 *     with `[old result cleared — re-read if needed]`.
 *  2. The read memo answers the re-read that instruction invites with "this is already
 *     in your context" — and routes the payload to the UI, not to the model.
 *
 * Composed, the agent is told to re-read and then refused the data, with no path back to
 * what it learned. Each `it.fails` below asserts the CORRECT behavior and therefore
 * passes only while the defect is present; M1 turns them into ordinary `it(...)`.
 *
 * The fixture is deliberately longer than `MAX_TRANSCRIPT_WORDS` (600), because that is
 * the only regime where the defect bites: on a short recording the whole transcript rides
 * in the base context every turn and the memo never matters. A six-minute talking-head
 * recording — the reported run — is comfortably past it, so the tail of the transcript is
 * reachable ONLY through a windowed `get_transcript` read.
 */
import { describe, expect, it } from 'vitest';
import { STALL_CONFIRM_TURNS } from './kernel/conductor.js';
import { Orchestrator } from './orchestrator.js';
import { makeProject } from './__fixtures__/project.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import { parseWorkingState } from './kernel/working-state.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from './providers/types.js';

const WORD_COUNT = 1200;
const WORD_SECONDS = 0.025;
const longTranscript = Array.from({ length: WORD_COUNT }, (_, i) => ({
  word: `word${i}`,
  start: Number((i * WORD_SECONDS).toFixed(3)),
  end: Number((i * WORD_SECONDS + 0.02).toFixed(3)),
}));

/**
 * A word past `MAX_TRANSCRIPT_WORDS`, so it appears in the prompt only when a read
 * actually returns it. `WINDOW` is the narrow window that contains it.
 */
const MARKER_INDEX = 900;
const TRANSCRIPT_MARKER = `word${MARKER_INDEX}`;
const WINDOW = { start: MARKER_INDEX * WORD_SECONDS, end: (MARKER_INDEX + 8) * WORD_SECONDS };

const project = makeProject({ transcript: longTranscript });
const input: ContextInput = { project, userPrompt: 'cut this to 60 seconds with captions' };

/** Replays a scripted turn sequence and records every request the loop assembled. */
class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public readonly requests: AiCompletionRequest[] = [];
  private index = 0;
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response as AiResponse;
  }
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (text: string, toolCalls: readonly ToolCall[]): AiResponse => ({
  text,
  toolCalls: [...toolCalls],
});

/** The log line for one 1-based step — what the model is told that turn accomplished. */
function stepNote(log: readonly string[], index: number): string {
  return log.find((line) => line.startsWith(`Step ${index}:`)) ?? '';
}

/** The concatenated text of every message in a request — what the model actually saw. */
function promptText(request: AiCompletionRequest): string {
  return request.messages.map((m) => m.content).join('\n');
}

describe('task memory — the compaction/memo deadlock (M0 evidence)', () => {
  /**
   * The core defect: the agent reads a transcript window, spends turns elsewhere, then
   * re-reads exactly what it was invited to re-read — and gets a scolding instead of the
   * words. From here it can only recover them by varying the window, which is precisely
   * the arg-varying research spin ADR 0074 observed.
   */
  it('re-reading a transcript window returns the words to the model', async () => {
    const provider = new ScriptedProvider([
      turn('Let me read that section.', [call('c1', 'get_transcript', WINDOW)]),
      turn('Now the timeline.', [call('c2', 'get_timeline')]),
      turn('And a summary.', [call('c3', 'get_timeline_summary')]),
      turn('That section again, to place the cut.', [call('c4', 'get_transcript', WINDOW)]),
      turn('Ready.', []),
    ]);

    const run = await new Orchestrator(provider).agent(input, { maxSteps: 5 });

    expect(stepNote(run.log, 4)).toContain(TRANSCRIPT_MARKER);
  });

  /**
   * The instruction half of the deadlock. Whatever the wording, the run must never
   * simultaneously invite a re-read and answer it with nothing — that combination leaves
   * the model no path back to its own findings.
   */
  it('never invites a re-read the memo will then withhold', async () => {
    const provider = new ScriptedProvider([
      turn('Reading that section.', [call('c1', 'get_transcript', WINDOW)]),
      turn('Timeline next.', [call('c2', 'get_timeline')]),
      turn('Summary next.', [call('c3', 'get_timeline_summary')]),
      turn('That section again.', [call('c4', 'get_transcript', WINDOW)]),
      turn('Done.', []),
    ]);

    await new Orchestrator(provider).agent(input, { maxSteps: 5 });

    const withheld = provider.requests.some((request) =>
      promptText(request).includes('already in your context'),
    );
    expect(withheld).toBe(false);
  });

  /**
   * The compounding defect: an applied edit used to call `readCache.clear()`, discarding
   * the whole memo. A timeline cut cannot change the words that were spoken, so the
   * transcript must survive it — the run should never pay to derive it twice.
   */
  it('an applied edit does not invalidate the transcript', async () => {
    const provider = new ScriptedProvider([
      turn('Reading that section.', [call('c1', 'get_transcript', WINDOW)]),
      turn('Cutting the dead air.', [
        call('c2', 'delete_range', { trackId: 'video_1', start: 6, end: 8 }),
      ]),
      turn('That section again, to place captions.', [call('c3', 'get_transcript', WINDOW)]),
      turn('Done.', []),
    ]);

    const run = await new Orchestrator(provider).agent(input, { maxSteps: 4 });

    // The re-read after the cut must be served from the evidence store — the words
    // survived the edit — and must still carry them.
    expect(stepNote(run.log, 3)).toContain('unchanged since you last read it');
    expect(stepNote(run.log, 3)).toContain(TRANSCRIPT_MARKER);
  });

  /**
   * The other side of §3.7: what a cut DOES invalidate. Timeline knowledge describes the
   * arrangement, so it must be re-derived after an edit rather than served stale — the
   * agent must never plan against a timeline that no longer exists.
   */
  it('an applied edit does invalidate timeline knowledge', async () => {
    const provider = new ScriptedProvider([
      turn('Reading the timeline.', [call('c1', 'get_timeline')]),
      turn('Cutting the dead air.', [
        call('c2', 'delete_range', { trackId: 'video_1', start: 6, end: 8 }),
      ]),
      turn('Timeline again.', [call('c3', 'get_timeline')]),
      turn('Done.', []),
    ]);

    const run = await new Orchestrator(provider).agent(input, { maxSteps: 4 });

    expect(stepNote(run.log, 3)).not.toContain('unchanged since you last read it');
  });
});

describe('task memory survives interruption (M1 persistence)', () => {
  /**
   * Cancel-then-resume is the case the creator actually hit: they stopped a looping run.
   * What comes back must be the run's understanding, not just its edits — otherwise
   * resumption re-orients from scratch, which is the loop again with extra steps.
   */
  it('carries the working state out on the resume checkpoint', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      turn('Cutting the dead air.', [
        call('c1', 'delete_range', { trackId: 'video_1', start: 6, end: 8 }),
      ]),
      turn('More.', [call('c2', 'delete_range', { trackId: 'video_1', start: 2, end: 3 })]),
    ]);

    const events: AiEvent[] = [];
    const stream = new Orchestrator(provider).streamAgent(input, {
      conversationId: 'conv_1',
      turnId: 'turn_1',
      now: () => 1000,
      signal: controller.signal,
    });
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'timeline_action') controller.abort();
    }

    const checkpoint = events.find((e) => e.type === 'checkpoint');
    expect(checkpoint).toBeDefined();
    const working = parseWorkingState((checkpoint as { working?: unknown }).working);
    expect(working).not.toBeNull();
    expect(working!.objective.request).toBe(input.userPrompt);
    // The applied cut is in the ledger with the revision it landed at, so a resumed run
    // knows work already happened instead of re-deriving it.
    expect(working!.operations.some((op) => op.status === 'succeeded')).toBe(true);
    expect(working!.currentProjectRevision).toBeGreaterThan(0);
  });
});

describe('stages drive the run forward (M2)', () => {
  /** Every tool name the model was offered on each turn, in order. */
  function offeredTools(provider: ScriptedProvider): string[][] {
    return provider.requests.map((r) => (r.tools ?? []).map((t) => t.name));
  }

  it('walks interpret → inspect → analyze → plan → apply from what turns actually do', async () => {
    const provider = new ScriptedProvider([
      turn('Orienting.', [call('c1', 'get_timeline_summary')]),
      turn('Reading the words.', [call('c2', 'get_transcript', WINDOW)]),
      turn('Cutting.', [call('c3', 'delete_range', { trackId: 'video_1', start: 6, end: 8 })]),
      turn('Done.', []),
    ]);

    const events: AiEvent[] = [];
    for await (const event of new Orchestrator(provider).streamAgent(input, {
      conversationId: 'conv_1',
      turnId: 'turn_1',
      now: () => 1000,
    })) {
      events.push(event);
    }

    // The stage is bookkeeping (ADR 0199): an executing run keeps every tool it has, so a
    // read after the first edit is still on offer — desktop run 001be135 was refused
    // `describe_footage` on its second step because a voiceover placement opened `apply`.
    const offered = offeredTools(provider);
    expect(offered[0]).toContain('get_transcript');
    expect(offered[1]).toContain('get_transcript');
    expect(offered[3]).toContain('get_transcript');
    // Reference data stays open (GAP-008): a catalog or a playbook is not observation of
    // the material, so there is nothing stored to recall in its place.
    expect(offered[3]).toContain('load_skill');
    // The GAP-008 hazard was an executing run holding `add_transition` with no legal way
    // to learn a transition id. Progressive disclosure (`tool-domains.ts`) now settles
    // that by construction rather than by exemption: both tools are in the `effects`
    // domain, so a run either has both or neither. Assert the invariant, not the
    // exemption — this run never loaded `effects`, and correctly has neither.
    expect(offered[3]).not.toContain('add_transition');
    for (const turnTools of offered) {
      if (turnTools.includes('add_transition')) {
        expect(turnTools).toContain('discover_transitions');
      }
    }
    // Inspection and recall stay open — a patch is written against the current
    // arrangement, and reading back stored evidence is not research.
    expect(offered[3]).toContain('get_timeline');
    expect(offered[3]).toContain('recall_evidence');
  });

  it('does not restart orientation after a tool call', async () => {
    // The reported failure, stated as an assertion: however the model narrates itself,
    // the stage only ever moves forward.
    const provider = new ScriptedProvider([
      turn('Let me orient myself.', [call('c1', 'get_timeline_summary')]),
      turn('Let me get the full picture.', [call('c2', 'get_transcript', WINDOW)]),
      turn('Let me first understand the project.', [call('c3', 'get_timeline')]),
      turn('Let me map the footage before editing.', [call('c4', 'get_timeline_summary')]),
      turn('Now I need to plan the cuts.', [
        call('c5', 'delete_range', { trackId: 'video_1', start: 6, end: 8 }),
      ]),
      turn('Done.', []),
    ]);

    for await (const _ of new Orchestrator(provider).streamAgent(input, {
      conversationId: 'conv_1',
      turnId: 'turn_1',
      now: () => 1000,
    })) {
      // drain
    }

    // The stage only ever moves forward however the model narrates itself — and moving it
    // never takes a tool away (ADR 0199).
    const offered = offeredTools(provider);
    expect(offered.every((names) => names.includes('get_transcript'))).toBe(true);
  });
});

describe('an orienting run keeps its tools (ADR 0199)', () => {
  /**
   * An adversarial model that never stops orienting — every turn a fresh sentence, a
   * genuinely novel call, and no edit — used to be FORCED into execution by withholding the
   * read tools (the M4 gate). ADR 0199 removed that: what the run may call is what it has
   * loaded, and a run that keeps reading is bounded by the editor's cost and time budgets
   * and the step cap, not by the harness deciding it has looked enough.
   */
  it('never withholds a read from a run that keeps reading', async () => {
    const orienting = [
      'Let me orient myself.',
      'Let me get the full picture.',
      'Let me first understand the project.',
      'Let me start by understanding the project.',
      'Let me get the full picture before editing.',
      'Let me orient myself properly.',
    ];
    // Every turn is novel (a different transcript window), verbose, and applies nothing —
    // so neither the stall guard nor diminishing returns can see it.
    const provider = new ScriptedProvider(
      orienting.map((prose, i) =>
        turn(prose, [
          call(`c${i}`, 'get_transcript', {
            start: WINDOW.start + i,
            end: WINDOW.end + i + 1,
          }),
        ]),
      ),
    );

    for await (const _ of new Orchestrator(provider).streamAgent(input, {
      conversationId: 'conv_1',
      turnId: 'turn_1',
      now: () => 1000,
    })) {
      // drain
    }

    const offered = provider.requests.map((r) => (r.tools ?? []).map((t) => t.name));
    expect(offered.every((names) => names.includes('get_transcript'))).toBe(true);
    // A transcript window is not a new question (`callNoveltyKey` drops window args), so
    // after the first read every turn learns nothing and the stall streak ends the run —
    // the run is stopped when it provably stops moving, never steered.
    expect(offered).toHaveLength(STALL_CONFIRM_TURNS + 1);
  });
});
