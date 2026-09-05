/**
 * A refusal the run has already been given, twice.
 *
 * Run `7d159862` spent roughly ten of its eighteen model calls calling `caption_the_edit`
 * and being answered, four times, with the byte-identical sentence
 * `add_caption_layer.end must be greater than start.` Two independent defects kept it there:
 *
 * 1. The per-call validator returns `ops: []` with the count out of band, so `turnOpCount`
 *    was 0 and NO operation row was recorded. The run's final ledger listed five operations,
 *    all `succeeded`, beside 584 rejected ones — so the briefing's
 *    "FAILED — fix the cause, do not retry unchanged" section never rendered once.
 * 2. Nothing remembered the refusal itself. `seenCallKeys` banks only calls that ANSWERED,
 *    and it is consulted only to GRANT progress credit — no code path has ever refused a
 *    call because the run already knew what it would say.
 *
 * Attempts 1, 2 and 4 shared one set of arguments; attempt 3 varied both `preset` and
 * `maxWordsPerCue` and produced the same error, which is why the guard keys on the ERROR
 * and not on the arguments.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { ContextInput } from '../context-builder.js';
import type { AiEvent } from '../events.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import type { HostToolExecutor } from '../tool-executor.js';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import { makeProject } from '../__fixtures__/project.js';
import { buildStateBriefing } from './briefing.js';
import type { Command } from './commands.js';
import {
  type AgentTurnResult,
  type ConductorState,
  initialConductorState,
  onCommand,
  onEffectResult,
} from './conductor.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'caption the edit' };
const stream = { conversationId: 'conv_1', turnId: 'turn_1', now: () => 1000 };
const command = (): Command => ({ kind: 'submit_turn', mode: 'agent', input, stream });
const started = (over: Partial<ConductorState> = {}): ConductorState => ({
  ...onCommand(initialConductorState(stream), command()).state,
  ...over,
});

const CAPTION_ERROR = 'add_caption_layer.end must be greater than start: both are 4s.';

const turn = (over: Partial<AgentTurnResult> = {}): AgentTurnResult => ({
  kind: 'agent_turn',
  stepIndex: 1,
  aborted: false,
  done: false,
  anyToolCancelled: false,
  anyToolFailed: true,
  turnOpCount: 0,
  rejectedOpCount: 0,
  rejectionNotes: [],
  applied: false,
  appliedOps: [],
  describedActions: [],
  signature: 'caption_the_edit:{"preset":"short-form","maxWordsPerCue":4}',
  callFacts: [],
  note: 'note',
  planSteps: [],
  planStepIndex: 0,
  intent: 'Captioning the edit',
  log: [],
  endSeq: 1,
  ...over,
});

/** A turn whose only call was refused by the PER-CALL validator (`ops: []`, count out of band). */
const perCallRejection = (over: Partial<AgentTurnResult> = {}): AgentTurnResult =>
  turn({
    rejectedOpCount: 3,
    rejectionNotes: [`Rejected "caption_the_edit" — ${CAPTION_ERROR}`],
    callFacts: [
      {
        key: 'caption_the_edit:{"preset":"short-form","maxWordsPerCue":4}',
        status: 'failed',
        fromCache: false,
        role: 'mutation',
        failureKey: `caption_the_edit:${CAPTION_ERROR}`,
      },
    ],
    ...over,
  });

describe('FIX 1 — a per-call validator rejection reaches the durable ledger', () => {
  it('records a failed operation even though the turn reported zero operations', () => {
    const step = onEffectResult(started(), perCallRejection());
    // The precondition the old code tripped on: nothing in `turnOpCount` to notice.
    expect(step.state.working.operations).toHaveLength(1);
    const [operation] = step.state.working.operations;
    expect(operation?.status).toBe('failed');
    expect(operation?.failureReason).toContain(CAPTION_ERROR);
  });

  it('renders under FAILED — fix the cause, do not retry unchanged', () => {
    const step = onEffectResult(started(), perCallRejection());
    const briefing = buildStateBriefing(step.state.working);
    expect(briefing).toContain('FAILED — fix the cause, do not retry unchanged');
    expect(briefing).toContain(CAPTION_ERROR);
    // And never as a success — the run must not read its own refusal as work done.
    expect(briefing).not.toContain('ALREADY APPLIED');
  });

  it('carries the per-call notes as the cause, not the turn note', () => {
    // The turn note holds every read result in the turn. Putting that in front of the
    // model as "the cause to fix" buries the one sentence that names it.
    const step = onEffectResult(
      started(),
      perCallRejection({ note: 'Read the timeline → 2 clips; Read the transcript → 2 words' }),
    );
    const [operation] = step.state.working.operations;
    expect(operation?.failureReason).toBe(`Rejected "caption_the_edit" — ${CAPTION_ERROR}`);
  });

  it('does not turn an already-satisfied turn into a failure', () => {
    // The inverse guard: an edit the timeline already reflects stays `succeeded`, so it
    // keeps landing under "ALREADY APPLIED — do not repeat".
    const step = onEffectResult(started(), turn({ turnOpCount: 1, satisfied: true }));
    expect(step.state.working.operations[0]?.status).toBe('succeeded');
  });
});

describe('FIX 2 — the run remembers refusals it can prove will repeat', () => {
  it('banks a deterministic failure key unconditionally', () => {
    // The exact inverse of `seenCallKeys`, which banks only calls that ANSWERED. This set
    // is a claim the run was REFUSED, and only a failure can prove that.
    const step = onEffectResult(started(), perCallRejection());
    expect(step.state.seenFailureKeys).toEqual([`caption_the_edit:${CAPTION_ERROR}`]);
    expect(step.state.seenCallKeys).toEqual([]);
  });

  it('never banks a failure with no key — a host error is transient', () => {
    const step = onEffectResult(
      started(),
      turn({
        signature: 'analyze_silence',
        callFacts: [
          { key: 'analyze_silence:asset_1', status: 'failed', fromCache: false, role: 'analysis' },
        ],
      }),
    );
    expect(step.state.seenFailureKeys).toEqual([]);
  });

  it('an applied edit retires the run’s refusals', () => {
    // A validator verdict describes the arrangement it was shown; the patch replaced it.
    const banked = onEffectResult(started(), perCallRejection()).state;
    expect(banked.seenFailureKeys).toHaveLength(1);
    const applied = onEffectResult(
      banked,
      turn({ stepIndex: 2, applied: true, turnOpCount: 1, anyToolFailed: false }),
    );
    expect(applied.state.seenFailureKeys).toEqual([]);
  });

  it('hands the banked keys to the next turn, and only when there are any', () => {
    const first = onEffectResult(started(), perCallRejection());
    const [effect] = first.effects;
    // Nothing banked yet on the run's first turn effect.
    expect(onCommand(initialConductorState(stream), command()).effects[0]).not.toHaveProperty(
      'seenFailureKeys',
    );
    expect(effect).toMatchObject({
      kind: 'run_turn',
      seenFailureKeys: [`caption_the_edit:${CAPTION_ERROR}`],
    });
  });
});

