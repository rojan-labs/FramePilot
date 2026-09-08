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

  describe('visual.embed and visual.text', () => {
    const vector = Buffer.alloc(8).toString('base64');
    const embedResult = {
      type: 'result',
      protocolVersion: 1,
      requestId: base.requestId,
      projectRevision: base.projectRevision,
      capability: 'visual.embed',
      backend: 'onnxruntime-cpu',
      modelDigests: { image: 'a'.repeat(64) },
      promptBankVersion: 1,
      dim: 4,
      shots: [
        {
          shotIndex: 0,
          vector,
          labels: { shotSize: { value: 'MS', p: 0.81 } },
          faces: 1,
          faceVectors: [vector],
        },
      ],
    } as const;

    it('accepts a bounded batch of shots against a media handle', () => {
      const parsed = CapabilityPackWorkerRequestSchema.parse({
        ...base,
        capability: 'visual.embed',
        parameters: {
          promptBankVersion: 1,
          shots: [
            { shotIndex: 0, keyframeT: 1.5 },
            { shotIndex: 1, keyframeT: 9 },
          ],
        },
      });
      expect(parsed.capability).toBe('visual.embed');
    });

    it('refuses a repeated shot index and an oversized batch', () => {
      const shots = (count: number, index = (i: number) => i) =>
        Array.from({ length: count }, (_, i) => ({ shotIndex: index(i), keyframeT: i }));
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'visual.embed',
          parameters: { promptBankVersion: 1, shots: shots(2, () => 3) },
        }),
      ).toThrow(/distinct/);
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'visual.embed',
          parameters: { promptBankVersion: 1, shots: shots(65) },
        }),
      ).toThrow();
    });

    it('embeds text with no media handle at all', () => {
      const parsed = CapabilityPackWorkerRequestSchema.parse({
        type: 'request',
        protocolVersion: 1,
        requestId: 'query:1',
        projectRevision: 0,
        capability: 'visual.text',
        parameters: { texts: ['a photo of a city street'] },
      });
      expect('media' in parsed).toBe(false);
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'visual.text',
          parameters: { texts: ['x'] },
        }),
      ).toThrow();
    });

    it('accepts a labelled shot result and refuses a face-vector count mismatch', () => {
      expect(CapabilityPackWorkerResultSchema.parse(embedResult)).toMatchObject({ dim: 4 });
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...embedResult,
          shots: [{ ...embedResult.shots[0], faces: 2 }],
        }),
      ).toThrow(/one vector per counted face/);
    });

    it('refuses a vector that is not base64', () => {
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...embedResult,
          shots: [{ ...embedResult.shots[0], vector: 'not base64!' }],
        }),
      ).toThrow(/base64/);
    });

    it('carries an embed progress phase', () => {
      expect(
        CapabilityPackWorkerProgressSchema.parse({
          type: 'progress',
          protocolVersion: 1,
          requestId: base.requestId,
          phase: 'embed',
          completed: 8,
          total: 64,
        }).phase,
      ).toBe('embed');
    });
  });

  describe('visual.describe', () => {
    const describeResult = {
      type: 'result',
      protocolVersion: 1,
      requestId: base.requestId,
      projectRevision: base.projectRevision,
      capability: 'visual.describe',
      backend: 'llama.cpp/smolvlm2-2.2b',
      modelDigests: { 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf': 'a'.repeat(64) },
      tier2Version: 1,
      model: 'framepilot/smolvlm2-2.2b-instruct-q4-k-m',
      shots: [
        {
          shotIndex: 0,
          summary: 'A man in a grey jacket speaks to camera at a desk.',
          subject: 'man in grey jacket',
          action: 'speaking to camera',
          setting: 'office desk with a laptop',
          camera: { shotSize: 'MS', angle: 'eye-level', movement: 'static' },
          mood: 'neutral, bright',
          onScreenText: [],
          quality: ['well-lit'],
          confidence: 'medium',
        },
      ],
    } as const;

    it('accepts a bounded batch of shot SPANS, not keyframes', () => {
      const parsed = CapabilityPackWorkerRequestSchema.parse({
        ...base,
        capability: 'visual.describe',
        parameters: {
          tier2Version: 1,
          shots: [
            { shotIndex: 0, t0: 0, t1: 4 },
            { shotIndex: 1, t0: 4, t1: 9 },
          ],
        },
      });
      expect(parsed.capability).toBe('visual.describe');
    });

    it('refuses a zero-length span, a repeated shot index and an oversized batch', () => {
      const spans = (count: number, index = (i: number) => i) =>
        Array.from({ length: count }, (_, i) => ({ shotIndex: index(i), t0: i, t1: i + 1 }));
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'visual.describe',
          parameters: { tier2Version: 1, shots: [{ shotIndex: 0, t0: 2, t1: 2 }] },
        }),
      ).toThrow();
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'visual.describe',
          parameters: { tier2Version: 1, shots: spans(2, () => 3) },
        }),
      ).toThrow(/distinct/);
      // Tier 2 is the slow tier: its batch bound is 16, not the embed tier's 64.
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'visual.describe',
          parameters: { tier2Version: 1, shots: spans(17) },
        }),
      ).toThrow();
    });

    it('accepts a structured description result', () => {
      expect(CapabilityPackWorkerResultSchema.parse(describeResult)).toMatchObject({
        tier2Version: 1,
      });
    });

    it('requires a non-empty summary', () => {
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...describeResult,
          shots: [{ ...describeResult.shots[0], summary: '' }],
        }),
      ).toThrow();
    });

    it('closes the camera and quality vocabularies, with an explicit unknown', () => {
      expect(
        CapabilityPackWorkerResultSchema.parse({
          ...describeResult,
          shots: [
            {
              ...describeResult.shots[0],
              camera: { shotSize: 'unknown', angle: 'unknown', movement: 'unknown' },
            },
          ],
        }),
      ).toBeDefined();
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...describeResult,
          shots: [{ ...describeResult.shots[0], quality: ['cinematic'] }],
        }),
      ).toThrow();
    });

    it('carries a describe progress phase', () => {
      expect(
        CapabilityPackWorkerProgressSchema.parse({
          type: 'progress',
          protocolVersion: 1,
          requestId: base.requestId,
          phase: 'describe',
          completed: 3,
          total: 16,
        }).phase,
      ).toBe('describe');
    });
  });
});
