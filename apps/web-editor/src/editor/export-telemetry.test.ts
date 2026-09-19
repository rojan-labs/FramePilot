import { describe, expect, it } from 'vitest';
import { MaskLayerSchema, type MaskLayerInput, type Timeline } from '@framepilot/timeline-schema';
import { exportJobEndPayload, exportMaskProfile } from './export-telemetry.js';

const clip = (id: string, masks: MaskLayerInput[]) => ({
  id,
  assetId: 'a1',
  trackId: 'v1',
  start: 0,
  end: 4,
  sourceStart: 0,
  sourceEnd: 4,
  effects: [],
  keyframes: [],
  ...(masks.length > 0 ? { masks: masks.map((mask) => MaskLayerSchema.parse(mask)) } : {}),
});

const rect = (id: string, over: Partial<MaskLayerInput> = {}): MaskLayerInput =>
  ({ kind: 'rectangle', id, cx: 10, cy: 10, width: 5, height: 5, ...over }) as MaskLayerInput;

const timeline = {
  revision: 0,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        clip('c1', [rect('m1'), rect('m2', { space: 'frame' } as Partial<MaskLayerInput>)]),
        clip('c2', [rect('off', { enabled: false } as Partial<MaskLayerInput>)]),
        clip('c3', []),
      ],
    },
  ],
} as unknown as Timeline;

describe('exportJobEnd (RD2.2)', () => {
  it('counts the enabled masks by kind and space, never the masks themselves', () => {
    expect(exportMaskProfile(timeline)).toEqual({
      maskedClips: 1,
      mattes: 0,
      keys: 0,
      shapes: 2,
      trackMattes: 0,
      frameSpaceMasks: 1,
    });
    expect(exportMaskProfile(undefined).maskedClips).toBe(0);
  });

  it('carries only catalogued scalars: no ids, paths or names', () => {
    const payload = exportJobEndPayload('completed', 1234.6, 299.6, '1080p', timeline);
    expect(payload).toEqual({
      status: 'completed',
      elapsedMs: 1235,
      frames: 300,
      resolution: '1080p',
      maskedClips: 1,
      mattes: 0,
      keys: 0,
      shapes: 2,
      trackMattes: 0,
      frameSpaceMasks: 1,
    });
    expect(JSON.stringify(payload)).not.toMatch(/c1|m1|m2|a1/);
  });
});
