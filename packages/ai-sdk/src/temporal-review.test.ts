import { describe, expect, it } from 'vitest';
import {
  TemporalEvidenceRequestSchema,
  planTemporalEvidence,
  planTemporalEvidenceForEdit,
  reviewTemporalEvidence,
  type TemporalEvidenceRequest,
  type TemporalEvidenceResult,
} from './temporal-review.js';
import { makeProject } from './__fixtures__/project.js';
import type { EditResult } from './assemble.js';

const requestBase = {
  schemaVersion: 1 as const,
  requestId: 'evidence_1',
  projectRevision: 7,
  reason: 'Check the edit',
};

const renderSettings = {
  identity: 'test:1920x1080@30:captions=true',
  presetId: 'test',
  width: 1920,
  height: 1080,
  fps: 30,
  burnCaptions: true,
} as const;

const resultBase = {
  schemaVersion: 1 as const,
  requestId: 'evidence_1',
  projectRevision: 7,
  renderSettings,
};

const rangeRequest: TemporalEvidenceRequest = {
  ...requestBase,
  kind: 'range',
  startFrame: 10,
  endFrame: 14,
  sampleEveryFrames: 1,
  checks: ['black_frames', 'flash_frames'],
};

describe('temporal evidence contracts', () => {
  it('parses every evidence request family and rejects invalid ranges', () => {
    const requests: unknown[] = [
      { ...requestBase, kind: 'frame', atFrame: 1, metrics: ['luma'] },
      rangeRequest,
      {
        ...requestBase,
        requestId: 'compare',
        kind: 'comparison',
        leftFrame: 1,
        rightFrame: 2,
        check: 'transition_continuity',
        maxDifference: 0.5,
      },
      {
        ...requestBase,
        requestId: 'scope',
        kind: 'scope',
        startFrame: 0,
        endFrame: 2,
        channels: ['luma'],
        legalMin: 0,
        legalMax: 1,
      },
      {
        ...requestBase,
        requestId: 'motion',
        kind: 'motion',
        startFrame: 0,
        endFrame: 3,
        targetId: 'clip',
        targetKind: 'clip_transform',
        property: 'scale',
      },
      {
        ...requestBase,
        requestId: 'audio',
        kind: 'audio',
        startFrame: 0,
        endFrame: 3,
        channels: 'dialogue',
      },
    ];
    expect(requests.map((request) => TemporalEvidenceRequestSchema.parse(request).kind)).toEqual([
      'frame',
      'range',
      'comparison',
      'scope',
      'motion',
      'audio',
    ]);
    expect(() => TemporalEvidenceRequestSchema.parse({ ...rangeRequest, endFrame: 10 })).toThrow(
      /endFrame/i,
    );
  });
});

describe('planTemporalEvidence', () => {
  it('chooses beginning/middle/end plus command-fact windows and J-cut audio', () => {
    const requests = planTemporalEvidence({
      projectRevision: 7,
      command: {
        type: 'j_cut_edit',
        timelineRevision: 7,
        videoOutgoingClipId: 'vo',
        videoIncomingClipId: 'vi',
        audioOutgoingClipId: 'ao',
        audioIncomingClipId: 'ai',
        delta: { domain: 'sequence', frames: 4, rate: { numerator: 30, denominator: 1 } },
      },
      facts: [
        { name: 'pictureCutSeconds', value: 2 },
        { name: 'soundCutSeconds', value: 1.8 },
      ],
      sequenceFps: 30,
      durationFrames: 300,
    });
    expect(
      requests.filter((request) => request.kind === 'frame').map((request) => request.atFrame),
    ).toEqual([0, 149, 299]);
    expect(requests.some((request) => request.kind === 'range' && request.startFrame === 58)).toBe(
      true,
    );
    expect(requests.some((request) => request.kind === 'comparison')).toBe(false);
    expect(requests.find((request) => request.kind === 'audio')).toMatchObject({ channels: 'mix' });
  });
});

