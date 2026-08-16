import { describe, expect, it } from 'vitest';
import {
  evidenceIdFor,
  normalizeMediaProbe,
  sequenceToSourceTime,
  sourceToSequenceTime,
  unavailableTimestampAnswer,
  visualEvidence,
  type ClipTimeMapping,
} from './media-evidence.js';

const mapping: ClipTimeMapping = {
  clipId: 'clip-1',
  assetId: 'asset-1',
  sequenceStart: 10,
  sequenceEnd: 15,
  sourceStart: 20,
  sourceEnd: 30,
  speed: 2,
};

describe('normalizeMediaProbe', () => {
  it('derives frame count for video without inventing missing stream fields', () => {
    expect(
      normalizeMediaProbe({
        assetId: 'asset-1',
        durationSeconds: 2,
        fps: 29.97,
        width: 1920,
        height: 1080,
        hasVideo: true,
        hasAudio: false,
      }),
    ).toEqual({
      assetId: 'asset-1',
      durationSeconds: 2,
      fps: 29.97,
      frameCount: 60,
      width: 1920,
      height: 1080,
      hasVideo: true,
      hasAudio: false,
    });
  });

  it('preserves a probed frame count and omits it for audio-only media', () => {
    expect(
      normalizeMediaProbe({
        assetId: 'asset-1',
        durationSeconds: 1,
        fps: 30,
        frameCount: 31,
        hasVideo: true,
        hasAudio: true,
      }).frameCount,
    ).toBe(31);
    expect(
      normalizeMediaProbe({
        assetId: 'audio-1',
        durationSeconds: 4,
        hasVideo: false,
        hasAudio: true,
      }),
    ).not.toHaveProperty('frameCount');
  });

  it('rejects malformed deterministic facts', () => {
    expect(() =>
      normalizeMediaProbe({
        assetId: 'asset-1',
        durationSeconds: -1,
        hasVideo: false,
        hasAudio: true,
      }),
    ).toThrow('durationSeconds');
    expect(() =>
      normalizeMediaProbe({
        assetId: 'asset-1',
        durationSeconds: 1,
        fps: 0,
        hasVideo: true,
        hasAudio: false,
      }),
    ).toThrow('fps');
    expect(() =>
      normalizeMediaProbe({
        assetId: 'asset-1',
        durationSeconds: 1,
        width: 1.5,
        hasVideo: true,
        hasAudio: false,
      }),
    ).toThrow('width');
    expect(() =>
      normalizeMediaProbe({
        assetId: 'asset-1',
        durationSeconds: 1,
        height: 0,
        hasVideo: true,
        hasAudio: false,
      }),
    ).toThrow('height');
  });
});

describe('constant-speed time mapping', () => {
  it('maps source to the nearest sequence frame', () => {
    expect(sourceToSequenceTime(mapping, 22, 30)).toEqual({
      domain: 'sequence',
      frame: 330,
      seconds: 11,
    });
  });

  it('maps sequence time back into source time', () => {
    expect(sequenceToSourceTime(mapping, 11)).toEqual({ domain: 'source', seconds: 22 });
  });

  it('uses half-open ranges and returns undefined outside the clip', () => {
    expect(sourceToSequenceTime(mapping, 19.9, 30)).toBeUndefined();
    expect(sourceToSequenceTime(mapping, 30, 30)).toBeUndefined();
    expect(sequenceToSourceTime(mapping, 9.9)).toBeUndefined();
    expect(sequenceToSourceTime(mapping, 15)).toBeUndefined();
  });

  it('defaults an unspecified speed to 1× rather than treating it as zero', () => {
    // `speed` is optional on a mapping. Reading an absent value as 0 would divide the
    // timeline by zero; reading it as 1 is the only correct default for a normal clip.
    const realtime = { ...mapping };
    delete (realtime as { speed?: number }).speed;
    expect(sourceToSequenceTime(realtime, 22, 30)?.seconds).toBe(
      22 - realtime.sourceStart + realtime.sequenceStart,
    );
    expect(sequenceToSourceTime(realtime, realtime.sequenceStart)?.seconds).toBe(
      realtime.sourceStart,
    );
  });

  it('rejects invalid times and playback speed', () => {
    expect(() => sourceToSequenceTime(mapping, -1, 30)).toThrow('sourceSeconds');
    expect(() => sequenceToSourceTime(mapping, -1)).toThrow('sequenceSeconds');
    expect(() => sourceToSequenceTime({ ...mapping, speed: 0 }, 22, 30)).toThrow('speed');
    expect(() => sequenceToSourceTime({ ...mapping, speed: Number.NaN }, 11)).toThrow('speed');
  });

  it('returns undefined when inconsistent ranges map outside the other domain', () => {
    expect(sourceToSequenceTime({ ...mapping, sequenceEnd: 10.5 }, 22, 30)).toBeUndefined();
    expect(sequenceToSourceTime({ ...mapping, sourceEnd: 20.5 }, 11)).toBeUndefined();
  });
});

