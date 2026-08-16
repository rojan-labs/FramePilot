import { describe, expect, it } from 'vitest';
import {
  CapabilityPackWorkerFailureSchema,
  CapabilityPackWorkerProgressSchema,
  CapabilityPackWorkerRequestSchema,
  CapabilityPackWorkerResultSchema,
} from './worker-protocol.js';

const base = {
  type: 'request',
  protocolVersion: 1,
  requestId: 'track:clip-1',
  projectRevision: 7,
  media: {
    handleId: 'media:clip-1',
    assetId: 'asset-1',
    absolutePath: '/sandbox/project/media/shot.mp4',
    sourceStartSeconds: 1,
    sourceEndSeconds: 4,
    fps: 30,
    firstFrame: 30,
    lastFrameExclusive: 120,
  },
} as const;

describe('Capability Pack worker protocol', () => {
  it.each([
    { capability: 'tracking.point', parameters: { point: { x: 0.4, y: 0.3 } } },
    {
      capability: 'tracking.region',
      parameters: { region: { x: 0.2, y: 0.1, width: 0.4, height: 0.5 } },
    },
    {
      capability: 'tracking.planar',
      parameters: {
        corners: [
          { x: 0.1, y: 0.1 },
          { x: 0.8, y: 0.1 },
          { x: 0.8, y: 0.8 },
          { x: 0.1, y: 0.8 },
        ],
      },
    },
    { capability: 'subject.detect', parameters: { labels: ['face'], maxDetections: 5 } },
    {
      capability: 'subject.segment',
      parameters: { region: { x: 0.2, y: 0.1, width: 0.4, height: 0.5 } },
    },
  ])('accepts a bounded $capability request', (variant) => {
    expect(CapabilityPackWorkerRequestSchema.parse({ ...base, ...variant })).toMatchObject(variant);
  });

  it('rejects escaped geometry, inverted ranges, and ambiguous segmentation prompts', () => {
    expect(() =>
      CapabilityPackWorkerRequestSchema.parse({
        ...base,
        capability: 'tracking.region',
        parameters: { region: { x: 0.8, y: 0.2, width: 0.5, height: 0.5 } },
      }),
    ).toThrow(/inside the frame/i);
    expect(() =>
      CapabilityPackWorkerRequestSchema.parse({
        ...base,
        media: { ...base.media, lastFrameExclusive: 20 },
        capability: 'tracking.point',
        parameters: { point: { x: 0.5, y: 0.5 } },
      }),
    ).toThrow(/frame range/i);
    expect(() =>
      CapabilityPackWorkerRequestSchema.parse({
        ...base,
        capability: 'subject.segment',
        parameters: {
          point: { x: 0.5, y: 0.5 },
          region: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        },
      }),
    ).toThrow(/exactly one/i);
  });

  it('accepts confidence/occlusion tracking results and strict progress', () => {
    expect(
      CapabilityPackWorkerResultSchema.parse({
        type: 'result',
        protocolVersion: 1,
        requestId: base.requestId,
        projectRevision: base.projectRevision,
        capability: 'tracking.region',
        backend: 'opencv-csrt',
        modelDigests: {},
        samples: [
          {
            frame: 30,
            box: { x: 0.2, y: 0.1, width: 0.4, height: 0.5 },
            confidence: 0.92,
            occluded: false,
          },
        ],
      }),
    ).toMatchObject({ capability: 'tracking.region', samples: [{ confidence: 0.92 }] });
    expect(() =>
      CapabilityPackWorkerProgressSchema.parse({
        type: 'progress',
        protocolVersion: 1,
        requestId: base.requestId,
        phase: 'track',
        completed: 11,
        total: 10,
      }),
    ).toThrow(/cannot exceed/i);
  });

  it('bounds masks and classifies terminal failures', () => {
    expect(() =>
      CapabilityPackWorkerResultSchema.parse({
        type: 'result',
        protocolVersion: 1,
        requestId: base.requestId,
        projectRevision: base.projectRevision,
        capability: 'subject.segment',
        backend: 'onnx',
        modelDigests: { model: 'a'.repeat(64) },
        masks: [{ frame: 30, width: 32, height: 32, counts: [], confidence: 0.8 }],
      }),
    ).toThrow();
    expect(
      CapabilityPackWorkerFailureSchema.parse({
        type: 'failure',
        protocolVersion: 1,
        requestId: base.requestId,
        code: 'target_lost',
        detail: 'Confidence stayed below the occlusion threshold for 15 frames.',
        retryable: false,
      }),
    ).toMatchObject({ code: 'target_lost', retryable: false });
  });
});
