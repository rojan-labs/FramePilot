/**
 * The per-run analysis budget, END TO END through the seam that enforces it (plan B5.4).
 *
 * `analysis-caps.test.ts` covers the arithmetic. This file exists because the arithmetic
 * was ALL that existed: `preflightCharge` returned `null` unconditionally, `outcomeCharge`
 * had no production caller, and the budget threaded through `HostCallContext` →
 * `HostToolEffect` → `EffectRuntime` → `HostExecutionContext` was read by nothing. Every
 * unit test passed, `spend()` was permanently zero, and both ceilings were undocumentedly
 * inert while `tool-executor.ts` documented them as enforced.
 *
 * So these assertions are deliberately about the WIRING rather than the maths: a call that
 * exceeds a cap must not reach the executor, and a call that runs must move the spend.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { ToolCall } from '../../providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from '../../tool-executor.js';
import { chargeAnalysisBudget, createSidecarExecutor } from '../../sidecar-executor.js';
import { makeProject } from '../../__fixtures__/project.js';
import {
  chargedResource,
  createAnalysisBudget,
  describeAnalysisSpend,
  outcomeCharge,
  preflightCharge,
} from './analysis-caps.js';

const project: Project = makeProject();
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 'c1',
  name,
  arguments: args,
});

/** An executor that records what reached it and can burn a scripted amount of clock. */
function recordingExecutor(
  outcome: HostToolOutcome,
  clock?: { ms: number },
  burnMs = 0,
): HostToolExecutor & { seen: string[] } {
  return {
    seen: [],
    async run(received) {
      this.seen.push(received.name);
      if (clock) clock.ms += burnMs;
      return outcome;
    },
  };
}

const transcriptOf = (endSeconds: number): HostToolOutcome => ({
  status: 'completed',
  summary: 'Transcribed',
  data: { words: [{ start: 0, end: endSeconds }] },
});

