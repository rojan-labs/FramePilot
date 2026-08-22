/**
 * The beat grid is WIRED — the gap ADR 0126 left open.
 *
 * `kernel/beat-grid/beat-alignment.ts` is a complete, tested editorial guarantee that had
 * **zero callers** after the 9.5 Phase-1 convergence retired the planned-edit route. The
 * agent could call `detect_beats` and then place picture cuts wherever it liked; nothing
 * checked those boundaries against the onsets it had just been given.
 *
 * `beat-alignment.test.ts` covers the RULE. This file covers the WIRING, which is the part
 * that was missing: that a real agent run reaches it, that the gate is the agent's own
 * decision to gather beat evidence, and that a run which never asked about the music is
 * completely unaffected.
 */
import { describe, expect, it } from 'vitest';
import type { AiEvent } from './events.js';
import type { ContextInput } from './context-builder.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { HostToolExecutor } from './tool-executor.js';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import { makeProject } from './__fixtures__/project.js';

/** Onsets every 0.5s — a clean 120bpm grid in SOURCE time on the music asset. */
const ONSETS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

const BEATS_PAYLOAD = {
  assetId: 'asset_music',
  bpm: 120,
  beats: ONSETS.map((time) => ({ time, strength: 1 })),
};

/**
 * A project whose music asset is already on an audio track at 1:1 with the timeline, so the
 * source-time onsets above ARE the timeline grid. This is the normal montage case: the bed
 * was placed on an earlier turn.
 */
function montageProject() {
  const base = makeProject();
  return {
    ...base,
    assets: [
      ...base.assets,
      {
        id: 'asset_music',
        name: 'track.mp3',
        path: '/media/track.mp3',
        kind: 'audio' as const,
        durationSec: 10,
      },
    ],
    timeline: {
      ...base.timeline,
      tracks: [
        ...base.timeline.tracks,
        { id: 'video_2', name: 'Montage', type: 'video' as const, clips: [] },
        {
          id: 'audio_1',
          name: 'Music',
          type: 'audio' as const,
          clips: [
            {
              id: 'music_clip',
              assetId: 'asset_music',
              start: 0,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
            },
          ],
        },
      ],
    },
  };
}

const opts: StreamOptions = { conversationId: 'conv_beat', turnId: 'turn_beat', now: () => 1000 };

/** Runs `detect_beats` for real (returning the payload above); everything else is a no-op. */
const beatExecutor: HostToolExecutor = {
  async run(call) {
    if (call.name === 'detect_beats') {
      return { status: 'completed', summary: 'found the beat', data: BEATS_PAYLOAD };
    }
    return { status: 'completed', summary: 'ok' };
  },
};

/** Turn 1 optionally detects beats; turn 2 places the picture cuts; turn 3 finishes. */
class MontageProvider implements AiProvider {
  private index = 0;
  public readonly name = 'mock' as const;
  public constructor(
    private readonly cuts: readonly { start: number; end: number }[],
    private readonly detectBeats: boolean,
  ) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    if (this.index === 1 && this.detectBeats) {
      return {
        text: '',
        toolCalls: [{ id: 'b1', name: 'detect_beats', arguments: { assetId: 'asset_music' } }],
      };
    }
    if (this.index <= 2) {
      return {
        text: '',
        toolCalls: this.cuts.map((cut, i) => ({
          id: `c${String(i)}`,
          name: 'add_clip',
          arguments: {
            trackId: 'video_2',
            assetId: 'asset_1',
            start: cut.start,
            end: cut.end,
            sourceStart: cut.start,
          },
        })),
      };
    }
    return { text: 'Done.', toolCalls: [] };
  }
}

async function runMontage(
  cuts: readonly { start: number; end: number }[],
  detectBeats: boolean,
): Promise<{ events: AiEvent[]; notes: string[] }> {
  const orchestrator = new Orchestrator(new MontageProvider(cuts, detectBeats), {
    executor: beatExecutor,
  });
  const input: ContextInput = {
    project: montageProject(),
    userPrompt: 'cut this to the music',
  };
  const events: AiEvent[] = [];
  for await (const event of orchestrator.streamAgent(input, opts)) events.push(event);
  // Every string the run surfaced anywhere — the rejection reaches the editor through the
  // completion report's "Skipped" line, not through a `note` field.
  const notes = events.flatMap((event) => {
    const record = event as unknown as Record<string, unknown>;
    return ['note', 'text', 'message', 'summary', 'detail'].flatMap((key) =>
      typeof record[key] === 'string' ? [record[key]] : [],
    );
  });
  return { events, notes };
}

