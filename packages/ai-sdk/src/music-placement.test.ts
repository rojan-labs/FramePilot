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
import { applyProjectPatch, invertProjectPatch } from '@framepilot/editor-core';
import { assembleEdit } from './assemble.js';
import type { Project } from '@framepilot/timeline-schema';
import {
  MusicAssetPayloadSchema,
  buildAddMusicOps,
  pictureEndSeconds,
  localMusicAssetRefusal,
  musicDuckSidechainIssue,
  nextMusicLayerId,
} from './music-placement.js';

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

  it('accepts the placement preferences the tool declares', () => {
    // `atSeconds` and `duckUnderTrackId` are advertised on the schema; a payload
    // carrying them must parse, or the model's instruction dies at the boundary.
    expect(
      MusicAssetPayloadSchema.safeParse({
        asset,
        atSeconds: 4,
        duckUnderTrackId: 'dialogue_1',
      }).success,
    ).toBe(true);
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
    expect(nextMusicLayerId(withMusic.timeline)).toBe('music_2');
  });
});

describe('buildAddMusicOps', () => {
  it('produces bin, music layer, and clip — in that order, as one list', () => {
    const ops = buildAddMusicOps(project().timeline, asset, 0);
    expect(ops.map((op) => op.type)).toEqual(['add_asset', 'add_layer', 'add_clip']);
  });

  it('gives the clip a deterministic id, so a duck op in the same list can name it', () => {
    const ops = buildAddMusicOps(project().timeline, asset, 0);
    expect(ops[2]).toMatchObject({ clipId: 'music_1_clip' });
    expect(buildAddMusicOps(project().timeline, asset, 0)[2]).toMatchObject({
      clipId: 'music_1_clip',
    });
  });

  it('appends the duck op when a sidechain is requested', () => {
    // The tool description promises "the bed drop[s] under the voice"; this is
    // the op that makes that true instead of an accepted-then-ignored argument.
    const ops = buildAddMusicOps(project().timeline, asset, 2, 'dialogue_1');
    expect(ops.map((op) => op.type)).toEqual([
      'add_asset',
      'add_layer',
      'add_clip',
      'adjust_audio',
    ]);
    expect(ops[3]).toMatchObject({
      clipId: 'music_1_clip',
      gainDb: 0,
      duckUnderTrackId: 'dialogue_1',
      duckAmountDb: -12,
    });
  });

  it('treats a blank sidechain as absent rather than emitting a duck at ""', () => {
    for (const blank of [undefined, '', '   ']) {
      const ops = buildAddMusicOps(project().timeline, asset, 0, blank);
      expect(ops.map((op) => op.type)).toEqual(['add_asset', 'add_layer', 'add_clip']);
    }
  });

  it('labels the layer music so ducking can find the bed', () => {
    expect(buildAddMusicOps(project().timeline, asset, 0)[1]).toMatchObject({ role: 'music' });
  });

  it('spans the clip the track length from the requested start', () => {
    expect(buildAddMusicOps(project().timeline, asset, 5)[2]).toMatchObject({ start: 5, end: 97 });
  });

  it('clamps a negative start rather than emitting an invalid clip', () => {
    expect(buildAddMusicOps(project().timeline, asset, -10)[2]).toMatchObject({ start: 0 });
  });

  it('falls back to a default length when the provider reported no duration', () => {
    const { durationSeconds: _none, ...noDuration } = asset;
    expect((buildAddMusicOps(project().timeline, noDuration, 0)[2] as { end: number }).end).toBe(
      30,
    );
  });

  it('validates and applies against a real project', () => {
    const base = project();
    const probe = assembleEdit(
      base,
      buildAddMusicOps(base.timeline, asset, 0),
      'Add music',
      'agent',
    );
    expect(probe.validation.valid).toBe(true);
  });

  it('carries the credit into the bin — this is what the Credits view reads', () => {
    const added = buildAddMusicOps(project().timeline, asset, 0)[0] as {
      asset: { source?: { attribution?: string } };
    };
    expect(added.asset.source?.attribution).toContain('Ada');
  });
});

