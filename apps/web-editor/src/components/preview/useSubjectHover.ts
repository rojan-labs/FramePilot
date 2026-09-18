/**
 * Hover highlight for AI Object (BR6.11, plan 05 "Hover highlight"): the object a click here
 * would select, tinted on the monitor BEFORE the click.
 *
 * The desktop host answers `matteSegmentFrame` from the Smart Mask pack's warm worker with a
 * preview-resolution mask. This hook only asks and remembers the answer; nothing reaches the
 * project until the editor clicks (the click itself is still an AI Object point, as before).
 *
 * Flow control: at most ONE request in flight. Pointer moves while it runs are coalesced into the
 * latest position, sent when the answer comes back, so a fast sweep costs one request per
 * round trip instead of one per pointer event. An answer for a frame, asset or point the monitor
 * has moved away from is dropped. `busy` (a job or export holds the model) and every other
 * refusal simply show no tint: the pick marker stays, and hover is never an error surface.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '@framepilot/shared-types';
import { getBridge } from '../../editor/bridge.js';

const log = createLogger('web-editor:subject-hover');
/** Preview height asked for: sharp enough to read the object's outline at monitor size. */
export const HOVER_PREVIEW_HEIGHT = 360;
/** A pointer that moved less than this (fraction of the picture) asks nothing new. */
const MOVE_EPSILON = 0.004;

export interface HoverMask {
  readonly assetId: string;
  readonly sourceTime: number;
  readonly width: number;
  readonly height: number;
  /** Row-major 8-bit coverage from the host (0 = not the object). */
  readonly mask: Uint8Array;
  /** Request round trip, milliseconds (the 06 hover budget is ≤ 100 ms p95). */
  readonly latencyMs: number;
}

export interface SubjectHoverTarget {
  readonly assetId: string;
  readonly sourceTime: number;
}

type HoverBridge = Pick<NonNullable<ReturnType<typeof getBridge>>, 'matteSegmentFrame'>;

export interface UseSubjectHover {
  readonly mask: HoverMask | null;
  /** Report the pointer, in picture fractions (0–1), or `null` when it left the picture. */
  readonly point: (at: { readonly x: number; readonly y: number } | null) => void;
}

let sequence = 0;

/**
 * @param target - The clip's asset and the source instant on the monitor, or `null` to stop.
 * @param bridge - Injected in tests; the desktop bridge otherwise.
 */
export function useSubjectHover(
  target: SubjectHoverTarget | null,
  bridge?: HoverBridge | null,
): UseSubjectHover {
  const [mask, setMask] = useState<HoverMask | null>(null);
  const source = bridge === undefined ? getBridge() : bridge;
  const available = typeof source?.matteSegmentFrame === 'function';
  // The bridge is read at call time through a ref, so `pump` and `point` keep one identity for
  // the component's life (a new function per render would re-run the reset effect every render).
  const bridgeRef = useRef(source);
  bridgeRef.current = source;
  const inFlight = useRef(false);
  const latest = useRef<{ x: number; y: number } | null>(null);
  const lastSent = useRef<{ x: number; y: number } | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  const pump = useCallback((): void => {
    const current = targetRef.current;
    const at = latest.current;
    const bridgeNow = bridgeRef.current;
    const ask = bridgeNow?.matteSegmentFrame?.bind(bridgeNow);
    if (ask === undefined || current === null || at === null || inFlight.current) return;
    const previous = lastSent.current;
    if (previous !== null && Math.hypot(previous.x - at.x, previous.y - at.y) < MOVE_EPSILON)
      return;
    inFlight.current = true;
    lastSent.current = at;
    sequence += 1;
    const started = performance.now();
    const asked = { assetId: current.assetId, sourceTime: current.sourceTime };
    void ask({
      requestId: `hover-${String(sequence)}`,
      assetId: asked.assetId,
      sourceTime: asked.sourceTime,
      hoverPoint: { x: at.x, y: at.y },
      previewHeight: HOVER_PREVIEW_HEIGHT,
    })
      .then((answer) => {
        const now = targetRef.current;
        // The monitor moved on (another frame, clip or tool): this answer describes nothing shown.
        if (now === null || now.assetId !== asked.assetId || now.sourceTime !== asked.sourceTime)
          return;
        if (!answer.ok) {
          setMask(null);
          return;
        }
        setMask({
          ...asked,
          width: answer.width,
          height: answer.height,
          mask: answer.mask,
          latencyMs: performance.now() - started,
        });
      })
      .catch((error: unknown) => {
        log.warn('hover request failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        setMask(null);
      })
      .finally(() => {
        inFlight.current = false;
        pump();
      });
  }, []);

  // A new frame or clip invalidates the tint at once and asks again for the same pointer.
  const targetKey = target === null ? null : `${target.assetId}@${String(target.sourceTime)}`;
  useEffect(() => {
    setMask(null);
    lastSent.current = null;
    if (targetKey !== null) pump();
  }, [targetKey, pump]);

  const point = useCallback(
    (at: { readonly x: number; readonly y: number } | null): void => {
      if (at === null) {
        latest.current = null;
        lastSent.current = null;
        setMask(null);
        return;
      }
      latest.current = { x: Math.min(1, Math.max(0, at.x)), y: Math.min(1, Math.max(0, at.y)) };
      pump();
    },
    [pump],
  );

  return { mask: available ? mask : null, point };
}

/**
 * The mask as a grayscale image for an SVG luminance `<mask>`: white where the host says
 * "object". The monitor fills the accent token through it, so the tint's colour comes from the
 * design system, not from here. `null` where there is no 2D canvas (tests).
 */
export function hoverMaskUrl(mask: HoverMask): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = mask.width;
  canvas.height = mask.height;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (context === null) return null;
  const image = context.createImageData(mask.width, mask.height);
  for (let index = 0; index < mask.mask.length; index += 1) {
    const value = mask.mask[index]!;
    const offset = index * 4;
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}