/** One frame at the fixture's 30fps — the timeline quantizes every operation to this. */
const FRAME = 1 / 30;

/** How far `time` sits from the nearest onset. */
const offGridBy = (time: number): number =>
  Math.min(...ONSETS.map((onset) => Math.abs(onset - time)));

/** Every clip start/end the run actually applied, from its emitted patches. */
function appliedBoundaries(events: readonly AiEvent[]): number[] {
  const times: number[] = [];
  for (const event of events) {
    if (event.type !== 'diff') continue;
    const operations = event.edit.patch.operations as readonly Record<string, unknown>[];
    for (const operation of operations) {
      if (operation['type'] !== 'add_clip') continue;
      if (typeof operation['start'] === 'number') times.push(operation['start']);
      if (typeof operation['end'] === 'number') times.push(operation['end']);
    }
  }
  return times;
}

describe('beat-grid enforcement in a real agent run', () => {
  it('snaps near-miss picture cuts onto the detected onsets', async () => {
    // Interior boundaries two frames (~67ms) off real onsets: outside the half-frame
    // on-grid tolerance but inside the 80ms snap window, so the runtime fixes them rather
    // than spending a repair turn arguing about it. Times are whole frames so the
    // timeline's own quantization cannot be mistaken for the snap.
    const nearMissA = 1 + 2 * FRAME;
    const nearMissB = 2 - 2 * FRAME;
    expect(offGridBy(nearMissA)).toBeGreaterThan(0.5 * FRAME);
    expect(offGridBy(nearMissB)).toBeGreaterThan(0.5 * FRAME);

    const { events } = await runMontage(
      [
        { start: 0, end: nearMissA },
        { start: nearMissA, end: nearMissB },
        { start: nearMissB, end: 3 },
      ],
      true,
    );
    const boundaries = appliedBoundaries(events);
    expect(boundaries.length).toBeGreaterThan(0);
    // Every boundary the grid governs now sits on a real onset, within a half frame.
    for (const time of boundaries) {
      expect(offGridBy(time)).toBeLessThanOrEqual(0.5 * FRAME);
    }
  });

  it('rejects cuts too far off the grid, naming the nearest real onset', async () => {
    // Squarely between two onsets — far outside the 80ms snap window.
    const wayOff = 1 + 8 * FRAME;
    expect(offGridBy(wayOff)).toBeGreaterThan(0.08);
    const { events, notes } = await runMontage(
      [
        { start: 0, end: wayOff },
        { start: wayOff, end: 2 },
      ],
      true,
    );
    const rejection = notes.find((note) => note.includes('beat grid'));
    expect(rejection).toBeDefined();
    expect(rejection).toContain('nearest detected onset');
    // And it really is a REJECTION: the off-grid cut never reached the timeline.
    const boundaries = appliedBoundaries(events);
    expect(boundaries.some((time) => offGridBy(time) > 0.08)).toBe(false);
  });

  it('does nothing at all when the run never gathered beat evidence', async () => {
    // THE point of the design: there is no beat-sync mode. The same off-grid cuts that were
    // rejected above apply untouched when the agent never called detect_beats.
    const wayOff = 1 + 8 * FRAME;
    const { events, notes } = await runMontage(
      [
        { start: 0, end: wayOff },
        { start: wayOff, end: 2 },
      ],
      false,
    );
    expect(notes.some((note) => note.includes('beat grid'))).toBe(false);
    const boundaries = appliedBoundaries(events);
    expect(boundaries.length).toBeGreaterThan(0);
    // The off-grid cut survived untouched: no grid was consulted, because none was asked for.
    expect(boundaries.some((time) => offGridBy(time) > 0.08)).toBe(true);
  });
});
