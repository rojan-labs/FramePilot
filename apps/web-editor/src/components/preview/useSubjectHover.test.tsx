import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  MatteSegmentFrameIntentWire,
  MatteSegmentFrameResultWire,
} from '@framepilot/shared-types';
import { useSubjectHover, type SubjectHoverTarget } from './useSubjectHover.js';

const ok = (): MatteSegmentFrameResultWire => ({
  ok: true,
  pts: 0,
  width: 2,
  height: 1,
  mask: Uint8Array.from([0, 255]),
  score: 0.9,
});

function deferredBridge() {
  const calls: {
    intent: MatteSegmentFrameIntentWire;
    resolve: (answer: MatteSegmentFrameResultWire) => void;
  }[] = [];
  const bridge = {
    matteSegmentFrame: vi.fn(
      (intent: MatteSegmentFrameIntentWire) =>
        new Promise<MatteSegmentFrameResultWire>((resolve) => calls.push({ intent, resolve })),
    ),
  };
  return { bridge, calls };
}

describe('useSubjectHover (BR6.11)', () => {
  it('keeps one request in flight and sends only the latest pointer when it returns', async () => {
    const { bridge, calls } = deferredBridge();
    const target: SubjectHoverTarget = { assetId: 'a', sourceTime: 1 };
    const { result } = renderHook(() => useSubjectHover(target, bridge));
    act(() => result.current.point({ x: 0.1, y: 0.1 }));
    act(() => result.current.point({ x: 0.2, y: 0.2 }));
    act(() => result.current.point({ x: 0.3, y: 0.3 }));
    expect(bridge.matteSegmentFrame).toHaveBeenCalledTimes(1);
    await act(async () => calls[0]!.resolve(ok()));
    await waitFor(() => expect(bridge.matteSegmentFrame).toHaveBeenCalledTimes(2));
    expect(calls[1]!.intent.hoverPoint).toEqual({ x: 0.3, y: 0.3 });
    expect(result.current.mask).toMatchObject({ assetId: 'a', sourceTime: 1, width: 2, height: 1 });
  });

  it('drops an answer for a frame the monitor has left, and shows nothing on a refusal', async () => {
    const { bridge, calls } = deferredBridge();
    let target: SubjectHoverTarget = { assetId: 'a', sourceTime: 1 };
    const { result, rerender } = renderHook(() => useSubjectHover(target, bridge));
    act(() => result.current.point({ x: 0.5, y: 0.5 }));
    target = { assetId: 'a', sourceTime: 2 };
    rerender();
    await act(async () => calls[0]!.resolve(ok()));
    expect(result.current.mask).toBeNull();
    // The new frame is asked about with the same pointer.
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.intent.sourceTime).toBe(2);
    await act(async () => calls[1]!.resolve({ ok: false, code: 'busy', error: 'x' }));
    expect(result.current.mask).toBeNull();
  });

  it('is inert without the desktop bridge or without a target', () => {
    const none = renderHook(() => useSubjectHover({ assetId: 'a', sourceTime: 0 }, null));
    act(() => none.result.current.point({ x: 0.5, y: 0.5 }));
    expect(none.result.current.mask).toBeNull();
    const { bridge } = deferredBridge();
    const idle = renderHook(() => useSubjectHover(null, bridge));
    act(() => idle.result.current.point({ x: 0.5, y: 0.5 }));
    expect(bridge.matteSegmentFrame).not.toHaveBeenCalled();
  });

  it('asks nothing new for a pointer that barely moved', async () => {
    const { bridge, calls } = deferredBridge();
    const { result } = renderHook(() => useSubjectHover({ assetId: 'a', sourceTime: 0 }, bridge));
    act(() => result.current.point({ x: 0.5, y: 0.5 }));
    await act(async () => calls[0]!.resolve(ok()));
    act(() => result.current.point({ x: 0.5005, y: 0.5 }));
    expect(bridge.matteSegmentFrame).toHaveBeenCalledTimes(1);
  });
});
