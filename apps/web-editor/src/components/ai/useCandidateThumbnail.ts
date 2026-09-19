/**
 * A candidate's thumbnail, cropped from the clip's own media in the renderer.
 *
 * The picker has to show WHICH face or object an id means, and the renderer can already play
 * the asset (`fp-media://`), so the crop is made here: seek a detached `<video>` to the frame
 * the candidate was measured on and draw its box to a canvas. Nothing new crosses IPC and no
 * thumbnail file is written. A thumbnail is a convenience — the picker stays usable (label,
 * position, time) when the frame cannot be decoded.
 */
import { useEffect, useState } from 'react';
import { mediaSrc } from '../../editor/media.js';

export interface CandidateCrop {
  /** The asset's stored path. */
  readonly path: string;
  readonly sourceTime: number;
  /** Fractions of the picture. */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** Longest side of a thumbnail, CSS pixels ×2 for a sharp crop on a retina display. */
const THUMBNAIL_SIDE = 192;
/** Context kept around the box so a face is recognisable, as a fraction of the box. */
const CROP_PADDING = 0.35;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** The padded crop rectangle in video pixels, clamped to the frame. */
export function cropRect(
  box: CandidateCrop['box'],
  width: number,
  height: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const padX = box.width * CROP_PADDING;
  const padY = box.height * CROP_PADDING;
  const left = clamp(box.x - padX, 0, 1);
  const top = clamp(box.y - padY, 0, 1);
  const right = clamp(box.x + box.width + padX, 0, 1);
  const bottom = clamp(box.y + box.height + padY, 0, 1);
  return {
    x: left * width,
    y: top * height,
    width: Math.max(1, (right - left) * width),
    height: Math.max(1, (bottom - top) * height),
  };
}

function capture(crop: CandidateCrop, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    const finish = (outcome: () => void): void => {
      signal.removeEventListener('abort', abort);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
      outcome();
    };
    const abort = (): void => finish(() => reject(new Error('aborted')));
    signal.addEventListener('abort', abort, { once: true });
    video.onerror = () => finish(() => reject(new Error('The frame could not be decoded.')));
    video.onloadedmetadata = () => {
      video.currentTime = clamp(
        crop.sourceTime,
        0,
        Math.max(0, (video.duration || crop.sourceTime) - 0.001),
      );
    };
    video.onseeked = () => {
      const rect = cropRect(crop.box, video.videoWidth, video.videoHeight);
      const scale = THUMBNAIL_SIDE / Math.max(rect.width, rect.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(rect.width * scale));
      canvas.height = Math.max(1, Math.round(rect.height * scale));
      const context = canvas.getContext('2d');
      if (context === null) {
        finish(() => reject(new Error('No canvas.')));
        return;
      }
      context.drawImage(
        video,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      finish(() => resolve(canvas.toDataURL('image/jpeg', 0.8)));
    };
    video.src = mediaSrc(crop.path);
  });
}

/** The crop as a data URL, or `null` while it loads or when it cannot be made. */
export function useCandidateThumbnail(crop: CandidateCrop | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // Primitives, not the object: a new `crop` with the same content must not re-decode.
  const path = crop?.path;
  const sourceTime = crop?.sourceTime;
  const x = crop?.box.x;
  const y = crop?.box.y;
  const width = crop?.box.width;
  const height = crop?.box.height;
  useEffect(() => {
    setUrl(null);
    if (path === undefined || sourceTime === undefined) return undefined;
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      return undefined;
    }
    const controller = new AbortController();
    capture({ path, sourceTime, box: { x, y, width, height } }, controller.signal).then(
      setUrl,
      () => undefined,
    );
    return () => controller.abort();
  }, [path, sourceTime, x, y, width, height]);
  return url;
}
