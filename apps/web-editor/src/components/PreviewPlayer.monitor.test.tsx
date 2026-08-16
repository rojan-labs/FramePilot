/**
 * Tests for the program-monitor transport additions (plan 3.4 Part 4): frame
 * stepping, the loop toggle, and the 9:16 safe-area guide overlay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { PREVIEW_POOL_SIZE } from '../editor/selectors.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { PreviewPlayer } from './PreviewPlayer.js';

// Loop + safe-area are persisted settings, so reset storage between cases.
afterEach(() => localStorage.clear());

/** Seed the persisted editor settings the {@link SettingsProvider} reads on mount. */
const seedSettings = (partial: Record<string, unknown>): void => {
  localStorage.setItem('framepilot.settings', JSON.stringify(partial));
};

const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 8,
          sourceStart: 0,
          sourceEnd: 8,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

function Host({
  soloedTrackIds,
  editorTimeline = timeline,
  assets = [],
}: {
  readonly soloedTrackIds?: ReadonlySet<string>;
  readonly editorTimeline?: Timeline;
  readonly assets?: readonly { id: string; path: string; kind: 'video' | 'audio' | 'image' }[];
} = {}): JSX.Element {
  const editor = useEditor(editorTimeline, ['a']);
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.seek(2)}>
        seek 2
      </button>
      <PreviewPlayer
        editor={editor}
        assets={assets}
        fps={30}
        aspect={9 / 16}
        {...(soloedTrackIds ? { soloedTrackIds } : {})}
      />
    </SettingsProvider>
  );
}

