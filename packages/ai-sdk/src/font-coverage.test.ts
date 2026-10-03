/**
 * Script-coverage warnings for the styling tools whose results `trackStyleNote` does not carry:
 * a caption cue override, a re-caption, a new or restyled title. Desktop run `001be135` drew
 * Devanagari in a Latin-only accent font and nothing said why the words never showed.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Project } from '@framepilot/timeline-schema';
import { fontCoverageNote, scriptCoverageWarning } from './font-coverage.js';

const caption = (id: string, text: string, captionStyle?: unknown): Clip =>
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
    captionCue: { text, words: [] },
    ...(captionStyle === undefined ? {} : { captionStyle }),
  }) as Clip;

const title = (id: string, start: number, params: Record<string, unknown>): Clip =>
  ({
    id,
    assetId: '__text__',
    trackId: 't',
    start,
    end: start + 2,
    sourceStart: 0,
    sourceEnd: 2,
    effects: [{ id: `${id}__text`, type: 'text', params, keyframes: [] }],
    keyframes: [],
  }) as Clip;

const project = (tracks: unknown[]): Project =>
  ({ fps: 30, timeline: { revision: 1, tracks } }) as unknown as Project;

describe('fontCoverageNote', () => {
  it('warns about a cue override whose font lacks the cue’s script', () => {
    const doc = project([
      {
        id: 'c',
        type: 'caption',
        captionStyle: { fontFamily: 'Poppins' },
        clips: [caption('cue_1', 'लूफी यहाँ', { fontFamily: 'Anton' })],
      },
    ]);
    const note = fontCoverageNote('set_caption_style', doc, { clipId: 'cue_1' });
    expect(note).toContain(
      'the font "Anton" has no Devanagari glyphs, and 2 words it draws in this cue',
    );
    expect(note).toContain('Bundled fonts with Devanagari: Poppins, Teko.');
    expect(fontCoverageNote('set_caption_style', doc, { clipId: 'missing' })).toBe('');
  });

  it('warns after a re-caption when the track’s existing look cannot draw the new words', () => {
    const doc = project([
      {
        id: 'c',
        type: 'caption',
        captionStyle: { fontFamily: 'Bebas Neue' },
        clips: [caption('cue_1', 'Привет мир')],
      },
    ]);
    expect(fontCoverageNote('caption_the_edit', doc, { trackId: 'c' })).toContain(
      'the font "Bebas Neue" has no Cyrillic glyphs',
    );
  });

  it('finds the title add_text_layer placed, on whatever lane it landed', () => {
    const doc = project([
      {
        id: 't',
        type: 'overlay',
        clips: [title('text_t_0', 0, { text: 'Other', fontFamily: 'Anton' })],
      },
      {
        id: 't_2',
        type: 'overlay',
        clips: [title('text_t_2_0', 0, { text: 'שלום עולם', fontFamily: 'Anton' })],
      },
    ]);
    const note = fontCoverageNote('add_text_layer', doc, {
      trackId: 't',
      text: 'שלום עולם',
      start: 0,
      end: 2,
    });
    expect(note).toContain(
      'the font "Anton" has no Hebrew glyphs, and 2 words it draws in this title',
    );
    expect(note).toContain(
      'Bundled fonts with Hebrew: Open Sans, Rubik, Fredoka, Rubik Mono One, Amatic SC.',
    );
  });

  it('reads each lockup line in its own face', () => {
    const doc = project([
      {
        id: 't',
        type: 'overlay',
        clips: [
          title('text_t_0', 0, {
            text: 'KICKER\nलूफी',
            fontFamily: 'Poppins',
            typography: { lines: [{ fontFamily: 'Anton' }, {}] },
          }),
        ],
      },
    ]);
    // The Devanagari line is in Poppins (it has it); the Latin kicker is in Anton (fine).
    expect(fontCoverageNote('set_text_style', doc, { clipId: 'text_t_0' })).toBe('');
    const swapped = project([
      {
        id: 't',
        type: 'overlay',
        clips: [
          title('text_t_0', 0, {
            text: 'KICKER\nलूफी',
            fontFamily: 'Poppins',
            typography: { lines: [{}, { fontFamily: 'Anton' }] },
          }),
        ],
      },
    ]);
    expect(fontCoverageNote('set_text_style', swapped, { clipId: 'text_t_0' })).toContain(
      'the font "Anton" has no Devanagari glyphs, and 1 word it draws in this title is Devanagari ("लूफी")',
    );
  });

  it('answers nothing for other tools, or a title with no font named', () => {
    const doc = project([
      { id: 't', type: 'overlay', clips: [title('text_t_0', 0, { text: 'लूफी' })] },
    ]);
    expect(fontCoverageNote('set_text_style', doc, { clipId: 'text_t_0' })).toBe('');
    expect(fontCoverageNote('set_track_caption_style', doc, { trackId: 't' })).toBe('');
    expect(fontCoverageNote('add_clip', doc, null)).toBe('');
  });
});

describe('scriptCoverageWarning', () => {
  it('caps a long list of alternatives and points at the catalog', () => {
    const note = scriptCoverageWarning(
      [{ family: 'Bebas Neue', role: 'font', words: ['Привет'] }],
      'here',
    );
    expect(note).toMatch(/Bundled fonts with Cyrillic: (?:[^,]+, ){7}[^,]+, and \d+ more/);
    expect(note).toContain("discover_caption_styles lists each font's scripts");
  });

  it('ignores a family that is not bundled — the style tools refuse those', () => {
    expect(
      scriptCoverageWarning([{ family: 'Comic Sans', role: 'font', words: ['лол'] }], 'x'),
    ).toBe('');
  });
});
