/**
 * Edit-mode (Insert/Overwrite) drop-behaviour tests (TIMELINE-REVAMP M2b-1).
 *
 * Insert mode must drop a clip in and push the downstream same-lane clips right by
 * the dropped clip's duration, as ONE validated patch (so one undo reverts the
 * whole thing). Overwrite (default) keeps the existing auto-layering drop.
 *
 * The Insert/Overwrite toggle UI lives in the Toolbar component; tests for the
 * toggle buttons themselves belong in Toolbar tests, not here.
 *
 * jsdom reports zero-origin rects, so a pointer/cursor `clientX` maps straight
 * through `pxToSeconds(clientX, pxPerSecond)`; at the 40 px/s default zoom a drop
 * at clientX N lands at N/40 seconds and renders at N px.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import type { EditMode } from '../editor/useEditMode.js';
import { TimelineView } from './TimelineView.js';
import { ASSET_DND_TYPE } from './MediaBin.js';

/** One short clip [0,2] on a single video track. */
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
          end: 2,
          sourceStart: 0,
          sourceEnd: 2,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

const dropAsset: Asset = { id: 'b', path: 'blob:b', kind: 'video', durationSeconds: 3 };

function Host({ editMode = 'overwrite' }: { editMode?: EditMode }): JSX.Element {
  const editor = useEditor(timeline, ['a', 'b']);
  return <TimelineView editor={editor} assets={[dropAsset]} fps={30} editMode={editMode} />;
}

/** Fire an asset-drop on a lane at the given cursor X (jsdom-safe). */
function dropOnLane(lane: HTMLElement, clientX: number): void {
  const dataTransfer = {
    getData: (type: string) => (type === ASSET_DND_TYPE ? 'b' : ''),
    types: [ASSET_DND_TYPE],
  };
  const dropEvent = new MouseEvent('drop', { bubbles: true, clientX });
  Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer });
  fireEvent(lane, dropEvent);
}

const leftOf = (el: Element): string => (el as HTMLElement).style.left;

describe('TimelineView Insert edit mode', () => {
  it('Insert drop pushes the downstream same-lane clip right by the drop duration', () => {
    const { container } = render(<Host editMode="insert" />);
    const lane = container.querySelector('[data-track-id="v"]') as HTMLElement;
    // Drop at clientX 0 ⇒ start 0; the new 3s clip lands at [0,3] and pushes c1 to [3,5].
    dropOnLane(lane, 0);

    const c1 = screen.getByLabelText('clip c1');
    expect(leftOf(c1)).toBe('120px'); // 3s @ 40px/s
    expect(c1.style.width).toBe('80px'); // c1 duration unchanged (2s)
    // The inserted clip occupies the freed [0,3] slot, on the SAME lane (no new layer).
    const onLane = lane.querySelectorAll('.clip-block');
    expect(onLane.length).toBe(2);
    const inserted = Array.from(onLane).find((el) => leftOf(el) === '0px');
    expect(inserted).toBeTruthy();
    expect((inserted as HTMLElement).style.width).toBe('120px'); // 3s
  });

  it('Overwrite drop (default) does not shift existing clips', () => {
    const { container } = render(<Host editMode="overwrite" />);
    const lane = container.querySelector('[data-track-id="v"]') as HTMLElement;
    dropOnLane(lane, 0); // overlaps c1 at 0 → auto-layers onto a new front layer
    // c1 stays at its original position (no downstream shift in overwrite).
    expect(leftOf(screen.getByLabelText('clip c1'))).toBe('0px');
  });
});