// ---------------------------------------------------------------------------
// End to end through `streamAgent` — the loop the captured run was actually in.
// ---------------------------------------------------------------------------

const baseOpts = (): StreamOptions => ({
  conversationId: 'conv_1',
  turnId: 'turn_1',
  now: () => 1000,
});

/** Replays a fixed script and keeps every request, so the model's own view is assertable. */
class RecordingProvider implements AiProvider {
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

async function drain(generator: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/**
 * `trim_clip` past its neighbour. Both `end: 8` and `end: 9` overlap `clip_b` (6s–10s), so
 * the two calls carry DIFFERENT arguments and are refused for the SAME reason — the shape
 * of the captured run's third attempt, and the one an args-keyed guard waves through.
 *
 * The rejections are compared on their CAUSE, not on the decorated string: when the
 * validator prefixes an operation locator (`op 1 of 1 (trim_clip, 0s–8s): …`) that prefix
 * names the arguments, so keying on the raw text would miss exactly this case. Stripping it
 * is what makes both attempts land on one key, with or without a locator present.
 */
const overlappingTrim = (id: string, end: number): AiResponse => ({
  text: '',
  toolCalls: [{ id, name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end } }],
});
const done: AiResponse = { text: 'done', toolCalls: [] };

const modelFacingText = (provider: RecordingProvider): string =>
  JSON.stringify(provider.requests.at(-1)?.messages ?? []);

describe('streamAgent refuses a call the run has already been refused', () => {
  it('refuses the repeat even though the arguments changed', async () => {
    const provider = new RecordingProvider([
      overlappingTrim('c1', 8),
      overlappingTrim('c2', 9),
      done,
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, baseOpts(), {}));

    const results = events.filter(
      (e): e is Extract<AiEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(results).toHaveLength(2);
    // First attempt: the validator's own words, unchanged.
    expect(results[0]?.summary).toContain('overlap');
    expect(results[0]?.summary).not.toContain('already failed');
    // Second attempt, different arguments, identical error: refused.
    expect(results[1]?.summary).toBe('Refused repeat of "trim_clip" — it already failed this run');

    // The refusal must be ACTIONABLE where the model actually reads it. "for this same
    // reason" rather than "with exactly this error" since run `369e8c82`: a policy refusal
    // keys on its RULE, so the sentence that reaches here can be one the run has never
    // seen even though the reason behind it is one it has.
    const seenByModel = modelFacingText(provider);
    expect(seenByModel).toContain('already failed this run for this same reason');
    expect(seenByModel).toContain('Do what that reason names instead');
  });

  it('settles the refusal as failed, never as a warning', async () => {
    // `callAnswered` reads a warning as an answer, so settling this as `warning` would
    // credit the turn with progress and bank the call's novelty key — the guard against
    // spinning would reset the guards against spinning.
    const provider = new RecordingProvider([
      overlappingTrim('c1', 8),
      overlappingTrim('c2', 9),
      done,
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, baseOpts(), {}));
    const terminal = events.filter(
      (e): e is Extract<AiEvent, { type: 'tool_call' }> =>
        e.type === 'tool_call' && e.status !== 'running',
    );
    expect(terminal.map((e) => e.status)).toEqual(['failed', 'failed']);
  });

  it('does not refuse a repeat of a TRANSIENT host failure', async () => {
    // A sidecar restart or a network timeout says nothing about whether the call can work.
    // Blocking one permanently would be a worse bug than the loop this guard exists to stop.
    let calls = 0;
    const executor: HostToolExecutor = {
      run: async () => {
        calls += 1;
        // Byte-identical both times — the property that makes this the strongest possible
        // test of the discriminator: the KEY would match if the outcome carried one.
        return { status: 'failed', summary: 'engine sidecar restarted', data: 'sidecar restarted' };
      },
    };
    const analyze = (id: string): AiResponse => ({
      text: '',
      toolCalls: [{ id, name: 'analyze_silence', arguments: { assetId: 'asset_1' } }],
    });
    const provider = new RecordingProvider([analyze('a1'), analyze('a2'), done]);
    const events = await drain(
      new Orchestrator(provider, { executor }).streamAgent(input, baseOpts(), {}),
    );

    // The host ran BOTH times — nothing was refused on the strength of the first failure.
    expect(calls).toBe(2);
    const results = events.filter(
      (e): e is Extract<AiEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(results).toHaveLength(2);
    for (const result of results) expect(result.summary).not.toContain('already failed');
  });
});

// ---------------------------------------------------------------------------
// `add_stock` — the same ADR 0140 rule, reached AFTER a paid download.
// ---------------------------------------------------------------------------

/**
 * The second instance of run `369e8c82`'s loop, on the tool a user reaches for when they
 * ask for b-roll.
 *
 * `add_stock` refuses a placement over existing picture twice over: `stock-host.ts` checks
 * BEFORE spending the download, and — because the timeline can move between the two
 * moments — `stockOpsFromPayload` checks again in-process AFTER it. The second refusal is
 * the one keyed here. It is a policy decision, not a host failure: the download completed,
 * and the verdict comes from the orchestrator's own working copy through the same
 * `editor-core` occupancy predicate. `add_clip` no longer shares it — ADR 0169 lets a
 * full-frame placement open a layer in front instead — but `add_stock` picks the track
 * itself and cannot, so ADR 0140's rule is still exactly what it answers with.
 *
 * The fixture's `video_1` holds picture across 0–10s, so 2s and 3s are both refused by that
 * rule and the free moment is 10s. The refusal sentence names the requested span and the
 * free moment, so the two attempts produce two DIFFERENT sentences and one identical rule —
 * exactly the shape that gave run `369e8c82` four keys and no match.
 *
 * The cost boundary is the thing these tests exist to hold still. A download is metered, so
 * the guard must neither block a corrected retry (wasting what was paid for) nor wave an
 * identical refused placement through (paying again for the same "no").
 */
const STOCK_REMOTE_ID = '9001';

const stockPayload = (atSeconds?: number): unknown => ({
  asset: {
    id: `stock_pexels_${STOCK_REMOTE_ID}`,
    path: 'media/stock/9001.mp4',
    kind: 'video',
    durationSeconds: 4,
    source: {
      provider: 'pexels',
      remoteId: STOCK_REMOTE_ID,
      license: 'CC0',
      attributionRequired: false,
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  ...(atSeconds === undefined ? {} : { atSeconds }),
});

const addStock = (id: string, atSeconds?: number): AiResponse => ({
  text: '',
  toolCalls: [
    {
      id,
      name: 'add_stock',
      arguments: {
        remoteId: STOCK_REMOTE_ID,
        kind: 'video',
        ...(atSeconds === undefined ? {} : { atSeconds }),
      },
    },
  ],
});

/** A host that always reports a SUCCESSFUL download, echoing the position it was asked for. */
const downloadingHost = (counter: { calls: number }): HostToolExecutor => ({
  run: async (call) => {
    counter.calls += 1;
    const { atSeconds } = call.arguments as { atSeconds?: number };
    return {
      status: 'completed',
      summary: 'Downloaded "stock/9001.mp4".',
      data: stockPayload(atSeconds),
    };
  },
});

const stockInput: ContextInput = { project: makeProject(), userPrompt: 'add some b-roll' };

const toolResults = (events: readonly AiEvent[]): Extract<AiEvent, { type: 'tool_result' }>[] =>
  events.filter((e): e is Extract<AiEvent, { type: 'tool_result' }> => e.type === 'tool_result');

describe('add_stock — a placement refused after the download is keyed on the rule', () => {
  it('refuses the second refused placement even though the sentence differs', async () => {
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 3), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: downloadingHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    // First attempt: the refusal in its own words, naming the free moment.
    expect(results[0]?.summary).toContain('already picture on the timeline');
    expect(results[0]?.summary).toContain('10.0s');
    expect(results[0]?.summary).not.toContain('already failed');
    // Second attempt: a DIFFERENT sentence (3.0s–7.0s, not 2.0s–6.0s) and the same rule.
    expect(results[1]?.summary).toBe('Refused repeat of "add_stock" — it already failed this run');
    expect(modelFacingText(provider)).toContain('already failed this run for this same reason');
  });

  it('lets the second call SETTLE — the guard never pre-empts a metered tool on its name', async () => {
    // The key is `name:cause` and the cause is produced by the attempt, so the only thing
    // knowable before execution is the tool's name. Blocking on that would refuse an
    // `add_stock` into a free span because an earlier one overlapped, which is the worse
    // bug: it wastes a download the run already paid for and strands the request.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 3), done]);
    await drain(
      new Orchestrator(provider, { executor: downloadingHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );
    expect(counter.calls).toBe(2);
  });

  it('does not block a CORRECTED placement into a free span', async () => {
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 12), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: downloadingHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('already picture on the timeline');
    // 12s–16s is past the fixture's picture, so the placement succeeds and never
    // computes a key to match against the banked one.
    expect(results[1]?.summary).not.toContain('already failed');
    expect(results[1]?.summary).toContain('Downloaded');
  });

  it('does not block a bin-only download — the gathering path has no placement to refuse', async () => {
    // `atSeconds` omitted means "into the media bin", which cannot conflict with anything.
    // Blocking it would break the gather-then-cut flow the absent argument exists for.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2'), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: downloadingHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[1]?.summary).not.toContain('already failed');
  });

  it('never keys an UNDECLARED host failure — a transient one must stay retryable', async () => {
    // THE INVARIANT, pinned. A host `failed` that declares nothing carries no
    // `deterministicFailure` and must never acquire one by association with the refusals
    // around it: `failed` from the host is what a download timeout, a provider 5xx, a
    // missing API key and an unresolvable remoteId all look like, and a permanent block on
    // any of those would lose the tool for the rest of the run over a fault it had no part
    // in. One bad network moment must not end `add_stock`.
    //
    // The host CAN now opt in, by declaring a `refusalCause` for a policy verdict it read
    // off the project (the describe below). This test is the other half of that boundary:
    // opting in has to be the only way across it. Simplifying it away — keying every
    // `add_stock` failure rather than only a declared verdict and the post-download one —
    // is what this test exists to fail.
    let calls = 0;
    const executor: HostToolExecutor = {
      run: async () => {
        calls += 1;
        // Byte-identical both times: the key WOULD match if the outcome carried one.
        return { status: 'failed', summary: 'Stock provider is unreachable right now.' };
      },
    };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 2), done]);
    const events = await drain(
      new Orchestrator(provider, { executor }).streamAgent(stockInput, baseOpts(), {}),
    );

    expect(calls).toBe(2);
    const results = toolResults(events);
    expect(results).toHaveLength(2);
    for (const result of results) expect(result.summary).not.toContain('already failed');
  });
});

// ---------------------------------------------------------------------------
// A host DECLARING its refusal — the same rule, refused BEFORE the download.
// ---------------------------------------------------------------------------

/**
 * The last unbounded arm of run `369e8c82`'s loop, and the one a real b-roll request on
 * DESKTOP reaches first.
 *
 * `stock-host.ts` answers ADR 0140's picture-over-picture rule before spending the
 * download, by reading the same `editor-core` occupancy predicate `add_clip` uses. That
 * reached the orchestrator as an ordinary host `failed`, and host failures are
 * deliberately never keyed — so on the product's primary surface the refusal cost nothing
 * per iteration and could repeat without limit. The browser build, which has no stock host
 * at all, never saw it.
 *
 * The fix is a channel, not a special case: `HostToolOutcome.refusalCause` lets a host say
 * WHY it refused, and a declared cause is keyed exactly like an in-process one. The
 * vocabulary is the single `RefusalCause` union, so the rule refused before the download
 * and the same rule refused after it (`stockOpsFromPayload`, above) produce ONE key —
 * `add_stock:picture_over_picture` — and the second attempt is answered as a repeat
 * whichever side said no first.
 *
 * The sentences below deliberately differ between the two attempts, exactly as the real
 * one does: `stockPlacementConflictReason` interpolates the requested span, the clip it
 * collides with and the next free moment. If the key were the text, these would be two
 * unrelated failures — which is precisely how the captured run banked four keys and
 * matched none of them.
 */
const conflictSentence = (atSeconds: number): string =>
  `That span (${atSeconds.toFixed(1)}s–${(atSeconds + 4).toFixed(1)}s) is already picture on ` +
  'the timeline, and FramePilot previews one picture layer. The first free moment is 10.0s ' +
  '— place it there, or split the clip underneath and put this on the same track.';

/**
 * A stand-in for `stock-host.ts`: refuses a placement over the fixture's picture BEFORE
 * downloading and declares the rule, and otherwise reports a successful download.
 */
const declaringStockHost = (counter: { calls: number }): HostToolExecutor => ({
  run: async (call) => {
    counter.calls += 1;
    const { atSeconds } = call.arguments as { atSeconds?: number };
    if (atSeconds !== undefined && atSeconds < 10) {
      return {
        status: 'failed',
        summary: conflictSentence(atSeconds),
        refusalCause: 'picture_over_picture',
      };
    }
    return {
      status: 'completed',
      summary: 'Downloaded "stock/9001.mp4".',
      data: stockPayload(atSeconds),
    };
  },
});

describe('add_stock — a placement the HOST refused before the download is keyed too', () => {
  it('refuses the second refused placement even though the sentence differs', async () => {
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 3), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: declaringStockHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    // First attempt: the host's own sentence, unchanged and un-prefixed — a refusal is not
    // a bad argument, so nothing is put in front of it.
    expect(results[0]?.summary).toBe(conflictSentence(2));
    expect(results[0]?.summary).not.toContain('already failed');
    // Second attempt: a DIFFERENT sentence (3.0s–7.0s, not 2.0s–6.0s) and the same rule.
    expect(results[1]?.summary).toBe('Refused repeat of "add_stock" — it already failed this run');
    // THE REMEDY SURVIVES. A guard that closed the loop by handing back a dead end would be
    // worse than the loop: the free moment and the split-and-place move are the whole
    // reason the refusal is worth reading.
    const seenByModel = modelFacingText(provider);
    expect(seenByModel).toContain('already failed this run for this same reason');
    expect(seenByModel).toContain('The first free moment is 10.0s');
    expect(seenByModel).toContain('Do what that reason names instead');
  });

  it('keys the host refusal on the RULE, so a repeat matches on nothing else', async () => {
    // The narrow claim, isolated: the two calls share no argument value and no sentence,
    // and are still one key. Nothing but the declared cause can be doing that.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 3), done]);
    await drain(
      new Orchestrator(provider, { executor: declaringStockHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );
    expect(conflictSentence(2)).not.toBe(conflictSentence(3));
    // Both calls reached the host: the key is computed once a call SETTLES, so the guard
    // never pre-empts a tool on its name. It costs nothing here — this host refuses before
    // it spends anything, which is exactly why the branch is safe to key.
    expect(counter.calls).toBe(2);
  });

  it('does not block a CORRECTED placement into a free span', async () => {
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 12), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: declaringStockHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toBe(conflictSentence(2));
    // 12s is past the fixture's picture, so the host downloads and the placement lands. A
    // corrected retry never computes a key, so it has nothing to match the banked one.
    expect(results[1]?.summary).not.toContain('already failed');
    expect(results[1]?.summary).toContain('Downloaded');
    expect(counter.calls).toBe(2);
  });

  it('answers the same key whichever side of the download said no', async () => {
    // The host refuses 2s before spending anything; the run then asks for 3s against a
    // host that downloads regardless, and the IN-PROCESS check refuses that one. Two
    // different modules, one rule, one key — so the second is answered as a repeat rather
    // than starting the loop again from the other side of the metered line.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), addStock('s2', 3), done]);
    let first = true;
    const mixedHost: HostToolExecutor = {
      run: async (call, ctx, signal) => {
        if (first) {
          first = false;
          return declaringStockHost(counter).run(call, ctx, signal);
        }
        return downloadingHost(counter).run(call, ctx, signal);
      },
    };
    const events = await drain(
      new Orchestrator(provider, { executor: mixedHost }).streamAgent(stockInput, baseOpts(), {}),
    );

    const results = toolResults(events);
    expect(results[0]?.summary).toBe(conflictSentence(2));
    expect(results[1]?.summary).toBe('Refused repeat of "add_stock" — it already failed this run');
  });
});

// ---------------------------------------------------------------------------
// `add_music` — the duck-sidechain refusal, and the validator probe behind it.
// ---------------------------------------------------------------------------

/**
 * The third in-process route out of run `369e8c82`'s loop, on the tool that scores an edit.
 *
 * `musicDuckSidechainIssue` refuses a duck at a track that does not exist or holds no
 * clips, and it refuses AFTER a completed paid download — the same shape as `add_stock`'s
 * post-download placement refusal, a different rule. Un-keyed it could be re-earned every
 * turn, at the price of a download each time.
 *
 * It is keyed on its TEXT, not on a rule name, and that is the whole difference from the
 * picture rule. There the sentence varied with the asset and the timestamps — incidental
 * detail around one unchanging verdict — so four attempts banked four keys. Here the only
 * thing that varies is the `duckUnderTrackId` the sentence names, which is the argument the
 * refusal is asking the model to correct: the same bad id twice is the loop, two different
 * bad ids are two different corrections, and each deserves an answer naming its own id.
 */
const musicAsset = (id: string, durationSeconds: number): unknown => ({
  id,
  path: `media/music/${id}.mp3`,
  kind: 'audio',
  durationSeconds,
  source: {
    provider: 'openverse',
    remoteId: id,
    license: 'CC0',
    attributionRequired: false,
    fetchedAt: '2026-01-01T00:00:00.000Z',
  },
});

const addMusic = (id: string, duckUnderTrackId?: string, atSeconds = 0): AiResponse => ({
  text: '',
  toolCalls: [
    {
      id,
      name: 'add_music',
      arguments: {
        remoteId: 'ov_1',
        atSeconds,
        ...(duckUnderTrackId === undefined ? {} : { duckUnderTrackId }),
      },
    },
  ],
});

/** A host that always reports a SUCCESSFUL download, echoing the sidechain it was asked for. */
const musicHost = (counter: { calls: number }): HostToolExecutor => ({
  run: async (call) => {
    counter.calls += 1;
    const { duckUnderTrackId } = call.arguments as { duckUnderTrackId?: string };
    return {
      status: 'completed',
      summary: 'Downloaded "music/ov_1.mp3".',
      data: {
        asset: musicAsset(`music_openverse_${counter.calls}`, 30),
        ...(duckUnderTrackId === undefined ? {} : { duckUnderTrackId }),
      },
    };
  },
});

const musicInput: ContextInput = { project: makeProject(), userPrompt: 'put music under it' };

const warnings = (events: readonly AiEvent[]): string[] =>
  events
    .filter((e): e is Extract<AiEvent, { type: 'warning' }> => e.type === 'warning')
    .map((e) => e.text);

describe('add_music — a duck refused after the download is keyed on its sentence', () => {
  it('refuses the second identical duck, remedy intact', async () => {
    const counter = { calls: 0 };
    // The arguments are NUDGED between the two, exactly as run `369e8c82`'s were: a
    // different `atSeconds` makes this a call the run has never made, and the duck is
    // resolved before placement so the answer is the identical sentence. An args-keyed
    // guard waves this through; a novelty-keyed run keeps going and asks again.
    const provider = new RecordingProvider([
      addMusic('m1', 'voiceover', 0),
      addMusic('m2', 'voiceover', 2),
      done,
    ]);
    const events = await drain(
      new Orchestrator(provider, { executor: musicHost(counter) }).streamAgent(
        musicInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('is not a track in this project');
    expect(results[0]?.summary).not.toContain('already failed');
    expect(results[1]?.summary).toBe('Refused repeat of "add_music" — it already failed this run');
    // The remedy has to survive the wrapper, or a closed loop is worse than an open one.
    const seenByModel = modelFacingText(provider);
    expect(seenByModel).toContain('already failed this run for this same reason');
    // The remedy is now the LIST of tracks that would work, not the generic instruction
    // to find dialogue — this project has none, and naming `video_1` is the whole move.
    expect(seenByModel).toContain('Tracks with clips to duck under: video_1');
  });

  it('lets a DIFFERENT bad track id have its own answer', async () => {
    // The text key's whole justification. `voiceover` and `narration` are two different
    // guesses at the same missing thing, and the sentence that answers each one names it.
    // A rule-shaped cause would collapse them and quote back a sentence about a track the
    // model is no longer asking about.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([
      addMusic('m1', 'voiceover', 0),
      addMusic('m2', 'narration', 2),
      done,
    ]);
    const events = await drain(
      new Orchestrator(provider, { executor: musicHost(counter) }).streamAgent(
        musicInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('"voiceover"');
    expect(results[1]?.summary).toContain('"narration"');
    for (const result of results) expect(result.summary).not.toContain('already failed');
  });

  it('does not block a duck at a track that exists', async () => {
    // The corrected retry, which must never be caught by the banked key: `audio_1` is a
    // real track, so the placement succeeds and computes no key to match.
    const counter = { calls: 0 };
    const project = makeProject();
    const withDialogue = makeProject({
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((track) =>
          track.id === 'audio_1'
            ? {
                ...track,
                clips: [
                  {
                    id: 'dialogue_1',
                    assetId: 'asset_1',
                    trackId: 'audio_1',
                    start: 0,
                    end: 6,
                    sourceStart: 0,
                    sourceEnd: 6,
                    effects: [],
                    keyframes: [],
                  },
                ],
              }
            : track,
        ),
      },
    });
    const provider = new RecordingProvider([
      addMusic('m1', 'voiceover', 0),
      addMusic('m2', 'audio_1', 2),
      done,
    ]);
    const events = await drain(
      new Orchestrator(provider, { executor: musicHost(counter) }).streamAgent(
        { project: withDialogue, userPrompt: 'put music under it' },
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('is not a track in this project');
    expect(results[1]?.summary).not.toContain('already failed');
    expect(results[1]?.summary).toContain('Downloaded');
  });

  it('files the refusal in the run’s account of itself, not only in the tool result', async () => {
    // The other half of the fix: a bounded loop that forgets WHAT IT WAS TOLD TO DO leaves
    // the model knowing only that something is forbidden. `rejectedOpCount` is the ledger's
    // existing route in, and it is also what makes a run that landed nothing say why rather
    // than reading as a silent no-op.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addMusic('m1', 'voiceover', 0), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: musicHost(counter) }).streamAgent(
        musicInput,
        baseOpts(),
        {},
      ),
    );

    const said = warnings(events).join('\n');
    expect(said).toContain('No edits were applied');
    expect(said).toContain('is not a track in this project');
    // NOT the "reviewed the footage but never made a change" notice — the run did try.
    expect(said).not.toContain('never made a change');
  });
});

/**
 * The host-backed VALIDATOR PROBE, and the collision the hazard analysis turns on.
 *
 * The fixture's picture ends at 10s and `buildAddMusicOps` trims a bed to the picture it
 * scores, so a bed starting exactly `MIN_SCORED_SECONDS` (1/60s) before the end is trimmed
 * to 1/60s — which the project's 30fps grid rounds to nothing, and `assembleEdit` refuses
 * as `add_clip.end must be greater than start`. It is the one configuration that reaches
 * any of these five probes end to end, and it is enough, because the branch is one shared
 * helper.
 *
 * The sentence names the TIMES, not the asset, so two entirely different tracks produce it
 * byte-identically — the collision a host-backed probe can have and the generic mutate
 * path cannot. It loses nothing, and the tests below are why: a key is computed only once a
 * call has SETTLED and only a `failed` outcome ever has one, so the second asset is
 * downloaded and validated in full, and one that VALIDATES lands with no key to match.
 */
const ZERO_LENGTH_AT = 10 - 1 / 60;

const musicHostAt = (
  counter: { calls: number },
  positions: readonly number[],
): HostToolExecutor => ({
  run: async () => {
    const atSeconds = positions[Math.min(counter.calls, positions.length - 1)]!;
    counter.calls += 1;
    return {
      status: 'completed',
      summary: `Downloaded "music/track_${String(counter.calls)}.mp3".`,
      // A DIFFERENT track each call — different id, different length, different file.
      data: {
        asset: musicAsset(`music_track_${String(counter.calls)}`, 20 + counter.calls),
        atSeconds,
      },
    };
  },
});

describe('a host-backed validator rejection is remembered like any other', () => {
  it('answers the second identical rejection as a repeat', async () => {
    const counter = { calls: 0 };
    const provider = new RecordingProvider([
      addMusic('m1', undefined, 0),
      addMusic('m2', undefined, 2),
      done,
    ]);
    const events = await drain(
      new Orchestrator(provider, {
        executor: musicHostAt(counter, [ZERO_LENGTH_AT, ZERO_LENGTH_AT]),
      }).streamAgent(musicInput, baseOpts(), {}),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('must be greater than start');
    expect(results[0]?.summary).not.toContain('already failed');
    expect(results[1]?.summary).toBe('Refused repeat of "add_music" — it already failed this run');
    // Two DIFFERENT assets collided on one sentence, and the guard treated them as one
    // failure — which costs nothing, because the second had already failed on its own
    // merits and for the identical stated reason.
    expect(counter.calls).toBe(2);
  });

  it('never refuses an asset that VALIDATES, however the banked key was earned', async () => {
    // The hazard, answered. If a key could pre-empt a call this would strand the request
    // on the first collision; it cannot, because the key is read off a settled outcome and
    // a successful placement never produces one.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([
      addMusic('m1', undefined, 0),
      addMusic('m2', undefined, 2),
      done,
    ]);
    const events = await drain(
      new Orchestrator(provider, {
        executor: musicHostAt(counter, [ZERO_LENGTH_AT, 0]),
      }).streamAgent(musicInput, baseOpts(), {}),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('must be greater than start');
    expect(results[1]?.summary).not.toContain('already failed');
    expect(results[1]?.summary).toContain('Downloaded');
  });
});

// ---------------------------------------------------------------------------
// GOLDEN-A.9 — a run that lost its work to a validator probe says WHAT it lost.
//
// The probes returned `ops: []` and set no `rejectedOpCount`, so the operations they
// refused were carried nowhere: the turn reported zero, `lostOpsPerCall` saw nothing, no
// ledger row was written, and the run closed with "reviewed the footage but never made a
// change" — true of the timeline, false about the run. goal.md's release gate names that
// class of report outright, and `b7f1fd3` fixed exactly this shape for the refusal paths.
//
// The COUNT is the second half. A refusal loses one proposed change; a probe loses every
// operation the tool built — three for a bed (`add_asset`, `add_layer`, `add_clip`) — and
// the closing message prints that number, so `1` there would be its own small dishonesty.
// ---------------------------------------------------------------------------

/** What `buildAddMusicOps` lays down for an unducked bed: bin, layer, clip. */
const ADD_MUSIC_OP_COUNT = 3;

describe('a run whose work the validator probe refused reports what it lost', () => {
  it('says the real number and the validator’s reason, not "never made a change"', async () => {
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addMusic('m1', undefined, 0), done]);
    const events = await drain(
      new Orchestrator(provider, {
        executor: musicHostAt(counter, [ZERO_LENGTH_AT]),
      }).streamAgent(musicInput, baseOpts(), {}),
    );

    const said = warnings(events).join('\n');
    expect(said).toContain('No edits were applied');
    // THE COUNT, spelled out: the three operations the probe actually refused.
    expect(said).toContain(
      `${String(ADD_MUSIC_OP_COUNT)} proposed changes couldn't be applied to the timeline`,
    );
    // The validator's own sentence, in the run's account of itself — not only in a tool
    // result that ages out of the context window with the turn (run `369e8c82`).
    expect(said).toContain('must be greater than start');
    // The notice this run used to fall through to. The run tried; it must not say it did not.
    expect(said).not.toContain('never made a change');
  });

  it('files the refused operations as a FAILED ledger row the briefing shows', async () => {
    // The ledger half, end to end rather than at the seam: `rejectedOpCount` is what
    // `lostOpsPerCall` reads, and a lost-ops turn is recorded as `failed` with the
    // per-call note as its cause. Read back through the briefing the next turn is built
    // from, which is where the remedy has to survive to.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addMusic('m1', undefined, 0), done]);
    const events = await drain(
      new Orchestrator(provider, {
        executor: musicHostAt(counter, [ZERO_LENGTH_AT]),
      }).streamAgent(musicInput, baseOpts(), {}),
    );

    const refusal = toolResults(events)[0]!.summary;
    // The REAL sentence, not a hand-written stand-in — the test degrades honestly if the
    // run's first result ever stops being this rejection.
    expect(refusal).toContain('Rejected "add_music"');
    const step = onEffectResult(
      started(),
      turn({
        signature: 'add_music:{"remoteId":"ov_1","atSeconds":0}',
        rejectedOpCount: ADD_MUSIC_OP_COUNT,
        rejectionNotes: [refusal],
      }),
    );

    expect(step.state.working.operations).toHaveLength(1);
    expect(step.state.working.operations[0]?.status).toBe('failed');
    const briefing = buildStateBriefing(step.state.working);
    expect(briefing).toContain('FAILED — fix the cause, do not retry unchanged');
    expect(briefing).toContain('must be greater than start');
    expect(briefing).not.toContain('ALREADY APPLIED');
  });

  it('accounts for the loss in a run that also landed something', async () => {
    // The partial case, which is the one a creator cannot see for themselves: two beds
    // asked for, one on the timeline, one refused. Before the count the report was
    // indistinguishable from a run that did everything it was asked.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([
      addMusic('m1', undefined, 0),
      addMusic('m2', undefined, 2),
      done,
    ]);
    const events = await drain(
      new Orchestrator(provider, {
        executor: musicHostAt(counter, [0, ZERO_LENGTH_AT]),
      }).streamAgent(musicInput, baseOpts(), {}),
    );

    const said = warnings(events).join('\n');
    expect(said).toContain('Some of this edit did not land');
    expect(said).toContain(
      `${String(ADD_MUSIC_OP_COUNT)} proposed changes couldn't be applied to the timeline`,
    );
    expect(said).toContain('must be greater than start');
  });
});

