/**
 * Run-level wiring guard for VU7 (ADR 0175 §4,
 * `plan/visual-understanding/06-VERIFICATION-AND-EVAL.md`).
 *
 * `picture-verification.test.ts` proves the module's own logic and `briefing-picture.test.ts`
 * proves the diff. This file proves the thing neither could: that a real `streamAgent` run
 * actually REACHES them, that what they produce arrives in front of the model, and — the
 * property the whole design rests on — that none of it can turn a good apply into a bad one.
 *
 * The run is the same one four times over: a two-clip timeline with a gap, a first turn that
 * extends the outgoing clip until the two touch (which manufactures exactly one new cut, with
 * an exposure jump across it), and a second turn that says it is done. What changes between
 * the cases is only what the host wired — a ledger and an evidence route, no ledger at all,
 * an evidence route that throws — and what changes in the result is only facts.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import type { AiEvent } from '../events.js';
import type { ContextInput } from '../context-builder.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
} from '../providers/types.js';
import type { LedgerSnapshot, MeasuredFacts, ShotRecord } from '../ledger.js';
import type { TemporalEvidenceAcquirer } from '../temporal-evidence-client.js';
import type { TemporalEvidenceBatch } from '../temporal-review.js';
import { TEMPORAL_EVIDENCE_VERSION } from '../temporal-review.js';

// --- the timeline -----------------------------------------------------------

/**
 * Two picture clips of two different assets with a five-second gap between them, so the
 * slice starts with NO cuts at all: every cut this run is judged on is one it made.
 */
function makeGappedProject(): Project {
  return parseProject({
    id: 'proj_picture',
    name: 'Picture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset_dark', path: 'media/dark.mp4', kind: 'video', durationSeconds: 30 },
      { id: 'asset_bright', path: 'media/bright.mp4', kind: 'video', durationSeconds: 30 },
    ],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_dark',
              trackId: 'video_1',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [],
              keyframes: [],
            },
            {
              id: 'clip_b',
              assetId: 'asset_bright',
              trackId: 'video_1',
              start: 10,
              end: 15,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [],
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
}

const measured = (lumaMean: number): MeasuredFacts => ({
  tier0Version: 1,
  luma: { mean: lumaMean, std: 0.1, p10: lumaMean / 2, p90: Math.min(1, lumaMean + 0.1) },
  chroma: { uMean: 128, vMean: 128, satMean: 0.3 },
  warmth: 0,
  contrastIdx: 0.6,
  motion: { si: 40, ti: 8, class: 'static' },
  cutScore: 0.3,
  black: false,
  freeze: false,
  sharpness: 0.8,
  phash: '0000000000000000',
});

const shot = (assetId: string, lumaMean: number): ShotRecord => ({
  assetId,
  contentHash: `hash_${assetId}`,
  shotIndex: 0,
  t0: 0,
  t1: 30,
  keyframeT: 15,
  splitOf: false,
  measured: measured(lumaMean),
});

/** 0.15 against 0.85 is far past `PICTURE_FLAG_THRESHOLDS.exposureJump`. */
const LEDGER: LedgerSnapshot = {
  shots: [shot('asset_dark', 0.15), shot('asset_bright', 0.85)],
  digests: [],
  coverage: { measured: 2, labelled: 0, described: 0, total: 2 },
};

// --- the run ----------------------------------------------------------------

/** Extending `clip_a` to 10s makes it touch `clip_b`: one new cut, one exposure jump. */
const CLOSE_THE_GAP = {
  id: 'call_1',
  name: 'trim_clip',
  arguments: { clipId: 'clip_a', end: 10 },
};

/** A provider that records every request it is handed, so the prompts can be read back. */
class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public readonly requests: AiCompletionRequest[] = [];
  private index = 0;

  public constructor(
    private readonly turns: readonly { text: string; calls?: AiResponse['toolCalls'] }[],
  ) {}

  private next(): { text: string; calls?: AiResponse['toolCalls'] } {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)]!;
    this.index += 1;
    return turn;
  }

  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const turn = this.next();
    return { text: turn.text, toolCalls: turn.calls ?? [] };
  }

  public async *stream(request: AiCompletionRequest): AsyncGenerator<ProviderChunk> {
    this.requests.push(request);
    const turn = this.next();
    yield { type: 'text-delta', text: turn.text };
    for (const call of turn.calls ?? []) yield { type: 'tool-call', call };
    yield { type: 'done', text: turn.text };
  }
}

const options: StreamOptions = {
  conversationId: 'conv_picture',
  turnId: 'turn_picture',
  now: () => 1000,
};

/** A comparison result far outside `SHOT_MATCH_MAX_DIFFERENCE` — the flag is real. */
const confirmingAcquirer: TemporalEvidenceAcquirer = (_project, requests) =>
  Promise.resolve({
    renderSettings: {
      identity: 'review:640x360@30:captions=false',
      presetId: 'review',
      width: 640,
      height: 360,
      fps: 30,
      burnCaptions: false,
    },
    results: requests.map((request) => ({
      schemaVersion: TEMPORAL_EVIDENCE_VERSION,
      requestId: request.requestId,
      projectRevision: request.projectRevision,
      renderSettings: {
        identity: 'review:640x360@30:captions=false',
        presetId: 'review',
        width: 640,
        height: 360,
        fps: 30,
        burnCaptions: false,
      },
      kind: 'comparison' as const,
      leftFrame: 299,
      rightFrame: 300,
      difference: 0.7,
    })),
  } as TemporalEvidenceBatch);

