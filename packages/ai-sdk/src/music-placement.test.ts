/**
 * Music placement — the shape of "a bed on the timeline", and the honesty of the
 * two tools that produce one.
 *
 * The load-bearing test here is the LAST one: an agent-placed bed and a
 * hand-placed bed must produce deep-equal timelines. If they ever diverge, the
 * agent path is quietly building something the manual path does not — an
 * unduckable track, or one with no credit — and nothing else in the suite would
 * notice.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch } from '@framepilot/editor-core';
import { assembleEdit } from './assemble.js';
import type { Project } from '@framepilot/timeline-schema';
import { MusicAssetPayloadSchema, buildAddMusicOps, nextMusicLayerId } from './music-placement.js';

const source = {
  provider: 'openverse',
  remoteId: 'ov-1',
  license: 'by',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attributionRequired: true,
  attribution: '"Calm Bed" by Ada is licensed under CC BY 4.0.',
  creator: 'Ada',
  fetchedAt: '2026-08-23T12:00:00.000Z',
};

const asset = {
  id: 'music_openverse_ov_1',
  path: 'media/p1/calm_bed.mp3',
  kind: 'audio' as const,
  durationSeconds: 92,
  source,
};

function project(): Project {
  return {
    id: 'p1',
    name: 'P',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'cam', path: 'media/cam.mp4', kind: 'video' }],
    folders: [],
    timeline: {
      tracks: [
        {
          id: 'dialogue_1',
          type: 'audio',
          role: 'dialogue',
          clips: [
            {
              id: 'vo',
              assetId: 'cam',
              trackId: 'dialogue_1',
              start: 0,
              end: 60,
              sourceStart: 0,
              sourceEnd: 60,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    markers: [],
    angleGroups: [],
    aiMemory: {},
    history: [],
  } as unknown as Project;
}

describe('MusicAssetPayloadSchema', () => {
  it('accepts what the host actually returns', () => {
    expect(MusicAssetPayloadSchema.safeParse({ asset, atSeconds: 3 }).success).toBe(true);
  });

  it('rejects a payload with no provenance — the credit is not optional', () => {
    // A track placed without its `source` is a silent licence violation waiting
    // to happen, so the tool must fail rather than place it uncredited.
    const { source: _dropped, ...noSource } = asset;
    expect(MusicAssetPayloadSchema.safeParse({ asset: noSource }).success).toBe(false);
  });

  it('rejects a payload whose asset is not audio', () => {
    expect(MusicAssetPayloadSchema.safeParse({ asset: { ...asset, kind: 'video' } }).success).toBe(
      false,
    );
  });

  it('rejects a source that omits whether a credit is owed', () => {
    const { attributionRequired: _omitted, ...partial } = source;
    expect(
      MusicAssetPayloadSchema.safeParse({ asset: { ...asset, source: partial } }).success,
    ).toBe(false);
  });

  it('rejects an empty or absent payload rather than defaulting one', () => {
    for (const bad of [undefined, null, {}, { asset: null }]) {
      expect(MusicAssetPayloadSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('nextMusicLayerId', () => {
  it('avoids a layer id the project already uses', () => {
    const withMusic = project();
    (withMusic.timeline.tracks as unknown as Array<{ id: string }>).push({ id: 'music_1' });
    expect(nextMusicLayerId(withMusic)).toBe('music_2');
  });
});

describe('buildAddMusicOps', () => {
  it('produces bin, music layer, and clip — in that order, as one list', () => {
    const ops = buildAddMusicOps(project(), asset, 0);
    expect(ops.map((op) => op.type)).toEqual(['add_asset', 'add_layer', 'add_clip']);
  });

  it('labels the layer music so ducking can find the bed', () => {
    expect(buildAddMusicOps(project(), asset, 0)[1]).toMatchObject({ role: 'music' });
  });

  it('spans the clip the track length from the requested start', () => {
    expect(buildAddMusicOps(project(), asset, 5)[2]).toMatchObject({ start: 5, end: 97 });
  });

  it('clamps a negative start rather than emitting an invalid clip', () => {
    expect(buildAddMusicOps(project(), asset, -10)[2]).toMatchObject({ start: 0 });
  });

  it('falls back to a default length when the provider reported no duration', () => {
    const { durationSeconds: _none, ...noDuration } = asset;
    expect((buildAddMusicOps(project(), noDuration, 0)[2] as { end: number }).end).toBe(30);
  });

  it('validates and applies against a real project', () => {
    const base = project();
    const probe = assembleEdit(base, buildAddMusicOps(base, asset, 0), 'Add music', 'agent');
    expect(probe.validation.valid).toBe(true);
  });

  it('carries the credit into the bin — this is what the Credits view reads', () => {
    const added = buildAddMusicOps(project(), asset, 0)[0] as {
      asset: { source?: { attribution?: string } };
    };
    expect(added.asset.source?.attribution).toContain('Ada');
  });
});

describe('the agent path and the manual path agree', () => {
  it('produces a deep-equal timeline either way', () => {
    // The manual path is `addMusicTrackPatch` in the renderer. Both call the same
    // decision, so the only way they can diverge is if someone reimplements one
    // of them — which is exactly what this test is here to catch.
    const base = project();
    const agentOps = buildAddMusicOps(base, asset, 0);

    // The manual patch, spelled out independently rather than imported, so a
    // change to the shared builder cannot make both sides wrong in the same way.
    const manualOps = [
      { type: 'add_asset', asset },
      { type: 'add_layer', layerId: 'music_1', layerType: 'audio', atIndex: 0, role: 'music' },
      {
        type: 'add_clip',
        trackId: 'music_1',
        assetId: asset.id,
        start: 0,
        end: 92,
        sourceStart: 0,
        sourceEnd: 92,
      },
    ];

    const agentResult = applyProjectPatch(base, {
      patchId: 'agent',
      createdBy: 'agent',
      reason: 'agent',
      operations: agentOps,
    });
    const manualResult = applyProjectPatch(base, {
      patchId: 'manual',
      createdBy: 'user',
      reason: 'manual',
      operations: manualOps as typeof agentOps,
    });

    expect(agentResult.timeline).toEqual(manualResult.timeline);
    expect(agentResult.assets).toEqual(manualResult.assets);
  });
});
