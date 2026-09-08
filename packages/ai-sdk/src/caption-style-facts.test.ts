import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track } from '@framepilot/timeline-schema';
import {
  CAPTION_FONT_HEIGHT_FRACTION,
  MAX_CAPTION_EM_VALUE,
  captionEmViolations,
  captionFontPx,
  emphasisCoverageNote,
  resolveCaptionStyle,
} from './caption-style-facts.js';

const portrait = { width: 1080, height: 1920 };

describe('the chip arithmetic matches the renderer', () => {
  it('derives the font from 1/22 of the frame height times fontScale', () => {
    expect(CAPTION_FONT_HEIGHT_FRACTION).toBeCloseTo(1 / 22);
    expect(captionFontPx({ fontScale: 1.08 }, portrait)).toBe(Math.floor((1920 / 22) * 1.08));
    expect(captionFontPx(undefined, { width: 100, height: 100 })).toBe(14);
  });

  it('reports the run’s chip as the pixels it would paint', () => {
    // Run `df81d58e`: paddingX 18 at fontScale 1.08 on 1080×1920.
    const violations = captionEmViolations(
      { fontScale: 1.08, background: { color: '#fff', radius: 18, paddingX: 18, paddingY: 10 } },
      portrait,
    );
    expect(violations.map((v) => v.path)).toEqual([
      'background.radius',
      'background.paddingX',
      'background.paddingY',
    ]);
    const paddingX = violations.find((v) => v.path === 'background.paddingX');
    expect(paddingX?.px).toBe(18 * Math.floor((1920 / 22) * 1.08));
    expect(paddingX?.px).toBeGreaterThan(portrait.width);
  });

  it('accepts the catalog range and the ceiling itself', () => {
    expect(
      captionEmViolations({ background: { color: '#fff', radius: 0.35, paddingX: 0.45, paddingY: 0.3 } }, portrait),
    ).toEqual([]);
    expect(
      captionEmViolations({ background: { color: '#fff', paddingX: MAX_CAPTION_EM_VALUE } }, portrait),
    ).toEqual([]);
    expect(captionEmViolations(null, portrait)).toEqual([]);
  });
});

const cue = (id: string, words: string[], extra: Partial<Clip> = {}): Clip =>
  ({
    id,
    assetId: '__caption__',
    trackId: 'c',
    start: 0,
    end: 1,
    sourceStart: 0,
    sourceEnd: 1,
    effects: [],
    keyframes: [],
    captionCue: {
      text: words.join(' '),
      words: words.map((word, i) => ({ word, start: i, end: i + 0.5 })),
    },
    ...extra,
  }) as Clip;

describe('resolveCaptionStyle layers cue over track over template', () => {
  it('takes the template’s chip when neither the track nor the cue sets one', () => {
    const track = { id: 'c', type: 'caption', clips: [], captionStyle: { templateId: 'tag' } } as unknown as Track;
    const resolved = resolveCaptionStyle(cue('x', ['hi']), track);
    expect(resolved?.background).toEqual({ color: '#ffffff', radius: 0.35, paddingX: 0.45, paddingY: 0.3 });
  });

  it('lets an authored chip replace the template’s whole', () => {
    const track = {
      id: 'c',
      type: 'caption',
      clips: [],
      captionStyle: { templateId: 'tag', background: { color: '#000', paddingX: 18 } },
    } as unknown as Track;
    expect(resolveCaptionStyle(cue('x', ['hi']), track)?.background).toEqual({ color: '#000', paddingX: 18 });
  });

  it('is undefined for an unstyled cue on an unstyled track', () => {
    expect(resolveCaptionStyle(cue('x', ['hi']), { id: 'c', type: 'caption', clips: [] } as unknown as Track)).toBeUndefined();
  });
});

describe('emphasisCoverageNote says how many cues an accent reached', () => {
  const project = (keywords: string[], cues: Clip[]): Project =>
    ({
      timeline: {
        tracks: [
          { id: 'c', type: 'caption', clips: cues, captionStyle: { accent: { mode: 'keywords', keywords } } },
        ],
      },
    }) as unknown as Project;

  it('counts hits per keyword and cues reached, and flags a keyword on no cue', () => {
    const note = emphasisCoverageNote(
      project(
        ['stop scrolling', '8 principles', 'top 1'],
        [cue('a', ['founders', 'stop', 'scrolling,']), cue('b', ['there', 'are', '8', 'principles']), cue('c', ['top']), cue('d', ['1%', 'of'])],
      ),
      'c',
    );
    expect(note).toContain('emphasis lands on 2 of 4 cues');
    expect(note).toContain('"stop scrolling" ×1');
    expect(note).toContain('"8 principles" ×1');
    expect(note).toContain('"top 1" ×0');
    expect(note).toMatch(/"top 1" is in the transcript but on no cue/);
  });

  it('says so when the track has no cues to accent', () => {
    expect(emphasisCoverageNote(project(['x'], []), 'c')).toContain('no cues yet');
  });

  it('is silent without a keyword accent or a track', () => {
    expect(emphasisCoverageNote(project([], [cue('a', ['x'])]), 'c')).toBe('');
    expect(emphasisCoverageNote(project(['x'], []), 'nope')).toBe('');
    expect(emphasisCoverageNote(project(['x'], []), 7)).toBe('');
  });
});