describe('planTemporalEvidenceForEdit', () => {
  const editWith = (after: ReturnType<typeof makeProject>['timeline']): EditResult => ({
    patch: { patchId: 'patch', createdBy: 'agent', reason: 'test', operations: [] },
    validation: { valid: true, issues: [] },
    diff: { before: makeProject().timeline, after, summary: ['changed'] },
    text: 'test',
  });

  it('asks for evidence when a whole effect lane is added, not just when one changes', () => {
    // Regression: the added track's layers were compared against themselves (the
    // absent side fell back to the present one), so a lane full of effects arrived
    // with no critical frames requested and reviewed clean by default.
    const before = makeProject();
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        ...before.timeline.tracks,
        {
          id: 'fx',
          type: 'effect' as const,
          clips: [],
          effectLayers: [
            {
              id: 'fx1',
              effectId: 'gaussian-blur',
              kind: 'blur-gaussian' as const,
              start: 1,
              end: 3,
              params: { radius: 8 },
              enabled: true,
            },
          ],
        },
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
    });
    // The lane runs 1–3s, so windows around both of its own boundaries are asked for.
    const windows = requests
      .filter((request) => request.kind === 'range')
      .map((request) => request.requestId);
    expect(windows).toContain('edit_range_30');
    expect(windows).toContain('edit_range_90');
    // …and the edit counts as visual, so the representative frames come too.
    expect(requests.some((request) => request.kind === 'frame')).toBe(true);
  });

  it('plans representative frames and exact visual edit-boundary windows', () => {
    const before = makeProject();
    const video = before.timeline.tracks[0]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        { ...video, clips: [{ ...video.clips[0]!, end: 5.5 }, video.clips[1]!] },
        before.timeline.tracks[1]!,
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
    });
    expect(requests.filter((candidate) => candidate.kind === 'frame')).toHaveLength(3);
    expect(
      requests.some(
        (candidate) => candidate.kind === 'range' && candidate.requestId === 'edit_range_165',
      ),
    ).toBe(true);
  });

  it('claims continuity at interior splices only, never at the programme edges', () => {
    // Regression: laying a music bed across the whole programme planned continuity
    // checks at frame 0 and at the last frame. Neither is a cut — there is nothing
    // on the far side — but the engine still split each window down the middle and
    // measured the music's own attack, so a clean 30s montage failed review and the
    // entire run was discarded.
    const before = makeProject();
    const audioTrack = before.timeline.tracks[1]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        before.timeline.tracks[0]!,
        {
          ...audioTrack,
          clips: [
            {
              ...before.timeline.tracks[0]!.clips[0]!,
              id: 'music_bed',
              trackId: audioTrack.id,
              start: 0,
              end: 10,
            },
          ],
        },
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
    });
    const audio = requests.filter((request) => request.kind === 'audio');
    expect(audio).not.toHaveLength(0);
    // The bed spans the whole programme: both edges are metered for level only.
    expect(audio.every((request) => request.boundaryFrame === undefined)).toBe(true);
    // Every window is still asked for, so peak/level regressions are still caught.
    expect(audio.map((request) => request.requestId)).toContain('edit_audio_0');
  });

  it('names the splice when a clip edge falls inside the programme', () => {
    const before = makeProject();
    const audioTrack = before.timeline.tracks[1]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        before.timeline.tracks[0]!,
        {
          ...audioTrack,
          clips: [
            {
              ...before.timeline.tracks[0]!.clips[0]!,
              id: 'music_bed',
              trackId: audioTrack.id,
              start: 2,
              end: 6,
            },
          ],
        },
      ],
    };
    const audio = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
    }).filter((request) => request.kind === 'audio');
    expect(audio.map((request) => request.boundaryFrame)).toEqual(
      expect.arrayContaining([60, 180]),
    );
  });

  it('plans mix windows without visual frames for an audio-only change', () => {
    const before = makeProject();
    const audioTrack = before.timeline.tracks[1]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        before.timeline.tracks[0]!,
        {
          ...audioTrack,
          clips: [
            {
              ...before.timeline.tracks[0]!.clips[0]!,
              id: 'audio_clip',
              trackId: audioTrack.id,
            },
          ],
        },
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
    });
    expect(requests.every((candidate) => candidate.kind === 'audio')).toBe(true);
    expect(requests).not.toHaveLength(0);
  });

  it('reviews embedded audio across a video clip after its mix changes', () => {
    const before = makeProject();
    const video = before.timeline.tracks[0]!;
    const clip = video.clips[0]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        {
          ...video,
          clips: [
            {
              ...clip,
              effects: [
                ...clip.effects,
                {
                  id: `${clip.id}__gain`,
                  type: 'audio_gain',
                  params: { gainDb: -6, normalize: true },
                  keyframes: [],
                },
              ],
            },
            ...video.clips.slice(1),
          ],
        },
        before.timeline.tracks[1]!,
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
    });
    const audio = requests.filter((candidate) => candidate.kind === 'audio');
    expect(audio.length).toBeGreaterThanOrEqual(3);
    expect(audio.some((request) => request.requestId === 'edit_audio_89')).toBe(true);
    expect(audio.every((request) => request.channels === 'mix')).toBe(true);
  });

  it('plans bounded inside-frame jitter evidence for a changed tracker', () => {
    const before = makeProject();
    const video = before.timeline.tracks[0]!;
    const clip = video.clips[0]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        {
          ...video,
          clips: [
            {
              ...clip,
              effects: [
                ...clip.effects,
                {
                  id: `${clip.id}__track`,
                  type: 'object_track',
                  params: {
                    target: 'object',
                    engine: 'manual',
                    region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
                  },
                  keyframes: [
                    { id: 'x', time: 0, property: 'x', value: 0.1, easing: 'linear' as const },
                    { id: 'y', time: 0, property: 'y', value: 0.1, easing: 'linear' as const },
                    { id: 'w', time: 0, property: 'width', value: 0.2, easing: 'linear' as const },
                    { id: 'h', time: 0, property: 'height', value: 0.2, easing: 'linear' as const },
                  ],
                },
              ],
            },
            ...video.clips.slice(1),
          ],
        },
        before.timeline.tracks[1]!,
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 900,
    });
    const motion = requests.filter((candidate) => candidate.kind === 'motion');
    expect(motion.length).toBeGreaterThan(0);
    expect(motion.every((request) => request.endFrame - request.startFrame <= 300)).toBe(true);
    expect(motion[0]).toMatchObject({
      targetId: `${clip.id}__track`,
      targetKind: 'tracker',
      property: 'x',
      requireInsideFrame: true,
    });
  });

  it('returns no plan without a validated diff and enforces the request cap', () => {
    const noDiff: EditResult = {
      patch: { patchId: 'patch', createdBy: 'agent', reason: 'test', operations: [] },
      validation: { valid: true, issues: [] },
      text: 'test',
    };
    expect(
      planTemporalEvidenceForEdit({
        projectRevision: 0,
        edit: noDiff,
        sequenceFps: 30,
        durationFrames: 300,
      }),
    ).toEqual([]);
    const before = makeProject();
    const after = {
      ...before.timeline,
      tracks: before.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, end: clip.end - 0.1 })),
      })),
    };
    expect(
      planTemporalEvidenceForEdit({
        projectRevision: 1,
        edit: editWith(after),
        sequenceFps: 30,
        durationFrames: 300,
        maxRequests: 2,
      }),
    ).toHaveLength(2);
  });

  it('preserves audio evidence inside a capped mixed visual and audio plan', () => {
    const before = makeProject();
    const videoTrack = before.timeline.tracks[0]!;
    const audioTrack = before.timeline.tracks[1]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        {
          ...videoTrack,
          clips: videoTrack.clips.map((clip, index) => ({
            ...clip,
            end: clip.end - (index + 1) * 0.1,
          })),
        },
        {
          ...audioTrack,
          clips: [
            {
              ...videoTrack.clips[0]!,
              id: 'audio_clip',
              trackId: audioTrack.id,
            },
          ],
        },
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
      maxRequests: 5,
    });
    expect(requests).toHaveLength(5);
    expect(requests.some((candidate) => candidate.kind === 'range')).toBe(true);
    expect(requests.some((candidate) => candidate.kind === 'audio')).toBe(true);
  });
});

