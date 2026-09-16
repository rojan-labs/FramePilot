/**
 * A decoded video frame as the layer compositor consumes it (PX2.1 / PX2.7).
 *
 * The compositor converts YUV to RGB itself, with the export's arithmetic
 * (`engine/raster/swscale.ts`), so it needs the decoder's planes rather than a `VideoFrame`
 * Chromium would convert with its own matrix. The decode worker copies the planes out
 * (`VideoFrame.copyTo`), closes the frame and transfers one buffer. Side benefits: the
 * decode-ahead cache no longer holds GPU-backed frames from Chromium's small output pool, and
 * the same bytes serve every layer that shows that frame.
 *
 * Formats the copy cannot represent as 8-bit 4:2:0 (RGB frames, high bit depth) are passed on
 * as the `VideoFrame` itself (`kind: 'frame'`), which the compositor uploads through the
 * browser's conversion: correct content, colour parity not guaranteed.
 */

/** 8-bit planar 4:2:0 picture with its colour tags. */
export interface I420Picture {
  readonly kind: 'i420';
  readonly width: number;
  readonly height: number;
  readonly y: Uint8Array;
  readonly u: Uint8Array;
  readonly v: Uint8Array;
  /** `VideoColorSpace.matrix` (`null` when untagged). */
  readonly matrix: string | null;
  /** `VideoColorSpace.fullRange` (`null` when untagged, which decoders treat as limited). */
  readonly fullRange: boolean | null;
  /** Bytes held, for the cache budget. */
  readonly byteLength: number;
}

/** A frame the worker could not copy into 8-bit 4:2:0 planes. */
export interface FramePicture {
  readonly kind: 'frame';
  readonly frame: VideoFrame;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

export type DecodedPicture = I420Picture | FramePicture;

/** Chroma plane size for 4:2:0. */
const half = (value: number): number => (value + 1) >> 1;

/**
 * Copy a decoded frame's planes into one transferable buffer as I420.
 *
 * @param frame - The decoded frame; the caller still owns and closes it.
 * @returns The planes, or `null` when the frame's format is not 8-bit 4:2:0 (I420, I420A, NV12).
 */
export async function copyI420(frame: VideoFrame): Promise<I420Picture | null> {
  const format = frame.format;
  const width = frame.visibleRect?.width ?? frame.codedWidth;
  const height = frame.visibleRect?.height ?? frame.codedHeight;
  const chromaWidth = half(width);
  const chromaHeight = half(height);
  const lumaBytes = width * height;
  const chromaBytes = chromaWidth * chromaHeight;
  const colorSpace = frame.colorSpace;
  const tags = {
    matrix: colorSpace?.matrix ?? null,
    fullRange: colorSpace?.fullRange ?? null,
  };

  if (format === 'I420' || format === 'I420A') {
    const size = frame.allocationSize();
    const buffer = new Uint8Array(size);
    await frame.copyTo(buffer);
    // Default layout: planes packed back to back with stride = plane width.
    const y = buffer.subarray(0, lumaBytes);
    const u = buffer.subarray(lumaBytes, lumaBytes + chromaBytes);
    const v = buffer.subarray(lumaBytes + chromaBytes, lumaBytes + 2 * chromaBytes);
    return {
      kind: 'i420',
      width,
      height,
      y,
      u,
      v,
      ...tags,
      byteLength: buffer.byteLength,
    };
  }
  if (format === 'NV12') {
    const packed = new Uint8Array(frame.allocationSize());
    await frame.copyTo(packed);
    const out = new Uint8Array(lumaBytes + 2 * chromaBytes);
    out.set(packed.subarray(0, lumaBytes), 0);
    const uv = packed.subarray(lumaBytes, lumaBytes + 2 * chromaBytes);
    for (let i = 0; i < chromaBytes; i++) {
      out[lumaBytes + i] = uv[i * 2]!;
      out[lumaBytes + chromaBytes + i] = uv[i * 2 + 1]!;
    }
    return {
      kind: 'i420',
      width,
      height,
      y: out.subarray(0, lumaBytes),
      u: out.subarray(lumaBytes, lumaBytes + chromaBytes),
      v: out.subarray(lumaBytes + chromaBytes),
      ...tags,
      byteLength: out.byteLength,
    };
  }
  return null;
}

/** The buffers a picture message transfers (none for a `VideoFrame`, which transfers itself). */
export function pictureTransfer(picture: DecodedPicture): Transferable[] {
  if (picture.kind === 'frame') return [picture.frame];
  return [picture.y.buffer as ArrayBuffer];
}

function rotatePlane(
  plane: Uint8Array,
  width: number,
  height: number,
  clockwise: 90 | 180 | 270,
): Uint8Array {
  const out = new Uint8Array(plane.length);
  if (clockwise === 180) {
    for (let i = 0, n = width * height; i < n; i++) out[n - 1 - i] = plane[i]!;
    return out;
  }
  // Output is height × width.
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < height; x++) {
      const source =
        clockwise === 90
          ? (height - 1 - x) * width + y // dst(x, y) = src(y, H-1-x)
          : x * width + (width - 1 - y); // dst(x, y) = src(W-1-y, x)
      out[y * height + x] = plane[source]!;
    }
  }
  return out;
}

/**
 * Turn an I420 picture upright by its clockwise display rotation (`Asset.media.rotation`), as
 * ffmpeg's autorotate does before the export's scaler sees the planes (PX2.9). WebCodecs decodes
 * the stored orientation, so the compositor would otherwise fit a phone clip sideways.
 */
export function rotateI420(picture: I420Picture, clockwise: number): I420Picture {
  if (clockwise !== 90 && clockwise !== 180 && clockwise !== 270) return picture;
  const cw = half(picture.width);
  const ch = half(picture.height);
  const quarter = clockwise !== 180;
  return {
    ...picture,
    width: quarter ? picture.height : picture.width,
    height: quarter ? picture.width : picture.height,
    y: rotatePlane(picture.y, picture.width, picture.height, clockwise),
    u: rotatePlane(picture.u, cw, ch, clockwise),
    v: rotatePlane(picture.v, cw, ch, clockwise),
  };
}
