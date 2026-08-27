import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from './assemble.js';
import { routeAutonomousToolCall } from './autonomous-tool-router.js';
import { partitionConcurrencyBatches } from './concurrency.js';
import { normalizeOperationTime } from './frame-time.js';
import { getTool } from './tool-registry.js';
import { QUESTION_ROUTE_PERMISSIONS, selectTools, toolMetadata } from './tool-scope.js';

const transition = (durationSeconds: number): AnyOperation => ({
  type: 'add_transition',
  trackId: 'video-1',
  fromClipId: 'clip-a',
  toClipId: 'clip-b',
  kind: 'cross-dissolve',
  durationSeconds,
});

const project = {
  fps: 30,
  assets: [
    { id: 'asset-a', path: '/a.mp4', kind: 'video', durationSeconds: 10 },
    { id: 'asset-b', path: '/b.mp4', kind: 'video', durationSeconds: 10 },
  ],
  folders: [],
  markers: [],
  transcript: [],
  timeline: {
    tracks: [
      {
        id: 'video-1',
        type: 'video',
        clips: [
          {
            id: 'clip-a',
            assetId: 'asset-a',
            trackId: 'video-1',
            start: 0,
            end: 5,
            sourceStart: 0,
            sourceEnd: 5,
            effects: [],
            keyframes: [],
          },
          {
            id: 'clip-b',
            assetId: 'asset-b',
            trackId: 'video-1',
            start: 5,
            end: 10,
            sourceStart: 0,
            sourceEnd: 5,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  },
} as Project;

const cloneProject = (): Project => structuredClone(project);

const expectRejected = (
  operation: AnyOperation,
  projectOverride = project,
  pattern?: RegExp,
): void => {
  const result = assembleEdit(projectOverride, [operation], 'contract test');
  expect(result.validation.valid).toBe(false);
  expect(result.diff).toBeUndefined();
  if (pattern)
    expect(result.validation.issues.map((issue) => issue.message).join('\n')).toMatch(pattern);
};

describe('AI timing contract hardening', () => {
  for (const bad of [-1, -0.001, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`never normalizes invalid transition duration ${String(bad)} into a legal frame`, () => {
      expect(() => normalizeOperationTime(transition(bad), 30)).toThrow(/positive finite number/);
    });

    it(`rejects raw transition duration ${String(bad)} before assembly normalization`, () => {
      const result = assembleEdit(project, [transition(bad)], 'bad transition');
      expect(result.validation.valid).toBe(false);
      expect(result.diff).toBeUndefined();
      expect(result.patch.operations[0]).toMatchObject({ durationSeconds: bad });
    });
  }

  it('still promotes a tiny positive duration to exactly one frame', () => {
    expect(normalizeOperationTime(transition(0.001), 30)).toMatchObject({
      durationSeconds: 1 / 30,
    });
  });

  it('rejects an inverted trim before operation replay', () => {
    expectRejected(
      { type: 'trim_clip', clipId: 'clip-a', start: 3, end: 2 },
      project,
      /greater than start/,
    );
  });
});

describe('canonical operation contract', () => {
  it('prevents AI edits on a locked track while preserving unlock as a valid operation', () => {
    const locked = cloneProject();
    locked.timeline.tracks[0] = { ...locked.timeline.tracks[0]!, locked: true };

    expectRejected(
      { type: 'trim_clip', clipId: 'clip-a', start: 0.5, end: 4 },
      locked,
      /locked track/,
    );

    const unlock = assembleEdit(
      locked,
      [{ type: 'set_track_flags', trackId: 'video-1', locked: false }],
      'unlock',
    );
    expect(unlock.validation.valid).toBe(true);
  });

  it('rejects effect intensity outside the persisted 0..1 schema', () => {
    const withEffect = cloneProject();
    withEffect.timeline.tracks.unshift({
      id: 'effect-1',
      type: 'effect',
      clips: [],
      effectLayers: [
        {
          id: 'layer-1',
          effectId: 'grain',
          kind: 'grain',
          start: 0,
          end: 5,
          params: {},
          keyframes: [],
        },
      ],
    });
    expectRejected(
      { type: 'set_effect_layer_params', layerId: 'layer-1', intensity: 2 },
      withEffect,
      /intensity.*0\.\.1/,
    );
    expectRejected(
      { type: 'set_effect_layer_params', layerId: 'layer-1', intensity: -0.1 },
      withEffect,
      /intensity.*0\.\.1/,
    );
  });

  it('rejects tracker rectangles outside normalized frame geometry', () => {
    expectRejected(
      {
        type: 'track_object',
        clipId: 'clip-a',
        target: 'object',
        region: { x: 0.8, y: 0.1, width: 0.4, height: 0.5 },
      },
      project,
      /inside the normalized frame/,
    );
    expectRejected(
      {
        type: 'track_object',
        clipId: 'clip-a',
        target: 'object',
        region: { x: 1.1, y: 0, width: 0.1, height: 0.1 },
      },
      project,
      /within 0\.\.1/,
    );
  });

  it('rejects non-finite keyframe values instead of persisting inert state', () => {
    expectRejected(
      {
        type: 'add_keyframes',
        clipId: 'clip-a',
        keyframes: [
          {
            id: 'bad-kf',
            time: 1,
            property: 'scale',
            value: Number.POSITIVE_INFINITY,
            easing: 'linear',
          },
        ],
      },
      project,
      /value must be finite/,
    );
  });

  it('rejects non-finite audio gain and negative fades', () => {
    expectRejected(
      { type: 'adjust_audio', clipId: 'clip-a', gainDb: Number.POSITIVE_INFINITY },
      project,
      /gainDb must be finite/,
    );
    expectRejected(
      { type: 'adjust_audio', clipId: 'clip-a', gainDb: -3, fadeInSeconds: -1 },
      project,
      /fadeInSeconds must be non-negative/,
    );
  });

  it('rejects negative layer positions rather than relying on downstream clamping', () => {
    expectRejected(
      { type: 'add_layer', layerId: 'bad-layer', layerType: 'overlay', atIndex: -1 },
      project,
      /non-negative integer/,
    );
  });
});

describe('truthful project review diffs', () => {
  it('reports marker-only project mutations instead of no changes', () => {
    const result = assembleEdit(
      project,
      [{ type: 'add_marker', id: 'marker-1', time: 1, label: 'Beat' }],
      'add marker',
    );
    expect(result.validation.valid).toBe(true);
    expect(result.diff?.summary).toContain('marker marker-1 added at 1s');
    expect(result.diff?.summary).not.toContain('no changes');
  });

  it('reports transcript-only project mutations instead of no changes', () => {
    const result = assembleEdit(
      project,
      [
        {
          type: 'set_transcript',
          words: [{ word: 'hello', start: 0, end: 0.5, assetId: 'asset-a' }],
        },
      ],
      'set transcript',
    );
    expect(result.validation.valid).toBe(true);
    expect(result.diff?.summary).toContain(
      'transcript updated (0 → 1 word(s) across 1 attributed asset(s))',
    );
    expect(result.diff?.summary).not.toContain('no changes');
  });
});

describe('autonomous public contract routing', () => {
  it('rejects a transcript asset scope that the underlying read cannot honor', () => {
    expect(() =>
      routeAutonomousToolCall({
        name: 'inspect_transcript',
        arguments: { assetId: 'asset-a' },
      }),
    ).toThrow(/assetId is not allowed/);
  });

  it('preserves advertised edit-candidate signals into the real registry route', () => {
    const route = routeAutonomousToolCall({
      name: 'plan_edit_candidates',
      arguments: { sceneCuts: [1, 2], verticalTarget: true },
    });
    expect(route.kind).toBe('registry');
    if (route.kind !== 'registry') return;
    expect(route.calls).toHaveLength(1);
    expect(route.calls[0]).toMatchObject({
      name: 'read_edit_signals',
      arguments: { sceneCuts: [1, 2], verticalTarget: true },
    });
  });

  it('requires recall_evidence to identify the evidence being recalled', () => {
    expect(() => routeAutonomousToolCall({ name: 'recall_evidence', arguments: {} })).toThrow(
      /evidenceId is required/,
    );
  });

  it('requires proposal operation entries to contain tool and arguments', () => {
    expect(() =>
      routeAutonomousToolCall({
        name: 'propose_timeline_patch',
        arguments: { reason: 'trim', operations: [{ tool: 'trim_clip' }] },
      }),
    ).toThrow(/arguments is required/);
  });

  it('rejects unsupported fields for a compact search mode instead of dropping them', () => {
    expect(() =>
      routeAutonomousToolCall({
        name: 'search_media',
        arguments: { mode: 'keyword', query: 'hello', assetIds: ['asset-a'] },
      }),
    ).toThrow(/does not support assetIds/);
  });
});

describe('host mutation permissions and scheduling', () => {
  it('requires write permission for transcribe and keeps it out of the question route', () => {
    const transcribeTool = getTool('transcribe');
    expect(transcribeTool).toBeDefined();
    if (!transcribeTool) return;
    expect(toolMetadata(transcribeTool).permissions).toEqual(['analysis', 'write']);
    expect(
      selectTools({ permissions: QUESTION_ROUTE_PERMISSIONS }).some(
        (tool) => tool.name === 'transcribe',
      ),
    ).toBe(false);
  });

  it('forces transcribe and index_media into serial singleton batches', () => {
    const calls = [
      { name: 'get_timeline' },
      { name: 'transcribe' },
      { name: 'get_frame' },
      { name: 'index_media' },
    ];
    const batches = partitionConcurrencyBatches(calls, () => true);
    expect(batches).toEqual([
      { concurrent: true, calls: [{ name: 'get_timeline' }] },
      { concurrent: false, calls: [{ name: 'transcribe' }] },
      { concurrent: true, calls: [{ name: 'get_frame' }] },
      { concurrent: false, calls: [{ name: 'index_media' }] },
    ]);
  });
});