describe('musicDuckSidechainIssue', () => {
  it('accepts a dialogue track that exists and carries clips', () => {
    expect(musicDuckSidechainIssue(project(), 'dialogue_1')).toBeNull();
  });

  it('is silent when no sidechain was requested', () => {
    expect(musicDuckSidechainIssue(project(), undefined)).toBeNull();
    expect(musicDuckSidechainIssue(project(), '')).toBeNull();
  });

  it('rejects a track id that is not in the project — validation would silently no-op the duck', () => {
    const issue = musicDuckSidechainIssue(project(), 'voiceover_missing');
    expect(issue).toContain('not a track in this project');
  });

  it('rejects an empty sidechain track, where a duck has nothing to duck under', () => {
    const base = project();
    (base.timeline.tracks as unknown as Array<{ id: string; clips: unknown[] }>).push({
      id: 'empty_audio',
      clips: [],
    });
    const issue = musicDuckSidechainIssue(base, 'empty_audio');
    expect(issue).toContain('no clips');
  });
});

describe('the agent path and the manual path agree', () => {
  // The real deep-equal — agent builder against the renderer's actual
  // `addMusicTrackPatch` — lives in `apps/web-editor`, the one package that can
  // import both. This is the half that belongs here: the operations the agent
  // authors are exactly the shared builder's, with nothing added or dropped
  // between the payload and the patch.
  it('authors the shared builder\u2019s operations verbatim, with no agent-only extras', () => {
    const base = project();
    const ops = buildAddMusicOps(base.timeline, asset, 0);
    const probe = assembleEdit(base, ops, 'Add background music', 'agent');
    expect(probe.validation.valid).toBe(true);
    expect(probe.patch.operations).toEqual(ops);
  });

  it('places a ducked bed as one reversible patch \u2014 the op the tool description promises', () => {
    // If the agent path dropped the adjust_audio here, the bed would play at
    // full level while the run reported it as ducked.
    const base = project();
    const ops = buildAddMusicOps(base.timeline, asset, 0, 'dialogue_1');
    const probe = assembleEdit(base, ops, 'Add background music', 'agent');
    expect(probe.validation.valid).toBe(true);
    expect(ops.map((op) => op.type)).toEqual([
      'add_asset',
      'add_layer',
      'add_clip',
      'adjust_audio',
    ]);
    // One patch: a single undo takes the bed, its layer, its bin entry and its
    // duck back together.
    const after = applyProjectPatch(base, probe.patch);
    const undone = applyProjectPatch(after, invertProjectPatch(base, probe.patch));
    // `revision` counts applies and legitimately moves; the CONTENT must not.
    expect(undone.timeline.tracks).toEqual(base.timeline.tracks);
    expect(undone.assets).toEqual(base.assets);
  });
});

// GAP-011 (run `fc10301a`). `add_music` mints its bin id from the provider identity —
// `music_<provider>_<remoteId>` — so the id it PRODUCES is a plausible thing for a later
// turn to hand back to it, and `list_assets` shows exactly that string. It was not
// accepted: the id went to the network, came back `unknown_track`, and the model was told
// to "search again" — the one recovery that cannot work for a track already on disk.
describe('localMusicAssetRefusal', () => {
  const bin = [
    { id: 'music_openverse_2052b163_fdbe_4005_b3ed_f45b481a324d', kind: 'audio' },
    { id: 'asset_photo_1', kind: 'image' },
  ];

  it('refuses the id add_music itself minted, and names the tool that places it', () => {
    const refusal = localMusicAssetRefusal(
      bin,
      'music_openverse_2052b163_fdbe_4005_b3ed_f45b481a324d',
    );
    expect(refusal).toContain('already in this project');
    expect(refusal).toContain('add_clip');
    // It says the id is not a search RESULT; it never tells the model to search again,
    // because no search will ever return a local id.
    expect(refusal).toContain('not a search result');
    expect(refusal).not.toMatch(/search again|search_music/i);
  });

  it('lets a genuine remote id through to the provider', () => {
    expect(localMusicAssetRefusal(bin, '2052b163-fdbe-4005-b3ed-f45b481a324d')).toBeUndefined();
    expect(localMusicAssetRefusal([], 'anything')).toBeUndefined();
  });

  it('names what the asset actually is when the id points at picture', () => {
    // A model reaching for `add_music` with a photo id has a different mistake, and the
    // sentence should not tell it the photo is a track.
    expect(localMusicAssetRefusal(bin, 'asset_photo_1')).toContain('an asset already');
  });
});