describe('visual evidence', () => {
  it('builds stable provenance and a timeline jump target', () => {
    const result = visualEvidence({
      assetId: 'asset-1',
      sourceSeconds: 22,
      backend: 'twelvelabs',
      cacheState: 'persistent-hit',
      sequenceFps: 30,
      mapping,
      query: ' Person enters ',
      thumbnailUrl: 'framepilot://frame/1',
      description: 'A person enters the room.',
      confidence: 0.91,
    });
    expect(result).toMatchObject({
      evidenceId: evidenceIdFor({
        assetId: 'asset-1',
        sourceSeconds: 22,
        backend: 'twelvelabs',
        query: 'person enters',
      }),
      assetId: 'asset-1',
      clipId: 'clip-1',
      source: { domain: 'source', seconds: 22 },
      sequence: { domain: 'sequence', frame: 330, seconds: 11 },
      backend: 'twelvelabs',
      cacheState: 'persistent-hit',
      thumbnailUrl: 'framepilot://frame/1',
      description: 'A person enters the room.',
      confidence: 0.91,
    });
  });

  it('does not manufacture optional visual fields', () => {
    expect(
      visualEvidence({
        assetId: 'asset-1',
        sourceSeconds: 1,
        backend: 'local',
        cacheState: 'fresh',
      }),
    ).toEqual({
      evidenceId: evidenceIdFor({
        assetId: 'asset-1',
        sourceSeconds: 1,
        backend: 'local',
      }),
      assetId: 'asset-1',
      source: { domain: 'source', seconds: 1 },
      backend: 'local',
      cacheState: 'fresh',
    });
  });

  it('rejects bad source times and confidence', () => {
    expect(() =>
      visualEvidence({
        assetId: 'asset-1',
        sourceSeconds: -1,
        backend: 'local',
        cacheState: 'fresh',
      }),
    ).toThrow('sourceSeconds');
    expect(() =>
      visualEvidence({
        assetId: 'asset-1',
        sourceSeconds: 1,
        backend: 'local',
        cacheState: 'fresh',
        confidence: 2,
      }),
    ).toThrow('confidence');
  });

  it('normalizes the evidence query for stable identity', () => {
    expect(
      evidenceIdFor({
        assetId: 'asset-1',
        sourceSeconds: 1.0004,
        backend: 'local',
        query: ' PERSON ',
      }),
    ).toBe(
      evidenceIdFor({
        assetId: 'asset-1',
        sourceSeconds: 1.00049,
        backend: 'local',
        query: 'person',
      }),
    );
  });
});

describe('unavailableTimestampAnswer', () => {
  it('returns an honest empty no-answer without a fake recovery', () => {
    expect(unavailableTimestampAnswer('no_answer')).toEqual({
      available: false,
      reason: 'no_answer',
      evidence: [],
    });
  });

  it('preserves recovery guidance and partial evidence', () => {
    const evidence = visualEvidence({
      assetId: 'asset-1',
      sourceSeconds: 1,
      backend: 'local',
      cacheState: 'fresh',
    });
    expect(
      unavailableTimestampAnswer(
        'offline_uncached',
        'Reconnect to use TwelveLabs for this semantic question.',
        [evidence],
      ),
    ).toEqual({
      available: false,
      reason: 'offline_uncached',
      recovery: 'Reconnect to use TwelveLabs for this semantic question.',
      evidence: [evidence],
    });
  });
});