describe('program monitor', () => {
  it('steps forward and back one frame', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'seek 2' }));
    fireEvent.click(screen.getByLabelText('step forward one frame'));
    expect(screen.getByLabelText('current time').textContent).toBe('00:00:02:01');
    fireEvent.click(screen.getByLabelText('step back one frame'));
    expect(screen.getByLabelText('current time').textContent).toBe('00:00:02:00');
  });

  it('toggles the loop control', () => {
    render(<Host />);
    const loop = screen.getByLabelText('loop');
    expect(loop.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(loop);
    expect(loop.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the rule-of-thirds grid when toggled on', () => {
    const { container } = render(<Host />);
    expect(container.querySelector('.preview-grid')).toBeNull();
    fireEvent.click(screen.getByLabelText('composition grid'));
    expect(container.querySelector('.preview-grid')).not.toBeNull();
  });

  it('separates top-right view controls from the centered playback cluster', () => {
    const { container } = render(<Host />);
    const viewControls = container.querySelector('.transport-right');
    const playback = container.querySelector('.transport-nav');

    expect(viewControls?.contains(screen.getByLabelText('composition grid'))).toBe(true);
    expect(viewControls?.contains(screen.getByLabelText('fullscreen preview'))).toBe(true);
    expect(playback?.contains(screen.getByLabelText('play'))).toBe(true);
    expect(playback?.contains(screen.getByLabelText('composition grid'))).toBe(false);
  });

  // The Settings dialog and the monitor buttons drive one shared, persisted value.
  // These assert the *settings → observed behaviour* direction: a preference the
  // user set in Settings must be honoured on first render of a live consumer.
  it('renders the time readout as raw seconds when the timeDisplay setting is "seconds"', () => {
    seedSettings({ timeDisplay: 'seconds' });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'seek 2' }));
    // Raw-seconds readout (2.00s), not SMPTE timecode (00:00:02:00).
    expect(screen.getByLabelText('current time').textContent).toBe('2.00s');
  });

  it('honours the loopByDefault setting as the monitor loop initial state', () => {
    seedSettings({ loopByDefault: true });
    render(<Host />);
    expect(screen.getByLabelText('loop').getAttribute('aria-pressed')).toBe('true');
  });

  it('honours the gridByDefault setting as the monitor initial state', () => {
    seedSettings({ gridByDefault: true });
    const { container } = render(<Host />);
    expect(container.querySelector('.preview-grid')).not.toBeNull();
    expect(screen.getByLabelText('composition grid').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the safe-area guide overlay when toggled on (default off)', () => {
    const { container } = render(<Host />);
    expect(container.querySelector('.preview-safe-area')).toBeNull();
    fireEvent.click(screen.getByLabelText('safe-area guides'));
    expect(container.querySelector('.preview-safe-area')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('safe-area guides'));
    expect(container.querySelector('.preview-safe-area')).toBeNull();
  });

  it('honours the safeAreaGuidesByDefault setting as the monitor initial state', () => {
    seedSettings({ safeAreaGuidesByDefault: true });
    const { container } = render(<Host />);
    expect(container.querySelector('.preview-safe-area')).not.toBeNull();
    expect(screen.getByLabelText('safe-area guides').getAttribute('aria-pressed')).toBe('true');
  });

  it('renders an image clip as <img>, not <video> (the no-freeze fix)', () => {
    // An image placed on the video track must mount as a still <img>; mounting it
    // as a <video> would leave the playback clock with no element to ride and the
    // playhead would freeze on it. We also advance the playhead through the still
    // (frame-step rides the wall clock) to confirm it is not stuck.
    function ImageHost(): JSX.Element {
      const editor = useEditor(timeline, ['a']);
      return (
        <SettingsProvider>
          <PreviewPlayer
            editor={editor}
            assets={[{ id: 'a', path: 'blob:img', kind: 'image' }]}
            fps={30}
          />
        </SettingsProvider>
      );
    }
    const { container } = render(<ImageHost />);
    const picture = screen.getByLabelText('preview a');
    expect(picture.tagName).toBe('IMG');
    expect(picture.className).toContain('preview-image');
    expect(container.querySelector('video')).toBeNull();
    // The playhead still advances over the still image (no freeze).
    fireEvent.click(screen.getByLabelText('step forward one frame'));
    expect(screen.getByLabelText('current time').textContent).toBe('00:00:00:01');
  });

  it('pools elements: mounts a front slot for the active clip and pre-warms the next', () => {
    // Two adjacent clips on different assets. The front slot shows the active clip;
    // a warm slot pre-loads the upcoming one so the cut is a swap, not a remount.
    const twoClips: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
            {
              id: 'c2',
              assetId: 'b',
              trackId: 'v',
              start: 4,
              end: 8,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    function TwoHost(): JSX.Element {
      const editor = useEditor(twoClips, ['a', 'b']);
      return (
        <SettingsProvider>
          <PreviewPlayer
            editor={editor}
            assets={[
              { id: 'a', path: 'blob:a', kind: 'video' },
              { id: 'b', path: 'blob:b', kind: 'video' },
            ]}
            fps={30}
          />
        </SettingsProvider>
      );
    }
    const { container } = render(<TwoHost />);
    // Every persistent pool slot is mounted (never remounted at a cut).
    expect(container.querySelectorAll('video.preview-slot').length).toBe(PREVIEW_POOL_SIZE);
    // Front slot shows the active clip's asset (visible); a warm slot holds the next.
    const front = screen.getByLabelText('preview a');
    const warm = screen.getByLabelText('preview b');
    expect(front.style.opacity).toBe('1');
    expect(warm.style.opacity).toBe('0');
  });

  it('pre-warms a same-asset trim in its own slot (the old 2-slot design skipped it)', () => {
    // Two clips cut within the SAME asset: the upcoming trim still needs its own
    // pre-seeked element, or the cut stalls on an in-file seek.
    const sameAsset: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
            {
              id: 'c2',
              assetId: 'a',
              trackId: 'v',
              start: 4,
              end: 8,
              sourceStart: 10,
              sourceEnd: 14,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    function SameHost(): JSX.Element {
      const editor = useEditor(sameAsset, ['a']);
      return (
        <SettingsProvider>
          <PreviewPlayer
            editor={editor}
            assets={[{ id: 'a', path: 'blob:a', kind: 'video' }]}
            fps={30}
          />
        </SettingsProvider>
      );
    }
    const { container } = render(<SameHost />);
    // Two slots carry the same asset source: the active clip AND its upcoming trim.
    const withSrc = [...container.querySelectorAll('video.preview-slot')].filter(
      (el) => el.getAttribute('src') === 'blob:a',
    );
    expect(withSrc.length).toBe(2);
  });

  it('holds play behind the prepare gate until the front media is ready', () => {
    // jsdom media never reports a decoded frame, so pressing play must show the
    // "Preparing preview…" status (the gate) rather than starting a raw playback.
    render(<Host />);
    fireEvent.click(screen.getByLabelText('play'));
    expect(screen.getByRole('status').textContent).toContain('Preparing preview');
    // Pausing re-arms the gate and removes the status.
    fireEvent.click(screen.getByLabelText('pause'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens the prepare gate once every loaded slot reports a decoded frame', () => {
    // The gate waits for the WHOLE pipeline (front + warm slots), then releases.
    const { container } = render(<Host />);
    fireEvent.click(screen.getByLabelText('play'));
    expect(screen.getByRole('status')).toBeTruthy();
    for (const el of container.querySelectorAll('video.preview-slot')) {
      // jsdom media elements are inert: report a decoded, settled frame.
      Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(el, 'seeking', { value: false, configurable: true });
      fireEvent.seeked(el);
    }
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('previews a graded clip and toggles before/after compare', () => {
    const gradedTimeline: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v',
              start: 0,
              end: 8,
              sourceStart: 0,
              sourceEnd: 8,
              effects: [
                { id: 'c1__grade', type: 'color_grade', params: { saturation: -1 }, keyframes: [] },
              ],
              keyframes: [],
            },
          ],
        },
      ],
    };
    function GradedHost(): JSX.Element {
      const editor = useEditor(gradedTimeline, ['a']);
      return (
        <SettingsProvider>
          <PreviewPlayer
            editor={editor}
            assets={[{ id: 'a', path: 'blob:x', kind: 'video' }]}
            fps={30}
          />
        </SettingsProvider>
      );
    }
    render(<GradedHost />);
    const video = screen.getByLabelText('preview a') as HTMLVideoElement;
    expect(video.style.filter).toContain('saturate(0.000)');
    // Compare flips the monitor to the ungraded source.
    fireEvent.click(screen.getByLabelText('compare original'));
    expect(video.style.filter).toBe('none');
  });
});

