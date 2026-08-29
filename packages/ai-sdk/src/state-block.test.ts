import { describe, expect, it } from 'vitest';

import { estimateTokens } from './context-builder.js';
import {
  aspectLabel,
  renderProjectState,
  renderStateBlock,
  renderTimelineState,
  STATE_PROJECT_KEYS,
  STATE_TIMELINE_KEYS,
  timelineDurationSeconds,
} from './state-block.js';
import type { EditorInteractionContext } from './editor-context/interaction-context.js';
import { makeProject } from './__fixtures__/project.js';

function bigProject(tracks: number, clipsPerTrack: number) {
  return makeProject({
    id: 'mission-montage',
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    timeline: {
      tracks: Array.from({ length: tracks }, (_, t) => ({
        id: `track_${String(t + 1)}`,
        type: t === 0 ? ('video' as const) : ('audio' as const),
        clips: Array.from({ length: clipsPerTrack }, (_, c) => ({
          id: `clip_${String(t)}_${String(c)}`,
          assetId: 'asset_001',
          trackId: `track_${String(t + 1)}`,
          start: c * 2,
          end: c * 2 + 2,
          sourceStart: 0,
          sourceEnd: 2,
          effects: [],
          keyframes: [],
        })),
      })),
    },
  });
}

describe('state block (P1.3)', () => {
  it('names common aspects and falls back to the exact ratio', () => {
    expect(aspectLabel(1080, 1920)).toBe('9:16');
    expect(aspectLabel(1920, 1080)).toBe('16:9');
    expect(aspectLabel(1080, 1080)).toBe('1:1');
    expect(aspectLabel(1080, 1350)).toBe('4:5');
    expect(aspectLabel(0, 10)).toBe('?');
  });

  it('renders project facts in the pinned key order', () => {
    const line = renderProjectState(bigProject(2, 3));
    expect(line).toBe(
      'project  { id: mission-montage, aspect: 9:16, fps: 30, duration: 6s, resolution: 1080x1920, ' +
        'tracks: [{ id: track_1, kind: video, clips: 3 }, { id: track_2, kind: audio, clips: 3 }] }',
    );
    // Key order is the cache prefix; a reorder is a regression even when the values match.
    const order = STATE_PROJECT_KEYS.map((key) => line.indexOf(`${key}:`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(timelineDurationSeconds(bigProject(1, 0).timeline)).toBe(0);
  });

  it('renders selection, playhead and revision — dashes when unknown', () => {
    expect(renderTimelineState({ project: bigProject(1, 1) })).toBe(
      'timeline { selection: none, playhead: –, revision: – }',
    );
    const interaction = {
      sequenceId: 'mission-montage',
      projectRevision: 12,
      timelineRevision: 4,
      playhead: { frame: 96, seconds: 3.2 },
      selection: { clipIds: [], trackIds: [], timeRange: { start: 1, end: 2.5 } },
    } as unknown as EditorInteractionContext;
    const line = renderTimelineState({ project: bigProject(1, 1), interaction });
    expect(line).toBe('timeline { selection: 1s–2.5s, playhead: 3.2s, revision: 12 }');
    const order = STATE_TIMELINE_KEYS.map((key) => line.indexOf(`${key}:`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // An explicit selection and host revision win over the interaction snapshot.
    expect(
      renderTimelineState({
        project: bigProject(1, 1),
        interaction,
        projectRevision: 13,
        selection: { start: 0, end: 1 },
      }),
    ).toBe('timeline { selection: 0s–1s, playhead: 3.2s, revision: 13 }');
  });

  it('stays under the 400-token budget on a montage-sized project and is deterministic', () => {
    const project = bigProject(8, 40);
    const a = renderStateBlock({ project, selection: { start: 4, end: 9 } });
    const b = renderStateBlock({ project, selection: { start: 4, end: 9 } });
    expect(a).toBe(b);
    expect(a.startsWith('STATE\nproject  {')).toBe(true);
    expect(estimateTokens(a)).toBeLessThanOrEqual(400);
  });
});
