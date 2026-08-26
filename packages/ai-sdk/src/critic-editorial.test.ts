/**
 * The editorial checks (context-management Phase 4).
 *
 * Read the Critic's original fourteen as an editor: every one answers "is the deliverable
 * well-formed?" — the right length, the right aspect, no missing media, no clipping,
 * nothing black. Not one answers "is this a good cut?". These six do, and this suite holds
 * them to the rules the phase set: every threshold stated in frames with a rationale,
 * every check computable from state the run already holds, and every check either naming
 * the tool that fixes it or saying plainly that it is diagnostic.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Clip, type Project } from '@framepilot/timeline-schema';
import { critique, type CheckId, type CriticCheck } from './critic.js';

const FPS = 30;
const frame = (n: number): number => n / FPS;

const clip = (
  id: string,
  start: number,
  end: number,
  over: Partial<Clip> = {},
): Record<string, unknown> => ({
  id,
  trackId: 'video_1',
  assetId: 'asset_1',
  start,
  end,
  sourceStart: start,
  sourceEnd: end,
  effects: [],
  keyframes: [],
  ...over,
});

function project(
  clips: readonly Record<string, unknown>[],
  over: Record<string, unknown> = {},
): Project {
  return parseProject({
    id: 'proj_e',
    name: 'Editorial',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 600 },
      { id: 'asset_2', path: 'media/b.mp4', kind: 'video', durationSeconds: 600 },
      { id: 'asset_music', path: 'media/m.mp3', kind: 'audio', durationSeconds: 600 },
    ],
    timeline: { tracks: [{ id: 'video_1', type: 'video', clips }], revision: 1 },
    transcript: [],
    aiMemory: {},
    history: [],
    ...over,
  });
}

const checkOf = (report: { checks: readonly CriticCheck[] }, id: CheckId): CriticCheck =>
  report.checks.find((c) => c.id === id)!;

describe('jump_cut — is that the same shot cut to itself?', () => {
  it('fires when a small removal leaves the framing unchanged across the cut', () => {
    // A silence removal of 20 frames: the speaker has not visibly moved, so the splice
    // reads as the picture stuttering.
    const found = checkOf(
      critique(
        project([
          clip('a', 0, 4),
          clip('b', 4, 8, { sourceStart: 4 + frame(20), sourceEnd: 8 + frame(20) }),
        ]),
      ),
      'jump_cut',
    );
    expect(found.status).toBe('warn');
    expect(found.detail).toContain('same shot to itself');
    // A check the agent cannot act on trains it to ignore the critic — so it names tools.
    expect(found.detail).toContain('add_stock');
    expect(found.detail).toContain('trim_clip');
  });

  it('does NOT fire on a plain split, where the footage runs on across the seam', () => {
    // Contiguous source is an invisible seam. Firing here would flag every split_clip.
    const found = checkOf(critique(project([clip('a', 0, 4), clip('b', 4, 8)])), 'jump_cut');
    expect(found.status).toBe('pass');
  });

  it('does NOT fire when the cut is between two different assets', () => {
    const found = checkOf(
      critique(
        project([
          clip('a', 0, 4),
          clip('b', 4, 8, { assetId: 'asset_2', sourceStart: 0, sourceEnd: 4 }),
        ]),
      ),
      'jump_cut',
    );
    expect(found.status).toBe('pass');
  });

  it('does NOT fire when enough source was removed for the shot to have changed', () => {
    const found = checkOf(
      critique(project([clip('a', 0, 4), clip('b', 4, 8, { sourceStart: 60, sourceEnd: 64 })])),
      'jump_cut',
    );
    expect(found.status).toBe('pass');
  });

  it('is honestly skipped when there are no cuts at all', () => {
    expect(checkOf(critique(project([clip('a', 0, 8)])), 'jump_cut').status).toBe('skipped');
  });
});

describe('word_severed — did I cut through a word?', () => {
  const words = [
    { word: 'the', start: 0, end: 0.5 },
    { word: 'hand', start: 0.6, end: 1.4 },
    { word: 'lands', start: 1.5, end: 2.2 },
  ];

  it('fails a cut that lands strictly inside a word', () => {
    // 1.0s is frame 30, in the middle of "hand" (frames 18–42).
    const found = checkOf(
      checkProject([clip('a', 0, 1), clip('b', 1, 3, { sourceStart: 1, sourceEnd: 3 })], words),
      'word_severed',
    );
    expect(found.status).toBe('fail');
    expect(found.detail).toContain('"hand"');
    expect(found.detail).toContain('get_mapped_transcript');
  });

  it('passes a cut on a word boundary — before the word is not through it', () => {
    // 1.5s is frame 45, exactly where "lands" begins.
    const found = checkOf(
      checkProject(
        [clip('a', 0, 1.5), clip('b', 1.5, 3, { sourceStart: 1.5, sourceEnd: 3 })],
        words,
      ),
      'word_severed',
    );
    expect(found.status).toBe('pass');
  });

  it('finds a severed word near the END of the transcript, not only the middle', () => {
    // The bound the binary search has to get right: every word starts before this cut, so
    // the lower bound is past the end of the list and the walk has to start behind it.
    const many = Array.from({ length: 200 }, (_, i) => ({
      word: `w${i}`,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    }));
    const cut = 99.2; // inside w198 (99.0–99.4)
    const found = checkOf(
      checkProject(
        [clip('a', 0, cut), clip('b', cut, 120, { sourceStart: cut, sourceEnd: 120 })],
        many,
      ),
      'word_severed',
    );
    expect(found.status).toBe('fail');
    expect(found.detail).toContain('"w198"');
  });

  it('finds a long word a short one sits inside', () => {
    // Overlapping words are rare but not impossible (a re-transcribed span, two speakers).
    // Stopping the walk at the first word that does not cover the cut would miss the long
    // one, so the walk is bounded by the longest word instead.
    const overlapping = [
      { word: 'looooong', start: 0, end: 4 },
      { word: 'short', start: 0.2, end: 0.5 },
    ];
    const found = checkOf(
      checkProject([clip('a', 0, 2), clip('b', 2, 6, { sourceStart: 2, sourceEnd: 6 })], overlapping),
      'word_severed',
    );
    expect(found.status).toBe('fail');
    expect(found.detail).toContain('"looooong"');
  });

  it('is honestly skipped with no transcript rather than passing', () => {
    const found = checkOf(critique(project([clip('a', 0, 1), clip('b', 1, 3)])), 'word_severed');
    expect(found.status).toBe('skipped');
    expect(found.detail).toContain('no transcript');
  });

  function checkProject(
    clips: readonly Record<string, unknown>[],
    transcript: readonly { word: string; start: number; end: number }[],
  ): { checks: readonly CriticCheck[] } {
    return critique(project(clips, { transcript }));
  }
});

describe('dead_air — is there nothing at the head or the tail?', () => {
  const words = [{ word: 'hello', start: 4, end: 4.5 }];

  it('warns about a long silent head, in frames, and names the tool', () => {
    const found = checkOf(critique(project([clip('a', 0, 6)], { transcript: words })), 'dead_air');
    expect(found.status).toBe('warn');
    expect(found.detail).toContain('120 frames');
    expect(found.detail).toContain('ripple_delete');
  });

  it('passes when speech starts and ends close to the sequence', () => {
    const found = checkOf(
      critique(project([clip('a', 0, 1)], { transcript: [{ word: 'hi', start: 0.1, end: 0.9 }] })),
      'dead_air',
    );
    expect(found.status).toBe('pass');
  });

  it('cites the evidence handle when the run measured silence itself (P4.3)', () => {
    const found = checkOf(
      critique(project([clip('a', 0, 6)], { transcript: words }), {
        silences: { ranges: [{ start: 0, end: 4 }], handle: 'ev_7' },
      }),
      'dead_air',
    );
    // A finding that cites ev_7 is one the editor can go and read; a bare number is one
    // they have to take on trust.
    expect(found.detail).toContain('ev_7');
  });

  it('is skipped, not passed, when there is no dialogue to measure against', () => {
    expect(checkOf(critique(project([clip('a', 0, 6)])), 'dead_air').status).toBe('skipped');
  });
});

describe('transition_fit — is the ramp longer than the cut can carry?', () => {
  const withTransition = (durationSeconds: number): Project =>
    project([
      clip('a', 0, 2),
      clip('b', 2, 4, {
        sourceStart: 2,
        sourceEnd: 4,
        effects: [
          {
            id: 'fx_1',
            type: 'transition',
            params: { kind: 'fade', durationSeconds },
            keyframes: [],
          },
        ],
      }),
    ]);

  it('fails a ramp longer than half the shorter shot, because the engine shortens it silently', () => {
    const found = checkOf(critique(withTransition(1.6)), 'transition_fit');
    expect(found.status).toBe('fail');
    expect(found.detail).toContain('maxTransitionFrames');
    expect(found.detail).toContain('add_transition');
  });

  it('passes a ramp that fits', () => {
    expect(checkOf(critique(withTransition(0.5)), 'transition_fit').status).toBe('pass');
  });

  it('is skipped when there are no transitions', () => {
    expect(checkOf(critique(project([clip('a', 0, 4)])), 'transition_fit').status).toBe('skipped');
  });
});

describe('audio_slam and shot_rhythm — the diagnostic pair', () => {
  const sixShots = Array.from({ length: 6 }, (_, i) =>
    clip(`s${i}`, i * 2, i * 2 + 2, {
      assetId: 'asset_2',
      sourceStart: i * 30,
      sourceEnd: i * 30 + 2,
    }),
  );

  it('shot_rhythm says plainly that it is diagnostic, not repairable', () => {
    const found = checkOf(critique(project(sixShots)), 'shot_rhythm');
    expect(found.status).toBe('warn');
    expect(found.detail).toContain('DIAGNOSTIC ONLY');
    // Pretending it were fixable would produce random re-trimming that satisfies a
    // variance metric and looks worse.
    expect(found.detail).toContain('do not re-trim');
  });

  it('shot_rhythm passes when the shots actually vary', () => {
    const varied = [
      clip('s0', 0, 1),
      clip('s1', 1, 5),
      clip('s2', 5, 6.5),
      clip('s3', 6.5, 13),
      clip('s4', 13, 14),
      clip('s5', 14, 22),
    ];
    expect(checkOf(critique(project(varied)), 'shot_rhythm').status).toBe('pass');
  });

  it('audio_slam is skipped with no separate audio layer, rather than passing', () => {
    const found = checkOf(critique(project(sixShots)), 'audio_slam');
    expect(found.status).toBe('skipped');
    expect(found.detail).toContain('No separate audio layer');
  });

  it('audio_slam warns when picture and sound cut on the same frame everywhere', () => {
    const audioClips = sixShots.map((c, i) => ({
      ...c,
      id: `a${i}`,
      trackId: 'audio_1',
      assetId: 'asset_music',
    }));
    const p = parseProject({
      ...(project(sixShots) as unknown as Record<string, unknown>),
      timeline: {
        tracks: [
          { id: 'video_1', type: 'video', clips: sixShots },
          { id: 'audio_1', type: 'audio', clips: audioClips },
        ],
        revision: 1,
      },
    });
    const found = checkOf(critique(p), 'audio_slam');
    expect(found.status).toBe('warn');
    expect(found.detail).toContain('no J or L cut anywhere');
    // Honestly gated: its repair tool is not reachable from a repair pass, and it says so
    // rather than sending the agent at a call that must refuse.
    expect(found.detail).toContain('Diagnostic only here');
  });

  it('audio_slam passes when something actually leads or trails', () => {
    const audioClips = sixShots.map((c, i) => ({
      ...c,
      id: `a${i}`,
      trackId: 'audio_1',
      assetId: 'asset_music',
      start: (c.start as number) + frame(6),
      end: (c.end as number) + frame(6),
    }));
    const p = parseProject({
      ...(project(sixShots) as unknown as Record<string, unknown>),
      timeline: {
        tracks: [
          { id: 'video_1', type: 'video', clips: sixShots },
          { id: 'audio_1', type: 'audio', clips: audioClips },
        ],
        revision: 1,
      },
    });
    expect(checkOf(critique(p), 'audio_slam').status).toBe('pass');
  });
});

describe('every editorial check is honest about what it cannot do', () => {
  it('never crashes a review on a clip that is missing its effects array', () => {
    // The Critic is what runs when an edit has already gone wrong, which is exactly when a
    // partially-formed clip is most likely and least excusable to crash on. `effects` is
    // required by the schema and absent from plenty of hand-built fixtures; iterating it
    // unguarded turned a whole agent run's report into "clip.effects is not iterable".
    const valid = project([clip('a', 0, 2), clip('b', 2, 4)]);
    const missingEffects = {
      ...valid,
      timeline: {
        ...valid.timeline,
        tracks: valid.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map(({ effects: _dropped, ...rest }) => rest),
        })),
      },
    } as unknown as Project;
    expect(() => critique(missingEffects)).not.toThrow();
  });

  it('reports frames, not seconds, in every editorial threshold it states', () => {
    const report = critique(
      project([clip('a', 0, 6)], { transcript: [{ word: 'hi', start: 4, end: 4.5 }] }),
    );
    expect(checkOf(report, 'dead_air').detail).toMatch(/\d+ frames/);
  });
});