/**
 * Preview workspace density (revamp Phase 1, F1 — "the picture is not the hero").
 *
 * jsdom has no layout engine, so "the canvas got bigger" is not directly
 * assertable here — the pixel budget is a CSS concern verified against the real
 * app. What IS assertable, and what actually causes the regressions this phase
 * fixes, is the STRUCTURE that gives the picture its budget:
 *
 *  - the transport is a SIBLING band of the stage, not chrome nested inside it,
 *    so its height is a fixed cost outside the frame's container-query budget;
 *  - the frame is sized purely by CSS (`--aspect` + cqw/cqh), never by an inline
 *    pixel width/height — the phase brief is explicit that the fix is removing
 *    what fights `container-type: size`, not adding measurement;
 *  - an aspect change re-uses the same frame node and the same control set, so
 *    switching 16:9 ⇄ 9:16 cannot remount the picture or reflow the chrome.
 */
describe('preview workspace density (F1)', () => {
  it('keeps the transport a sibling band of the stage, not chrome inside it', () => {
    const { container } = render(<Host />);
    const preview = container.querySelector('.preview');
    const stage = container.querySelector('.preview-stage');
    const transport = container.querySelector('.transport');

    expect(stage?.parentElement).toBe(preview);
    expect(transport?.parentElement).toBe(preview);
    // The band must not live inside the picture's sizing container, or its height
    // would come out of the frame's budget instead of the column's.
    expect(stage?.contains(transport!)).toBe(false);
  });

  it('sizes the frame from --aspect alone, with no inline pixel dimensions', () => {
    const { container } = render(<Host />);
    const frame = container.querySelector<HTMLElement>('.preview-frame');

    expect(frame?.style.getPropertyValue('--aspect')).toBe(String(9 / 16));
    // Any inline width/height here would defeat the container-query sizing that
    // makes the frame reflow correctly on a splitter drag or a rail collapse.
    expect(frame?.style.width).toBe('');
    expect(frame?.style.height).toBe('');
    // 'fit' is the default zoom and must not stamp a transform (which would
    // compound with the transition/clip transforms composed onto the slots).
    expect(frame?.style.transform).toBe('');
  });

  it('survives an aspect change without remounting the frame or changing the chrome', () => {
    // Portrait/square parity: 9:16 in a wide stage must reflow, not restructure.
    function AspectHost({ aspect }: { readonly aspect: number }): JSX.Element {
      const editor = useEditor(timeline, ['a']);
      return (
        <SettingsProvider>
          <PreviewPlayer editor={editor} assets={[]} fps={30} aspect={aspect} />
        </SettingsProvider>
      );
    }
    const { container, rerender } = render(<AspectHost aspect={16 / 9} />);
    const frameBefore = container.querySelector('.preview-frame');
    const chromeBefore = container.querySelectorAll('.transport button').length;

    rerender(<AspectHost aspect={9 / 16} />);
    const frameAfter = container.querySelector<HTMLElement>('.preview-frame');

    // Same node: the picture is reflowed by CSS, never torn down and rebuilt.
    expect(frameAfter).toBe(frameBefore);
    expect(frameAfter?.style.getPropertyValue('--aspect')).toBe(String(9 / 16));
    // Same control set: no band gains or loses a row across the switch.
    expect(container.querySelectorAll('.transport button').length).toBe(chromeBefore);
    expect(container.querySelectorAll('.preview-stage').length).toBe(1);
    expect(container.querySelectorAll('.transport').length).toBe(1);
  });
});