describe('reviewTemporalEvidence', () => {
  it('passes stable range evidence and fails black/flash frames', () => {
    const stable: TemporalEvidenceResult = {
      ...resultBase,
      kind: 'range',
      samples: [
        { frame: 10, luma: 0.4, blackRatio: 0 },
        { frame: 11, luma: 0.45, blackRatio: 0 },
        { frame: 12, luma: 0.5, blackRatio: 0 },
        { frame: 13, luma: 0.55, blackRatio: 0 },
      ],
    };
    expect(reviewTemporalEvidence([rangeRequest], [stable]).ok).toBe(true);
    const broken = {
      ...stable,
      samples: [
        { frame: 10, luma: 0.05, blackRatio: 0.99 },
        { frame: 11, luma: 0.95, blackRatio: 0 },
        { frame: 12, luma: 0.05, blackRatio: 0 },
        { frame: 13, luma: 0.05, blackRatio: 0 },
      ],
    };
    const report = reviewTemporalEvidence([rangeRequest], [broken]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.issues.join(' ')).toMatch(/black.*flash/i);
  });

  // GAP-005. A timeline with no picture under its overlays makes every sampled frame
  // black, so every range fails and the run reports the same fact once per edit boundary.
  // Run e30c1fe9 ended on fifteen such lines; the model read them as fifteen broken cuts
  // and spent its last turn adding transitions to fix them.
  it('names the cause once when every sampled range is black, not per boundary', () => {
    const black = (requestId: string, at: number): TemporalEvidenceResult => ({
      ...resultBase,
      requestId,
      kind: 'range',
      samples: [
        { frame: at, luma: 0, blackRatio: 1 },
        { frame: at + 1, luma: 0, blackRatio: 1 },
      ],
    });
    const range = (requestId: string, at: number): TemporalEvidenceRequest => ({
      ...rangeRequest,
      requestId,
      startFrame: at,
      endFrame: at + 2,
    });
    const report = reviewTemporalEvidence(
      [range('edit_range_0', 0), range('edit_range_90', 90), range('edit_range_240', 240)],
      [black('edit_range_0', 0), black('edit_range_90', 90), black('edit_range_240', 240)],
    );
    expect(report.ok).toBe(false);
    for (const check of report.checks) {
      expect(check.issues[0]).toMatch(/no picture under its overlays|Every sampled moment/);
      expect(check.issues.join(' ')).not.toMatch(/Unexpected black/);
    }
  });

  it('keeps precise frame numbers when only one range is black', () => {
    const clean: TemporalEvidenceResult = {
      ...resultBase,
      requestId: 'edit_range_90',
      kind: 'range',
      samples: [
        { frame: 90, luma: 0.4, blackRatio: 0 },
        { frame: 91, luma: 0.42, blackRatio: 0 },
      ],
    };
    const dark: TemporalEvidenceResult = {
      ...resultBase,
      requestId: 'edit_range_0',
      kind: 'range',
      samples: [
        { frame: 0, luma: 0, blackRatio: 1 },
        { frame: 1, luma: 0.4, blackRatio: 0 },
      ],
    };
    const report = reviewTemporalEvidence(
      [
        { ...rangeRequest, requestId: 'edit_range_0', startFrame: 0, endFrame: 2 },
        { ...rangeRequest, requestId: 'edit_range_90', startFrame: 90, endFrame: 92 },
      ],
      [dark, clean],
    );
    // A real flash at a real cut keeps its own numbers — that is a defect an edit can fix.
    expect(report.checks[0]?.issues.join(' ')).toMatch(/Unexpected black frame\(s\): 0/);
  });

  it('checks comparison continuity and legal scopes', () => {
    const requests = [
      {
        ...requestBase,
        requestId: 'compare',
        kind: 'comparison',
        leftFrame: 9,
        rightFrame: 10,
        check: 'transition_continuity',
        maxDifference: 0.4,
      },
      {
        ...requestBase,
        requestId: 'scope',
        kind: 'scope',
        startFrame: 9,
        endFrame: 11,
        channels: ['luma'],
        legalMin: 0,
        legalMax: 1,
      },
    ];
    const results = [
      {
        ...resultBase,
        requestId: 'compare',
        kind: 'comparison',
        leftFrame: 9,
        rightFrame: 10,
        difference: 0.8,
      },
      {
        ...resultBase,
        requestId: 'scope',
        kind: 'scope',
        samples: [
          {
            frame: 10,
            channel: 'luma',
            min: -0.1,
            max: 1,
            mean: 0.45,
            p10: 0.1,
            p50: 0.4,
            p90: 0.8,
            nearBlackRatio: 0.01,
            nearWhiteRatio: 0.02,
          },
        ],
      },
    ];
    const report = reviewTemporalEvidence(requests, results);
    expect(report.checks.every((check) => check.status === 'fail')).toBe(true);
  });

  it('detects transform acceleration, out-of-frame bounds, and tracker jitter', () => {
    const motionRequest = {
      ...requestBase,
      kind: 'motion',
      startFrame: 0,
      endFrame: 3,
      targetId: 'subject',
      targetKind: 'tracker',
      property: 'position',
      maxAccelerationPerFrame: 0.2,
      maxJitterPerFrame: 0.1,
      requireInsideFrame: true,
    };
    const result = {
      ...resultBase,
      renderSettings: null,
      kind: 'motion',
      samples: [
        {
          frame: 0,
          value: 0,
          point: { x: 0, y: 0 },
          bounds: { x: 0, y: 0, width: 0.2, height: 0.2 },
        },
        {
          frame: 1,
          value: 1,
          point: { x: 1, y: 1 },
          bounds: { x: 0.9, y: 0.9, width: 0.2, height: 0.2 },
        },
        {
          frame: 2,
          value: 1,
          point: { x: 0, y: 0 },
          bounds: { x: 0, y: 0, width: 0.2, height: 0.2 },
        },
      ],
    };
    const issues = reviewTemporalEvidence([motionRequest], [result]).checks[0]?.issues.join(' ');
    expect(issues).toMatch(/bounds.*acceleration.*jitter/i);
  });

  it('rejects motion evidence that omits metrics required by the request', () => {
    const request = {
      ...requestBase,
      kind: 'motion',
      startFrame: 0,
      endFrame: 2,
      targetId: 'subject',
      targetKind: 'tracker',
      property: 'position',
      maxAccelerationPerFrame: 0.2,
      maxJitterPerFrame: 0.1,
      requireInsideFrame: true,
    };
    const result = {
      ...resultBase,
      renderSettings: null,
      kind: 'motion',
      samples: [{ frame: 0 }, { frame: 1 }],
    };
    expect(reviewTemporalEvidence([request], [result]).checks[0]?.issues.join(' ')).toMatch(
      /numeric values.*tracked points.*normalized bounds/i,
    );
  });

  it('detects audio peaks and discontinuities', () => {
    const request = {
      ...requestBase,
      kind: 'audio',
      startFrame: 0,
      endFrame: 3,
      boundaryFrame: 1,
      channels: 'dialogue',
      maxPeakDbfs: -0.1,
      maxBoundaryJumpDb: 12,
    };
    const result = {
      ...resultBase,
      kind: 'audio',
      samples: [{ startFrame: 0, endFrame: 3, peakDbfs: 0, rmsDbfs: -10, boundaryJumpDb: 18 }],
    };
    expect(reviewTemporalEvidence([request], [result]).checks[0]?.issues.join(' ')).toMatch(
      /peak.*discontinuity/i,
    );
  });

  it('judges continuity only where the request named a splice', () => {
    // A window with no boundary is a level check. Failing it on a "jump" is how a
    // valid montage got discarded: the music simply starting is not a bad cut.
    const request = {
      ...requestBase,
      kind: 'audio',
      startFrame: 0,
      endFrame: 3,
      channels: 'mix',
      maxPeakDbfs: -0.1,
      maxBoundaryJumpDb: 12,
    };
    const result = {
      ...resultBase,
      kind: 'audio',
      samples: [{ startFrame: 0, endFrame: 3, peakDbfs: -3, rmsDbfs: -10, boundaryJumpDb: 18 }],
    };
    expect(reviewTemporalEvidence([request], [result]).checks[0]).toMatchObject({ status: 'pass' });
  });

  it('refuses a boundary that has no audio on one side of it', () => {
    expect(() =>
      reviewTemporalEvidence(
        [
          {
            ...requestBase,
            kind: 'audio',
            startFrame: 0,
            endFrame: 3,
            boundaryFrame: 0,
            channels: 'mix',
            maxPeakDbfs: -0.1,
            maxBoundaryJumpDb: 12,
          },
        ],
        [],
      ),
    ).toThrow(/boundaryFrame must sit strictly inside the window/);
  });

  it('fails stale lineage and treats missing evidence as skipped, never pass', () => {
    const stale = {
      ...resultBase,
      projectRevision: 8,
      kind: 'range',
      samples: [{ frame: 10, luma: 0.4, blackRatio: 0 }],
    };
    expect(reviewTemporalEvidence([rangeRequest], [stale]).checks[0]).toMatchObject({
      status: 'fail',
    });
    expect(reviewTemporalEvidence([rangeRequest], []).checks[0]).toMatchObject({
      status: 'skipped',
    });
  });

  it('rejects evidence contamination and mismatched sample windows', () => {
    expect(() =>
      reviewTemporalEvidence(
        [rangeRequest],
        [
          {
            ...resultBase,
            requestId: 'not_requested',
            kind: 'range',
            samples: [{ frame: 10, luma: 0.4, blackRatio: 0 }],
          },
        ],
      ),
    ).toThrow(/Unexpected temporal result/);
    const report = reviewTemporalEvidence(
      [rangeRequest],
      [
        {
          ...resultBase,
          kind: 'range',
          samples: [{ frame: 99, luma: 0.4, blackRatio: 0 }],
        },
      ],
    );
    expect(report.checks[0]).toMatchObject({ status: 'fail' });
    expect(report.checks[0]?.issues.join(' ')).toMatch(/missing.*outside|outside.*missing/i);
  });
});

