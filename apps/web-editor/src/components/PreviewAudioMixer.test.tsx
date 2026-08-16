/**
 * Tests for the preview audio mixer — the audio bus that plays audio-only clips
 * (music/VO/SFX) the program monitor's single <video> cannot carry. jsdom has no
 * media clock, so these assert the *mounted elements and their gain*, not audible
 * playback (the transport/seek effects are v8-ignored, verified in e2e).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { PreviewAudioMixer } from './PreviewAudioMixer.js';

const audioClip = (
  id: string,
  start: number,
  end: number,
  effects: Clip['effects'] = [],
): Clip => ({
  id,
  assetId: 'song',
  trackId: 'a',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects,
  keyframes: [],
});

const assets: Asset[] = [
  { id: 'song', path: '/media/Rise_Up.mp3', kind: 'audio' },
  { id: 'shot', path: '/media/shot.mp4', kind: 'video' },
];

// The default playhead is 0, which sits inside every [0, 20) clip below.
function Host({
  timeline,
  soloedTrackIds,
}: {
  timeline: Timeline;
  soloedTrackIds?: ReadonlySet<string>;
}): JSX.Element {
  const editor = useEditor(timeline, ['song', 'shot']);
  return (
    <PreviewAudioMixer
      editor={editor}
      assets={assets}
      {...(soloedTrackIds ? { soloedTrackIds } : {})}
    />
  );
}

describe('PreviewAudioMixer', () => {
  it('mounts an <audio> element for the audio-only clip under the playhead', () => {
    const timeline: Timeline = {
      tracks: [{ id: 'a', type: 'audio', clips: [audioClip('music', 0, 20)] }],
    };
    const { container } = render(<Host timeline={timeline} />);
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toContain('Rise_Up.mp3');
    // Unity gain → full element volume.
    expect((audio as HTMLAudioElement).volume).toBe(1);
  });

  it('applies the clip gain to the element volume and mutes a muted clip', () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: 'a',
          type: 'audio',
          clips: [
            audioClip('soft', 0, 20, [
              { id: 'g', type: 'audio_gain', params: { gainDb: -20 }, keyframes: [] },
            ]),
          ],
        },
      ],
    };
    const { container } = render(<Host timeline={timeline} />);
    expect((container.querySelector('audio') as HTMLAudioElement).volume).toBeCloseTo(0.1, 6);
  });

  it('does not mount audio for a muted track or for a video clip (footage rides the monitor)', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'a', type: 'audio', clips: [audioClip('music', 0, 20)], muted: true },
        { id: 'v', type: 'video', clips: [{ ...audioClip('shot', 0, 20), assetId: 'shot' }] },
      ],
    };
    const { container } = render(<Host timeline={timeline} />);
    expect(container.querySelector('audio')).toBeNull();
  });

  describe('track solo (H0.4 J2 — session state; never mutates the project)', () => {
    it('soloing a muted track still mounts and plays it (solo overrides the persisted flag)', () => {
      const timeline: Timeline = {
        tracks: [{ id: 'a', type: 'audio', clips: [audioClip('music', 0, 20)], muted: true }],
      };
      const { container } = render(<Host timeline={timeline} soloedTrackIds={new Set(['a'])} />);
      const audio = container.querySelector('audio') as HTMLAudioElement | null;
      expect(audio).not.toBeNull();
      expect(audio?.volume).toBe(1);
    });

    it('soloing a different track silences one that is not persisted-muted', () => {
      const timeline: Timeline = {
        tracks: [
          { id: 'a', type: 'audio', clips: [audioClip('music', 0, 20)] },
          { id: 'b', type: 'audio', clips: [audioClip('vo', 0, 20)] },
        ],
      };
      const { container } = render(<Host timeline={timeline} soloedTrackIds={new Set(['b'])} />);
      expect(container.querySelectorAll('audio').length).toBe(1);
    });

    it('never mutates the timeline/track objects while resolving solo', () => {
      const timeline: Timeline = {
        tracks: [{ id: 'a', type: 'audio', clips: [audioClip('music', 0, 20)], muted: true }],
      };
      const before = JSON.stringify(timeline);
      render(<Host timeline={timeline} soloedTrackIds={new Set(['a'])} />);
      expect(JSON.stringify(timeline)).toBe(before);
    });
  });
});
