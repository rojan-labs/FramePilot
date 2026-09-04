/**
 * What `caption_the_edit` says about how its cues will LOOK.
 *
 * The tool writes cue text and cue timing and never touches the track's design, and its
 * note said nothing about that — so run `e8cb2636` captioned the edit, told the editor the
 * cues were "already styled to a boxed template", and moved on with nothing styled. The
 * claim was invented out of the silence, and the fact needed to contradict it existed at
 * the moment the note was written.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Track } from '@framepilot/timeline-schema';
import { captionStyleNote } from './orchestrator.js';
import { getTool } from './tool-registry.js';
import { makeProject } from './__fixtures__/project.js';

const track = (id: string, extra: Partial<Track> = {}): Track =>
  ({ id, type: 'caption', clips: [], ...extra }) as Track;

const project = (tracks: readonly Track[]): Project =>
  ({ timeline: { tracks } }) as unknown as Project;

describe('captionStyleNote', () => {
  it('says the cues are unstyled, and names the two tools that style them', () => {
    const note = captionStyleNote(project([track('captions_main')]), 'captions_main');
    expect(note).toContain('no track style yet');
    expect(note).toContain('set_track_caption_style');
    expect(note).toContain('auto_emphasize_captions');
  });

  it('says nothing when the track already carries a style', () => {
    // Nothing left to do about it, so nothing to say — a note that repeated itself every
    // re-caption would be noise the model learns to skip.
    const styled = track('captions_main', {
      captionStyle: { templateId: 'boxed' },
    } as Partial<Track>);
    expect(captionStyleNote(project([styled]), 'captions_main')).toBe('');
  });

  it('says nothing about a track that is not there', () => {
    expect(captionStyleNote(project([]), 'captions_main')).toBe('');
    expect(captionStyleNote(project([track('captions_main')]), undefined)).toBe('');
    expect(captionStyleNote(project([track('captions_main')]), 42)).toBe('');
  });
});

/**
 * Run `137d8fd0` sent one `set_track_caption_style` call carrying
 * `fontWeight: "bold"` and `background: "rgba(0,0,0,0.6)"`, and was refused for both:
 * "captionStyle.fontWeight: Invalid input: expected number, received string;
 * captionStyle.background: Invalid input: expected object, received string". The captions
 * it had just written kept the plain default look for the rest of the run.
 *
 * The persisted schema takes 100–900 because a weight is a real font file, and a chip is
 * an object because it has a radius and padding. Both stay. The model writes CSS, so the
 * tool boundary translates the two spellings — and only those two.
 */
describe('a caption style written in CSS spelling', () => {
  const style = (captionStyle: unknown) => {
    const tool = getTool('set_track_caption_style');
    if (!tool || tool.kind !== 'mutate') throw new Error('not a mutate tool');
    return tool.buildOps(
      { trackId: 'captions_main', captionStyle },
      { project: makeProject() },
    )[0] as { captionStyle: Record<string, unknown> };
  };

  it('reads a font-weight keyword as its number', () => {
    expect(style({ fontWeight: 'bold' }).captionStyle.fontWeight).toBe(700);
    expect(style({ fontWeight: 'Black' }).captionStyle.fontWeight).toBe(900);
    expect(style({ fontWeight: 'regular' }).captionStyle.fontWeight).toBe(400);
    expect(style({ fontWeight: '800' }).captionStyle.fontWeight).toBe(800);
  });

  it('reads a bare colour where a background chip belongs', () => {
    expect(style({ background: 'rgba(0,0,0,0.6)' }).captionStyle.background).toEqual({
      color: 'rgba(0,0,0,0.6)',
    });
  });

  it('leaves the authored spelling alone when it is already right', () => {
    expect(style({ fontWeight: 600 }).captionStyle.fontWeight).toBe(600);
    expect(style({ background: { color: '#000', radius: 0.2 } }).captionStyle.background).toEqual({
      color: '#000',
      radius: 0.2,
    });
  });

  it('still refuses a weight that is not one', () => {
    expect(() => style({ fontWeight: 'chunky' })).toThrow();
    expect(() => style({ fontWeight: 1400 })).toThrow();
  });
});
