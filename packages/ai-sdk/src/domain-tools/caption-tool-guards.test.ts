/**
 * The caption tools learn their units and their floor from run `df81d58e` (2026-09-08):
 * a chip sent as `paddingX: 18` (pixels, in a field that is a fraction of the font size)
 * painted every caption as a full-frame white rectangle; `discover_caption_styles` had
 * shown no number to match and answered two mis-categorised queries with `matched: 0`;
 * a 0.10 s cue was placed by hand, twice.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { ToolContext } from '../tool-context.js';
import { getTool } from '../tool-registry.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { CAPTION_STYLE_UNITS } from '../caption-style-facts.js';

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

const ctx = (): ToolContext => ({ project: project() }) as unknown as ToolContext;

function mutate(name: string, args: unknown): unknown {
  const tool = getTool(name);
  if (!tool || tool.kind !== 'mutate') throw new Error(`${name} is not a mutate tool`);
  return tool.buildOps(args, ctx());
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
      mutate('set_caption_style', { clipId: 'cue_1', captionStyle: { shadow: { color: '#000', blur: 12, offsetX: 0, offsetY: 4 } } }),
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
      mutate('set_track_caption_style', { trackId: 'track_captions', captionStyle: { templateId: 'tag' } }),
    ).not.toThrow();
  });
});

describe('discover_caption_styles shows the numbers a chip override has to match', () => {
  it('returns each template’s background and shadow, and states the units', () => {
    const result = read('discover_caption_styles', { query: 'tag', category: 'boxed' });
    expect(result.units).toBe(CAPTION_STYLE_UNITS);
    const [tag] = result.templates as Record<string, unknown>[];
    expect(tag?.templateId).toBe('tag');
    expect(tag?.background).toEqual({ color: '#ffffff', radius: 0.35, paddingX: 0.45, paddingY: 0.3 });
  });

  it('answers a right id in the wrong category with the near misses, not with nothing', () => {
    // The run asked for "tag" in `phrase` and "negative" in `boxed`.
    const result = read('discover_caption_styles', { query: 'tag', category: 'phrase' });
    expect(result.matched).toBe(0);
    expect(result.returned).toBe(1);
    expect(result.note).toMatch(/No template matches "tag" in category "phrase"/);
    expect((result.templates as { templateId: string }[]).map((t) => t.templateId)).toEqual(['tag']);

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
