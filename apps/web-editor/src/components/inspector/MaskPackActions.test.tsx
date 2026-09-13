/**
 * Inspector pack tracking: the measured result must actually steer the mask.
 *
 * Regression: "Follow silhouette" sends `subject.segment`, and the host answered
 * with `kind: 'segment'`, which this component refused — the button could never
 * succeed. Main now converts silhouettes to a track; the renderer also converts
 * a raw segmentation itself so an older host still works.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import type { TrackingRunResultWire } from '@framepilot/shared-types';
import { useEditor } from '../../editor/useEditor.js';
import { MaskPackActions } from './MaskPackActions.js';

const bridge = vi.hoisted(() => ({
  capabilityPackTrack: vi.fn(),
  onCapabilityPackTrackProgress: vi.fn(() => () => {}),
  capabilityPackCancelTrack: vi.fn(),
}));

vi.mock('../../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

afterEach(() => {
  bridge.capabilityPackTrack.mockReset();
});

const timeline: Timeline = {
  revision: 0,
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
          effects: [
            {
              id: 'c1__mask',
              type: 'mask',
              params: { shape: 'rectangle', bounds: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } },
              keyframes: [],
            },
          ],
          keyframes: [],
        },
      ],
    },
  ],
};

function Host(): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  const mask = clip.effects.find((effect) => effect.id === 'c1__mask');
  return (
    <>
      <span data-testid="mask-keyframes">{mask?.keyframes.length ?? 0}</span>
      <MaskPackActions editor={editor} clip={clip} fps={30} />
    </>
  );
}

const ENGINE = 'framepilot.subject-intelligence@1.0.0';

/** A 10x10 row-major RLE silhouette four pixels wide on row 2, shifted one pixel per frame. */
function segmentResult(): TrackingRunResultWire {
  return {
    ok: true,
    kind: 'segment',
    masks: Array.from({ length: 8 }, (_unused, frame) => ({
      frame,
      width: 10,
      height: 10,
      counts: [22 + (frame % 3), 4, 74 - (frame % 3)],
      confidence: 0.9,
    })),
    engine: ENGINE,
    backend: 'opencv-dnn',
    projectRevision: 0,
  } as TrackingRunResultWire;
}

function trackingResult(): TrackingRunResultWire {
  return {
    ok: true,
    kind: 'tracking',
    samples: Array.from({ length: 8 }, (_unused, frame) => ({
      frame,
      box: { x: 0.2 + frame * 0.005, y: 0.2, width: 0.4, height: 0.4 },
      confidence: 0.9,
      occluded: false,
    })),
    engine: ENGINE,
    backend: 'opencv-dnn',
    projectRevision: 0,
  } as TrackingRunResultWire;
}

async function followSilhouette(): Promise<void> {
  fireEvent.click(screen.getByRole('combobox', { name: 'pack follow mode' }));
  fireEvent.click(screen.getByRole('option', { name: 'Follow silhouette' }));
  fireEvent.click(screen.getByRole('button', { name: 'Measure and follow' }));
  await waitFor(() => expect(bridge.capabilityPackTrack).toHaveBeenCalledTimes(1));
}

describe('MaskPackActions', () => {
  it('Follow silhouette applies the host-converted track to the mask', async () => {
    bridge.capabilityPackTrack.mockResolvedValue(trackingResult());
    render(<Host />);

    await followSilhouette();

    expect(bridge.capabilityPackTrack.mock.calls[0]![0]).toMatchObject({
      capability: 'subject.segment',
      assetId: 'a',
      firstFrame: 0,
      fps: 30,
    });
    await waitFor(() => expect(Number(screen.getByTestId('mask-keyframes').textContent)).toBeGreaterThan(0));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('converts a raw segmentation result instead of refusing it', async () => {
    bridge.capabilityPackTrack.mockResolvedValue(segmentResult());
    render(<Host />);

    await followSilhouette();

    await waitFor(() => expect(Number(screen.getByTestId('mask-keyframes').textContent)).toBe(8 * 4));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still refuses a result that carries no track', async () => {
    bridge.capabilityPackTrack.mockResolvedValue({
      ok: true,
      kind: 'detect',
      detections: [],
      engine: ENGINE,
      backend: 'opencv-dnn',
      projectRevision: 0,
    } as unknown as TrackingRunResultWire);
    render(<Host />);

    await followSilhouette();

    expect((await screen.findByRole('alert')).textContent).toContain('did not return a track');
    expect(screen.getByTestId('mask-keyframes').textContent).toBe('0');
  });
});