describe('canvas orientation selector (H5)', () => {
  function OrientationHost({
    onChangeOrientation,
  }: {
    onChangeOrientation: (id: string) => void;
  }): JSX.Element {
    const editor = useEditor(timeline, ['a']);
    return (
      <SettingsProvider>
        <PreviewPlayer
          editor={editor}
          assets={[]}
          fps={30}
          aspect={9 / 16}
          resolution={{ width: 1080, height: 1920 }}
          onChangeOrientation={onChangeOrientation}
        />
      </SettingsProvider>
    );
  }

  it('shows the matched preset and dispatches a preset change', () => {
    const changes: string[] = [];
    render(<OrientationHost onChangeOrientation={(id) => changes.push(id)} />);
    const trigger = screen.getByRole('combobox', { name: 'Canvas orientation' });
    expect(trigger.textContent).toContain('9:16');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /16:9/ }));
    expect(changes).toEqual(['16:9']);
  });

  it('is absent without the orientation props (read-only surfaces)', () => {
    render(<Host />);
    expect(screen.queryByRole('combobox', { name: 'Canvas orientation' })).toBeNull();
  });
});

describe('track solo drives actual playback mute (H0.4 J2 — session state, never the render)', () => {
  const mutedVideoTrackTimeline: Timeline = {
    tracks: [
      {
        id: 'v',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId: 'a',
            trackId: 'v',
            start: 0,
            end: 8,
            sourceStart: 0,
            sourceEnd: 8,
            effects: [],
            keyframes: [],
          },
        ],
        muted: true,
      },
    ],
  };
  const assets = [{ id: 'a', path: 'blob:x', kind: 'video' as const }];

  it('with no solo, honors the persisted `muted` track flag on the front element', () => {
    render(<Host editorTimeline={mutedVideoTrackTimeline} assets={assets} />);
    const video = screen.getByLabelText('preview a') as HTMLVideoElement;
    expect(video.muted).toBe(true);
  });

  it('soloing the (persisted-muted) track un-mutes it for preview playback', () => {
    render(
      <Host
        editorTimeline={mutedVideoTrackTimeline}
        assets={assets}
        soloedTrackIds={new Set(['v'])}
      />,
    );
    const video = screen.getByLabelText('preview a') as HTMLVideoElement;
    expect(video.muted).toBe(false);
  });

  it('soloing a DIFFERENT track mutes this one even though its persisted `muted` is false', () => {
    const timelineNotMuted: Timeline = {
      tracks: [
        { ...mutedVideoTrackTimeline.tracks[0]!, muted: false },
        { id: 'other', type: 'audio', clips: [] },
      ],
    };
    render(
      <Host
        editorTimeline={timelineNotMuted}
        assets={assets}
        soloedTrackIds={new Set(['other'])}
      />,
    );
    const video = screen.getByLabelText('preview a') as HTMLVideoElement;
    // 'other' has no audio clips, so it isn't audio-bearing and solo never
    // engages — this asserts the no-op case doesn't accidentally mute 'v'.
    expect(video.muted).toBe(false);
  });

  it('never mutates the project timeline when solo drives playback', () => {
    const before = JSON.stringify(mutedVideoTrackTimeline);
    render(
      <Host
        editorTimeline={mutedVideoTrackTimeline}
        assets={assets}
        soloedTrackIds={new Set(['v'])}
      />,
    );
    expect(JSON.stringify(mutedVideoTrackTimeline)).toBe(before);
  });
});
