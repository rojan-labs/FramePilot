import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { applyPatch } from './patch.js';
import {
  compileAudioCommand,
  type AudioCommand,
  type AudioCommandCompileResult,
} from './audio-commands.js';

const assets: Asset[] = [
  { id: 'music_asset', path: 'music.wav', kind: 'audio', durationSeconds: 10 },
  { id: 'voice_asset', path: 'voice.wav', kind: 'audio', durationSeconds: 10 },
  { id: 'still_asset', path: 'still.png', kind: 'image', durationSeconds: 10 },
];

function timeline(options: { readonly locked?: boolean; readonly image?: boolean } = {}): Timeline {
  return {
    revision: 4,
    tracks: [
      {
        id: 'music',
        type: 'audio',
        ...(options.locked ? { locked: true } : {}),
        clips: [
          {
            id: 'bed',
            assetId: options.image ? 'still_asset' : 'music_asset',
            trackId: 'music',
            start: 0,
            end: 10,
            sourceStart: 0,
            sourceEnd: 10,
            effects: [
              {
                id: 'legacy_gain',
                type: 'audio_gain',
                params: { gainDb: -3, fadeInSeconds: 0.5, normalize: true },
                keyframes: [],
              },
            ],
            keyframes: [],
          },
        ],
      },
      {
        id: 'dialogue',
        type: 'audio',
        clips: [
          {
            id: 'voice',
            assetId: 'voice_asset',
            trackId: 'dialogue',
            start: 1,
            end: 9,
            sourceStart: 0,
            sourceEnd: 8,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  };
}

function command(overrides: Partial<AudioCommand> = {}): AudioCommand {
  return {
    type: 'mix_clip_audio',
    timelineRevision: 4,
    clipId: 'bed',
    rate: { numerator: 30, denominator: 1 },
    settings: { gainDb: -6 },
    ...overrides,
  } as AudioCommand;
}

function compiled(
  value: AudioCommand,
  base = timeline(),
): Extract<AudioCommandCompileResult, { status: 'compiled' }> {
  const result = compileAudioCommand({ timeline: base, assets, command: value });
  expect(result.status, result.status === 'rejected' ? result.detail : undefined).toBe('compiled');
  return result as Extract<AudioCommandCompileResult, { status: 'compiled' }>;
}

describe('audio command compiler', () => {
  it('merges frame-based fades into the canonical mix and round-trips its inverse', () => {
    const base = timeline();
    const result = compiled(
      command({ settings: { gainDb: -6, fadeOutFrames: 30, fadeCurve: 'equal-power' } }),
      base,
    );
    expect(result.patch.operations).toEqual([
      {
        type: 'adjust_audio',
        clipId: 'bed',
        gainDb: -6,
        fadeInSeconds: 0.5,
        fadeOutSeconds: 1,
        fadeCurve: 'equal-power',
        muted: false,
        normalize: true,
      },
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips[0]!.effects).toHaveLength(1);
    expect(edited.tracks[0]!.clips[0]!.effects[0]).toMatchObject({
      id: 'bed__gain',
      type: 'audio_gain',
      params: { gainDb: -6, fadeInSeconds: 0.5, fadeOutSeconds: 1, normalize: true },
    });
    const restored = applyPatch(edited, result.inversePatch);
    expect({ ...restored, revision: base.revision }).toEqual(base);
  });

  it('adds deterministic sidechain ducking without discarding the existing mix', () => {
    const result = compiled(
      command({ settings: { duckUnderTrackId: 'dialogue', duckAmountDb: -14 } }),
    );
    expect(result.patch.operations[0]).toMatchObject({
      type: 'adjust_audio',
      clipId: 'bed',
      gainDb: -3,
      normalize: true,
      duckUnderTrackId: 'dialogue',
      duckAmountDb: -14,
    });
  });

  it('writes an EQ curve and a compressor onto the canonical mix effect', () => {
    const base = timeline();
    const result = compiled(
      command({
        settings: {
          eq: {
            bands: [
              { kind: 'high-pass', frequencyHz: 80 },
              { kind: 'peaking', frequencyHz: 3000, gainDb: 2.5, q: 1.2 },
            ],
          },
          dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, makeupGainDb: 2 },
        },
      }),
      base,
    );
    const params = applyPatch(base, result.patch).tracks[0]!.clips[0]!.effects[0]!.params;
    expect(params.eq).toEqual({
      bands: [
        { kind: 'high-pass', frequencyHz: 80 },
        { kind: 'peaking', frequencyHz: 3000, gainDb: 2.5, q: 1.2 },
      ],
    });
    expect(params.dynamics).toEqual({
      thresholdDb: -18,
      ratio: 3,
      attackMs: 10,
      releaseMs: 120,
      makeupGainDb: 2,
    });
    // The pre-existing gain/fade/normalize mix survives an EQ-only instruction.
    expect(params).toMatchObject({ gainDb: -3, fadeInSeconds: 0.5, normalize: true });
    expect(applyPatch(applyPatch(base, result.patch), result.inversePatch)).toEqual({
      ...base,
      revision: base.revision,
    });
  });

  it('writes a gain automation lane as keyframes on the mix effect and reports its span', () => {
    const base = timeline();
    const result = compiled(
      command({
        settings: {
          automation: {
            property: 'gainDb',
            points: [
              { timeSeconds: 0, value: 0 },
              { timeSeconds: 4, value: -12, easing: 'ease-in-out' },
              { timeSeconds: 8, value: 0 },
            ],
          },
        },
      }),
      base,
    );
    const effect = applyPatch(base, result.patch).tracks[0]!.clips[0]!.effects[0]!;
    expect(effect.keyframes).toEqual([
      { id: 'bed__gainDb__0', time: 0, property: 'gainDb', value: 0, easing: 'linear' },
      { id: 'bed__gainDb__4000', time: 4, property: 'gainDb', value: -12, easing: 'ease-in-out' },
      { id: 'bed__gainDb__8000', time: 8, property: 'gainDb', value: 0, easing: 'linear' },
    ]);
    expect(result.facts).toEqual(
      expect.arrayContaining([
        { name: 'automationPoints', value: 3 },
        { name: 'automationStartSeconds', value: 0 },
        { name: 'automationEndSeconds', value: 8 },
      ]),
    );
    expect(applyPatch(applyPatch(base, result.patch), result.inversePatch)).toEqual(base);
  });

  it('carries an existing automation lane through an unrelated mix edit, and clears it on request', () => {
    const base = timeline();
    const automated = applyPatch(
      base,
      compiled(
        command({
          settings: {
            automation: {
              property: 'gainDb',
              points: [
                { timeSeconds: 0, value: -20 },
                { timeSeconds: 5, value: 0 },
              ],
            },
          },
        }),
        base,
      ).patch,
    );

    // A later fade edit must not silently erase the lane it knows nothing about.
    const faded = compiled(
      command({ timelineRevision: automated.revision ?? 0, settings: { fadeOutFrames: 15 } }),
      automated,
    );
    const keptLane = applyPatch(automated, faded.patch).tracks[0]!.clips[0]!.effects[0]!;
    expect(keptLane.keyframes).toHaveLength(2);
    expect(keptLane.params.fadeOutSeconds).toBe(0.5);

    const cleared = compiled(
      command({
        timelineRevision: automated.revision ?? 0,
        settings: { automation: { property: 'gainDb', points: [] } },
      }),
      automated,
    );
    expect(applyPatch(automated, cleared.patch).tracks[0]!.clips[0]!.effects[0]!.keyframes).toEqual(
      [],
    );
  });

  it('carries the whole channel strip through a gain-only edit, and clears on request', () => {
    const base = timeline();
    const strip = applyPatch(
      base,
      compiled(
        command({
          settings: {
            eq: { bands: [{ kind: 'high-pass', frequencyHz: 80 }] },
            dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120 },
          },
        }),
        base,
      ).patch,
    );

    // The legacy gain-only verb must not delete processors it knows nothing about:
    // "lower this 3 dB" silently wiping an EQ is invisible until playback.
    const levelled = applyPatch(strip, {
      patchId: 'raw_gain' as never,
      createdBy: 'agent',
      reason: 'gain only',
      operations: [{ type: 'adjust_audio', clipId: 'bed', gainDb: -9 }],
    });
    const params = levelled.tracks[0]!.clips[0]!.effects[0]!.params;
    expect(params).toMatchObject({
      gainDb: -9,
      eq: { bands: [{ kind: 'high-pass', frequencyHz: 80 }] },
      dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120 },
    });

    // Removal stays expressible by saying so.
    const cleared = compiled(
      command({ timelineRevision: strip.revision ?? 0, settings: { eq: { bands: [] } } }),
      strip,
    );
    const clearedParams = applyPatch(strip, cleared.patch).tracks[0]!.clips[0]!.effects[0]!.params;
    expect(clearedParams.eq).toBeUndefined();
    expect(clearedParams.dynamics).toBeDefined();
  });

  it('refuses a static level while an automation lane owns the same parameter', () => {
    const base = timeline();
    const automated = applyPatch(
      base,
      compiled(
        command({
          settings: {
            automation: {
              property: 'gainDb',
              points: [
                { timeSeconds: 0, value: -20 },
                { timeSeconds: 5, value: 0 },
              ],
            },
          },
        }),
        base,
      ).patch,
    );
    expect(
      compileAudioCommand({
        timeline: automated,
        assets,
        command: command({
          timelineRevision: automated.revision ?? 0,
          settings: { gainDb: -6 },
        }),
      }),
    ).toMatchObject({ status: 'rejected', code: 'conflicting_gain' });
  });

  it.each([
    [command({ timelineRevision: 3 }), 'stale_timeline'],
    [command({ clipId: 'missing' }), 'missing_clip'],
    [command({ rate: { numerator: 0, denominator: 1 } }), 'invalid_frame_rate'],
    [command({ settings: {} }), 'empty_settings'],
    [command({ settings: { gainDb: 25 } }), 'invalid_gain'],
    [command({ settings: { fadeInFrames: 301 } }), 'invalid_fade'],
    [command({ settings: { duckUnderTrackId: 'music', duckAmountDb: -12 } }), 'invalid_duck'],
    [
      command({ settings: { eq: { bands: [{ kind: 'peaking', frequencyHz: 1000 }] } } }),
      'invalid_eq',
    ],
    [
      command({
        settings: { eq: { bands: [{ kind: 'high-pass', frequencyHz: 80, gainDb: 3 }] } },
      }),
      'invalid_eq',
    ],
    [
      command({
        settings: {
          dynamics: { thresholdDb: -18, ratio: 3, attackMs: 0.2, releaseMs: 120 },
        },
      }),
      'invalid_dynamics',
    ],
    [
      command({
        settings: {
          automation: {
            property: 'gainDb',
            points: [
              { timeSeconds: 2, value: 0 },
              { timeSeconds: 2, value: -6 },
            ],
          },
        },
      }),
      'invalid_automation',
    ],
    [
      command({
        settings: {
          automation: {
            property: 'gainDb',
            points: [
              { timeSeconds: 0, value: 0 },
              { timeSeconds: 40, value: -6 },
            ],
          },
        },
      }),
      'invalid_automation',
    ],
    [
      command({
        settings: {
          gainDb: -6,
          automation: {
            property: 'gainDb',
            points: [
              { timeSeconds: 0, value: 0 },
              { timeSeconds: 5, value: -6 },
            ],
          },
        },
      }),
      'conflicting_gain',
    ],
  ] as const)('rejects invalid command input', (value, code) => {
    expect(compileAudioCommand({ timeline: timeline(), assets, command: value })).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('rejects locked clips and media without audio', () => {
    expect(
      compileAudioCommand({ timeline: timeline({ locked: true }), assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'locked_track' });
    expect(
      compileAudioCommand({ timeline: timeline({ image: true }), assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'no_audio' });
  });
});
