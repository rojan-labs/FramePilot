/**
 * Edge/empty-state coverage the main integration test doesn't reach: an empty
 * transcript, a project with no caption track, and preview overlay text from a
 * text-overlay clip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { resetTranscriptionJobs } from '../editor/transcriptionJobs.js';
import { CaptionEditor } from './CaptionEditor.js';
import { PreviewPlayer } from './PreviewPlayer.js';

/** Render a component that needs a live `useEditor` against the given timeline. */
function Harness({
  timeline,
  children,
}: {
  timeline: Timeline;
  children: (editor: ReturnType<typeof useEditor>) => JSX.Element;
}): JSX.Element {
  const editor = useEditor(timeline);
  return children(editor);
}

const emptyTimeline: Timeline = { tracks: [] };

afterEach(() => act(() => resetTranscriptionJobs()));

describe('empty and edge states', () => {
  it('CaptionEditor reports a missing caption track and disables generation', () => {
    render(
      <Harness timeline={emptyTimeline}>
        {(e) => <CaptionEditor editor={e} transcript={[{ word: 'hi', start: 0, end: 1 }]} />}
      </Harness>,
    );
    expect(screen.getByText('No caption track in this project.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Generate captions' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('PreviewPlayer draws overlay text from a text-overlay clip at the playhead', () => {
    const overlayTimeline: Timeline = {
      tracks: [
        {
          id: 'overlay_1',
          type: 'overlay',
          clips: [
            {
              id: 'ov_1',
              assetId: '__text__',
              trackId: 'overlay_1',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [
                { id: 'ov_1__text', type: 'text', params: { text: 'Hello!' }, keyframes: [] },
              ],
              keyframes: [],
            },
          ],
        },
      ],
    };
    render(
      <Harness timeline={overlayTimeline}>
        {(e) => <PreviewPlayer editor={e} assets={[]} fps={30} />}
      </Harness>,
    );
    expect(screen.getByText('Hello!')).toBeDefined();
    expect(screen.getByText('No clip at the playhead')).toBeDefined(); // no video track
  });

  it('clicking an overlay text in the preview selects THAT overlay for on-canvas editing', () => {
    // Regression: clicking a text overlay used to fall through to the full-frame
    // select-hit and reselect the background clip, so the overlay was never editable
    // from the preview. Now the text is a selectable control that opens its on-canvas
    // editor (move/resize/double-click-to-edit).
    const overlayTimeline: Timeline = {
      tracks: [
        {
          id: 'overlay_1',
          type: 'overlay',
          clips: [
            {
              id: 'ov_1',
              assetId: '__text__',
              trackId: 'overlay_1',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [
                { id: 'ov_1__text', type: 'text', params: { text: 'Tap me' }, keyframes: [] },
              ],
              keyframes: [],
            },
          ],
        },
      ],
    };
    render(
      <Harness timeline={overlayTimeline}>
        {(e) => <PreviewPlayer editor={e} assets={[]} fps={30} />}
      </Harness>,
    );
    // Before selection: a plain, selectable overlay label — no on-canvas editor yet.
    const label = screen.getByRole('button', { name: /select text overlay ov_1/ });
    expect(screen.queryByLabelText('edit text overlay')).toBeNull();
    fireEvent.click(label);
    // After: the interactive on-canvas editor is mounted for this overlay.
    expect(screen.getByLabelText('edit text overlay')).toBeDefined();
  });

  it('PreviewPlayer plays a clip whose asset is an object URL (passthrough)', () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_1',
              assetId: 'asset_blob',
              trackId: 'video_1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    render(
      <Harness timeline={timeline}>
        {(e) => (
          <PreviewPlayer
            editor={e}
            assets={[{ id: 'asset_blob', path: 'blob:demo', kind: 'video', durationSeconds: 4 }]}
            fps={30}
          />
        )}
      </Harness>,
    );
    // An object URL is already playable and must pass through unchanged (not
    // rewritten to the fp-media:// scheme) so the <video> can render the imported media.
    const video = screen.getByLabelText('preview asset_blob') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('blob:demo');
  });

  it('PreviewPlayer play button toggles the shared transport state', () => {
    const timeline: Timeline = {
      tracks: [{ id: 'overlay_1', type: 'overlay', clips: [] }],
    };
    render(
      <Harness timeline={timeline}>
        {(e) => <PreviewPlayer editor={e} assets={[]} fps={30} />}
      </Harness>,
    );
    expect(screen.getByLabelText('play')).toBeDefined();
    fireEvent.click(screen.getByLabelText('play'));
    expect(screen.getByLabelText('pause')).toBeDefined();
    fireEvent.click(screen.getByLabelText('pause'));
    expect(screen.getByLabelText('play')).toBeDefined();
  });

  it('PreviewPlayer "go to start" jumps the playhead back to zero', () => {
    const timeline: Timeline = {
      tracks: [{ id: 'overlay_1', type: 'overlay', clips: [] }],
    };
    render(
      <Harness timeline={timeline}>
        {(e) => (
          <>
            <button type="button" onClick={() => e.seek(3)}>
              jump
            </button>
            <PreviewPlayer editor={e} assets={[]} fps={30} />
          </>
        )}
      </Harness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'jump' }));
    expect(screen.getByLabelText('current time').textContent).toBe('00:00:03:00');
    fireEvent.click(screen.getByLabelText('go to start'));
    expect(screen.getByLabelText('current time').textContent).toBe('00:00:00:00');
  });
});