// ---------------------------------------------------------------------------
// `track_subject_automatically`'s op-build throw — the same two fixes, one branch later.
//
// It is not a validator probe: the throw comes out of `automaticTrackingOpsFromMeasurement`,
// so no operation was ever built. It is deterministic all the same — `compileTrackingCommand`
// and `validateProfessionalOperationBatch` are pure verdicts over the working copy — and it
// was the last unkeyed, untraced one of the group.
// ---------------------------------------------------------------------------

/** A clip carrying a drawn rectangle mask: what the tracking compiler needs to exist. */
const maskedProject = (): Project =>
  parseProject({
    id: 'auto_tracking_project',
    name: 'Automatic tracking fixture',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset', path: 'shot.mp4', kind: 'video', durationSeconds: 900 }],
    timeline: {
      revision: 7,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'asset',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [
                {
                  id: 'shot__mask',
                  type: 'mask',
                  params: {
                    shape: 'rectangle',
                    bounds: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
                  },
                  keyframes: [],
                },
              ],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });

const trackSubject = (id: string): AiResponse => ({
  text: '',
  toolCalls: [
    {
      id,
      name: 'track_subject_automatically',
      arguments: { intent: 'track_subject_automatically', target: 'this', subject: 'region' },
    },
  ],
});

/**
 * A pack worker that measured the clip and came back with nothing usable — every sample
 * occluded and under the confidence floor. The measurement PARSES; the compiler is what
 * refuses it, which is the branch under test.
 */
const unusableTrackHost = (counter: { calls: number }): HostToolExecutor => ({
  run: async () => {
    counter.calls += 1;
    return {
      status: 'completed',
      summary: 'Measured the subject.',
      data: {
        objective: { intent: 'track_subject_automatically', target: 'this', subject: 'region' },
        plan: {
          clipId: 'shot',
          maskEffectId: 'shot__mask',
          capability: 'tracking.region',
          fps: 24,
          startSeconds: 0,
        },
        samples: [
          {
            frame: 0,
            box: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
            confidence: 0.05,
            occluded: true,
          },
        ],
        engine: 'framepilot.tracking-lite@1.0.0-dev.local',
        backend: 'opencv',
      },
    };
  },
});

const trackingInput = (): ContextInput => ({
  project: maskedProject(),
  userPrompt: 'track the subject',
});

describe('a refused automatic track is remembered, and the run says it was refused', () => {
  it('reports the refusal instead of reading as a run that never tried', async () => {
    const counter = { calls: 0 };
    const events = await drain(
      new Orchestrator(new RecordingProvider([trackSubject('t1'), done]), {
        executor: unusableTrackHost(counter),
      }).streamAgent(trackingInput(), baseOpts(), {}),
    );

    const said = warnings(events).join('\n');
    expect(said).toContain('No edits were applied');
    // ONE, and honestly so: the throw came out of the op builder, so nothing was built to
    // count — one refused call is one thing the run could not do.
    expect(said).toContain("1 proposed change couldn't be applied to the timeline");
    // The compiler's own verdict, where the next turn and the editor can both read it.
    expect(said).toContain('unusable_track');
    expect(said).not.toContain('never made a change');
  });

  it('answers the second identical refusal as a repeat, having still run the worker', async () => {
    const counter = { calls: 0 };
    const events = await drain(
      new Orchestrator(new RecordingProvider([trackSubject('t1'), trackSubject('t2'), done]), {
        executor: unusableTrackHost(counter),
      }).streamAgent(trackingInput(), baseOpts(), {}),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toContain('unusable_track');
    expect(results[1]?.summary).toBe(
      'Refused repeat of "track_subject_automatically" — it already failed this run',
    );
    // The key is read off a SETTLED outcome, so it never pre-empts the measurement — the
    // pack worker ran both times, and a re-measure that produced a usable track would have
    // landed with no key to match.
    expect(counter.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A declared HOST refusal leaves the same trace an in-process one does.
// ---------------------------------------------------------------------------

describe('a declared host refusal reaches the run’s durable account of itself', () => {
  it('says what it could not do, instead of reading as a silent no-op', async () => {
    // A run whose ONLY event is a refused host call. Before the trace it reported "this run
    // reviewed the footage but never made a change" — true of the timeline, false about the
    // run, and it left the editor with no idea a rule had refused anything.
    const counter = { calls: 0 };
    const provider = new RecordingProvider([addStock('s1', 2), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: declaringStockHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );

    const said = warnings(events).join('\n');
    expect(said).toContain('No edits were applied');
    // The REMEDY, in the run's own account of itself — not only in a tool result that ages
    // out of the context window with the turn that produced it (run `369e8c82`).
    expect(said).toContain('The first free moment is 10.0s');
    expect(said).not.toContain('never made a change');
  });

  it('records a FAILED operation carrying the refusal, and the briefing shows it', () => {
    // The conductor half, at the seam the orchestrator now feeds: `rejectedOpCount` is what
    // `lostOpsPerCall` reads, and a lost-ops turn is recorded as `failed` with the per-call
    // note as its cause. Without the count the turn reports zero operations and nothing is
    // recorded at all — the exact defect FIX 1 above closed for the validator path.
    const sentence = conflictSentence(2);
    const step = onEffectResult(
      started(),
      turn({
        signature: 'add_stock:{"remoteId":"9001","atSeconds":2}',
        rejectedOpCount: 1,
        rejectionNotes: [sentence],
        callFacts: [
          {
            key: 'add_stock:{"remoteId":"9001","atSeconds":2}',
            status: 'failed',
            fromCache: false,
            role: 'mutation',
            failureKey: 'add_stock:picture_over_picture',
          },
        ],
      }),
    );

    expect(step.state.working.operations).toHaveLength(1);
    expect(step.state.working.operations[0]?.status).toBe('failed');
    expect(step.state.working.operations[0]?.failureReason).toBe(sentence);
    const briefing = buildStateBriefing(step.state.working);
    expect(briefing).toContain('FAILED — fix the cause, do not retry unchanged');
    expect(briefing).toContain('The first free moment is 10.0s');
    expect(briefing).not.toContain('ALREADY APPLIED');
  });
});

// ---------------------------------------------------------------------------
// A tool with no implementation on this surface — run 137d8fd0
// ---------------------------------------------------------------------------

/**
 * `render_preview` and `export_video` have no sidecar route: the editor renders through
 * its own Export dialog, and the executor says exactly that — "Do not call it again".
 *
 * Nothing enforced it. Host failures are deliberately never keyed, so the refusal cost
 * the run nothing per attempt and repeated freely. Run `137d8fd0` called `render_preview`
 * three separate times and `export_video` once, on a run that ended at its budget ceiling.
 *
 * The channel is the one `stock-host.ts` already uses: the executor declares
 * `surface_unavailable`, which is a verdict about the surface rather than an event on it,
 * and the run refuses the second call.
 */
const renderPreview = (id: string): AiResponse => ({
  text: '',
  toolCalls: [{ id, name: 'render_preview', arguments: {} }],
});

const SURFACE_SENTENCE =
  '"render_preview" cannot be run from here — the editor renders and exports through its ' +
  'own Export dialog. Do not call it again: finish the edit, then tell the editor it is ' +
  'ready to export.';

const surfaceRefusingHost = (counter: { calls: number }): HostToolExecutor => ({
  run: async () => {
    counter.calls += 1;
    return { status: 'failed', summary: SURFACE_SENTENCE, refusalCause: 'surface_unavailable' };
  },
});

describe('a tool this surface cannot run is refused on the second call', () => {
  it('answers the repeat as a repeat, and keeps the remedy', async () => {
    const counter = { calls: 0 };
    const provider = new RecordingProvider([renderPreview('r1'), renderPreview('r2'), done]);
    const events = await drain(
      new Orchestrator(provider, { executor: surfaceRefusingHost(counter) }).streamAgent(
        stockInput,
        baseOpts(),
        {},
      ),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results[0]?.summary).toBe(SURFACE_SENTENCE);
    expect(results[1]?.summary).toBe(
      'Refused repeat of "render_preview" — it already failed this run',
    );
    // The instruction the refusal carries has to outlive the tool result.
    const seenByModel = modelFacingText(provider);
    expect(seenByModel).toContain('finish the edit, then tell the editor it is ready to export');
  });
});

// ---------------------------------------------------------------------------
// An edit that changed nothing — run 137d8fd0
// ---------------------------------------------------------------------------

/**
 * `adjust_audio` setting a clip to the gain it already has applies cleanly and answers
 * "Adjusted audio …". Run `137d8fd0` made 65 of those calls, seven of them re-setting one
 * clip to −18 dB, because nothing in the answer distinguished the fader moving from the
 * fader already being there.
 *
 * The operations are still applied — a re-derivation that comes out identical is the tool
 * doing its job — but the sentence the model reads now says the project already said
 * exactly this, and where to check before trying again.
 */
const setGain = (id: string, gainDb: number): AiResponse => ({
  text: '',
  toolCalls: [{ id, name: 'adjust_audio', arguments: { clipId: 'clip_a', gainDb } }],
});

describe('a tool call that moved nothing says so', () => {
  /** `clip_a` is already at −18 dB, so setting it to −18 dB is the run's no-op. */
  const alreadyQuiet: ContextInput = {
    project: makeProject({
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_a',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 0,
                end: 6,
                sourceStart: 0,
                sourceEnd: 6,
                effects: [
                  {
                    id: 'clip_a__gain',
                    type: 'audio_gain',
                    params: { gainDb: -18 },
                    keyframes: [],
                  },
                ],
                keyframes: [],
              },
            ],
          },
          { id: 'audio_1', type: 'audio', clips: [] },
        ],
      },
    } as unknown as Partial<ContextInput['project']>),
    userPrompt: 'bring the wind down',
  };

  it('says the fader did not move, and says it only when it did not', async () => {
    const provider = new RecordingProvider([setGain('g1', -18), setGain('g2', -12), done]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(alreadyQuiet, baseOpts(), {}),
    );

    const results = toolResults(events);
    expect(results).toHaveLength(2);
    // Setting −18 dB on a clip already at −18 dB.
    expect(results[0]?.summary).toContain('nothing moved');
    expect(results[0]?.summary).toContain('get_timeline');
    // −12 dB is a real move, and must not be labelled as one that was not.
    expect(results[1]?.summary).not.toContain('nothing moved');
    expect(modelFacingText(provider)).toContain('the project already said exactly this');
  });
});

// ---------------------------------------------------------------------------
// A repeat of an applied edit — run 137d8fd0
// ---------------------------------------------------------------------------

/**
 * **66 mutating calls in run `137d8fd0` were byte-identical repeats of an edit the run
 * had already applied** — the same −12 dB on the same clip fifteen times, the same
 * transition nine times, the same colour grade four times, `add_track "captions"` four
 * times. Nothing caught them: the turn loop compares PATCHES, and `seenFailureKeys` only
 * remembers refusals.
 *
 * The guard needs BOTH signals. "Changed nothing" alone is legitimate —
 * `caption_the_edit` re-deriving cues off an unchanged timeline is the tool working, and
 * two incident regressions pin that its operations still flow. "Byte-identical repeat"
 * alone is legitimate too — the same call after a cut is how captions are repaired.
 * Together they are neither, and withholding is provably safe because the apply has just
 * demonstrated the result is the same project.
 */
const gainOn = (id: string, clipId: string, gainDb: number): AiResponse => ({
  text: '',
  toolCalls: [{ id, name: 'adjust_audio', arguments: { clipId, gainDb } }],
});

describe('a mutating call the run has already applied', () => {
  it('is withheld when making it again moves nothing', async () => {
    // Turn 2 carries a read alongside the repeat, so the turn's own signature differs and
    // the no-progress guard does not end the run before the repeat is reached. The
    // guard under test is the CALL-level one, not the turn-level one.
    const provider = new RecordingProvider([
      gainOn('g1', 'clip_a', -12),
      {
        text: '',
        toolCalls: [
          { id: 'r1', name: 'get_timeline', arguments: {} },
          { id: 'g2', name: 'adjust_audio', arguments: { clipId: 'clip_a', gainDb: -12 } },
        ],
      },
      done,
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, baseOpts(), {}));
    const summaries = toolResults(events).map((r) => r.summary);
    expect(summaries.some((s) => s.includes('already done, and doing it again moved nothing'))).toBe(
      true,
    );
    expect(modelFacingText(provider)).toContain('the next part of the request');
  });

  it('sees through the order the arguments arrived in', async () => {
    // The captured run sent the same instruction both ways round — 15 times one way and
    // 10 the other — and a key that stringifies as-received cannot tell them apart.
    const provider = new RecordingProvider([
      { text: '', toolCalls: [{ id: 'a', name: 'adjust_audio', arguments: { clipId: 'clip_a', gainDb: -12 } }] },
      {
        text: '',
        toolCalls: [
          { id: 'r1', name: 'get_timeline', arguments: {} },
          { id: 'b', name: 'adjust_audio', arguments: { gainDb: -12, clipId: 'clip_a' } },
        ],
      },
      done,
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, baseOpts(), {}));
    const summaries = toolResults(events).map((r) => r.summary);
    expect(summaries.some((s) => s.includes('already done'))).toBe(true);
  });

  it('lets a repeat through when it actually changes something', async () => {
    const provider = new RecordingProvider([
      gainOn('g1', 'clip_a', -12),
      gainOn('g2', 'clip_a', -6),
      gainOn('g3', 'clip_a', -12),
      done,
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, baseOpts(), {}));
    // The third call repeats the first, but the second moved the value, so re-setting
    // −12 dB is a real change and must land.
    const results = toolResults(events);
    expect(results.map((r) => r.summary).filter((s) => s.includes('already done'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A check's card carries its verdict — run 137d8fd0
// ---------------------------------------------------------------------------

/**
 * Run `137d8fd0` shows fourteen rows reading "Checking caption sync" and "Checking
 * transitions". One of them found 287 of 287 retained words with no caption over them;
 * the rest passed. Nothing on any of the rows said which was which.
 *
 * Every other read's card is correctly just the action — "Reading the timeline" is the
 * whole story. A verification is not: the answer is the reason the run called it.
 */
describe('a verification read shows what it found', () => {
  const verify = (name: string): AiResponse => ({
    text: '',
    toolCalls: [{ id: `v-${name}`, name, arguments: {} }],
  });

  it('says how many cues are in sync when captions pass', async () => {
    const provider = new RecordingProvider([verify('verify_captions'), done]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, baseOpts(), {}));
    const summary = toolResults(events)[0]?.summary ?? '';
    expect(summary).toMatch(/in sync|problem/);
  });

  it('leaves an ordinary read as the action it performed', async () => {
    const provider = new RecordingProvider([
      { text: '', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      done,
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, baseOpts(), {}));
    const summary = toolResults(events)[0]?.summary ?? '';
    expect(summary).not.toMatch(/in sync|problem|all good/);
  });
});
