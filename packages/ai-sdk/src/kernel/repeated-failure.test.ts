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
 * `editor-core` occupancy predicate `assertNoPictureStacking` uses for `add_clip`.
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