interface RunOutcome {
  readonly events: readonly AiEvent[];
  readonly prompts: readonly string[];
}

async function run(args: {
  readonly ledger?: LedgerSnapshot;
  readonly temporalEvidence?: TemporalEvidenceAcquirer;
}): Promise<RunOutcome> {
  const provider = new ScriptedProvider([
    { text: 'Closing the gap.', calls: [CLOSE_THE_GAP] },
    { text: 'Done.' },
  ]);
  const orchestrator = new Orchestrator(provider);
  const input: ContextInput = {
    project: makeGappedProject(),
    userPrompt: 'close the gap between the two shots',
    ...(args.ledger === undefined ? {} : { ledger: args.ledger }),
  };
  const events: AiEvent[] = [];
  for await (const event of orchestrator.streamEditorRun(
    input,
    options,
    { route: 'agent' },
    {
      ...(args.temporalEvidence === undefined ? {} : { temporalEvidence: args.temporalEvidence }),
    },
  )) {
    events.push(event);
  }
  const prompts = provider.requests.map((request) =>
    request.messages.map((message) => message.content).join('\n'),
  );
  return { events, prompts };
}

/** Did the timeline actually receive the edit? The only question verification may not touch. */
function appliedOps(events: readonly AiEvent[]): number {
  let total = 0;
  for (const event of events) {
    const record = event as unknown as Record<string, unknown>;
    if (record['type'] !== 'diff') continue;
    const edit = record['edit'] as { patch?: { operations?: unknown[] } } | undefined;
    total += edit?.patch?.operations?.length ?? 0;
  }
  return total;
}

/** Everything the model was told, minus the volatile per-turn wrapper. */
const promptsAfterFirstTurn = (outcome: RunOutcome): string => outcome.prompts.slice(1).join('\n');

const VERIFICATION_FACT = 'the exposure jump at 0:10.0 is really there on screen';

describe('picture verification — wired into a real agent run', () => {
  it('records a verification fact for the cut the apply made, and shows it to the next turn', async () => {
    const outcome = await run({ ledger: LEDGER, temporalEvidence: confirmingAcquirer });

    expect(appliedOps(outcome.events)).toBeGreaterThan(0);
    const later = promptsAfterFirstTurn(outcome);
    expect(later).toContain(VERIFICATION_FACT);
    // It is a FACT, with its evidence handle beside it — not a finding, not a warning.
    expect(later).toContain('Verified —');
    expect(later).toContain('picture:');
    // …and it arrived through the FACT channel. `streamEditorRun`'s own review queue is
    // still running beside this on the same evidence route, and it is a different thing
    // with a different job: it publishes `review_finding` events and steers the next turn.
    // No verification text may appear there, or a run that verified its own good edit
    // would be told to repair it.
    const findings = outcome.events
      .filter((event) => event.type === 'review_finding')
      .map((event) => JSON.stringify(event))
      .join('\n');
    expect(findings).not.toContain('is really there on screen');
  });

  it('records nothing without a ledger, and the run is otherwise unchanged', async () => {
    const withLedger = await run({ ledger: LEDGER, temporalEvidence: confirmingAcquirer });
    const without = await run({ temporalEvidence: confirmingAcquirer });

    expect(promptsAfterFirstTurn(without)).not.toContain(VERIFICATION_FACT);
    expect(promptsAfterFirstTurn(without)).not.toContain('Verified —');
    expect(appliedOps(without.events)).toBe(appliedOps(withLedger.events));
    // Byte-identical where it counts: the same events, in the same order, with the same
    // ids. A run with no shot ledger must not be able to tell that VU7 exists.
    expect(without.events.map((event) => `${event.type}:${event.id}`)).toEqual(
      withLedger.events.map((event) => `${event.type}:${event.id}`),
    );
  });

  it('leaves the apply standing when the evidence route throws', async () => {
    const outcome = await run({
      ledger: LEDGER,
      temporalEvidence: () => {
        throw new Error('sidecar is not running');
      },
    });

    expect(appliedOps(outcome.events)).toBeGreaterThan(0);
    expect(outcome.events.some((event) => event.type === 'error')).toBe(false);
    // Honest degradation: the fact says it could not be checked, and says so in words the
    // model can act on. There is no path from "could not look" to "looked and it is fine".
    const later = promptsAfterFirstTurn(outcome);
    expect(later).toContain('the exposure jump at 0:10.0 could not be checked');
    expect(later).not.toContain(VERIFICATION_FACT);
  });

  it('says so honestly when the host wired no evidence route at all', async () => {
    const outcome = await run({ ledger: LEDGER });

    expect(appliedOps(outcome.events)).toBeGreaterThan(0);
    expect(promptsAfterFirstTurn(outcome)).toContain('this host has no render evidence route');
  });
});
