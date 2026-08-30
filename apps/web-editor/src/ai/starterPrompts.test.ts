import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { starterPrompts } from './starterPrompts.js';

const clip = (id: string, trackId: string): Record<string, unknown> => ({
  id,
  assetId: 'a',
  trackId,
  start: 0,
  end: 3,
  sourceStart: 0,
  sourceEnd: 3,
  effects: [],
  keyframes: [],
});

const project = (over: Record<string, unknown> = {}): Project =>
  parseProject({
    id: 'p',
    name: 'D',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [],
    timeline: { tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
    ...over,
  });

const videoOnly = project({
  timeline: { tracks: [{ id: 'v', type: 'video', clips: [clip('c1', 'v')] }] },
});

describe('starterPrompts (UX-02)', () => {
  // The finding verbatim: the panel offered these on a project that had neither.
  it('does not offer captions without a transcript, or muting without music', () => {
    const prompts = starterPrompts(videoOnly);
    expect(prompts).not.toContain('Add captions from the transcript');
    expect(prompts).not.toContain('Mute the music track');
    expect(prompts).toContain('Remove the silent gaps');
  });

  it('offers captions once there is a transcript to make them from', () => {
    const prompts = starterPrompts(
      project({
        timeline: videoOnly.timeline,
        transcript: [{ word: 'hello', start: 0, end: 1 }],
      }),
    );
    expect(prompts).toContain('Add captions from the transcript');
  });

  it('switches from making captions to restyling them once they exist', () => {
    const prompts = starterPrompts(
      project({
        timeline: {
          tracks: [
            { id: 'v', type: 'video', clips: [clip('c1', 'v')] },
            { id: 'cap', type: 'caption', clips: [clip('c2', 'cap')] },
          ],
        },
        transcript: [{ word: 'hello', start: 0, end: 1 }],
      }),
    );
    expect(prompts).toContain('Restyle the captions');
    expect(prompts).not.toContain('Add captions from the transcript');
  });

  it('offers muting only when there is audio on the timeline', () => {
    const prompts = starterPrompts(
      project({
        timeline: {
          tracks: [
            { id: 'v', type: 'video', clips: [clip('c1', 'v')] },
            { id: 'a', type: 'audio', clips: [clip('c2', 'a')] },
          ],
        },
      }),
    );
    expect(prompts).toContain('Mute the music track');
  });

  // The panel's first impression must never be blank, and the two unconditional
  // candidates are things the agent really can do with nothing on the timeline.
  it('always has something to offer, even on an empty project', () => {
    const prompts = starterPrompts(project());
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts).toContain('What’s in my footage?');
  });

  it('shows at most four', () => {
    const prompts = starterPrompts(
      project({
        timeline: {
          tracks: [
            { id: 'v', type: 'video', clips: [clip('c1', 'v')] },
            { id: 'a', type: 'audio', clips: [clip('c2', 'a')] },
          ],
        },
        transcript: [{ word: 'hello', start: 0, end: 1 }],
      }),
    );
    expect(prompts).toHaveLength(4);
  });
});
