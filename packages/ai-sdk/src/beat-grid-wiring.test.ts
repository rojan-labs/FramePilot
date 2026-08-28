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
    /** Also read the timeline in the cut turn, so its note carries a read payload. */
    private readonly readFirst = false,
    /** Declare that every interior cut is meant to sit exactly on an onset. */
    private readonly hardSync = false,
  ) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    if (this.index === 1 && this.detectBeats) {
      return {
        text: '',
        toolCalls: [
          {
            id: 'b1',
            name: 'detect_beats',
            arguments: {
              assetId: 'asset_music',
              ...(this.hardSync ? { hardSync: true } : {}),
            },
          },
        ],
      };
    }
    if (this.index <= 2) {
      return {
        text: '',
        toolCalls: [
          ...(this.readFirst
            ? [{ id: 'read1', name: 'get_timeline', arguments: {} as Record<string, unknown> }]
            : []),
          ...this.cuts.map((cut, i) => ({
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
        ],
      };
    }
    return { text: 'Done.', toolCalls: [] };
  }
}

async function runMontage(
  cuts: readonly { start: number; end: number }[],
  detectBeats: boolean,
  readFirst = false,
  hardSync = false,
): Promise<{ events: AiEvent[]; notes: string[] }> {
  const orchestrator = new Orchestrator(
    new MontageProvider(cuts, detectBeats, readFirst, hardSync),
    { executor: beatExecutor },
  );
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

  it('rejects cuts too far off the grid when the run DECLARED hard sync', async () => {
    // Squarely between two onsets — far outside the 80ms snap window.
    const wayOff = 1 + 8 * FRAME;
    expect(offGridBy(wayOff)).toBeGreaterThan(0.08);
    const { events, notes } = await runMontage(
      [
        { start: 0, end: wayOff },
        { start: wayOff, end: 2 },
      ],
      true,
      false,
      true,
    );
    const rejection = notes.find((note) => note.includes('beat grid'));
    expect(rejection).toBeDefined();
    expect(rejection).toContain('nearest detected onset');
    // And it really is a REJECTION: the off-grid cut never reached the timeline.
    const boundaries = appliedBoundaries(events);
    expect(boundaries.some((time) => offGridBy(time) > 0.08)).toBe(false);
  });

  it("shows the editor the rejection reason, not the turn's read output", async () => {
    // The captured run's completion report read: "**Skipped:** 8 proposed changes did not
    // validate (Recalling what it found → {"assets":[…]}; Reframed clip …; rejected by the
    // beat grid: …)". The reason was in there, after a media-bin dump, and read tools were
    // counted as failed changes.
    const wayOff = 1 + 8 * FRAME;
    const { events } = await runMontage(
      [
        { start: 0, end: wayOff },
        { start: wayOff, end: 2 },
      ],
      true,
      true,
      true,
    );
    const texts = events.flatMap((event) =>
      typeof (event as { text?: unknown }).text === 'string'
        ? [(event as { text: string }).text]
        : [],
    );
    // The editor-facing account of what could not be applied — the "Skipped" line on a run
    // that landed something, the empty-run message on one that landed nothing.
    const reported = texts.find((text) => text.includes("couldn't be applied"));
    expect(reported).toBeDefined();
    expect(reported).toContain('rejected by the beat grid');
    // The read that shared the turn contributed nothing to it.
    expect(reported).not.toContain('get_timeline');
    expect(reported).not.toContain('sequence duration');
  });

  it('applies an off-grid cut and REPORTS the miss when hard sync was not declared', async () => {
    // The captured run: a brief asking for cuts on visual motion peaks — "so the edit is
    // ready to beat-sync once music is dropped in" — had four cuts rejected for 124ms and
    // 215ms misses, and the rhythm it delivered was the grid's rather than the one the brief
    // described. Quantising every cut is a style, not a correctness property.
    const wayOff = 1 + 8 * FRAME;
    const { events, notes } = await runMontage(
      [
        { start: 0, end: wayOff },
        { start: wayOff, end: 2 },
      ],
      true,
    );
    // The cut LANDED, off-grid and all.
    const boundaries = appliedBoundaries(events);
    expect(boundaries.some((time) => Math.abs(time - wayOff) < 1e-6)).toBe(true);
    // And the measurement reached the run's own account of itself.
    const measured = notes.find((note) => note.includes('do not sit on a detected onset'));
    expect(measured).toBeDefined();
    expect(measured).toContain('nearest detected onset');
    expect(measured).toContain('hardSync');
    // Not a rejection: nothing tells the editor a change failed to validate.
    expect(notes.some((note) => note.includes('rejected by the beat grid'))).toBe(false);
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

/**
 * Run `ea8e46ec`, replayed end to end.
 *
 * The brief said "evaluate multiple suitable tracks and select the strongest one". The run
 * did exactly that: three `detect_beats` calls in ONE turn, then it placed the track it
 * chose and cut sixty-one photos to it. `detect_beats` is a `pure_read`, so the three calls
 * went through `mapBounded` and all three wrote the single `beatEvidence.current` slot; the
 * survivor described a track the editor had not chosen. Every montage proposal after that
 * was rejected for not placing an asset nobody wanted, the model's own attempt to fix it
 * (re-analyse the placed track) was refused by the stage policy, and the run died after
 * thirty-five minutes with no picture on the timeline.
 */
describe('a run that auditions several tracks before choosing one', () => {
  /** Three candidate tracks with deliberately DIFFERENT grids, so the wrong one is visible. */
  const CANDIDATES = {
    asset_music_a: [0.17, 0.62, 1.07, 1.52, 1.97, 2.42, 2.87],
    asset_music_b: [0.29, 0.81, 1.33, 1.85, 2.37, 2.89],
    asset_music_c: ONSETS,
  } as const;

  /** The three tracks are in the bin; none is on the timeline yet. */
  function auditionProject() {
    const base = makeProject();
    return {
      ...base,
      assets: [
        ...base.assets,
        ...Object.keys(CANDIDATES).map((id) => ({
          id,
          name: `${id}.mp3`,
          path: `/media/${id}.mp3`,
          kind: 'audio' as const,
          durationSec: 10,
        })),
      ],
      timeline: {
        ...base.timeline,
        tracks: [
          ...base.timeline.tracks,
          { id: 'video_2', name: 'Montage', type: 'video' as const, clips: [] },
          { id: 'audio_1', name: 'Music', type: 'audio' as const, clips: [] },
        ],
      },
    };
  }

  const auditionExecutor: HostToolExecutor = {
    async run(call) {
      if (call.name === 'detect_beats') {
        const assetId = String((call.arguments as { assetId?: unknown }).assetId);
        const beats = CANDIDATES[assetId as keyof typeof CANDIDATES];
        return {
          status: 'completed',
          summary: `found ${String(beats.length)} beats`,
          data: { assetId, bpm: 120, beats: beats.map((time) => ({ time, strength: 1 })) },
        };
      }
      return { status: 'completed', summary: 'ok' };
    },
  };

  /**
   * Turn 1 analyses all three tracks at once. Turn 2 places the chosen bed (unless the
   * scenario is the "music never placed" one). Turn 3 cuts the picture to the chosen grid.
   */
  class AuditionProvider implements AiProvider {
    private index = 0;
    public readonly name = 'mock' as const;
    public constructor(
      private readonly placeBed: boolean,
      private readonly hardSync = false,
    ) {}
    public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
      this.index += 1;
      if (this.index === 1) {
        return {
          text: 'Auditioning three tracks.',
          toolCalls: Object.keys(CANDIDATES).map((assetId, i) => ({
            id: `b${String(i)}`,
            name: 'detect_beats',
            arguments: { assetId, ...(this.hardSync ? { hardSync: true } : {}) },
          })),
        };
      }
      if (this.index === 2 && this.placeBed) {
        return {
          text: 'Track C has the strongest drive — placing it.',
          toolCalls: [
            {
              id: 'bed',
              name: 'add_clip',
              arguments: {
                trackId: 'audio_1',
                assetId: 'asset_music_c',
                start: 0,
                end: 4,
                sourceStart: 0,
              },
            },
          ],
        };
      }
      if (this.index <= 3) {
        return {
          text: 'Cutting the montage to its onsets.',
          toolCalls: [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
            { start: 2, end: 3 },
          ].map((cut, i) => ({
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

  async function runAudition(
    placeBed: boolean,
    hardSync = false,
  ): Promise<{ events: AiEvent[]; notes: string[] }> {
    const orchestrator = new Orchestrator(new AuditionProvider(placeBed, hardSync), {
      executor: auditionExecutor,
    });
    const events: AiEvent[] = [];
    for await (const event of orchestrator.streamAgent(
      { project: auditionProject(), userPrompt: 'make me a beat-synced montage' },
      opts,
    )) {
      events.push(event);
    }
    const notes = events.flatMap((event) => {
      const record = event as unknown as Record<string, unknown>;
      return ['note', 'text', 'message', 'summary', 'detail'].flatMap((key) =>
        typeof record[key] === 'string' ? [record[key]] : [],
      );
    });
    return { events, notes };
  }

  it('cuts to the track it PLACED, not to whichever analysis settled last', async () => {
    const { events, notes } = await runAudition(true);

    // The montage landed. This is the assertion the incident fails: six proposals, zero
    // clips, thirty-five minutes.
    const boundaries = appliedBoundaries(events);
    expect(boundaries.length).toBeGreaterThan(0);
    expect(notes.some((note) => note.includes('beat grid'))).toBe(false);
    expect(notes.some((note) => note.includes('not on the timeline'))).toBe(false);

    // And it is held to the grid of the track that is actually under the picture: every
    // boundary sits on one of C's onsets, none of which belongs to A or B.
    for (const time of boundaries) {
      expect(offGridBy(time)).toBeLessThanOrEqual(0.5 * FRAME);
    }
    // Nothing was reported off-grid, because the run really was cut to the right music.
    expect(notes.some((note) => note.includes('do not sit on a detected onset'))).toBe(false);
  });

  it('reports — never vetoes — a montage cut before any analysed track is placed', async () => {
    const { events, notes } = await runAudition(false);
    // The cuts land: the run never promised hard sync, and the only remedy for a veto here
    // would be `detect_beats`, which every execution stage withholds.
    expect(appliedBoundaries(events).length).toBeGreaterThan(0);
    const measured = notes.find((note) => note.includes('not checked against any onset'));
    expect(measured).toBeDefined();
    // All three analysed tracks are named, so the model knows exactly what it must place.
    for (const assetId of Object.keys(CANDIDATES)) expect(measured).toContain(assetId);
  });

  it('DOES refuse an ungrounded montage when the run declared hard sync', async () => {
    const { events, notes } = await runAudition(false, true);
    const rejection = notes.find((note) => note.includes('beat grid'));
    expect(rejection).toBeDefined();
    expect(rejection).toContain('hard sync');
    // A real refusal: no picture reached the timeline.
    expect(appliedBoundaries(events)).toHaveLength(0);
  });

  /**
   * A tool card settles when its own call returns, which is before the turn gate runs. Run
   * `ea8e46ec` therefore showed the editor sixty-one green "Added clip Video 1 · 0s–0.5s"
   * rows — past tense — for clips that never reached the timeline, six times over. A run
   * that reports work it did not do is worse than one that reports nothing.
   */
  it('settles the cards that proposed a rejected turn as failed, not as checkmarks', async () => {
    const { events } = await runAudition(false, true);
    // `reduceEvents` upserts by id, so the LAST status for each card is what the editor
    // sees. Every card that proposed the refused montage must end red.
    const finalStatus = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'tool_call') finalStatus.set(event.id, event.status);
    }
    const cutCards = [...finalStatus.entries()].filter(([id]) => id.startsWith('c'));
    expect(cutCards.length).toBeGreaterThan(0);
    for (const [id, status] of cutCards) {
      expect(status, `card ${id} claims success for a clip that never landed`).toBe('failed');
    }
  });

  it('leaves the cards of a turn that APPLIED alone', async () => {
    const { events } = await runAudition(true);
    const finalStatus = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'tool_call') finalStatus.set(event.id, event.status);
    }
    expect([...finalStatus.values()].every((status) => status === 'completed')).toBe(true);
  });
});
