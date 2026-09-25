/**
 * The caption tools learn their units and their floor from run `df81d58e` (2026-09-08):
 * a chip sent as `paddingX: 18` (pixels, in a field that is a fraction of the font size)
 * painted every caption as a full-frame white rectangle; `discover_caption_styles` had
 * shown no number to match and answered two mis-categorised queries with `matched: 0`;
 * a 0.10 s cue was placed by hand, twice.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  CAPTION_TEMPLATE_CATALOG,
  getCaptionTemplate,
} from '@framepilot/timeline-schema/caption-templates';
import type { ToolContext } from '../tool-context.js';
import { getTool } from '../tool-registry.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { CAPTION_STYLE_UNITS, captionEmViolations } from '../caption-style-facts.js';

const ASSET = 'asset_talk';

function project(): Project {
  const words = [];
  for (let t = 0; t < 60; t += 0.5) {
    words.push({ word: `w${String(t)}`, start: t, end: t + 0.4, assetId: ASSET });
  }
  return parseProject({
    id: 'guards',
    name: 'Caption guards',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [{ id: ASSET, path: '/talk.mp4', kind: 'video', durationSeconds: 60 }],
    folders: [],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: ASSET,
              trackId: 'v1',
              start: 0,
              end: 60,
              sourceStart: 0,
              sourceEnd: 60,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'track_captions', type: 'caption', clips: [] },
      ],
    },
    transcript: words,
    markers: [],
    aiMemory: {},
    history: [],
  });
}

const ctx = (doc: Project = project()): ToolContext => ({ project: doc }) as unknown as ToolContext;

function mutate(name: string, args: unknown, doc?: Project): unknown {
  const tool = getTool(name);
  if (!tool || tool.kind !== 'mutate') throw new Error(`${name} is not a mutate tool`);
  return tool.buildOps(args, ctx(doc));
}

function read(name: string, args: unknown): Record<string, unknown> {
  const tool = getTool(name);
  if (!tool?.read) throw new Error(`${name} is not a read tool`);
  return tool.read(args, ctx()) as Record<string, unknown>;
}

describe('a caption chip written in pixels is refused with the unit it should be in', () => {
  const pixelChip = {
    templateId: 'tag',
    fontScale: 1.08,
    background: { color: '#FFFFFF', radius: 18, paddingX: 18, paddingY: 10 },
  };

  it('set_track_caption_style names every offending field and what it would draw', () => {
    let thrown: unknown;
    try {
      mutate('set_track_caption_style', { trackId: 'track_captions', captionStyle: pixelChip });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolRefusalError);
    const message = (thrown as Error).message;
    expect(message).toMatch(/background\.paddingX 18 \(≈\d+ px\)/);
    expect(message).toMatch(/background\.paddingY 10/);
    expect(message).toMatch(/background\.radius 18/);
    expect(message).toContain('fractions of the font size');
    expect(message).toContain('0.25–0.6');
    expect((thrown as ToolRefusalError).refusalCause).toBe('caption_style_units');
  });

  it('set_caption_style is held to the same unit', () => {
    expect(() =>
      mutate('set_caption_style', {
        clipId: 'cue_1',
        captionStyle: { shadow: { color: '#000', blur: 12, offsetX: 0, offsetY: 4 } },
      }),
    ).toThrow(/shadow\.blur 12/);
  });

  it('accepts the catalog range and the template untouched', () => {
    expect(() =>
      mutate('set_track_caption_style', {
        trackId: 'track_captions',
        captionStyle: {
          templateId: 'tag',
          background: { color: '#FFFFFF', radius: 0.35, paddingX: 0.45, paddingY: 0.3 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      mutate('set_track_caption_style', {
        trackId: 'track_captions',
        captionStyle: { templateId: 'tag' },
      }),
    ).not.toThrow();
  });
});

describe('discover_caption_styles shows the numbers a chip override has to match', () => {
  it('returns each template’s background and shadow, and states the units', () => {
    const result = read('discover_caption_styles', { query: 'tag', category: 'boxed' });
    expect(result.units).toBe(CAPTION_STYLE_UNITS);
    const [tag] = result.templates as Record<string, unknown>[];
    expect(tag?.templateId).toBe('tag');
    // The payload carries the catalog's own numbers, whatever they are today.
    expect(tag?.background).toEqual(getCaptionTemplate('tag')?.style.background);
  });

  it('answers a right id in the wrong category with the near misses, not with nothing', () => {
    // The run asked for "tag" in `phrase` and "negative" in `boxed`.
    const result = read('discover_caption_styles', { query: 'tag', category: 'phrase' });
    expect(result.matched).toBe(0);
    expect(result.returned).toBe(1);
    expect(result.note).toMatch(/No template matches "tag" in category "phrase"/);
    expect((result.templates as { templateId: string }[]).map((t) => t.templateId)).toEqual([
      'tag',
    ]);

    const negative = read('discover_caption_styles', { query: 'negative', category: 'boxed' });
    expect((negative.templates as { templateId: string; category: string }[])[0]).toMatchObject({
      templateId: 'negative',
      category: 'aesthetic',
    });
  });

  it('still returns nothing, and no note, when nothing matches at all', () => {
    const result = read('discover_caption_styles', { query: 'zzz-no-such-template' });
    expect(result.matched).toBe(0);
    expect(result.returned).toBe(0);
    expect(result.note).toBeUndefined();
  });
});

describe('add_caption_layer will not place a cue nobody can read', () => {
  it('refuses a range below the shortest preset floor and names the frames', () => {
    let thrown: unknown;
    try {
      mutate('add_caption_layer', { trackId: 'track_captions', start: 40.833, end: 40.933 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolRefusalError);
    expect((thrown as Error).message).toMatch(/0\.1s — about 3 frame\(s\), below the 0\.25s floor/);
    expect((thrown as ToolRefusalError).refusalCause).toBe('caption_cue_too_short');
  });

  it('accepts a cue at the floor', () => {
    expect(() =>
      mutate('add_caption_layer', { trackId: 'track_captions', start: 40.5, end: 40.75 }),
    ).not.toThrow();
  });
});

describe('shadow offsets and letter spacing are em, not pixels (runs fb90e58d, 0d7d679f)', () => {
  const refusal = (captionStyle: unknown): ToolRefusalError => {
    try {
      mutate('set_track_caption_style', { trackId: 'track_captions', captionStyle });
    } catch (error) {
      return error as ToolRefusalError;
    }
    throw new Error('expected a refusal');
  };

  it('refuses a drop shadow written in pixels and says it would draw a detached copy', () => {
    // fb90e58d: `offsetY: 2` meant two pixels and drew a copy two font-heights below the
    // line, on a canvas wide enough to push every cue off the frame.
    const thrown = refusal({ shadow: { color: '#000000a6', blur: 0.3, offsetX: 0, offsetY: 2 } });
    expect(thrown).toBeInstanceOf(ToolRefusalError);
    expect(thrown.refusalCause).toBe('caption_style_units');
    expect(thrown.message).toMatch(/shadow\.offsetY 2 \(≈\d+ px\)/);
    expect(thrown.message).toContain('detached second copy');
    expect(thrown.message).not.toContain('wider than the');
  });

  it('refuses letter spacing that runs the letters into each other', () => {
    const thrown = refusal({ fontFamily: 'Anton', letterSpacing: -0.5 });
    expect(thrown.message).toMatch(/letterSpacing -0\.5/);
    expect(thrown.message).toContain('run into each other');
  });

  it('accepts tight and wide tracking inside the range, and a real drop shadow', () => {
    expect(() =>
      mutate('set_track_caption_style', {
        trackId: 'track_captions',
        captionStyle: {
          letterSpacing: -0.05,
          shadow: { color: '#000000b3', blur: 0.2, offsetX: 0, offsetY: 0.06 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      mutate('set_track_caption_style', {
        trackId: 'track_captions',
        captionStyle: { letterSpacing: 0.4 },
      }),
    ).not.toThrow();
  });

  it('holds every catalog template inside the ranges it teaches', () => {
    for (const template of CAPTION_TEMPLATE_CATALOG) {
      expect({
        id: template.id,
        violations: captionEmViolations(template.style, { width: 1080, height: 1920 }),
      }).toEqual({ id: template.id, violations: [] });
    }
  });
});

describe('a keywords-mode restyle keeps the words the track already accents', () => {
  const KEYWORDS = ['stop scrolling', 'mission'];
  const accented = (): Project => {
    const doc = project();
    return {
      ...doc,
      timeline: {
        ...doc.timeline,
        tracks: doc.timeline.tracks.map((track) =>
          track.id === 'track_captions'
            ? {
                ...track,
                captionStyle: {
                  accent: { mode: 'keywords', keywords: KEYWORDS, color: '#ffd60a' },
                },
              }
            : track,
        ),
      },
    } as Project;
  };
  const writtenAccent = (ops: unknown): unknown =>
    (ops as { captionStyle: { accent?: unknown } | null }[])[0]?.captionStyle?.accent;

  it('fills an omitted keyword list from the track (run 1292449c restyled them away)', () => {
    const ops = mutate(
      'set_track_caption_style',
      {
        trackId: 'track_captions',
        captionStyle: {
          fontFamily: 'Anton',
          accent: { mode: 'keywords', fontFamily: 'Mr Dafoe', color: '#e0231c' },
        },
      },
      accented(),
    );
    expect(writtenAccent(ops)).toEqual({
      mode: 'keywords',
      fontFamily: 'Mr Dafoe',
      color: '#e0231c',
      keywords: KEYWORDS,
    });
  });

  it('leaves an explicit list, another mode, and a cleared style exactly as written', () => {
    const doc = accented();
    const explicit = mutate(
      'set_track_caption_style',
      {
        trackId: 'track_captions',
        captionStyle: { accent: { mode: 'keywords', keywords: ['mission'] } },
      },
      doc,
    );
    expect(writtenAccent(explicit)).toEqual({ mode: 'keywords', keywords: ['mission'] });
    const none = mutate(
      'set_track_caption_style',
      { trackId: 'track_captions', captionStyle: { accent: { mode: 'none' } } },
      doc,
    );
    expect(writtenAccent(none)).toEqual({ mode: 'none' });
    const cleared = mutate(
      'set_track_caption_style',
      { trackId: 'track_captions', captionStyle: null },
      doc,
    );
    expect((cleared as { captionStyle: unknown }[])[0]?.captionStyle).toBeNull();
  });

  it('carries the track keywords onto a per-cue override too', () => {
    const doc = accented();
    const withCue = {
      ...doc,
      timeline: {
        ...doc.timeline,
        tracks: doc.timeline.tracks.map((track) =>
          track.id === 'track_captions'
            ? {
                ...track,
                clips: [
                  {
                    id: 'cue_1',
                    assetId: '__caption__',
                    trackId: 'track_captions',
                    start: 0,
                    end: 2,
                    sourceStart: 0,
                    sourceEnd: 2,
                    effects: [],
                    keyframes: [],
                  },
                ],
              }
            : track,
        ),
      },
    } as Project;
    const ops = mutate(
      'set_caption_style',
      { clipId: 'cue_1', captionStyle: { accent: { mode: 'keywords', color: '#ffffff' } } },
      withCue,
    );
    expect(writtenAccent(ops)).toEqual({ mode: 'keywords', color: '#ffffff', keywords: KEYWORDS });
  });
});
