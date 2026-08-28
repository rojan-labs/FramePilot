/**
 * Tests for the schema migration framework (PLAN §1.1).
 */
import { describe, expect, it } from 'vitest';
import {
  LEGACY_PRESET_TO_TEMPLATE_ID,
  migrateToCurrent,
  readSchemaVersion,
  type Migration,
  type RawProject,
} from './migrations.js';
import { SCHEMA_VERSION } from './index.js';

describe('readSchemaVersion', () => {
  it('reads a valid integer version', () => {
    expect(readSchemaVersion({ schemaVersion: 3 })).toBe(3);
  });

  it('defaults to 1 when absent or invalid', () => {
    expect(readSchemaVersion({})).toBe(1);
    expect(readSchemaVersion({ schemaVersion: 0 })).toBe(1);
    expect(readSchemaVersion({ schemaVersion: 1.5 })).toBe(1);
    expect(readSchemaVersion({ schemaVersion: 'two' })).toBe(1);
  });
});

describe('migrateToCurrent', () => {
  it('is a no-op when already at the current version', () => {
    const raw: RawProject = { schemaVersion: SCHEMA_VERSION, name: 'x' };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([]);
    expect(result.raw).toBe(raw);
  });

  it('migrates a v1 file to current via the registered chain (additive `media`/`folders`)', () => {
    const raw: RawProject = {
      schemaVersion: 1,
      name: 'legacy',
      assets: [{ id: 'a', path: 'a.mp4' }],
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    // Additive: the v1 asset is preserved untouched (no `media`/`folderId` required).
    expect(result.raw.assets).toEqual([{ id: 'a', path: 'a.mp4' }]);
    // v2→v3 is additive: no `folders` is injected into the raw shape (the schema
    // supplies the empty default on parse).
    expect(result.raw.folders).toBeUndefined();
  });

  it('migrates a v2 file to current (additive folders + track flags) stamping the envelope', () => {
    const raw: RawProject = {
      schemaVersion: 2,
      name: 'v2-project',
      assets: [{ id: 'a', path: 'a.mp4', media: { peaks: [0.1] } }],
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.raw.assets).toEqual([{ id: 'a', path: 'a.mp4', media: { peaks: [0.1] } }]);
  });

  it('migrates a v3 file to v4 (additive track flags) without touching track data', () => {
    const raw: RawProject = {
      schemaVersion: 3,
      name: 'v3-project',
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    // Additive: no locked/hidden/muted is injected; the schema supplies the
    // absent ≡ false default on parse.
    expect(result.raw.timeline).toEqual({
      tracks: [{ id: 'video_1', type: 'video', clips: [] }],
    });
  });

  it('migrates a v4 file to v5 (additive captionStyle) without touching clip data', () => {
    const raw: RawProject = {
      schemaVersion: 4,
      name: 'v4-project',
      timeline: {
        tracks: [
          {
            id: 'caption_1',
            type: 'caption',
            clips: [
              {
                id: 'caption_1__0',
                assetId: '__caption__',
                trackId: 'caption_1',
                start: 0,
                end: 2,
                sourceStart: 0,
                sourceEnd: 2,
                effects: [
                  { id: 'caption_1__0__caption', type: 'caption', params: {}, keyframes: [] },
                ],
                keyframes: [],
              },
            ],
          },
        ],
      },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    // Additive: no `captionStyle` is injected; the schema treats absent as
    // "unstyled" on parse, and the pre-existing caption clip is untouched.
    const clip = (result.raw.timeline as { tracks: { clips: Record<string, unknown>[] }[] })
      .tracks[0]!.clips[0]!;
    expect(clip.captionStyle).toBeUndefined();
    expect(clip.id).toBe('caption_1__0');
  });

  it('migrates a v5 file to v6 (additive speed) without touching clip data', () => {
    const raw: RawProject = {
      schemaVersion: 5,
      name: 'v5-project',
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_1',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 0,
                end: 10,
                sourceStart: 0,
                sourceEnd: 10,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    // Additive: no `speed` is injected; the schema treats absent as 1x on parse,
    // and the pre-existing clip is untouched.
    const clip = (result.raw.timeline as { tracks: { clips: Record<string, unknown>[] }[] })
      .tracks[0]!.clips[0]!;
    expect(clip.speed).toBeUndefined();
    expect(clip.id).toBe('clip_1');
  });

  it('migrates a v6 file to v7 (additive crop) without touching clip data', () => {
    const raw: RawProject = {
      schemaVersion: 6,
      name: 'v6-project',
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_1',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 0,
                end: 10,
                sourceStart: 0,
                sourceEnd: 10,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    // Additive: no `crop` is injected; the schema treats absent as "uncropped"
    // (the full source frame) on parse, and the pre-existing clip is untouched.
    const clip = (result.raw.timeline as { tracks: { clips: Record<string, unknown>[] }[] })
      .tracks[0]!.clips[0]!;
    expect(clip.crop).toBeUndefined();
    expect(clip.id).toBe('clip_1');
  });

  it('migrates a v7 file to v8 (additive blendMode) without touching clip data', () => {
    const raw: RawProject = {
      schemaVersion: 7,
      name: 'v7-project',
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_1',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 0,
                end: 10,
                sourceStart: 0,
                sourceEnd: 10,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    // Additive: no `blendMode` is injected; the schema treats absent as
    // 'normal' (today's default compositing) on parse, and the pre-existing
    // clip is untouched.
    const clip = (result.raw.timeline as { tracks: { clips: Record<string, unknown>[] }[] })
      .tracks[0]!.clips[0]!;
    expect(clip.blendMode).toBeUndefined();
    expect(clip.id).toBe('clip_1');
  });

  it('migrates a v8 file to v9 (additive markers) without touching existing data', () => {
    const raw: RawProject = {
      schemaVersion: 8,
      name: 'v8-project',
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    // Additive: no `markers` is injected; the schema treats absent as `[]`
    // (no markers placed) on parse.
    expect(result.raw.markers).toBeUndefined();
  });

  describe('v9 → v10 (caption presetId → templateId, the first transforming step)', () => {
    /** A minimal v9 project with one caption clip carrying the given style. */
    const v9ProjectWith = (captionStyle: Record<string, unknown> | undefined): RawProject => ({
      schemaVersion: 9,
      name: 'v9-project',
      timeline: {
        tracks: [
          {
            id: 'caption_1',
            type: 'caption',
            clips: [
              {
                id: 'caption_1__0',
                assetId: '__caption__',
                trackId: 'caption_1',
                start: 0,
                end: 2,
                sourceStart: 0,
                sourceEnd: 2,
                effects: [],
                keyframes: [],
                ...(captionStyle === undefined ? {} : { captionStyle }),
              },
            ],
          },
        ],
      },
    });

    const migratedStyle = (result: { raw: RawProject }): Record<string, unknown> | undefined =>
      (result.raw.timeline as { tracks: { clips: { captionStyle?: Record<string, unknown> }[] }[] })
        .tracks[0]!.clips[0]!.captionStyle;

    it('maps each known preset id to its catalog template id', () => {
      for (const [presetId, templateId] of Object.entries(LEGACY_PRESET_TO_TEMPLATE_ID)) {
        const result = migrateToCurrent(v9ProjectWith({ presetId }));
        expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
        expect(migratedStyle(result)).toEqual({ templateId });
      }
    });

    it('carries explicit style fields over unchanged alongside the mapped template id', () => {
      const result = migrateToCurrent(
        v9ProjectWith({
          presetId: 'bold-pop',
          fontScale: 1.4,
          textColor: '#ff0000',
          highlight: { enabled: true, animation: 'karaoke-fill' },
        }),
      );
      expect(migratedStyle(result)).toEqual({
        templateId: 'boxed',
        fontScale: 1.4,
        textColor: '#ff0000',
        highlight: { enabled: true, animation: 'karaoke-fill' },
      });
    });

    it('drops an unknown preset id but keeps the explicit fields', () => {
      const result = migrateToCurrent(v9ProjectWith({ presetId: 'mystery', textColor: '#00ff00' }));
      expect(migratedStyle(result)).toEqual({ textColor: '#00ff00' });
    });

    it('leaves a style without presetId untouched', () => {
      const result = migrateToCurrent(v9ProjectWith({ textColor: '#00ff00' }));
      expect(migratedStyle(result)).toEqual({ textColor: '#00ff00' });
    });

    it('leaves unstyled clips untouched (baseline rendering preserved)', () => {
      const result = migrateToCurrent(v9ProjectWith(undefined));
      expect(migratedStyle(result)).toBeUndefined();
    });

    it('passes malformed raw shapes through untouched (validation happens after migration)', () => {
      const noTimeline: RawProject = { schemaVersion: 9, name: 'x' };
      expect(migrateToCurrent(noTimeline).raw.timeline).toBeUndefined();

      const weirdTracks: RawProject = { schemaVersion: 9, timeline: { tracks: 'nope' } };
      expect(migrateToCurrent(weirdTracks).raw.timeline).toEqual({ tracks: 'nope' });

      const weirdClips: RawProject = {
        schemaVersion: 9,
        timeline: { tracks: [{ id: 't', clips: [null, 'str', { captionStyle: 7 }] }] },
      };
      expect(
        (migrateToCurrent(weirdClips).raw.timeline as { tracks: { clips: unknown[] }[] }).tracks[0]!
          .clips,
      ).toEqual([null, 'str', { captionStyle: 7 }]);
    });
  });

  describe('v10 → v11 (caption cue + track caption style, additive)', () => {
    /** A v10 caption clip: styled, but with no cue of its own — the pre-v11 shape. */
    const v10Project = (): RawProject => ({
      schemaVersion: 10,
      name: 'v10-project',
      transcript: [
        { word: 'we', start: 0.0, end: 0.4 },
        { word: 'shipped', start: 0.4, end: 1.0 },
      ],
      timeline: {
        tracks: [
          {
            id: 'caption_1',
            type: 'caption',
            clips: [
              {
                id: 'caption_1__0',
                assetId: '__caption__',
                trackId: 'caption_1',
                start: 0,
                end: 2,
                sourceStart: 0,
                sourceEnd: 2,
                effects: [],
                keyframes: [],
                captionStyle: { templateId: 'karaoke' },
              },
            ],
          },
        ],
      },
    });

    const firstClip = (raw: RawProject): Record<string, unknown> =>
      (raw.timeline as { tracks: { clips: Record<string, unknown>[] }[] }).tracks[0]!.clips[0]!;

    it('stamps the envelope version without transforming any data', () => {
      const before = v10Project();
      // Scoped to the one step under test, so this stays meaningful — and stops
      // needing an edit — as later schema versions are added above it.
      const result = migrateToCurrent(before, { targetVersion: 11 });
      expect(result.appliedTo).toEqual([11]);
      expect(result.raw.schemaVersion).toBe(11);
      // Every other field is byte-identical — this is why a v10 project still
      // renders exactly as it did (ADR 0071).
      expect({ ...result.raw, schemaVersion: 10 }).toEqual(before);
    });

    it('injects no captionCue — absence IS the "derive from transcript" fallback', () => {
      const result = migrateToCurrent(v10Project());
      expect(firstClip(result.raw).captionCue).toBeUndefined();
      // The per-cue style the v10 project already had is untouched.
      expect(firstClip(result.raw).captionStyle).toEqual({ templateId: 'karaoke' });
    });

    it('injects no track-level captionStyle — absence means "each cue keeps its own"', () => {
      const result = migrateToCurrent(v10Project());
      const track = (result.raw.timeline as { tracks: Record<string, unknown>[] }).tracks[0]!;
      expect(track.captionStyle).toBeUndefined();
    });

    it('leaves the project transcript intact (cues still derive from it)', () => {
      const result = migrateToCurrent(v10Project());
      expect(result.raw.transcript).toEqual([
        { word: 'we', start: 0.0, end: 0.4 },
        { word: 'shipped', start: 0.4, end: 1.0 },
      ]);
    });
  });

  describe('v11 → v12 (transcript becomes source-relative, ADR 0076)', () => {
    /** A v11 project: one asset, one trimmed clip, an unattributed transcript. */
    const v11Project = (assets: unknown[]): RawProject => ({
      schemaVersion: 11,
      name: 'v11-project',
      assets,
      transcript: [
        { word: 'we', start: 6.9, end: 7.2 },
        { word: 'shipped', start: 7.2, end: 7.8 },
      ],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_0',
                assetId: 'asset_a',
                trackId: 'video_1',
                start: 0,
                end: 12.64,
                sourceStart: 6.86,
                sourceEnd: 19.5,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    });

    const single = [{ id: 'asset_a', path: '/a.mp4' }];

    it('attributes the transcript when the project has exactly one asset', () => {
      const result = migrateToCurrent(v11Project(single));
      expect(result.appliedTo).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
      expect(result.raw.transcript).toEqual([
        { word: 'we', start: 6.9, end: 7.2, assetId: 'asset_a' },
        { word: 'shipped', start: 7.2, end: 7.8, assetId: 'asset_a' },
      ]);
    });

    it('leaves the timestamps alone — they were always source-relative', () => {
      // The v12 change is to the CONTRACT, not the numbers: consumers used to
      // read these as sequence times, which is what placed captions wrongly on
      // any edited timeline. Rewriting them here would bake one timeline's
      // offsets into data meant to outlive it.
      const result = migrateToCurrent(v11Project(single));
      const words = result.raw.transcript as { start: number; end: number }[];
      expect(words.map((w) => w.start)).toEqual([6.9, 7.2]);
    });

    it('refuses to guess attribution when the project has several assets', () => {
      const result = migrateToCurrent(
        v11Project([
          { id: 'asset_a', path: '/a.mp4' },
          { id: 'asset_b', path: '/b.mp4' },
        ]),
      );
      // Genuinely ambiguous: a v11 transcript has no record of which file each
      // word came from. Unattributed is honest; the mapper handles it.
      const words = result.raw.transcript as Record<string, unknown>[];
      expect(words.every((w) => w.assetId === undefined)).toBe(true);
    });

    it('never overwrites an attribution that is already present', () => {
      const raw = v11Project(single);
      raw.transcript = [{ word: 'we', start: 6.9, end: 7.2, assetId: 'asset_z' }];
      const result = migrateToCurrent(raw);
      expect((result.raw.transcript as { assetId: string }[])[0]!.assetId).toBe('asset_z');
    });

    it('seeds no timeline revision — absent already means "never edited"', () => {
      const result = migrateToCurrent(v11Project(single));
      expect((result.raw.timeline as Record<string, unknown>).revision).toBeUndefined();
    });

    it('passes malformed transcript/asset shapes through untouched', () => {
      // Migration runs BEFORE validation, so the raw JSON may be anything.
      const broken: RawProject = { schemaVersion: 11, assets: 'nope', transcript: 7 };
      expect(() => migrateToCurrent(broken)).not.toThrow();
      expect(migrateToCurrent(broken).raw.transcript).toBe(7);
    });
  });

  it('migrates v15 to v16 without injecting caption geometry', () => {
    const raw: RawProject = {
      schemaVersion: 15,
      timeline: {
        tracks: [
          {
            id: 'captions',
            type: 'caption',
            clips: [{ id: 'cap', captionStyle: { templateId: 'karaoke' } }],
          },
        ],
      },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([16, 17, 18, 19, 20, 21]);
    const timeline = result.raw.timeline as {
      tracks: { clips: { captionStyle?: Record<string, unknown> }[] }[];
    };
    expect(timeline.tracks[0]!.clips[0]!.captionStyle).toEqual({ templateId: 'karaoke' });
  });

  it('migrates v16 to v17 without guessing an audio role from track names', () => {
    const raw: RawProject = {
      schemaVersion: 16,
      timeline: {
        tracks: [
          { id: 'music', type: 'audio', clips: [] },
          { id: 'dialogue', type: 'audio', clips: [] },
          { id: 'sfx_left', type: 'audio', clips: [] },
        ],
      },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([17, 18, 19, 20, 21]);
    const timeline = result.raw.timeline as { tracks: Record<string, unknown>[] };
    // Track names are the most tempting possible signal and the most dangerous: a lane called
    // "music" routinely holds a voice-over. Every migrated track stays role-less.
    for (const track of timeline.tracks) expect(track.role).toBeUndefined();
  });

  it('migrates v17 to v18 without inventing camera angle groups', () => {
    const raw: RawProject = {
      schemaVersion: 17,
      // Two files that look exactly like an A/B camera shoot: same folder, adjacent
      // names, near-identical durations. That resemblance is not evidence of a sync
      // relationship, and a fabricated offset cuts confidently to the wrong moment.
      assets: [
        { id: 'a', path: '/shoot/CAM_A_0001.MP4', folderId: 'shoot', durationSeconds: 611.2 },
        { id: 'b', path: '/shoot/CAM_B_0001.MP4', folderId: 'shoot', durationSeconds: 610.9 },
      ],
      timeline: { tracks: [] },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([18, 19, 20, 21]);
    expect(result.raw.angleGroups).toBeUndefined();
  });

  it('migrates v18 to v19 without guessing capability packs from project content', () => {
    const raw: RawProject = {
      schemaVersion: 18,
      transcript: [{ word: 'hello', start: 0, end: 1 }],
      timeline: {
        tracks: [
          {
            id: 'video',
            type: 'video',
            clips: [{ id: 'tracked', effects: [{ id: 'track', type: 'object_track' }] }],
          },
        ],
      },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([19, 20, 21]);
    expect(result.raw.capabilityPacks).toBeUndefined();
  });

  it('migrates v20 to v21 without guessing dimensions for an unprobed asset', () => {
    const raw: RawProject = {
      schemaVersion: 20,
      assets: [
        { id: 'a1', path: 'media/hike.jpeg', kind: 'image' },
        { id: 'a2', path: 'media/b.mp4', kind: 'video', media: { peaks: [0.1] } },
      ],
      timeline: { tracks: [] },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([21]);
    // Absent is the truthful reading: the engine probes dimensions when it derives media,
    // and a guessed 1920x1080 would be worse than silence — `list_assets` would then tell
    // the model a portrait photo is landscape and send it to crop the wrong axis.
    for (const asset of result.raw.assets as Array<Record<string, unknown>>) {
      const media = asset.media as Record<string, unknown> | undefined;
      expect(media?.width).toBeUndefined();
      expect(media?.height).toBeUndefined();
    }
    // And nothing else on the asset moves.
    expect((result.raw.assets as Array<Record<string, unknown>>)[1]?.media).toEqual({
      peaks: [0.1],
    });
  });

  it('migrates v19 to v20 without inventing provenance for user-imported assets', () => {
    const raw: RawProject = {
      schemaVersion: 19,
      assets: [
        { id: 'a1', path: 'media/interview.mp4', kind: 'video' },
        { id: 'a2', path: 'media/bed.mp3', kind: 'audio' },
      ],
      timeline: { tracks: [] },
    };
    const result = migrateToCurrent(raw);
    expect(result.appliedTo).toEqual([20, 21]);
    // Absent is the truthful reading: neither of these came from a provider, and
    // guessing a licence for a file the user dragged in would be worse than silence.
    for (const asset of result.raw.assets as Array<Record<string, unknown>>) {
      expect(asset.source).toBeUndefined();
    }
  });

  it('carries an already-present v19 asset `source` through the v20 step untouched', () => {
    // A project written by a newer build and downgraded, or hand-edited: the step
    // is a carry-over, so it must not normalize or drop a field it did not add.
    const source = { provider: 'openverse', remoteId: '42', license: 'cc-by' };
    const raw: RawProject = {
      schemaVersion: 19,
      assets: [{ id: 'a1', path: 'media/bed.mp3', kind: 'audio', source }],
      timeline: { tracks: [] },
    };
    const result = migrateToCurrent(raw);
    expect((result.raw.assets as Array<Record<string, unknown>>)[0]?.source).toEqual(source);
  });

  it('applies registered migrations in sequence (v1 → v3)', () => {
    const migrations: Migration[] = [
      { from: 1, to: 2, describe: 'add fieldA', migrate: (r) => ({ ...r, fieldA: true }) },
      { from: 2, to: 3, describe: 'add fieldB', migrate: (r) => ({ ...r, fieldB: 2 }) },
    ];
    const result = migrateToCurrent({ schemaVersion: 1 }, { migrations, targetVersion: 3 });
    expect(result.appliedTo).toEqual([2, 3]);
    expect(result.raw).toMatchObject({ schemaVersion: 3, fieldA: true, fieldB: 2 });
  });

  it('throws when the file is newer than the target', () => {
    expect(() => migrateToCurrent({ schemaVersion: 5 }, { targetVersion: 1 })).toThrow(
      /newer than/,
    );
  });

  it('throws when a migration step is missing', () => {
    const migrations: Migration[] = [{ from: 2, to: 3, describe: 'gap', migrate: (r) => r }];
    expect(() => migrateToCurrent({ schemaVersion: 1 }, { migrations, targetVersion: 3 })).toThrow(
      /No migration registered from schema version 1/,
    );
  });
});
