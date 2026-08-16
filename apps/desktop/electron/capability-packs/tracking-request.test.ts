import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { buildTrackingWorkerRequest } from './tracking-request.js';

const MEDIA_PATH = '/projects/demo/media/shot.mp4';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    assets: [
      { id: 'asset-1', path: MEDIA_PATH, kind: 'video', durationSeconds: 10 },
      { id: 'music', path: '/projects/demo/media/music.wav', kind: 'audio' },
    ],
    ...overrides,
  } as unknown as Project;
}

function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    assetId: 'asset-1',
    capability: 'tracking.region',
    firstFrame: 0,
    lastFrameExclusive: 60,
    fps: 30,
    parameters: { region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    ...overrides,
  };
}

describe('buildTrackingWorkerRequest', () => {
  it('resolves the media path from the project, never from the renderer', () => {
    const result = buildTrackingWorkerRequest(project(), 7, {
      ...intent(),
      // A renderer trying to smuggle a path must have no effect.
      absolutePath: '/etc/passwd',
      media: { absolutePath: '/etc/passwd' },
    });

    expect(result.status).toBe('built');
    if (result.status !== 'built') return;
    expect(result.request.media.absolutePath).toBe(MEDIA_PATH);
    expect(result.mediaRoot).toBe('/projects/demo/media');
    expect(result.request.projectRevision).toBe(7);
  });

  it('derives the source range from the frame range and fps', () => {
    const result = buildTrackingWorkerRequest(project(), 1, {
      ...intent(),
      firstFrame: 30,
      lastFrameExclusive: 90,
    });

    if (result.status !== 'built') throw new Error('expected a request');
    expect(result.request.media.sourceStartSeconds).toBeCloseTo(1);
    expect(result.request.media.sourceEndSeconds).toBeCloseTo(3);
  });

  it('carries the host revision rather than any renderer-supplied revision', () => {
    const result = buildTrackingWorkerRequest(project(), 42, {
      ...intent(),
      projectRevision: 1,
    });

    if (result.status !== 'built') throw new Error('expected a request');
    expect(result.request.projectRevision).toBe(42);
  });

  it.each([
    ['point', 'tracking.point', { point: { x: 0.5, y: 0.5 } }],
    ['region', 'tracking.region', { region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    [
      'planar',
      'tracking.planar',
      {
        corners: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.5 },
          { x: 0.1, y: 0.5 },
        ],
      },
    ],
  ])('builds a %s request', (_label, capability, parameters) => {
    const result = buildTrackingWorkerRequest(project(), 1, {
      ...intent(),
      capability,
      parameters,
    });

    expect(result.status).toBe('built');
  });

  it.each([
    ['a missing asset', { assetId: 'nope' }, 'missing_asset'],
    ['an audio asset', { assetId: 'music' }, 'wrong_asset_kind'],
    ['an empty frame range', { lastFrameExclusive: 0 }, 'invalid_intent'],
    ['a negative first frame', { firstFrame: -1 }, 'invalid_intent'],
    ['a zero fps', { fps: 0 }, 'invalid_intent'],
    ['a range past the media', { lastFrameExclusive: 600 }, 'range_outside_media'],
    [
      'pixel-shaped geometry',
      { parameters: { region: { x: 120, y: 40, width: 0.2, height: 0.2 } } },
      'invalid_geometry',
    ],
    [
      'geometry that escapes the frame',
      { parameters: { region: { x: 0.9, y: 0.1, width: 0.5, height: 0.2 } } },
      'invalid_geometry',
    ],
    [
      'parameters for a different capability',
      { capability: 'tracking.point', parameters: { region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } },
      'invalid_geometry',
    ],
  ])('rejects %s', (_label, overrides, code) => {
    expect(buildTrackingWorkerRequest(project(), 1, intent(overrides))).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('rejects a malformed intent outright', () => {
    expect(buildTrackingWorkerRequest(project(), 1, null)).toMatchObject({
      status: 'rejected',
      code: 'invalid_intent',
    });
    expect(buildTrackingWorkerRequest(project(), 1, { assetId: 'asset-1' })).toMatchObject({
      status: 'rejected',
      code: 'invalid_intent',
    });
  });

  it('refuses an asset whose path was never resolved to an absolute location', () => {
    const relative = project({
      assets: [{ id: 'asset-1', path: 'media/shot.mp4', kind: 'video' }],
    } as unknown as Partial<Project>);

    expect(buildTrackingWorkerRequest(relative, 1, intent())).toMatchObject({
      status: 'rejected',
      code: 'missing_asset',
    });
  });
});
