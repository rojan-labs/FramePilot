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
import { Orchestrator } from './orchestrator.js';
import { makeProject } from './__fixtures__/project.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import { parseWorkingState } from './kernel/working-state.js';
import { SEMANTIC_LOOP_TURNS } from './kernel/loop-detector.js';
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

    // The tool surface is the observable proof of the stage: once the run is executing,
    // analysis descriptors are gone from the prompt entirely.
    const offered = offeredTools(provider);
    expect(offered[0]).toContain('get_transcript');
    expect(offered[1]).toContain('get_transcript');
    expect(offered[3]).not.toContain('get_transcript');
    // Reference data stays open (GAP-008): a catalog or a playbook is not observation of
    // the material, so there is nothing stored to recall in its place — and withholding
    // it stranded an executing run with `add_transition` on offer and no legal way to
    // learn a transition id.
    expect(offered[3]).toContain('load_skill');
    expect(offered[3]).toContain('discover_transitions');
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

    // Turn 3 says "let me first understand the project" — the run must already be past
    // inspection and must not hand it back the surface to start over.
    const offered = offeredTools(provider);
    const analysisOffered = offered.map((names) => names.includes('get_transcript'));
    // Once analysis is withdrawn it never comes back.
    const firstClosed = analysisOffered.indexOf(false);
    if (firstClosed !== -1) {
      expect(analysisOffered.slice(firstClosed).every((open) => !open)).toBe(true);
    }
  });
});

describe('the run cannot circle forever (M4)', () => {
  /**
   * The M4 exit gate. An adversarial model that never stops orienting — every turn a
   * fresh sentence, a genuinely novel call, and no edit — is exactly the shape that
   * defeated every pre-existing guard. It must be forced into execution, not merely
   * stopped, and it must be forced quickly.
   */
  it('forces an endlessly orienting run into execution', async () => {
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

    // Within the detector's window plus one, the read tools are gone from the prompt: the
    // run is structurally unable to keep gathering.
    //
    // This assertion is load-bearing for a bug it once masked. The Conductor's
    // `stageAdvanced` was an object comparison against a `state.working` the fact fold had
    // already replaced, so it read true on any turn that recorded a fact — and
    // `isSemanticLoop` treats advancing as proof the run is not circling. The test passed
    // only because every read reported its own descriptor as its finding, making each
    // turn's fact a byte-identical duplicate that `recordFact` deduplicates into a no-op.
    // Give the reads real findings and the detector goes quiet in production. It now
    // compares the stage.
    const offered = provider.requests.map((r) => (r.tools ?? []).map((t) => t.name));
    const closed = offered.findIndex((names) => !names.includes('get_transcript'));
    expect(closed).toBeGreaterThan(0);
    expect(closed).toBeLessThanOrEqual(SEMANTIC_LOOP_TURNS + 1);

    // And it is told exactly what to do instead — an action, not another plan.
    const forcedPrompt = promptText(provider.requests[closed]!);
    expect(forcedPrompt).toContain('DO THIS NOW');
  });
});
