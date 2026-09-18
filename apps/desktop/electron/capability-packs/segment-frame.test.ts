/**
 * BR6.11: hover highlight through main — intent validation, the busy/pack gates, strict
 * verification of the worker's mask, latest-wins, and the hover latency with a stub pack.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityPackWorkerRequest } from '@framepilot/capability-packs';
import {
  CapabilityPackWarmWorker,
  type SegmentFrameWorkerResult,
} from '@framepilot/capability-packs/node';
import type { Project } from '@framepilot/timeline-schema';
import { constantRateTiming } from './__fixtures__/fake-matte-worker.js';
import { encodeGrayPng, pngChunk } from './matte-png.js';
import {
  CapabilityPackSegmentFrameService,
  previewDimensions,
  pythonRound,
  verifySegmentFrame,
} from './segment-frame.js';

const STUB = fileURLToPath(new URL('./__fixtures__/warm-segment-worker.mjs', import.meta.url));
const TIMING = constantRateTiming(90, 512, [1, 15360]); // 30 fps
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function projectWith(
  width = 1920,
  height = 1080,
): Promise<{ project: Project; media: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-hover-'));
  const media = path.join(root, 'interview.mov');
  await writeFile(media, 'fixture');
  const project = {
    id: 'p',
    assets: [{ id: 'asset-1', path: media, kind: 'video', media: { width, height } }],
    timeline: { tracks: [], revision: 4 },
  } as unknown as Project;
  return { project, media };
}

type Answer = (request: CapabilityPackWorkerRequest) => Promise<SegmentFrameWorkerResult>;

function service(answer: Answer, overrides: { slotFree?: () => boolean; ready?: boolean } = {}) {
  const requests: CapabilityPackWorkerRequest[] = [];
  const timingCalls: string[] = [];
  const instance = new CapabilityPackSegmentFrameService({
    matte: async () => ({
      resolveWorker: async () =>
        overrides.ready === false
          ? {
              status: 'blocked' as const,
              outcome: {
                status: 'pack_missing' as const,
                proposal: { ok: false, code: 'catalog_unconfigured', error: 'x' } as never,
              },
            }
          : {
              status: 'ready' as const,
              entrypoint: '/packs/smart-mask/bin/w',
              installRoot: '/packs/smart-mask',
              packVersion: '1.0.0',
            },
    }),
    inspector: {
      videoTiming: async (file) => {
        timingCalls.push(file);
        return TIMING;
      },
    },
    slotFree: overrides.slotFree ?? (() => true),
    openWorker: () => ({
      segmentFrame: async ({ request, signal }) => {
        requests.push(request);
        if (signal?.aborted) throw new Error('aborted');
        return answer(request);
      },
      close: () => undefined,
    }),
  });
  return { instance, requests, timingCalls };
}

function result(
  request: CapabilityPackWorkerRequest,
  width: number,
  height: number,
  png: Buffer,
): SegmentFrameWorkerResult {
  const pts = request.capability === 'subject.segment_frame' ? request.parameters.pts : -1;
  return {
    type: 'result',
    protocolVersion: 1,
    requestId: request.requestId,
    projectRevision: request.projectRevision,
    capability: 'subject.segment_frame',
    backend: 'fake',
    modelDigests: {},
    pts,
    width,
    height,
    maskPng: png.toString('base64'),
    score: 0.8,
  };
}

const hover = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'h1',
  assetId: 'asset-1',
  sourceTime: 1.01,
  hoverPoint: { x: 0.25, y: 0.5 },
  ...overrides,
});

describe('previewDimensions mirrors the worker', () => {
  it('rounds half to even like Python', () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6].map(pythonRound)).toEqual([0, 2, 2, 2, 3]);
    expect(previewDimensions(1920, 1080, 360)).toEqual({ width: 640, height: 360 });
    expect(previewDimensions(3840, 2160, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(previewDimensions(640, 272, 360)).toEqual(
      { width: 640, height: 272 },
      'never taller than the source',
    );
    // 1001 × 360 / 720 = 500.5 → 500 (even), where Math.round would say 501.
    expect(previewDimensions(1001, 720, 360)).toEqual({ width: 500, height: 360 });
  });
});

describe('CapabilityPackSegmentFrameService (BR6.11)', () => {
  it('asks for the frame under the playhead and returns verified pixels, writing nothing', async () => {
    const { project } = await projectWith();
    const { instance, requests } = service(async (request) => {
      const pixels = new Uint8Array(640 * 360).fill(255);
      return result(request, 640, 360, encodeGrayPng(640, 360, pixels));
    });
    const answer = await instance.segment(hover(), { project, projectRevision: 4 });
    expect(answer).toMatchObject({ ok: true, width: 640, height: 360, pts: 30 * 512, score: 0.8 });
    if (!answer.ok) throw new Error('expected a mask');
    expect(answer.mask.byteLength).toBe(640 * 360);
    const request = requests[0]!;
    expect(request.capability).toBe('subject.segment_frame');
    expect(request).toMatchObject({
      projectRevision: 4,
      media: { firstFrame: 30, lastFrameExclusive: 31 },
    });
    expect(request.requestId).toMatch(/^hover-\d+$/u);
    if (request.capability === 'subject.segment_frame') {
      expect(request.parameters).toEqual({
        pts: 30 * 512,
        hoverPoint: { x: 0.25, y: 0.5 },
        previewHeight: 360,
      });
    }
  });

  it('refuses malformed intents before any work', async () => {
    const { project } = await projectWith();
    const { instance, requests } = service(async () => {
      throw new Error('unreachable');
    });
    for (const bad of [
      hover({ points: [{ x: 0.1, y: 0.1, label: 'include' }] }),
      hover({ hoverPoint: undefined }),
      hover({ hoverPoint: { x: 1.5, y: 0.5 } }),
      hover({ previewHeight: 4000 }),
      hover({ requestId: '../../etc' }),
      { ...hover(), path: '/etc/passwd' },
    ]) {
      expect(await instance.segment(bad, { project, projectRevision: 1 })).toMatchObject({
        ok: false,
        code: 'invalid_request',
      });
    }
    expect(requests).toHaveLength(0);
  });

  it('pauses while a job or export holds the slot, and offers nothing without a ready pack', async () => {
    const { project } = await projectWith();
    const busy = service(
      async () => {
        throw new Error('unreachable');
      },
      { slotFree: () => false },
    );
    expect(await busy.instance.segment(hover(), { project, projectRevision: 1 })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    const missing = service(
      async () => {
        throw new Error('unreachable');
      },
      { ready: false },
    );
    expect(await missing.instance.segment(hover(), { project, projectRevision: 1 })).toMatchObject({
      ok: false,
      code: 'pack_missing',
    });
    expect(busy.requests.length + missing.requests.length).toBe(0);
  });

  it('re-probes timing only when the file changes', async () => {
    const { project } = await projectWith();
    const { instance, timingCalls } = service(async (request) =>
      result(request, 640, 360, encodeGrayPng(640, 360, new Uint8Array(640 * 360))),
    );
    for (let index = 0; index < 5; index += 1)
      await instance.segment(hover({ requestId: `h${String(index)}` }), {
        project,
        projectRevision: 1,
      });
    expect(timingCalls).toHaveLength(1);
  });

  it('latest wins: a new hover supersedes the one in flight', async () => {
    const { project } = await projectWith();
    let release: (() => void) | undefined;
    const { instance } = service(
      (request) =>
        new Promise((resolve) => {
          release = () =>
            resolve(result(request, 640, 360, encodeGrayPng(640, 360, new Uint8Array(640 * 360))));
        }),
    );
    const first = instance.segment(hover({ requestId: 'a' }), { project, projectRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const firstRelease = release!;
    const second = instance.segment(hover({ requestId: 'b' }), { project, projectRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstRelease();
    release!();
    // The first call's worker answered, but its caller had been superseded: the answer is
    // still verified and returned (the renderer drops it by id); nothing breaks.
    expect((await first).ok || (await first).code === 'superseded').toBe(true);
    expect(await second).toMatchObject({ ok: true });
  });
});

describe('verifySegmentFrame (BR4.12 rules on the worker output)', () => {
  const request = {
    capability: 'subject.segment_frame',
    parameters: { pts: 7 },
    requestId: 'r',
    projectRevision: 1,
  } as unknown as CapabilityPackWorkerRequest;
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = (width: number, height: number): Buffer => {
    const body = Buffer.alloc(13);
    body.writeUInt32BE(width, 0);
    body.writeUInt32BE(height, 4);
    body[8] = 8;
    return pngChunk('IHDR', body);
  };

  it.each([
    ['a different pts', { pts: 8 }, encodeGrayPng(4, 2, new Uint8Array(8))],
    ['a different size', { width: 5 }, encodeGrayPng(4, 2, new Uint8Array(8))],
    [
      'an ancillary chunk',
      {},
      Buffer.concat([
        SIGNATURE,
        header(4, 2),
        pngChunk('tEXt', Buffer.from('k\0/Users/x')),
        pngChunk('IDAT', deflateSync(Buffer.alloc(10))),
        pngChunk('IEND', Buffer.alloc(0)),
      ]),
    ],
    [
      'an IHDR larger than announced (bomb)',
      {},
      Buffer.concat([
        SIGNATURE,
        header(8192, 8192),
        pngChunk('IDAT', deflateSync(Buffer.alloc(1))),
        pngChunk('IEND', Buffer.alloc(0)),
      ]),
    ],
    [
      'a colour PNG',
      {},
      (() => {
        const body = Buffer.alloc(13);
        body.writeUInt32BE(4, 0);
        body.writeUInt32BE(2, 4);
        body[8] = 8;
        body[9] = 2;
        return Buffer.concat([
          SIGNATURE,
          pngChunk('IHDR', body),
          pngChunk('IDAT', deflateSync(Buffer.alloc(26))),
          pngChunk('IEND', Buffer.alloc(0)),
        ]);
      })(),
    ],
  ])('refuses %s as invalid_output, with no path in the message', (_name, patch, png) => {
    const verdict = verifySegmentFrame({ ...result(request, 4, 2, png), ...patch }, 7, {
      width: 4,
      height: 2,
    });
    expect(verdict).toMatchObject({ ok: false, code: 'invalid_output' });
    expect(JSON.stringify(verdict)).not.toContain('/Users');
  });

  it('accepts a canonical gray PNG and returns its decoded pixels', () => {
    const pixels = Uint8Array.from([0, 255, 128, 3, 255, 0, 9, 10]);
    const verdict = verifySegmentFrame(result(request, 4, 2, encodeGrayPng(4, 2, pixels)), 7, {
      width: 4,
      height: 2,
    });
    expect(verdict.ok && [...verdict.mask]).toEqual([...pixels]);
  });
});

describe('hover latency with a stub pack (06 budget: ≤ 100 ms p95 after the embedding exists)', () => {
  it('measures main-side round trips through a real warm process', async () => {
    const { project } = await projectWith();
    const instance = new CapabilityPackSegmentFrameService({
      matte: async () => ({
        resolveWorker: async () => ({
          status: 'ready' as const,
          entrypoint: '/stub',
          installRoot: '/stub-root',
          packVersion: '1.0.0',
        }),
      }),
      inspector: { videoTiming: async () => TIMING },
      slotFree: () => true,
      openWorker: (options) => {
        const worker = new CapabilityPackWarmWorker({
          ...options,
          launch: (_entrypoint, _args, env) =>
            spawn(process.execPath, [STUB, '640', '360'], {
              shell: false,
              env: { ...env },
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
        });
        closers.push(() => worker.close());
        return worker;
      },
    });
    // Warm-up: the process start is the "first request" the budget excludes.
    expect(
      await instance.segment(hover({ requestId: 'warm' }), { project, projectRevision: 1 }),
    ).toMatchObject({ ok: true });
    const samples: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      const started = performance.now();
      const answer = await instance.segment(
        hover({ requestId: `m${String(index)}`, hoverPoint: { x: (index % 20) / 20, y: 0.5 } }),
        { project, projectRevision: 1 },
      );
      samples.push(performance.now() - started);
      expect(answer.ok).toBe(true);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    // Recorded in the BR6.11 notes; the stub answers instantly, so this is the host's own cost
    // (schema, pts lookup, stdio round trip, strict PNG decode of a 640×360 mask).
    process.stdout.write(
      `hover latency (stub pack, main-side, 640x360): p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms\n`,
    );
    expect(p95).toBeLessThan(100);
  });
});