describe('the analysis budget is charged by the host seam, not merely threaded through it', () => {
  it('records the minutes a transcription really produced', async () => {
    const budget = createAnalysisBudget({ maxTranscriptionMinutes: 60 });
    const executor = recordingExecutor(transcriptOf(180));

    await chargeAnalysisBudget(
      executor,
      call('transcribe'),
      { project, analysisBudget: budget },
      undefined,
      () => 0,
    );

    expect(budget.spend().transcriptionMinutes).toBe(3);
    expect(describeAnalysisSpend(budget.spend())).toBe('3 min transcribed');
  });

  it('refuses the call after the transcription cap is reached, before it can run', async () => {
    // The cap only bites on the call AFTER the one that crossed it — see
    // `preflightCharge`'s note on why an up-front estimate would be worse.
    const budget = createAnalysisBudget({ maxTranscriptionMinutes: 2 });
    const executor = recordingExecutor(transcriptOf(180));
    const ctx = { project, analysisBudget: budget };

    const first = await chargeAnalysisBudget(executor, call('transcribe'), ctx, undefined, () => 0);
    const second = await chargeAnalysisBudget(
      executor,
      call('transcribe'),
      ctx,
      undefined,
      () => 0,
    );

    expect(first.status).toBe('completed');
    expect(second.status).toBe('failed');
    expect(second.summary).toContain('analysis cap reached');
    expect(second.summary).toContain('min transcribed');
    // The whole point of a pre-check: the second call never reached the engine.
    expect(executor.seen).toEqual(['transcribe']);
  });

  it('charges ffmpeg-backed analysis the wall clock it actually spent', async () => {
    const clock = { ms: 1_000 };
    const budget = createAnalysisBudget({ maxFfmpegSeconds: 900 });
    const executor = recordingExecutor(
      { status: 'completed', summary: 'Found 2 scene cuts' },
      clock,
      4_500,
    );

    await chargeAnalysisBudget(
      executor,
      call('detect_scenes', { assetId: 'a1' }),
      { project, analysisBudget: budget },
      undefined,
      () => clock.ms,
    );

    expect(budget.spend().ffmpegSeconds).toBe(4.5);
  });

  it('charges a decode that failed, because the machine still ran it', async () => {
    // A failing loop that costs nothing is a loop the cap cannot stop.
    const clock = { ms: 0 };
    const budget = createAnalysisBudget({ maxFfmpegSeconds: 900 });
    const executor = recordingExecutor(
      { status: 'failed', summary: '"detect_beats" timed out after 120s' },
      clock,
      120_000,
    );

    await chargeAnalysisBudget(
      executor,
      call('detect_beats', { assetId: 'a1' }),
      { project, analysisBudget: budget },
      undefined,
      () => clock.ms,
    );

    expect(budget.spend().ffmpegSeconds).toBe(120);
  });

  it('stops a runaway frame-rendering loop once the ffmpeg ceiling is spent', async () => {
    // `get_frame` is exempt from the execution-stage withholding (`kernel/stage-policy.ts`),
    // and this is the ceiling that docstring now names as what bounds it.
    const clock = { ms: 0 };
    const budget = createAnalysisBudget({ maxFfmpegSeconds: 3 });
    const executor = recordingExecutor(
      { status: 'completed', summary: 'Rendered frame' },
      clock,
      2_000,
    );
    const ctx = { project, analysisBudget: budget };
    const frameAt = (t: number) => call('get_frame', { timeSeconds: t });

    await chargeAnalysisBudget(executor, frameAt(1), ctx, undefined, () => clock.ms);
    await chargeAnalysisBudget(executor, frameAt(2), ctx, undefined, () => clock.ms);
    const third = await chargeAnalysisBudget(executor, frameAt(3), ctx, undefined, () => clock.ms);

    expect(budget.spend().ffmpegSeconds).toBe(4);
    expect(third.status).toBe('failed');
    expect(executor.seen).toEqual(['get_frame', 'get_frame']);
  });

  it('leaves uncapped calls and budget-less callers alone', async () => {
    const clock = { ms: 0 };
    const budget = createAnalysisBudget();
    const executor = recordingExecutor(
      { status: 'completed', summary: 'Found 8 tracks' },
      clock,
      9_000,
    );

    // A catalogue search spends provider quota, not machine time: it is not this cap's
    // business, and charging its network latency to ffmpeg would be a fabricated number.
    await chargeAnalysisBudget(
      executor,
      call('search_music', { query: 'lo-fi' }),
      { project, analysisBudget: budget },
      undefined,
      () => clock.ms,
    );
    expect(budget.spend()).toEqual({ ffmpegSeconds: 0, transcriptionMinutes: 0 });
    expect(describeAnalysisSpend(budget.spend())).toBe('no analysis');

    // A caller that threads no budget (a one-off MCP call) still runs.
    const outcome = await chargeAnalysisBudget(
      executor,
      call('detect_scenes'),
      { project },
      undefined,
      () => clock.ms,
    );
    expect(outcome.status).toBe('completed');
  });

  it('enforces the cap through the shipped sidecar executor, not just the helper', async () => {
    // The regression that mattered was an executor that accepted the budget and ignored
    // it, so the assertion has to run through `createSidecarExecutor`'s public `run`.
    const clock = { ms: 0 };
    let requests = 0;
    const fetchFn = (async () => {
      requests += 1;
      clock.ms += 30_000;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          assetId: 'a1',
          results: [{ kind: 'silence', status: 'ok', cached: false, result: { ranges: [] } }],
        }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    const executor = createSidecarExecutor({
      baseUrl: 'http://127.0.0.1:8765',
      fetchFn,
      now: () => clock.ms,
    });
    const budget = createAnalysisBudget({ maxFfmpegSeconds: 20 });
    const ctx = { project, analysisBudget: budget };

    const first = await executor.run(call('analyze_silence', { assetId: 'a1' }), ctx);
    const second = await executor.run(call('analyze_silence', { assetId: 'a1' }), ctx);

    expect(first.status).toBe('completed');
    expect(budget.spend().ffmpegSeconds).toBe(30);
    expect(second.status).toBe('failed');
    expect(second.summary).toContain('analysis cap reached');
    expect(requests).toBe(1);
  });
});

describe('every capped tool is chargeable on both sides of its dispatch', () => {
  /**
   * The structural pin. A tool named as capped must have BOTH a pre-check and a way to be
   * charged afterwards; a charge function that can never fire is how this cap became a
   * comment. Keyed off `chargedResource` so adding a tool to either table is enough.
   */
  it.each([
    ['transcribe', 'transcriptionMinutes', transcriptOf(60).data, undefined],
    ['analyze_silence', 'ffmpegSeconds', { ranges: [] }, 1_000],
    ['remove_silences', 'ffmpegSeconds', { ranges: [] }, 1_000],
    ['detect_scenes', 'ffmpegSeconds', { cuts: [] }, 1_000],
    ['detect_beats', 'ffmpegSeconds', { beats: [] }, 1_000],
    ['get_frame', 'ffmpegSeconds', {}, 1_000],
    ['measure_color', 'ffmpegSeconds', {}, 1_000],
  ] as const)('%s pre-checks and records against %s', (name, resource, data, elapsedMs) => {
    expect(chargedResource(name)).toBe(resource);
    expect(preflightCharge({ name, arguments: {} })).toEqual({ resource, amount: 0 });
    const recorded = outcomeCharge(name, data, elapsedMs);
    expect(recorded?.resource).toBe(resource);
    expect(recorded?.amount).toBeGreaterThan(0);
  });

  it('charges nothing for a tool no cap names', () => {
    expect(chargedResource('search_stock')).toBeNull();
    expect(preflightCharge({ name: 'search_stock', arguments: {} })).toBeNull();
    expect(outcomeCharge('search_stock', { hits: [] }, 5_000)).toBeNull();
  });

  it('charges nothing when the host measured no elapsed time', () => {
    // Defends the arithmetic against a caller that forgets the clock: a missing or
    // nonsensical measurement must read as "unknown, charge nothing", never as zero
    // seconds of work reported as fact.
    expect(outcomeCharge('detect_scenes', { cuts: [] })).toBeNull();
    expect(outcomeCharge('detect_scenes', { cuts: [] }, 0)).toBeNull();
    expect(outcomeCharge('detect_scenes', { cuts: [] }, Number.NaN)).toBeNull();
  });
});
