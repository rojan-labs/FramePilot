import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { captureEditorInteractionContext } from './interaction-context.js';
import { resolveEditorTarget } from './target-resolver.js';

const project = (): Project => ({
  id: 'project-1',
  name: 'Resolver fixture',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [
    { id: 'asset-a', name: 'A', path: 'media/a.mp4', kind: 'video', durationSeconds: 20 },
    { id: 'asset-b', name: 'B', path: 'media/b.mp4', kind: 'video', durationSeconds: 20 },
  ],
  folders: [],
  markers: [],
  transcript: [],
  aiMemory: {},
  history: [],
  timeline: {
    revision: 4,
    tracks: [
      {
        id: 'v1',
        name: 'V1',
        type: 'video',
        clips: [
          {
            id: 'a',
            assetId: 'asset-a',
            trackId: 'v1',
            start: 0,
            end: 5,
            sourceStart: 0,
            sourceEnd: 5,
            effects: [],
            keyframes: [],
          },
          {
            id: 'b',
            assetId: 'asset-b',
            trackId: 'v1',
            start: 5,
            end: 10,
            sourceStart: 2,
            sourceEnd: 7,
            effects: [],
            keyframes: [],
          },
        ],
      },
      {
        id: 'v2',
        name: 'V2',
        type: 'video',
        clips: [
          {
            id: 'overlay',
            assetId: 'asset-a',
            trackId: 'v2',
            start: 1,
            end: 4,
            sourceStart: 6,
            sourceEnd: 9,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  },
});

function linkedProject(): Project {
  const fixture = project();
  fixture.timeline.tracks.push({
    id: 'a1',
    name: 'A1',
    type: 'audio',
    clips: [
      {
        id: 'a-audio',
        assetId: 'asset-a',
        trackId: 'a1',
        start: 0,
        end: 5,
        sourceStart: 0,
        sourceEnd: 5,
        effects: [],
        keyframes: [],
      },
      {
        id: 'b-audio',
        assetId: 'asset-b',
        trackId: 'a1',
        start: 5,
        end: 10,
        sourceStart: 2,
        sourceEnd: 7,
        effects: [],
        keyframes: [],
      },
    ],
  });
  return fixture;
}

describe('resolveEditorTarget', () => {
  it('omits a stale source-monitor asset without weakening live clock validation', () => {
    const fixture = project();
    const stale = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 0,
      sourceMonitor: {
        assetId: 'asset-removed',
        rate: { numerator: 30, denominator: 1 },
        playhead: { seconds: 0, frame: 0 },
      },
    });
    expect(stale.sourceMonitor).toBeUndefined();

    expect(() =>
      captureEditorInteractionContext({
        project: fixture,
        projectRevision: 1,
        playheadSeconds: 0,
        sourceMonitor: {
          assetId: 'asset-a',
          rate: { numerator: 30, denominator: 1 },
          playhead: { seconds: 1, frame: 300 },
        },
      }),
    ).toThrow('sourceMonitor must reference live media and valid frame positions');
  });

  it('resolves “this” to the primary selected clip and “these” to the full selection', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 9,
      playheadSeconds: 2,
      selectedClipIds: ['a', 'overlay'],
      primaryClipId: 'overlay',
    });

    expect(
      resolveEditorTarget(fixture, context, { kind: 'clips', referent: 'this' }),
    ).toMatchObject({
      status: 'resolved',
      evidence: 'selection',
      target: { clipIds: ['overlay'] },
    });
    expect(
      resolveEditorTarget(fixture, context, { kind: 'clips', referent: 'these' }),
    ).toMatchObject({
      status: 'resolved',
      target: { clipIds: ['a', 'overlay'], trackIds: ['v1', 'v2'] },
    });
  });

  it('refuses to guess when multiple unselected clips are under the playhead', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 2,
    });

    expect(resolveEditorTarget(fixture, context, { kind: 'clips', referent: 'playhead' })).toEqual({
      status: 'ambiguous',
      reason: 'multiple_playhead_clips',
      candidateIds: ['a', 'overlay'],
    });
  });

  it('resolves the cut before the selected incoming clip', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 8,
      selectedClipIds: ['b'],
      primaryClipId: 'b',
    });

    expect(
      resolveEditorTarget(fixture, context, {
        kind: 'edit_point',
        anchor: 'selection',
        relation: 'before',
      }),
    ).toMatchObject({
      status: 'resolved',
      evidence: 'selected_edit_point',
      target: { boundary: { at: 5, fromClipId: 'a', toClipId: 'b' } },
    });
  });

  it('resolves one linked picture/sound edit by cut alignment and matching assets', () => {
    const fixture = linkedProject();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 5,
    });

    expect(
      resolveEditorTarget(fixture, context, {
        kind: 'linked_edit_point',
        anchor: 'playhead',
      }),
    ).toMatchObject({
      status: 'resolved',
      evidence: 'linked_edit_point',
      target: {
        kind: 'linked_edit_point',
        videoBoundary: { fromClipId: 'a', toClipId: 'b' },
        audioBoundary: { fromClipId: 'a-audio', toClipId: 'b-audio' },
      },
    });
  });

  it('rejects a coincident picture/sound cut when source linkage does not match', () => {
    const fixture = linkedProject();
    fixture.timeline.tracks[2]!.clips[1]!.assetId = 'asset-a';
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 5,
    });

    expect(
      resolveEditorTarget(fixture, context, {
        kind: 'linked_edit_point',
        anchor: 'playhead',
      }),
    ).toMatchObject({ status: 'unresolved', reason: 'no_linked_edit_point' });
  });

  it('reports ambiguity instead of choosing between multiple valid linked sound edits', () => {
    const fixture = linkedProject();
    const duplicateAudio = fixture.timeline.tracks[2]!;
    fixture.timeline.tracks.push({
      ...duplicateAudio,
      id: 'a2',
      clips: duplicateAudio.clips.map((clip) => ({
        ...clip,
        id: `${clip.id}-duplicate`,
        trackId: 'a2',
      })),
    });
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 5,
    });

    expect(
      resolveEditorTarget(fixture, context, {
        kind: 'linked_edit_point',
        anchor: 'playhead',
      }),
    ).toMatchObject({ status: 'ambiguous', reason: 'multiple_linked_edit_points' });
  });

  it('rejects stale structural context before target resolution', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 2,
      selectedClipIds: ['a'],
    });
    const changed = { ...fixture, timeline: { ...fixture.timeline, revision: 5 } };

    expect(
      resolveEditorTarget(changed, context, { kind: 'clips', referent: 'this' }),
    ).toMatchObject({
      status: 'unresolved',
      reason: 'stale_context',
    });
  });

  it('requires all explicit ids to exist', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 1,
      playheadSeconds: 0,
    });

    expect(
      resolveEditorTarget(fixture, context, {
        kind: 'clips',
        referent: 'explicit',
        clipIds: ['a', 'missing'],
      }),
    ).toMatchObject({ status: 'unresolved', reason: 'missing_explicit_target' });
  });

  it('resolves explicit and selected tracks without inventing a track role', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 3,
      playheadSeconds: 2,
      selectedClipIds: ['overlay'],
    });

    expect(
      resolveEditorTarget(fixture, context, { kind: 'tracks', referent: 'selected' }),
    ).toMatchObject({
      status: 'resolved',
      evidence: 'selected_track',
      target: { kind: 'tracks', trackIds: ['v2'] },
    });
    expect(
      resolveEditorTarget(fixture, context, {
        kind: 'tracks',
        referent: 'explicit',
        trackIds: ['v1', 'missing'],
      }),
    ).toMatchObject({ status: 'unresolved', reason: 'missing_explicit_track' });
  });

  it('resolves selected and visible ranges with the selected track scope', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 3,
      playheadSeconds: 2,
      selectedClipIds: ['a'],
      timeRange: { start: 1, end: 4 },
      visibleTimelineRange: { start: 0, end: 12 },
    });

    expect(
      resolveEditorTarget(fixture, context, { kind: 'range', referent: 'selection' }),
    ).toMatchObject({
      status: 'resolved',
      evidence: 'selection_range',
      target: { kind: 'range', range: { start: 1, end: 4 }, trackIds: ['v1'] },
    });
    expect(
      resolveEditorTarget(fixture, context, { kind: 'range', referent: 'visible' }),
    ).toMatchObject({ target: { range: { start: 0, end: 12 } } });
  });

  it('rechecks host project authority for mutating call sites', () => {
    const fixture = project();
    const context = captureEditorInteractionContext({
      project: fixture,
      projectRevision: 7,
      playheadSeconds: 2,
      selectedClipIds: ['a'],
    });

    expect(
      resolveEditorTarget(
        fixture,
        context,
        { kind: 'clips', referent: 'this' },
        { projectRevision: 8 },
      ),
    ).toMatchObject({ status: 'unresolved', reason: 'stale_context' });
  });
});
