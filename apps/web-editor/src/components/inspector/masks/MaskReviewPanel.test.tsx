/**
 * The shared review list (BR6.5).
 *
 * The assertions are about the promise the badge makes. VERIFIED must mean "every frame checked",
 * so it appears only when nothing is flagged; approving must be a reversible project edit, not a
 * UI flag; and an unapplied brush stroke must change nothing at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MaskLayerSchema, masksOf, type Asset, type Timeline } from '@framepilot/timeline-schema';
import { useEditor, type UseEditor } from '../../../editor/useEditor.js';
import { MaskReviewPanel } from './MaskReviewPanel.js';
import { MatteJobStore } from './matteJobStore.js';
import { MaskToolStore } from './useMaskTools.js';
import { rememberReviewReasons } from './matteReviewReasons.js';

const bridge = vi.hoisted(() => ({
  matteSaveCorrection: vi.fn(),
  capabilityPackMatte: vi.fn(),
  capabilityPackCancelMatte: vi.fn(),
  onCapabilityPackMatteProgress: vi.fn(() => () => {}),
}));

vi.mock('../../../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

const KEY = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

const assets: readonly Asset[] = [
  {
    id: 'a1',
    path: 'media/a1.mp4',
    kind: 'video',
    media: { width: 64, height: 36 },
  } as unknown as Asset,
];

function timeline(review: {
  flagged?: { start: number; end: number }[];
  approved?: { start: number; end: number }[];
  locked?: number[];
}): Timeline {
  return {
    revision: 1,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId: 'a1',
            trackId: 'v1',
            start: 0,
            end: 4,
            sourceStart: 0,
            sourceEnd: 4,
            effects: [],
            keyframes: [],
            masks: [
              MaskLayerSchema.parse({
                id: 'm1',
                kind: 'matte',
                artifact: {
                  key: KEY,
                  files: [{ name: 'matte.mkv', sha256: SHA }],
                  width: 64,
                  height: 36,
                  coverage: { sourceStart: 0, sourceEnd: 4 },
                  packId: 'smart-mask',
                  packVersion: '1',
                  modelDigests: [SHA],
                },
                review: { flagged: [], approved: [], locked: [], ...review },
              }),
            ],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

let editor: UseEditor;
let store: MaskToolStore;
let jobs: MatteJobStore;

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  const mask = masksOf(clip)[0]!;
  return (
    <MaskReviewPanel
      editor={editor}
      clip={clip}
      mask={mask}
      subject="matte"
      store={store}
      jobs={jobs}
    />
  );
}

const matte = () => {
  const mask = masksOf(editor.state.timeline.tracks[0]!.clips[0]!)[0]!;
  return mask.kind === 'matte' ? mask : null;
};

function mount(initial: Timeline): void {
  store = new MaskToolStore();
  jobs = new MatteJobStore();
  render(<Host initial={initial} />);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MaskReviewPanel', () => {
  it('shows VERIFIED only when nothing is flagged', () => {
    mount(timeline({ flagged: [], approved: [{ start: 0, end: 1 }] }));
    expect(screen.getByText('VERIFIED')).toBeTruthy();
    expect(screen.getByText('Every frame checked.')).toBeTruthy();
  });

  it('counts the moments and does not claim verification while any is flagged', () => {
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));
    expect(screen.queryByText('VERIFIED')).toBeNull();
    expect(screen.getByText(/1 moment needs a look/)).toBeTruthy();
  });

  it('approves a moment as one reversible edit, and reaches VERIFIED when the last one clears', () => {
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Looks right' }));

    expect(matte()!.review.flagged).toHaveLength(0);
    expect(matte()!.review.approved).toEqual([{ start: 1, end: 1.5 }]);
    expect(editor.history.entries.length).toBe(1);
    expect(screen.getByText('VERIFIED')).toBeTruthy();

    act(() => editor.undo());
    expect(matte()!.review.flagged).toEqual([{ start: 1, end: 1.5 }]);
  });

  it('steps between moments with J and K, and switches the monitor to Overlay', () => {
    mount(
      timeline({
        flagged: [
          { start: 1, end: 1.5 },
          { start: 3, end: 3.2 },
        ],
      }),
    );
    const list = screen.getByRole('list', { name: 'Moments to review' });
    fireEvent.keyDown(list, { key: 'j' });

    expect(store.getState().requestedMaskView).toBe('overlay');
    expect(editor.state.playhead).toBeCloseTo(3, 5);
    fireEvent.keyDown(list, { key: 'k' });
    expect(editor.state.playhead).toBeCloseTo(1, 5);
  });

  it('shows the reason the pipeline gave, in plain words', () => {
    rememberReviewReasons(KEY, [{ start: 1, end: 1.5, reason: 'edge_disagreement' }]);
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));
    expect(screen.getByText('Edges disagreed')).toBeTruthy();
  });

  it('locks the frame under the playhead so later runs cannot change it', () => {
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));
    act(() => editor.seek(2));
    fireEvent.click(screen.getByRole('button', { name: 'Lock this frame' }));
    expect(matte()!.review.locked).toEqual([2]);
  });

  it('refuses to apply a fix with nothing drawn, rather than saving an empty mask', async () => {
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));
    expect((screen.getByRole('button', { name: 'Apply fix' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(bridge.matteSaveCorrection).not.toHaveBeenCalled();
  });

  it('saves a drawn stroke as a correction and re-runs only the flagged window', async () => {
    bridge.matteSaveCorrection.mockResolvedValue({
      ok: true,
      reference: { kind: 'brush', sourceTime: 1.2, sha256: SHA },
    });
    bridge.capabilityPackMatte.mockImplementation((() => new Promise(() => {})) as never);
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));

    act(() =>
      store.addCorrectionStroke({
        kind: 'remove',
        radiusPx: 4,
        sourceTime: 1.2,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 12 },
        ],
      }),
    );

    // An unapplied stroke changes nothing in the project.
    expect(editor.history.entries.length).toBe(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Apply fix' }));
    await waitFor(() => expect(bridge.matteSaveCorrection).toHaveBeenCalled());
    const saved = bridge.matteSaveCorrection.mock.calls[0]![0] as {
      artifactKey: string;
      kind: string;
      png: Uint8Array;
    };
    expect(saved.artifactKey).toBe(KEY);
    expect(saved.kind).toBe('brush');
    // A real 8-bit grayscale PNG, which is what the host's strict reader accepts.
    expect([...saved.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    await waitFor(() => expect(bridge.capabilityPackMatte).toHaveBeenCalled());
    const intent = bridge.capabilityPackMatte.mock.calls[0]![0] as {
      sourceStart: number;
      sourceEnd: number;
      previousArtifactKey: string;
      prompts: { kind: string }[];
    };
    // Only the window around the moment, not the whole clip again.
    expect(intent.sourceStart).toBeCloseTo(0.5, 5);
    expect(intent.sourceEnd).toBeCloseTo(2, 5);
    expect(intent.previousArtifactKey).toBe(KEY);
    expect(intent.prompts.some((prompt) => prompt.kind === 'brush')).toBe(true);
    expect(store.getState().correctionStrokes).toHaveLength(0);
  });

  it('arms the edge brush like Keep and Remove, and saves an edge stroke as a brush fix (BR6.10)', async () => {
    bridge.matteSaveCorrection.mockResolvedValue({
      ok: true,
      reference: { kind: 'brush', sourceTime: 1.2, sha256: SHA },
    });
    bridge.capabilityPackMatte.mockImplementation((() => new Promise(() => {})) as never);
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));
    const edge = screen.getByRole('button', { name: 'Edge brush' }) as HTMLButtonElement;
    expect(edge.disabled).toBe(false);
    fireEvent.click(edge);
    expect(store.getState().tool).toBe('correction-brush');
    expect(store.getState().brushKind).toBe('edge');
    expect(edge.getAttribute('aria-pressed')).toBe('true');
    act(() =>
      store.addCorrectionStroke({
        kind: 'edge',
        radiusPx: 3,
        sourceTime: 1.2,
        points: [{ x: 8, y: 8 }],
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Apply fix' }));
    await waitFor(() => expect(bridge.matteSaveCorrection).toHaveBeenCalled());
    expect((bridge.matteSaveCorrection.mock.calls[0]![0] as { kind: string }).kind).toBe('brush');
  });

  it('offers a mouse-free way through every correction (BR6.9)', () => {
    mount(timeline({ flagged: [{ start: 1, end: 1.5 }] }));
    const list = screen.getByRole('list', { name: 'Moments to review' });
    // The keys are declared, not folklore.
    expect(list.getAttribute('aria-keyshortcuts')).toBe('J K');
    expect((list as HTMLElement).tabIndex).toBe(0);
    // Approving, locking and stepping are all buttons or keys; the brush is never the only route.
    expect(screen.getByRole('button', { name: 'Looks right' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lock this frame' })).toBeTruthy();
    expect(screen.getByText(/J and K step through the moments/)).toBeTruthy();
  });

  it('marks the moment being reviewed, so the list says where you are', () => {
    mount(
      timeline({
        flagged: [
          { start: 1, end: 1.5 },
          { start: 3, end: 3.2 },
        ],
      }),
    );
    const ranges = screen.getAllByRole('button', { name: /s – / });
    expect(ranges[0]!.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(screen.getByRole('list', { name: 'Moments to review' }), { key: 'j' });
    expect(screen.getAllByRole('button', { name: /s – / })[1]!.getAttribute('aria-current')).toBe(
      'true',
    );
  });
});
