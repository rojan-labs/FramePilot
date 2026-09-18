/**
 * The mask tool store changes on every pointer move of a mask drag. A component that reads one
 * field of it through `useMaskToolValue` must not re-render on those moves: `Editor` and
 * `Inspector` read `reviewRequest` that way, and through the whole-store hook they re-rendered
 * the whole editor inside the MK4.6 pointer budget's `work` window.
 */
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MaskToolStore, useMaskToolValue } from './useMaskTools';

describe('useMaskToolValue', () => {
  it('re-renders for its own field only, not for a drag in progress', () => {
    const store = new MaskToolStore();
    let renders = 0;
    let seen: unknown = undefined;
    function ReadsReview(): null {
      renders += 1;
      seen = useMaskToolValue((state) => state.reviewRequest, store);
      return null;
    }
    render(<ReadsReview />);
    expect(renders).toBe(1);

    // A drag: the live geometry changes on every move.
    act(() => {
      for (let move = 0; move < 50; move += 1) {
        store.update({
          live: {
            clipId: 'c',
            maskId: 'm',
            geometry: { kind: 'rectangle', cx: move, cy: 0, width: 10, height: 10, rotation: 0 },
          } as never,
        });
      }
    });
    expect(renders).toBe(1);

    act(() => store.requestReview('c'));
    expect(renders).toBe(2);
    expect(seen).toEqual({ clipId: 'c', seq: 1 });
  });
});
