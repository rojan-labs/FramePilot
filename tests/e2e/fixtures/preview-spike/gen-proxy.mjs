#!/usr/bin/env node
// Generates a synthetic H.264 proxy with a 16-bit binary frame-index watermark
// burned into the top-left corner of every frame — a machine-readable ground
// truth for the P0 WebCodecs feasibility spike's cut-continuity gate.
//
// Watermark spec (MUST stay in sync with the decoder at
// apps/web-editor/src/preview/spike/watermark.ts):
//   - 16 blocks, BLOCK_PX x BLOCK_PX each, laid out left to right starting at
//     (0, 0): block `bit` at x = bit * BLOCK_PX.
//   - Block `bit` is pure white (255,255,255) iff bit `bit` of the 0-based
//     frame index is set, else pure black (0,0,0). Full-luma blocks (not text)
//     so the reader only needs a luma threshold — robust to yuv420 chroma
//     subsampling and lossy compression.
//   - No B-frames, closed short GOP (-bf 0 -g 15 -sc_threshold 0): decode
//     order == presentation order, and no seek ever needs more than a
//     14-frame keyframe-to-target prefix.
//
// Usage:
//   node gen-proxy.mjs <out.mp4> <frames> <width> <height> <toneHz> <r,g,b>

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BLOCK_PX = 32;
const WATERMARK_BITS = 16;
const FPS = 30;

function paintFrame(px, width, frameIndex, bg) {
  const [r, g, b] = bg;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  for (let bit = 0; bit < WATERMARK_BITS; bit++) {
    const on = (frameIndex >> bit) & 1;
    const val = on ? 255 : 0;
    const x0 = bit * BLOCK_PX;
    for (let y = 0; y < BLOCK_PX; y++) {
      const rowStart = y * width;
      for (let x = x0; x < x0 + BLOCK_PX; x++) {
        const idx = (rowStart + x) * 4;
        px[idx] = val;
        px[idx + 1] = val;
        px[idx + 2] = val;
        px[idx + 3] = 255;
      }
    }
  }
}

async function main() {
  const [, , outPath, framesArg, wArg, hArg, toneArg, bgArg, gopArg, bframesArg] = process.argv;
  if (!outPath || !framesArg || !wArg || !hArg) {
    console.error(
      'usage: node gen-proxy.mjs <out.mp4> <frames> <width> <height> [toneHz] [r,g,b] [gop] [bframes]'
    );
    process.exit(1);
  }
  const frames = Number.parseInt(framesArg, 10);
  const width = Number.parseInt(wArg, 10);
  const height = Number.parseInt(hArg, 10);
  const tone = toneArg ? Number.parseFloat(toneArg) : 440;
  const bg = (bgArg ?? '20,20,60').split(',').map((n) => Number.parseInt(n, 10));
  // GOP size (keyframe interval). Default 15 mirrors the P-1 proxy; pass 1 for
  // an all-intra proxy (every frame a keyframe → O(1) seek, no prefix decode).
  const gop = gopArg ? Number.parseInt(gopArg, 10) : 15;
  // Max consecutive B-frames. Default 0 mirrors the P-1 proxy (decode order ==
  // presentation order); pass e.g. 2 to emulate real camera footage, whose
  // decode order is reordered — exercises the presentation-index translation.
  const bframes = bframesArg ? Number.parseInt(bframesArg, 10) : 0;

  if (width < BLOCK_PX * WATERMARK_BITS) {
    throw new Error(
      `width ${width} too small for ${WATERMARK_BITS} x ${BLOCK_PX}px watermark blocks`
    );
  }

  // Two-step encode, not one ffmpeg invocation with `+faststart` directly on
  // the piped-stdin encode: that combination was observed to be genuinely
  // non-deterministic — one run produced a byte-for-byte DUPLICATE `moov` box
  // (ftyp, moov, moov, <corrupted rest>) that every real player and demuxer
  // then chokes on, while an identical invocation with identical args
  // produced a clean file. The moov-relocation rewrite ffmpeg performs for
  // `+faststart` isn't reliable when its own input is a live, non-seekable
  // pipe under backpressure. Step 1 encodes from the pipe with no faststart
  // surgery (a plain single-pass mux); step 2 remuxes (`-c copy`) that
  // already-complete, actually-seekable file with `+faststart` — the
  // standard, reliable way to relocate moov.
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-gen-proxy-'));
  const rawEncodePath = join(tmpDir, 'raw-encode.mp4');
  try {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-y',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${width}x${height}`,
        '-r',
        String(FPS),
        '-i',
        'pipe:0',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${tone}:sample_rate=48000`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-g',
        String(gop),
        '-keyint_min',
        String(gop),
        '-sc_threshold',
        '0',
        '-bf',
        String(bframes),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        rawEncodePath,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    );

    const px = new Uint8Array(width * height * 4);
    for (let f = 0; f < frames; f++) {
      paintFrame(px, width, f, bg);
      const canWriteMore = ffmpeg.stdin.write(px);
      if (!canWriteMore) {
        await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
      }
    }
    ffmpeg.stdin.end();

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg (encode pass) exited with code ${code}`));
      });
      ffmpeg.on('error', reject);
    });

    const remux = spawnSync(
      'ffmpeg',
      ['-y', '-i', rawEncodePath, '-c', 'copy', '-movflags', '+faststart', outPath],
      { stdio: 'inherit' }
    );
    if (remux.status !== 0) {
      throw new Error(`ffmpeg (faststart remux pass) exited with code ${remux.status}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
