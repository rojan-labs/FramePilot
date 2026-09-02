import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import {
  MAX_WEBCODECS_DECODED_AUDIO_BYTES,
  webCodecsPreviewEligible,
} from './selectors.js';

const bytesPerSecond = 48_000 * 2 * 4;

/** The project frame the stack would be fitted into (ADR 0170). Nothing here stacks, so it
    only has to be a real size. */
const FRAME = { width: 1920, height: 1080 };

function asset(id: string, durationSeconds: number): Asset {
  return {
    id,
    path: `${id}.mp4`,
    kind: 'video',
    durationSeconds,
    media: { proxyPath: `${id}.proxy.mp4` },
  } as unknown as Asset;
}

function timelineFor(assetIds: readonly string[]): Timeline {
  return {
    revision: 1,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: assetIds.map((assetId, index) => ({
          id: `clip-${String(index)}`,
          assetId,
          start: index * 10,
          end: index * 10 + 10,
          effects: [],
          keyframes: [],
        })),
      },
    ],
  } as unknown as Timeline;
}

describe('WebCodecs preview audio admission', () => {
  it('falls back before decoded source audio can exceed the PCM budget', () => {
    const overBudgetSeconds = MAX_WEBCODECS_DECODED_AUDIO_BYTES / bytesPerSecond + 1;
    const media = asset('long', overBudgetSeconds);

    expect(
      webCodecsPreviewEligible(timelineFor(['long']), new Map([[media.id, media]]), FRAME),
    ).toBe(false);
  });

  it('counts one source once even when several timeline clips reference it', () => {
    const safeSeconds = MAX_WEBCODECS_DECODED_AUDIO_BYTES / bytesPerSecond / 2;
    const media = asset('shared', safeSeconds);

    expect(
      webCodecsPreviewEligible(
        timelineFor(['shared', 'shared', 'shared']),
        new Map([[media.id, media]]),
        FRAME,
      ),
    ).toBe(true);
  });
});