describe('loudness review', () => {
  const request = {
    schemaVersion: 1,
    requestId: 'loud_1',
    projectRevision: 4,
    reason: 'delivery loudness',
    kind: 'loudness',
    startFrame: 0,
    endFrame: 150,
    channels: 'dialogue',
    targetLufs: -14,
    toleranceLu: 1,
  };
  const result = (integratedLufs: number) => ({
    schemaVersion: 1,
    requestId: 'loud_1',
    projectRevision: 4,
    kind: 'loudness',
    renderSettings,
    sample: { integratedLufs },
  });

  it('passes a reading inside the delivery tolerance', () => {
    expect(reviewTemporalEvidence([request], [result(-14.6)]).ok).toBe(true);
  });

  it.each([
    ['too quiet', -18],
    ['too loud', -9],
  ])('fails a reading that is %s', (_label, lufs) => {
    const report = reviewTemporalEvidence([request], [result(lufs)]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.issues.join(' ')).toContain('LUFS target');
  });
});

describe('representative frames assert what they measure', () => {
  const frameAt = (frame: number, blackRatio: number) => ({
    schemaVersion: 1 as const,
    requestId: `representative_x_${String(frame)}`,
    projectRevision: 7,
    kind: 'frame' as const,
    renderSettings,
    sample: { frame, luma: blackRatio === 1 ? 0 : 0.5, blackRatio },
  });

  const requestAt = (frame: number, reason: string) => ({
    schemaVersion: 1 as const,
    requestId: `representative_x_${String(frame)}`,
    projectRevision: 7,
    kind: 'frame' as const,
    atFrame: frame,
    metrics: ['luma', 'black_ratio', 'perceptual_hash'] as const,
    checks: ['black_frames'] as const,
    reason,
  });

  it('regression: a black programme midpoint and ending are reported', () => {
    // Run 4c9b5f82. Picture ran out at 10.0s of a 36.1s programme. Both of these frames
    // came back with blackRatio 1 and both were checked only for carrying the right frame
    // number, so the run's whole account of 26 seconds of black was the two frames that
    // fell inside a ±2-frame window around the final cut.
    const report = reviewTemporalEvidence(
      [
        requestAt(0, 'Program opening'),
        requestAt(541, 'Program midpoint'),
        requestAt(1083, 'Program ending'),
      ],
      [frameAt(0, 0), frameAt(541, 1), frameAt(1083, 1)],
    );
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ status: 'pass' });
    expect(report.checks[1]).toMatchObject({ status: 'fail' });
    expect(report.checks[1]?.issues.join(' ')).toBe('Program midpoint is black (frame 541).');
    expect(report.checks[2]?.issues.join(' ')).toBe('Program ending is black (frame 1083).');
  });

  it('a frame request without checks still only measures', () => {
    const { checks: _checks, ...measureOnly } = requestAt(541, 'Program midpoint');
    const report = reviewTemporalEvidence([measureOnly], [frameAt(541, 1)]);
    expect(report.ok).toBe(true);
  });

  it('the edit planner asks its representative frames to assert', () => {
    const before = makeProject();
    const video = before.timeline.tracks[0]!;
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        { ...video, clips: [{ ...video.clips[0]!, end: 5.5 }, video.clips[1]!] },
        before.timeline.tracks[1]!,
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 7,
      edit: {
        patch: { patchId: 'patch', createdBy: 'agent', reason: 'test', operations: [] },
        validation: { valid: true, issues: [] },
        diff: { before: before.timeline, after, summary: ['changed'] },
        text: 'test',
      },
      sequenceFps: 30,
      durationFrames: 1084,
    });
    const representative = requests.filter((request) => request.requestId.startsWith('repres'));
    expect(representative.length).toBeGreaterThan(0);
    for (const request of representative) {
      expect(request).toMatchObject({ kind: 'frame', checks: ['black_frames'] });
    }
  });
});
