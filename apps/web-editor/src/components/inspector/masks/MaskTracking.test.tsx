/**
 * The Inspector's per-mask tracking panel (MK7.4).
 *
 * What is asserted is the contract between the panel and main, and between the panel and the
 * project: the request carries the method, the direction and the editor's tracking hints; a
 * finished track lands on the SELECTED mask as one reversible edit; the review list shows the
 * ranges the measurement flagged; a constraint is recorded on the frame the editor is on.
 *
 * (This replaces the clip-wide "Measure and follow" buttons, which could only steer one
 * hard-coded mask's bounding box.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MaskLayerSchema, masksOf, type Asset, type Timeline } from '@framepilot/timeline-schema';
import type { MaskTrackResultWire } from '@framepilot/shared-types';
import { useEditor } from '../../../editor/useEditor.js';
import { MaskTracking } from './MaskTracking.js';
import { MaskToolStore } from './useMaskTools.js';

const bridge = vi.hoisted(() => ({
  capabilityPackTrackMask: vi.fn(),
  onCapabilityPackTrackProgress: vi.fn(() => () => {}),
  capabilityPackCancelTrack: vi.fn(),
}));

vi.mock('../../../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

afterEach(() => {
  bridge.capabilityPackTrackMask.mockReset();
});

const KEY = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

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
          effects: [],
          masks: [
            MaskLayerSchema.parse({
              id: 'm1',
              kind: 'rectangle',
              cx: 768,
              cy: 432,
              width: 768,
              height: 432,
            }),
          ],
          keyframes: [],
        },
      ],
    },
  ],
};

const assets: Asset[] = [
  {
    id: 'a',
    path: '/media/a.mp4',
    kind: 'video',
    durationSeconds: 4,
    media: { width: 1920, height: 1080 },
  },
];

function result(flagged: readonly { start: number; end: number }[] = []): MaskTrackResultWire {
  return {
    ok: true,
    artifact: { key: KEY, sha256: SHA },
    method: 'position',
    frames: 120,
    flagged,
    worstResidualPx: 0.3,
    engine: 'framepilot.tracking-lite@1.0.0',
    projectRevision: 0,
  };
}

function host(store: MaskToolStore): () => JSX.Element {
  return function Host(): JSX.Element {
    const editor = useEditor(timeline, { assets });
    const clip = editor.state.timeline.tracks[0]!.clips[0]!;
    const mask = masksOf(clip).find((layer) => layer.id === 'm1');
    return (
      <>
        <span data-testid="tracked">{mask?.tracking === undefined ? 'no' : 'yes'}</span>
        <span data-testid="constraints">{mask?.tracking?.constraints.length ?? 0}</span>
        <MaskTracking editor={editor} clip={clip} fps={30} store={store} />
      </>
    );
  };
}

function selected(): MaskToolStore {
  const store = new MaskToolStore();
  store.selectMask('m1');
  return store;
}

/** The Inspector's selects are listboxes, not native `select` elements. */
function choose(label: string, option: string): void {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

async function track(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Track this mask' }));
  await waitFor(() => expect(bridge.capabilityPackTrackMask).toHaveBeenCalledTimes(1));
}

describe('the tracking panel', () => {
  it('asks for a mask before it offers to track anything', () => {
    const Host = host(new MaskToolStore());
    render(<Host />);
    expect(screen.getByText(/Select a mask to track it/)).toBeTruthy();
  });

  it('sends the chosen method, direction and hints, and pins the result on the mask', async () => {
    bridge.capabilityPackTrackMask.mockResolvedValue(result());
    const store = selected();
    store.toggleFeaturePoint({ x: 100, y: 200 });
    store.addExclusion({ x: 0, y: 0, width: 50, height: 50 });
    const Host = host(store);
    render(<Host />);
    choose('tracking method', 'Perspective');
    choose('tracking direction', 'Both ways');
    await track();
    const intent = bridge.capabilityPackTrackMask.mock.calls[0]![0] as Record<string, unknown>;
    expect(intent['clipId']).toBe('c1');
    expect(intent['maskId']).toBe('m1');
    expect(intent['method']).toBe('perspective');
    expect(intent['direction']).toBe('both');
    expect(intent['featurePoints']).toEqual([{ x: 100, y: 200 }]);
    expect(intent['exclusions']).toEqual([{ x: 0, y: 0, width: 50, height: 50 }]);
    // No media path, no frame range: main derives both from the project it reads from disk.
    expect(intent['assetId']).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('tracked').textContent).toBe('yes'));
  });

  it('shows the ranges the measurement flagged, and says so when nothing needs review', async () => {
    bridge.capabilityPackTrackMask.mockResolvedValue(result([{ start: 1, end: 1.5 }]));
    const Host = host(selected());
    render(<Host />);
    await track();
    await waitFor(() => expect(screen.getByLabelText('track review')).toBeTruthy());
    expect(screen.getByRole('button', { name: '1.00s – 1.50s' })).toBeTruthy();
    expect(screen.getAllByText(/1 range\(s\) need review/).length).toBeGreaterThan(0);
  });

  it('records the frame the editor fixed as a constraint', async () => {
    bridge.capabilityPackTrackMask.mockResolvedValue(result([{ start: 1, end: 1.5 }]));
    const Host = host(selected());
    render(<Host />);
    await track();
    await waitFor(() => expect(screen.getByLabelText('track review')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lock this frame' }));
    await waitFor(() => expect(screen.getByTestId('constraints').textContent).toBe('1'));
    // Re-tracking is only offered once there is something to re-measure from.
    expect(
      screen.getByRole('button', { name: 'Re-track from constraints' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('surfaces a typed refusal from main without touching the project', async () => {
    bridge.capabilityPackTrackMask.mockResolvedValue({
      ok: false,
      code: 'target_lost',
      error: 'The tracker lost the subject. Move the playhead to a clearer frame and track again.',
      retryable: false,
    });
    const Host = host(selected());
    render(<Host />);
    await track();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/lost the subject/));
    expect(screen.getByTestId('tracked').textContent).toBe('no');
  });

  it('removes a track and leaves the mask its own animation', async () => {
    bridge.capabilityPackTrackMask.mockResolvedValue(result());
    const Host = host(selected());
    render(<Host />);
    await track();
    await waitFor(() => expect(screen.getByTestId('tracked').textContent).toBe('yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove track' }));
    await waitFor(() => expect(screen.getByTestId('tracked').textContent).toBe('no'));
  });
});