describe('a bed is trimmed to the picture it scores', () => {
  /** The captured run's shape: a 49.767s talking head on a video track, nothing else. */
  function scored(pictureEnd: number): Project {
    return {
      ...project(),
      timeline: {
        tracks: [
          {
            id: 'v_main',
            type: 'video',
            clips: [
              {
                id: 'clip_talk',
                assetId: 'cam',
                trackId: 'v_main',
                start: 0,
                end: pictureEnd,
                sourceStart: 0,
                sourceEnd: pictureEnd,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    } as unknown as Project;
  }

  const clipOf = (ops: readonly unknown[]) =>
    ops.find((op) => (op as { type?: string }).type === 'add_clip') as {
      start: number;
      end: number;
      sourceStart: number;
      sourceEnd: number;
    };

  it('does not lay 43.9 seconds of music over an empty frame', () => {
    // Run `e8cb2636` scored a 49.767s talking head with a 93.64s track and shipped a
    // 93.633s programme. Its own self-check reported "43.867s of the 93.633s programme has
    // no picture under it … that renders as black" — as a warning, after the fact, and the
    // run completed anyway.
    const ops = buildAddMusicOps(scored(49.767).timeline, { ...asset, durationSeconds: 93.64 });
    expect(clipOf(ops)).toMatchObject({ start: 0, end: 49.767, sourceStart: 0, sourceEnd: 49.767 });
  });

  it('leaves a bed shorter than the picture exactly as long as it is', () => {
    // Trimming is a ceiling, never a stretch: a 30s track under a 50s film stays 30s.
    const ops = buildAddMusicOps(scored(50).timeline, { ...asset, durationSeconds: 30 });
    expect(clipOf(ops)).toMatchObject({ start: 0, end: 30, sourceEnd: 30 });
  });

  it('measures the room from where the bed starts, not from zero', () => {
    const ops = buildAddMusicOps(scored(50).timeline, { ...asset, durationSeconds: 93.64 }, 20);
    expect(clipOf(ops)).toMatchObject({ start: 20, end: 50, sourceStart: 0, sourceEnd: 30 });
  });

  it('lays the whole track when there is no picture to score yet', () => {
    // A music-led montage puts the song down first and cuts to it. Trimming to a picture
    // that does not exist would place a zero-length clip and fail the validator.
    const ops = buildAddMusicOps(scored(0).timeline, { ...asset, durationSeconds: 93.64 });
    expect(clipOf(ops)).toMatchObject({ start: 0, end: 93.64 });
  });

  it('treats a sub-frame sliver of room as no room at all', () => {
    // Trimming to a millisecond produces a clip the frame grid rounds away to nothing and
    // the validator refuses; a bed starting that close to the end is a sting, not an overrun.
    const ops = buildAddMusicOps(scored(50).timeline, { ...asset, durationSeconds: 10 }, 49.999);
    expect(clipOf(ops)).toMatchObject({ start: 49.999, end: 59.999 });
  });

  it('lays the whole track when the bed starts past the end of the picture', () => {
    // An end-card sting after the film is a deliberate placement, not an overrun.
    const ops = buildAddMusicOps(scored(50).timeline, { ...asset, durationSeconds: 10 }, 50);
    expect(clipOf(ops)).toMatchObject({ start: 50, end: 60 });
  });
});

describe('pictureEndSeconds', () => {
  it('reads the latest end on the video tracks', () => {
    const timeline = {
      tracks: [
        {
          id: 'v_main',
          type: 'video',
          clips: [
            {
              id: 'a',
              assetId: 'cam',
              trackId: 'v_main',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [],
              keyframes: [],
            },
            {
              id: 'b',
              assetId: 'cam',
              trackId: 'v_main',
              start: 5,
              end: 12,
              sourceStart: 0,
              sourceEnd: 7,
              effects: [],
              keyframes: [],
            },
          ],
        },
        // Captions sit OVER the picture and cannot stand in for it.
        {
          id: 'captions_main',
          type: 'caption',
          clips: [
            {
              id: 'c',
              assetId: '__caption__',
              trackId: 'captions_main',
              start: 0,
              end: 40,
              sourceStart: 0,
              sourceEnd: 40,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    expect(pictureEndSeconds(timeline as never)).toBe(12);
  });

  it('is zero for a timeline with no picture', () => {
    expect(pictureEndSeconds({ tracks: [] } as never)).toBe(0);
  });
});
