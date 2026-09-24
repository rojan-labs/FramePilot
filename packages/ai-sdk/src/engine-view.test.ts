import type { Asset, Project } from '@framepilot/timeline-schema';
import { describe, expect, it, vi } from 'vitest';
import { toEngineAsset, toEngineProject } from './engine-view.js';
import { createTemporalEvidenceAcquirer } from './temporal-evidence-client.js';
import { createVisionFrameAcquirer } from './vision-evidence-client.js';

const talkingHead: Asset = {
  id: 'a_talk',
  path: 'media/talk.mp4',
  kind: 'video',
  durationSeconds: 49.78,
  media: {
    width: 1920,
    height: 1080,
    proxyPath: '.framepilot-derived/x/proxy.mp4',
    peaks: Array.from({ length: 400 }, (_, index) => index / 400),
    peaksPerSecond: 8,
    thumbnailPaths: ['.framepilot-derived/x/thumbs/thumb_000.png'],
  },
};

const project = {
  schemaVersion: 23,
  id: 'p1',
  name: 'p',
  version: 1,
  fps: 30,
  resolution: { width: 1080, height: 1920 },
  assets: [talkingHead, { id: 'a_unprobed', path: 'media/u.mp4', kind: 'video' }],
  timeline: { tracks: [], revision: 4 },
  transcript: [],
  markers: [],
  history: [{ patchId: 'patch_1' }],
} as unknown as Project;

describe('toEngineProject', () => {
  it('keeps the measured size a source-pixel mask is resolved against', () => {
    // The 2026-09-23 desktop runs: every review after `remove_background` failed with
    // "stored in source pixels but the media size is unknown" because this was stripped.
    const media = toEngineProject(project).assets[0]!.media!;
    expect(media.width).toBe(1920);
    expect(media.height).toBe(1080);
    expect(media.proxyPath).toBe('.framepilot-derived/x/proxy.mp4');
  });

  it('drops only what no render reads: peaks, their rate, thumbnails and history', () => {
    const engine = toEngineProject(project);
    const media = engine.assets[0]!.media!;
    expect(media.peaks).toBeUndefined();
    expect(media.peaksPerSecond).toBeUndefined();
    expect(media.thumbnailPaths).toBeUndefined();
    expect(engine.history).toEqual([]);
    expect(JSON.stringify(engine)).not.toContain('peaks');
  });

  it('leaves an unprobed asset exactly as it was, and never mutates the input', () => {
    expect(toEngineAsset(project.assets[1]!)).toBe(project.assets[1]);
    toEngineProject(project);
    expect(talkingHead.media!.peaks).toHaveLength(400);
  });
});

describe('engine requests carry asset media', () => {
  it('sends the review batch with media sizes', async () => {
    let sent: { project?: Project } = {};
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as { project?: Project };
      return new Response(JSON.stringify({ detail: 'stop here' }), { status: 500 });
    });
    const acquire = createTemporalEvidenceAcquirer({
      baseUrl: 'http://engine',
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    await expect(
      acquire(project, [
        {
          schemaVersion: 1,
          requestId: 'r1',
          projectRevision: 4,
          kind: 'frame',
          frame: 0,
          reason: 'look',
        } as never,
      ]),
    ).rejects.toThrow(/rejected the batch/);
    expect(sent.project?.assets[0]?.media?.width).toBe(1920);
    expect(sent.project?.assets[0]?.media?.peaks).toBeUndefined();
  });

  it('renders vision-review frames from a project that still knows its sizes', async () => {
    let sent: { project?: Project } = {};
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as { project?: Project };
      return new Response('offline', { status: 503 });
    });
    const acquire = createVisionFrameAcquirer({
      baseUrl: 'http://engine',
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    await expect(
      acquire(project, {
        schemaVersion: 1,
        requestId: 'v1',
        projectRevision: 4,
        objective: 'the title reads',
        frames: [0],
      } as never),
    ).rejects.toThrow();
    expect(sent.project?.assets[0]?.media?.height).toBe(1080);
  });
});
