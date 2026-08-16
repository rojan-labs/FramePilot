/**
 * Tests for @framepilot/timeline-schema.
 * Parses the PRD §11 example project (valid) and asserts an invalid clip
 * (negative duration) fails. See plan/PLAN.md Phase 1.1.
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, parseProject, safeParseProject } from './index.js';

/** Mirrors the PRD §11 example project shape. */
const validProject = {
  id: 'project_001',
  name: 'Demo Video',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [{ id: 'asset_001', path: '/media/intro.mp4', kind: 'video' as const }],
  timeline: {
    tracks: [
      {
        id: 'video_1',
        type: 'video' as const,
        clips: [
          {
            id: 'clip_001',
            assetId: 'asset_001',
            trackId: 'video_1',
            start: 0,
            end: 12.5,
            sourceStart: 4.0,
            sourceEnd: 16.5,
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
};

describe('timeline-schema', () => {
  it('exposes a numeric SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBe(19);
  });

  it('parses the PRD example project', () => {
    const project = parseProject(validProject);
    expect(project.name).toBe('Demo Video');
    expect(project.timeline.tracks[0]?.clips[0]?.id).toBe('clip_001');
  });

  it('defaults to an empty folder tree and root-level assets (schema v3)', () => {
    const project = parseProject(validProject);
    expect(project.folders).toEqual([]);
    expect(project.assets[0]?.folderId).toBeUndefined();
  });

  it('parses nested folders and folder-assigned assets (schema v3)', () => {
    const project = parseProject({
      ...validProject,
      folders: [
        { id: 'f_root', name: 'B-roll', parentId: null },
        { id: 'f_child', name: 'City', parentId: 'f_root' },
      ],
      assets: [
        { id: 'asset_001', path: '/media/intro.mp4', kind: 'video' as const, folderId: 'f_child' },
      ],
    });
    expect(project.folders).toHaveLength(2);
    expect(project.folders[1]).toEqual({ id: 'f_child', name: 'City', parentId: 'f_root' });
    expect(project.assets[0]?.folderId).toBe('f_child');
  });

  it('tolerates engine-emitted null media fields (Pydantic serializes absent as null)', () => {
    // The Python engine dumps `AssetMedia` fields (`list[str] | None`) as JSON
    // `null`, not omitted. Plain `.optional()` would reject that null and fail the
    // whole project parse; the schema is `.nullish()` so "null == absent" parses.
    const withNullMediaFields = {
      ...validProject,
      assets: [
        {
          id: 'asset_001',
          path: '/media/intro.mp4',
          kind: 'video' as const,
          media: { proxyPath: null, peaks: null, peaksPerSecond: null, thumbnailPaths: null },
        },
      ],
    };
    // The key assertion: this no longer throws. Readers treat null like absent.
    const project = parseProject(withNullMediaFields);
    expect(project.assets[0]?.media?.thumbnailPaths ?? undefined).toBeUndefined();
  });

  it('tolerates a wholly-null asset media (engine emits `media: null`)', () => {
    const withNullMedia = {
      ...validProject,
      assets: [{ id: 'asset_001', path: '/media/intro.mp4', kind: 'video' as const, media: null }],
    };
    const project = parseProject(withNullMedia);
    expect(project.assets[0]?.media?.thumbnailPaths ?? undefined).toBeUndefined();
  });

  it('still keeps present media fields (null tolerance does not drop real data)', () => {
    const project = parseProject({
      ...validProject,
      assets: [
        {
          id: 'asset_001',
          path: '/media/intro.mp4',
          kind: 'video' as const,
          media: { peaks: [0.1, 0.2], peaksPerSecond: 10, thumbnailPaths: ['t0.jpg'] },
        },
      ],
    });
    expect(project.assets[0]?.media?.thumbnailPaths).toEqual(['t0.jpg']);
    expect(project.assets[0]?.media?.peaksPerSecond).toBe(10);
  });

  it('rejects a clip with negative/zero duration', () => {
    const invalid = structuredClone(validProject);
    const clip = invalid.timeline.tracks[0]!.clips[0]!;
    clip.end = clip.start; // zero duration
    const result = safeParseProject(invalid);
    expect(result.success).toBe(false);
  });

  it('defaults to no captionStyle on a clip that omits it (schema v5)', () => {
    const project = parseProject(validProject);
    expect(project.timeline.tracks[0]?.clips[0]?.captionStyle).toBeUndefined();
  });

  it('parses a fully-populated captionStyle (schema v5)', () => {
    const project = parseProject({
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                captionStyle: {
                  fontFamily: 'Inter',
                  fontScale: 1.25,
                  textColor: '#ffffff',
                  outlineColor: '#000000',
                  outlineWidth: 2,
                  position: 'bottom',
                  xPercent: 42,
                  yPercent: 68,
                  rotation: -7,
                  maxWidthPercent: 72,
                  textAlign: 'left',
                  lineHeight: 0.95,
                  safeArea: true,
                  highlight: { enabled: true, color: '#ffe600', animation: 'karaoke-fill' },
                  templateId: 'bold-pop',
                },
              },
            ],
          },
        ],
      },
    });
    expect(project.timeline.tracks[0]?.clips[0]?.captionStyle).toEqual({
      fontFamily: 'Inter',
      fontScale: 1.25,
      textColor: '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 2,
      position: 'bottom',
      xPercent: 42,
      yPercent: 68,
      rotation: -7,
      maxWidthPercent: 72,
      textAlign: 'left',
      lineHeight: 0.95,
      safeArea: true,
      highlight: { enabled: true, color: '#ffe600', animation: 'karaoke-fill' },
      templateId: 'bold-pop',
    });
  });

  it('rejects caption layout outside its frame-safe schema bounds (schema v16)', () => {
    for (const captionStyle of [
      { xPercent: -1 },
      { yPercent: 101 },
      { maxWidthPercent: 4 },
      { lineHeight: 0.5 },
      { textAlign: 'justify' },
    ]) {
      const invalid = structuredClone(validProject);
      invalid.timeline.tracks[0]!.clips[0]!.captionStyle = captionStyle as never;
      expect(safeParseProject(invalid).success).toBe(false);
    }
  });

  it('rejects a captionStyle with out-of-range fields (schema v5)', () => {
    const invalid = {
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                captionStyle: { fontScale: -1 },
              },
            ],
          },
        ],
      },
    };
    const result = safeParseProject(invalid);
    expect(result.success).toBe(false);
  });

  it('defaults to no speed (1x) on a clip that omits it (schema v6)', () => {
    const project = parseProject(validProject);
    expect(project.timeline.tracks[0]?.clips[0]?.speed).toBeUndefined();
  });

  it('parses a clip with an explicit speed (schema v6)', () => {
    const project = parseProject({
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [{ ...validProject.timeline.tracks[0].clips[0], speed: 2 }],
          },
        ],
      },
    });
    expect(project.timeline.tracks[0]?.clips[0]?.speed).toBe(2);
  });

  it('ACCEPTS a zero or negative speed (schema v15 widened v6)', () => {
    // ADR 0090 widened `speed` from `.positive()`: 0 is a freeze frame and a
    // negative value plays the source range backwards. Both are now legal shapes;
    // what stays illegal is a speed that is not a finite number at all, because
    // there is no render that could mean.
    const withSpeed = (speed: unknown) => ({
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [{ ...validProject.timeline.tracks[0].clips[0], speed }],
          },
        ],
      },
    });
    expect(safeParseProject(withSpeed(0)).success).toBe(true);
    expect(safeParseProject(withSpeed(-1)).success).toBe(true);
    expect(safeParseProject(withSpeed(Number.POSITIVE_INFINITY)).success).toBe(false);
    expect(safeParseProject(withSpeed(Number.NaN)).success).toBe(false);
  });

  it('rejects a speed-ramp point with a non-positive rate (schema v15)', () => {
    // A rate of 0 makes the duration integral divergent; a negative one makes the
    // timeline<->source mapping non-invertible. Neither is a curve the render
    // could follow, so the shape refuses them rather than the render discovering it.
    const withRamp = (rate: number) => ({
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                speedRamp: [{ id: 'p1', sourceTime: 0, rate, easing: 'linear' }],
              },
            ],
          },
        ],
      },
    });
    expect(safeParseProject(withRamp(2)).success).toBe(true);
    expect(safeParseProject(withRamp(0)).success).toBe(false);
    expect(safeParseProject(withRamp(-2)).success).toBe(false);
  });

  it('defaults to uncropped on a clip that omits crop (schema v7)', () => {
    const project = parseProject(validProject);
    expect(project.timeline.tracks[0]?.clips[0]?.crop).toBeUndefined();
  });

  it('parses a clip with an explicit crop rect (schema v7)', () => {
    const project = parseProject({
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
              },
            ],
          },
        ],
      },
    });
    expect(project.timeline.tracks[0]?.clips[0]?.crop).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.6,
    });
  });

  it('rejects a crop rect with non-positive width/height (schema v7)', () => {
    const zeroWidth = {
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                crop: { x: 0, y: 0, width: 0, height: 0.5 },
              },
            ],
          },
        ],
      },
    };
    expect(safeParseProject(zeroWidth).success).toBe(false);

    const negativeHeight = {
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                crop: { x: 0, y: 0, width: 0.5, height: -1 },
              },
            ],
          },
        ],
      },
    };
    expect(safeParseProject(negativeHeight).success).toBe(false);
  });

  it('rejects an out-of-bounds crop rect (schema v7)', () => {
    const overflowsRight = {
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                crop: { x: 0.6, y: 0, width: 0.6, height: 0.5 },
              },
            ],
          },
        ],
      },
    };
    expect(safeParseProject(overflowsRight).success).toBe(false);

    const overflowsBottom = {
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                crop: { x: 0, y: 0.6, width: 0.5, height: 0.6 },
              },
            ],
          },
        ],
      },
    };
    expect(safeParseProject(overflowsBottom).success).toBe(false);
  });

  it('defaults to no blendMode (normal compositing) on a clip that omits it (schema v8)', () => {
    const project = parseProject(validProject);
    expect(project.timeline.tracks[0]?.clips[0]?.blendMode).toBeUndefined();
  });

  it('parses a clip with an explicit blendMode (schema v8)', () => {
    const project = parseProject({
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                blendMode: 'multiply',
              },
            ],
          },
        ],
      },
    });
    expect(project.timeline.tracks[0]?.clips[0]?.blendMode).toBe('multiply');
  });

  it('rejects an unknown blendMode string (schema v8)', () => {
    const invalid = {
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            clips: [
              {
                ...validProject.timeline.tracks[0].clips[0],
                blendMode: 'not-a-real-mode',
              },
            ],
          },
        ],
      },
    };
    expect(safeParseProject(invalid).success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Caption cue + track-level caption style (schema v11, ADR 0071)
  // -------------------------------------------------------------------------

  /** Build a project whose single clip carries `patch` (schema v11 cue tests). */
  const withClip = (patch: Record<string, unknown>): Record<string, unknown> => ({
    ...validProject,
    timeline: {
      tracks: [
        {
          ...validProject.timeline.tracks[0],
          clips: [{ ...validProject.timeline.tracks[0].clips[0], ...patch }],
        },
      ],
    },
  });

  it('defaults to no captionCue on a clip that omits it (schema v11)', () => {
    // Absence is the v10 fallback contract: derive text from the transcript.
    const project = parseProject(validProject);
    expect(project.timeline.tracks[0]?.clips[0]?.captionCue).toBeUndefined();
  });

  it('parses a captionCue with text and word timings (schema v11)', () => {
    const project = parseProject(
      withClip({
        captionCue: {
          text: 'we shipped it',
          words: [
            { word: 'we', start: 0.1, end: 0.24 },
            { word: 'shipped', start: 0.24, end: 0.61 },
            { word: 'it', start: 0.61, end: 0.78 },
          ],
        },
      }),
    );
    const cue = project.timeline.tracks[0]?.clips[0]?.captionCue;
    expect(cue?.text).toBe('we shipped it');
    expect(cue?.words).toHaveLength(3);
    expect(cue?.words[1]).toEqual({ word: 'shipped', start: 0.24, end: 0.61 });
  });

  it('defaults captionCue.words to empty — a hand-typed cue has no timings (v11)', () => {
    const project = parseProject(withClip({ captionCue: { text: 'typed by hand' } }));
    expect(project.timeline.tracks[0]?.clips[0]?.captionCue?.words).toEqual([]);
  });

  it('keeps an empty-string captionCue text (a deliberately blanked cue, v11)', () => {
    // Distinct from `captionCue: undefined`: an empty cue renders nothing,
    // whereas an absent cue falls back to the transcript.
    const project = parseProject(withClip({ captionCue: { text: '', words: [] } }));
    expect(project.timeline.tracks[0]?.clips[0]?.captionCue?.text).toBe('');
  });

  it('preserves an explicit newline in captionCue text (author line break, v11)', () => {
    const project = parseProject(withClip({ captionCue: { text: 'first line\nsecond line' } }));
    expect(project.timeline.tracks[0]?.clips[0]?.captionCue?.text).toBe('first line\nsecond line');
  });

  it('rejects a captionCue missing its text (schema v11)', () => {
    expect(safeParseProject(withClip({ captionCue: { words: [] } })).success).toBe(false);
  });

  it('rejects a captionCue word with a negative timestamp (schema v11)', () => {
    const invalid = withClip({
      captionCue: { text: 'bad', words: [{ word: 'bad', start: -1, end: 0.5 }] },
    });
    expect(safeParseProject(invalid).success).toBe(false);
  });

  it('defaults to no track-level captionStyle (schema v11)', () => {
    const project = parseProject(validProject);
    expect(project.timeline.tracks[0]?.captionStyle).toBeUndefined();
  });

  it('parses a track-level captionStyle default (schema v11)', () => {
    const project = parseProject({
      ...validProject,
      timeline: {
        tracks: [
          {
            ...validProject.timeline.tracks[0],
            captionStyle: { templateId: 'hormozi', textColor: '#ffffff' },
          },
        ],
      },
    });
    expect(project.timeline.tracks[0]?.captionStyle).toEqual({
      templateId: 'hormozi',
      textColor: '#ffffff',
    });
  });

  it('rejects an invalid track-level captionStyle (schema v11)', () => {
    const invalid = {
      ...validProject,
      timeline: {
        tracks: [{ ...validProject.timeline.tracks[0], captionStyle: { fontScale: 0 } }],
      },
    };
    expect(safeParseProject(invalid).success).toBe(false);
  });

  it('parses accent keywords — the list `accent.mode: keywords` needs (schema v11)', () => {
    const project = parseProject(
      withClip({
        captionStyle: { accent: { mode: 'keywords', keywords: ['viral', 'growth'] } },
      }),
    );
    expect(project.timeline.tracks[0]?.clips[0]?.captionStyle?.accent).toEqual({
      mode: 'keywords',
      keywords: ['viral', 'growth'],
    });
  });

  it('rejects an empty accent keyword string (schema v11)', () => {
    const invalid = withClip({ captionStyle: { accent: { mode: 'keywords', keywords: [''] } } });
    expect(safeParseProject(invalid).success).toBe(false);
  });
});
