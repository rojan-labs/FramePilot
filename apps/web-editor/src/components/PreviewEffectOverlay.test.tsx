import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimedEffectLayer } from '../preview/effects/gl-effect-chain.js';
import { PreviewEffectOverlay } from './PreviewEffectOverlay.js';

const layer: TimedEffectLayer = {
  kind: 'blur-gaussian',
  start: 0,
  end: 10,
  params: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PreviewEffectOverlay scheduling', () => {
  it('paints once while paused instead of maintaining an idle display-rate loop', () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });

    render(
      <PreviewEffectOverlay
        layers={[layer]}
        getSource={() => null}
        getTime={() => 1}
        playing={false}
      />,
    );
    expect(requestFrame).toHaveBeenCalledTimes(1);

    act(() => frames[0]?.(0));
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it('continues scheduling while playback is active', () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });

    render(
      <PreviewEffectOverlay
        layers={[layer]}
        getSource={() => null}
        getTime={() => 1}
        playing
      />,
    );
    act(() => frames[0]?.(0));
    expect(requestFrame).toHaveBeenCalledTimes(2);
  });
});
