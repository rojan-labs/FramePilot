import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_PACK_OUTPUT_HANDLE_CAPABILITIES,
  CapabilityPackWorkerFailureSchema,
  CapabilityPackWorkerInputSchema,
  negotiateCapabilityPackCapability,
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
    // A deterministic size-bound refusal carries its own stable code so the host can
    // branch on it instead of matching `detail` text.
    expect(
      CapabilityPackWorkerFailureSchema.parse({
        type: 'failure',
        protocolVersion: 1,
        requestId: base.requestId,
        code: 'output_too_large',
        detail: 'worker output line exceeded its 1 MiB bound.',
        retryable: false,
      }),
    ).toMatchObject({ code: 'output_too_large', retryable: false });
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

  describe('subject.matte and subject.segment_frame', () => {
    const sha = (c: string) => c.repeat(64);
    const output = {
      handleId: 'matte-out:req-1',
      absolutePath: '/projects/p/.framepilot-derived/mattes/.staging/req-1',
      allowedFiles: ['matte.mkv', 'foreground.mkv', 'frames.json', 'report.json'],
      maxBytes: 1_000_000_000,
    };
    const matteRequest = (parameters: Record<string, unknown>) => ({
      ...base,
      capability: 'subject.matte',
      parameters: { output, prompts: [{ kind: 'box', pts: 0, box: { x: 0.1, y: 0.1, width: 0.5, height: 0.8 } }], previewHeight: 540, ...parameters },
    });
    const matteResult = {
      type: 'result',
      protocolVersion: 1,
      requestId: base.requestId,
      projectRevision: base.projectRevision,
      capability: 'subject.matte',
      backend: 'onnxruntime',
      modelDigests: { sam: sha('a') },
      artifact: {
        files: [
          { name: 'matte.mkv', bytes: 1024, sha256: sha('b') },
          { name: 'frames.json', bytes: 64, sha256: sha('c') },
        ],
        width: 1920,
        height: 1080,
        frameCount: 90,
        firstPts: 512,
        lastPts: 46080,
        timeBase: [1, 15360],
      },
      executionProvider: 'cpu',
      summary: { verifiedFrames: 88, flaggedFrames: 2, lockedFrames: 0, selfCorrectionRounds: 1 },
      needsReview: [{ startPts: 1024, endPts: 1536, reason: 'occlusion' }],
    } as const;

    it('accepts points, box, brush and lock prompts with a host output handle', () => {
      const parsed = CapabilityPackWorkerRequestSchema.parse(
        matteRequest({
          inputs: {
            handleId: 'matte-in:req-1',
            absolutePath: '/projects/p/.framepilot-derived/mattes/.staging/req-1/inputs',
            files: ['corrections/1024.png', 'locked/-512.png'],
          },
          prompts: [
            { kind: 'points', pts: 0, points: [{ x: 0.5, y: 0.5, label: 'include' }] },
            { kind: 'brush', pts: 1024, file: 'corrections/1024.png' },
            { kind: 'lock', pts: -512, file: 'locked/-512.png' },
          ],
          previousArtifact: sha('d'),
        }),
      );
      expect(parsed.capability).toBe('subject.matte');
    });

    it('refuses traversal, undeclared files, and a relative handle', () => {
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse(
          matteRequest({ output: { ...output, absolutePath: '/projects/p/../../etc' } }),
        ),
      ).toThrow(/traversal/);
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse(
          matteRequest({ output: { ...output, absolutePath: 'relative/dir' } }),
        ),
      ).toThrow(/absolute/);
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse(
          matteRequest({ output: { ...output, allowedFiles: ['matte.mkv', '../evil.sh'] } }),
        ),
      ).toThrow();
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse(
          matteRequest({
            inputs: {
              handleId: 'matte-in:req-1',
              absolutePath: '/staging/req-1/inputs',
              files: ['corrections/../../x.png'],
            },
            prompts: [{ kind: 'brush', pts: 0, file: 'corrections/../../x.png' }],
            previousArtifact: sha('d'),
          }),
        ),
      ).toThrow();
      // A brush that is not in the inputs handle, and a file named for a different pts.
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse(
          matteRequest({
            prompts: [{ kind: 'brush', pts: 10, file: 'corrections/10.png' }],
            previousArtifact: sha('d'),
          }),
        ),
      ).toThrow(/inputs handle/);
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse(
          matteRequest({
            inputs: { handleId: 'matte-in:1', absolutePath: '/s/in', files: ['locked/11.png'] },
            prompts: [{ kind: 'lock', pts: 10, file: 'locked/11.png' }],
            previousArtifact: sha('d'),
          }),
        ),
      ).toThrow(/its pts/);
    });

    it('refuses an empty prompt list and a corrections-only first run', () => {
      expect(() => CapabilityPackWorkerRequestSchema.parse(matteRequest({ prompts: [] }))).toThrow();
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse(
          matteRequest({
            inputs: { handleId: 'matte-in:1', absolutePath: '/s/in', files: ['locked/1.png'] },
            prompts: [{ kind: 'lock', pts: 1, file: 'locked/1.png' }],
          }),
        ),
      ).toThrow(/previous artifact/);
    });

    it('accepts a matte result and refuses unsafe or impossible descriptors', () => {
      expect(CapabilityPackWorkerResultSchema.parse(matteResult)).toMatchObject({
        executionProvider: 'cpu',
      });
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...matteResult,
          artifact: { ...matteResult.artifact, files: [matteResult.artifact.files[0]] },
        }),
      ).toThrow();
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...matteResult,
          artifact: {
            ...matteResult.artifact,
            files: [...matteResult.artifact.files, { name: 'run.sh', bytes: 1, sha256: sha('e') }],
          },
        }),
      ).toThrow();
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...matteResult,
          summary: { ...matteResult.summary, verifiedFrames: 90 },
        }),
      ).toThrow(/cannot exceed/);
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({
          ...matteResult,
          needsReview: [{ startPts: 10, endPts: 5, reason: 'occlusion' }],
        }),
      ).toThrow(/end before/);
    });

    it('adds matte progress phases with a round, and output_unwritable', () => {
      expect(
        CapabilityPackWorkerProgressSchema.parse({
          type: 'progress',
          protocolVersion: 1,
          requestId: base.requestId,
          phase: 'self_correct',
          completed: 1,
          total: 3,
          round: 2,
        }),
      ).toMatchObject({ phase: 'self_correct', round: 2 });
      expect(
        CapabilityPackWorkerFailureSchema.parse({
          type: 'failure',
          protocolVersion: 1,
          requestId: base.requestId,
          code: 'output_unwritable',
          detail: 'No space left on device.',
          retryable: true,
        }).code,
      ).toBe('output_unwritable');
    });

    it('accepts a segment_frame request and a bounded PNG result', () => {
      expect(
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'subject.segment_frame',
          parameters: { pts: 512, hoverPoint: { x: 0.4, y: 0.4 }, previewHeight: 540 },
        }).capability,
      ).toBe('subject.segment_frame');
      expect(() =>
        CapabilityPackWorkerRequestSchema.parse({
          ...base,
          capability: 'subject.segment_frame',
          parameters: { pts: 512, previewHeight: 540 },
        }),
      ).toThrow(/needs points/);
      const png = {
        type: 'result',
        protocolVersion: 1,
        requestId: base.requestId,
        projectRevision: base.projectRevision,
        capability: 'subject.segment_frame',
        backend: 'onnxruntime',
        modelDigests: {},
        pts: 512,
        width: 960,
        height: 540,
        maskPng: Buffer.from('png-bytes').toString('base64'),
        score: 0.93,
      };
      expect(CapabilityPackWorkerResultSchema.parse(png)).toMatchObject({ score: 0.93 });
      expect(() =>
        CapabilityPackWorkerResultSchema.parse({ ...png, maskPng: 'x'.repeat(900_001) }),
      ).toThrow();
    });

    it('negotiates additively: v1 stays v1 and an older pack is unsupported, not broken', () => {
      // Existing v1 messages still parse through the widened input union.
      expect(
        CapabilityPackWorkerInputSchema.parse({
          ...base,
          capability: 'tracking.point',
          parameters: { point: { x: 0.4, y: 0.3 } },
        }),
      ).toBeDefined();
      expect(
        negotiateCapabilityPackCapability(
          { protocolVersion: 1, capabilities: ['subject.detect', 'subject.segment'] },
          'subject.matte',
        ),
      ).toEqual({ status: 'unsupported', reason: 'capability_absent' });
      expect(
        negotiateCapabilityPackCapability(
          { protocolVersion: 1, capabilities: ['subject.matte', 'subject.segment_frame'] },
          'subject.matte',
        ),
      ).toEqual({ status: 'supported' });
      expect(
        negotiateCapabilityPackCapability({ protocolVersion: 2, capabilities: ['subject.matte'] }, 'subject.matte'),
      ).toEqual({ status: 'unsupported', reason: 'protocol_mismatch' });
      expect([...CAPABILITY_PACK_OUTPUT_HANDLE_CAPABILITIES]).toEqual(['subject.matte']);
    });
  });
});
