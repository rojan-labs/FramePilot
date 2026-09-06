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

  it('offers muting only when the audio on the timeline is music', () => {
    // A voice-over on an audio track is not music: the demo project offered "Mute the
    // music track" over `voiceover.wav` and nothing else. Music is a track labelled with
    // the music role, or an audio asset whose file name says so.
    const voiceOver = project({
      timeline: {
        tracks: [
          { id: 'v', type: 'video', clips: [clip('c1', 'v')] },
          { id: 'a', type: 'audio', clips: [clip('c2', 'a')] },
        ],
      },
    });
    expect(starterPrompts(voiceOver)).not.toContain('Mute the music track');
    const labelled = {
      ...voiceOver,
      timeline: {
        ...voiceOver.timeline,
        tracks: voiceOver.timeline.tracks.map((track) =>
          track.id === 'a' ? { ...track, role: 'music' as const } : track,
        ),
      },
    };
    expect(starterPrompts(labelled)).toContain('Mute the music track');
    const named = {
      ...voiceOver,
      assets: [
        ...voiceOver.assets,
        { id: 'asset_music', path: 'media/beat-100bpm.wav', kind: 'audio' as const, durationSeconds: 30 },
      ],
      timeline: {
        ...voiceOver.timeline,
        tracks: voiceOver.timeline.tracks.map((track) =>
          track.id === 'a'
            ? { ...track, clips: [{ ...track.clips[0]!, assetId: 'asset_music' }] }
            : track,
        ),
      },
    };
    expect(starterPrompts(named)).toContain('Mute the music track');
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
