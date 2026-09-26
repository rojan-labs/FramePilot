/**
 * A sticker or shape tile dropped on the program monitor, through the real Editor (plan/elements
 * EL11, 02 §3): the drop lands at the playhead, centred where it was let go, as one edit that is
 * selected — or the sticker's failure sentence when main could not copy it. The desktop app only:
 * the browser build offers no Elements, and its monitor takes no drops.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import type { ElementMaterializeResult } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { demoProject } from '../editor/demo.js';
import { Editor } from './Editor.js';
import {
  ELEMENT_DND_TYPE,
  elementKindDndType,
  encodeElementDrag,
  type ElementDragPayload,
} from './elements/element-dnd.js';

const compositorFlag = vi.hoisted(() => ({ layers: true }));
vi.mock('../preview/compositor-flag.js', () => ({
  layerCompositorEnabled: () => compositorFlag.layers,
  previewCompositor: () => (compositorFlag.layers ? 'layers' : 'legacy'),
}));

/** The monitor's picture on screen: 800 × 450 at (100, 50). */
const FRAME = { left: 100, top: 50, width: 800, height: 450 };

function installDesktop(materialize: () => Promise<ElementMaterializeResult>): void {
  (window as unknown as { framepilot?: unknown }).framepilot = { elementsMaterialize: materialize };
}

afterEach(() => {
  delete (window as unknown as { framepilot?: unknown }).framepilot;
  window.localStorage.clear();
});

function mount(): { frame: HTMLElement; onProjectChange: ReturnType<typeof vi.fn> } {
  const onProjectChange = vi.fn<(project: Project) => void>();
  const { container } = render(<Editor project={demoProject} onProjectChange={onProjectChange} />);
  const frame = container.querySelector<HTMLElement>('.preview-frame')!;
  frame.getBoundingClientRect = () =>
    ({ ...FRAME, x: FRAME.left, y: FRAME.top, right: 900, bottom: 500 }) as DOMRect;
  return { frame, onProjectChange };
}

/** Drag a tile's payload over `target` and let go at `at`; returns whether the monitor took it. */
async function dropTile(
  target: Element,
  payload: ElementDragPayload,
  at: { readonly x: number; readonly y: number },
): Promise<boolean> {
  const data = new Map([
    [ELEMENT_DND_TYPE, encodeElementDrag(payload)],
    [elementKindDndType(payload.kind), payload.kind],
  ]);
  const dataTransfer = {
    types: [...data.keys()],
    dropEffect: 'none',
    getData: (format: string) => data.get(format) ?? '',
  };
  let taken = false;
  for (const type of ['dragOver', 'drop'] as const) {
    const event = createEvent[type](target, { dataTransfer });
    Object.defineProperties(event, { clientX: { value: at.x }, clientY: { value: at.y } });
    taken = !fireEvent(target, event);
  }
  // The placement settles after the drop (a sticker waits for main's copy).
  await act(async () => {});
  return taken;
}

const lastProject = (spy: ReturnType<typeof vi.fn>): Project =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as Project;

describe('Editor — a tile dropped on the program monitor', () => {
  it('adds a shape at the playhead, centred where it was let go, selected', async () => {
    installDesktop(async () => ({ ok: false, error: 'io_failed' }));
    const { frame, onProjectChange } = mount();
    const before = demoProject.timeline.tracks.flatMap((track) => track.clips).length;

    // 30% across and 40% down the picture.
    const taken = await dropTile(
      frame,
      { kind: 'shape', presetId: 'rounded-rect/highlight', colour: null },
      { x: FRAME.left + FRAME.width * 0.3, y: FRAME.top + FRAME.height * 0.4 },
    );
    expect(taken).toBe(true);

    const after = lastProject(onProjectChange);
    const clips = after.timeline.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(before + 1);
    const shape = clips.find((clip) => clip.assetId === '__shape__')!;
    expect(shape.start).toBe(0);
    expect(shape.effects.find((effect) => effect.type === 'shape')?.params).toMatchObject({
      x: 30,
      y: 40,
    });
    // Selected, so its handles show on the monitor for the fine adjustment.
    expect(
      screen.getByRole('button', { name: `clip ${shape.id}` }).getAttribute('data-selected'),
    ).toBe('true');
    // And said, politely: the timeline it landed on is in another part of the window.
    expect(screen.getByText('Added the highlight box at 0:00').getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  it('says why a sticker could not be added when main could not copy it', async () => {
    installDesktop(async () => ({ ok: false, error: 'disk_full' }));
    const { frame, onProjectChange } = mount();
    await dropTile(frame, { kind: 'sticker', elementId: 'fire' }, { x: 500, y: 275 });
    // The Stickers tab's own sentence, as a toast: the tile that was dragged is in another panel.
    expect(
      await screen.findByText("Couldn't add this sticker: there isn't enough disk space."),
    ).toBeTruthy();
    expect(onProjectChange).not.toHaveBeenCalled();
  });

  it('takes no drop in the browser build, which offers no Elements', async () => {
    const { frame, onProjectChange } = mount();
    const taken = await dropTile(
      frame,
      { kind: 'shape', presetId: 'rounded-rect/highlight', colour: null },
      { x: 500, y: 275 },
    );
    expect(taken).toBe(false);
    expect(onProjectChange).not.toHaveBeenCalled();
  });
});
