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
