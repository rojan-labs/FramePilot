/**
 * Caption derivation over generated transcripts (ADR 0163).
 *
 * The single-transcript regression in `caption-the-edit-grid.test.ts` pins the run that
 * exposed this. These properties are what stop the fix being a fix for that one file:
 * real ASR emits sub-frame words, zero gaps and dense bursts constantly, and any one of
 * them used to be able to produce an operation the contract rejects — which, because a
 * patch is all-or-nothing, discards every other cue in the same call.
 *
 * The three invariants a caption patch depends on, asserted against what the patch
 * boundary will actually see (`snapSecondsToFrame`, per ADR 0146) rather than against
 * the unquantised seconds the segmenter works in:
 *
 *  1. Every cue occupies at least one frame once snapped. A zero-length range is a
 *     rejected patch.
 *  2. No two cues overlap once snapped. Caption clips share a track and `insertClip`
 *     refuses a collision.
 *  3. Every spoken word that survives the edit is captioned exactly once. Coalescing
 *     merges cues; it must never drop or duplicate speech.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@framepilot/timeline-schema';
import { buildTimelineMap } from '../timeline-map.js';
import { snapSecondsToFrame } from '../frame-grid.js';
import { captionSegmentConfig, type CaptionSegmentPresetName } from './segment.js';
import { deriveCaptionCues } from './derive.js';

/** Deterministic PRNG, so a failure is reproducible from its seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  'today',
  'we',
  'are',
  'talking',
  'about',
  'motion.',
  'if',
  'you',
  'want',
  'the',
  'best,',
  'stop',
  'scrolling!',
  "India's",
  'top',
  'build',
];

/**
 * A transcript with the pathologies real ASR produces: words far shorter than a frame,
 * words that abut with no gap at all, occasional real pauses, and the odd long word.
 */
function generateTranscript(rng: () => number, wordCount: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let t = +(rng() * 0.2).toFixed(3);
  for (let i = 0; i < wordCount; i += 1) {
    const roll = rng();
    // 20% sub-frame (10-20ms) — the shape that collapsed a whole patch.
    const duration =
      roll < 0.2 ? 0.01 + rng() * 0.01 : roll < 0.9 ? 0.05 + rng() * 0.45 : 0.8 + rng() * 0.8;
    const end = t + duration;
    words.push({
      word: VOCAB[Math.floor(rng() * VOCAB.length)]!,
      start: +t.toFixed(4),
      end: +end.toFixed(4),
    });
    // Most words abut exactly; some carry a real pause.
    const gap = rng() < 0.75 ? 0 : rng() < 0.7 ? rng() * 0.4 : 0.5 + rng() * 1.5;
    t = end + gap;
  }
  return words;
}

const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 60] as const;
const PRESETS: readonly CaptionSegmentPresetName[] = ['short-form', 'subtitle', 'one-word'];

/** One clip carrying the whole recording — the shape captioning is asked for most. */
function mapFor(durationSeconds: number): ReturnType<typeof buildTimelineMap> {
  return buildTimelineMap({
    revision: 1,
    tracks: [
      {
        id: 'v_main',
        type: 'video',
        clips: [
          {
            id: 'clip_1',
            assetId: 'asset_1',
            trackId: 'v_main',
            start: 0,
            end: durationSeconds,
            sourceStart: 0,
            sourceEnd: durationSeconds,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  } as unknown as Parameters<typeof buildTimelineMap>[0]);
}

/**
 * A rippled timeline: several clips whose SOURCE ranges skip forward, laid end to end in
 * sequence. This is the shape the module exists for — `mapFor` above is one untrimmed
 * clip, which is the one arrangement where source time and sequence time are the same
 * thing, so it can never exercise a cut. Words landing in the skipped source are dropped;
 * the survivors must still not produce an invalid or overlapping cue, and no cue may span
 * two clips (two stretches never spoken in one breath).
 */
function rippledMap(rng: () => number, clipCount: number): ReturnType<typeof buildTimelineMap> {
  const clips: Record<string, unknown>[] = [];
  let sourceAt = 0;
  let sequenceAt = 0;
  for (let i = 0; i < clipCount; i += 1) {
    const kept = 1 + rng() * 4;
    clips.push({
      id: `clip_${String(i)}`,
      assetId: 'asset_1',
      trackId: 'v_main',
      start: +sequenceAt.toFixed(4),
      end: +(sequenceAt + kept).toFixed(4),
      sourceStart: +sourceAt.toFixed(4),
      sourceEnd: +(sourceAt + kept).toFixed(4),
      effects: [],
      keyframes: [],
    });
    sequenceAt += kept;
    // The cut: source skips forward without the sequence doing so.
    sourceAt += kept + 0.2 + rng() * 2;
  }
  return buildTimelineMap({
    revision: 1,
    tracks: [{ id: 'v_main', type: 'video', clips }],
  } as unknown as Parameters<typeof buildTimelineMap>[0]);
}

describe('deriveCaptionCues across cuts', () => {
  it('holds every invariant on a rippled timeline, not just an untrimmed one', () => {
    for (let seed = 301; seed <= 340; seed += 1) {
      const rng = mulberry32(seed);
      const words = generateTranscript(rng, 60 + Math.floor(rng() * 60));
      const map = rippledMap(rng, 2 + Math.floor(rng() * 4));
      for (const fps of FRAME_RATES) {
        for (const preset of PRESETS) {
          const cues = deriveCaptionCues(map, words, captionSegmentConfig(preset), fps);
          const where = `seed ${String(seed)} ${preset} @ ${String(fps)}fps`;
          let previousEnd = -Infinity;
          for (const cue of cues) {
            const start = snapSecondsToFrame(cue.start, fps);
            const end = snapSecondsToFrame(cue.end, fps);
            expect(end, `${where}: zero-length cue`).toBeGreaterThan(start);
            expect(start, `${where}: overlapping cue`).toBeGreaterThanOrEqual(previousEnd);
            previousEnd = end;
          }
        }
      }
    }
  });

  it('never lets one cue span two clips', () => {
    // The promise the whole module is built around: after a ripple, two source ranges
    // become visually continuous, and a caption must still break between them because
    // the words either side were never spoken together.
    for (let seed = 401; seed <= 430; seed += 1) {
      const rng = mulberry32(seed);
      const words = generateTranscript(rng, 60 + Math.floor(rng() * 60));
      const map = rippledMap(rng, 2 + Math.floor(rng() * 4));
      const spans = new Map(map.spans.map((span) => [span.clipId, span]));
      for (const cue of deriveCaptionCues(map, words, captionSegmentConfig('short-form'), 30)) {
        const span = spans.get(cue.clipId);
        expect(span, `seed ${String(seed)}: cue cites an unknown clip`).toBeDefined();
        // Clamped INSIDE its own clip, so it cannot bleed over the cut on either side.
        expect(cue.start).toBeGreaterThanOrEqual(span!.start - 1e-9);
        expect(cue.end).toBeLessThanOrEqual(span!.end + 1e-9);
      }
    }
  });

  it('captions each surviving word once, and drops the ones the cut removed', () => {
    for (let seed = 501; seed <= 530; seed += 1) {
      const rng = mulberry32(seed);
      const words = generateTranscript(rng, 60 + Math.floor(rng() * 60));
      const map = rippledMap(rng, 2 + Math.floor(rng() * 4));
      const cues = deriveCaptionCues(map, words, captionSegmentConfig('short-form'), 30);
      const captioned = cues.flatMap((cue) => cue.words.map((word) => word.word));
      const spoken = words.map((word) => word.word);
      // A subsequence of the transcript: order preserved, nothing invented, nothing said
      // twice — but shorter, because the cut really did remove speech.
      let cursor = 0;
      for (const word of captioned) {
        const at = spoken.indexOf(word, cursor);
        expect(
          at,
          `seed ${String(seed)}: "${word}" is not the next surviving word`,
        ).toBeGreaterThanOrEqual(0);
        cursor = at + 1;
      }
      expect(captioned.length).toBeLessThanOrEqual(spoken.length);
    }
  });
});

describe('deriveCaptionCues over generated transcripts', () => {
  it('never emits a cue the frame grid can round out of existence', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rng = mulberry32(seed);
      const words = generateTranscript(rng, 40 + Math.floor(rng() * 60));
      const map = mapFor(words[words.length - 1]!.end + 1);
      for (const fps of FRAME_RATES) {
        for (const preset of PRESETS) {
          const cues = deriveCaptionCues(map, words, captionSegmentConfig(preset), fps);
          for (const cue of cues) {
            const frames = snapSecondsToFrame(cue.end, fps) - snapSecondsToFrame(cue.start, fps);
            expect(
              frames,
              `seed ${String(seed)} ${preset} @ ${String(fps)}fps: ${JSON.stringify({ start: cue.start, end: cue.end, text: cue.text })}`,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('never emits two cues that overlap once snapped', () => {
    for (let seed = 101; seed <= 140; seed += 1) {
      const rng = mulberry32(seed);
      const words = generateTranscript(rng, 40 + Math.floor(rng() * 60));
      const map = mapFor(words[words.length - 1]!.end + 1);
      for (const fps of FRAME_RATES) {
        for (const preset of PRESETS) {
          const snapped = deriveCaptionCues(map, words, captionSegmentConfig(preset), fps).map(
            (cue) => ({
              start: snapSecondsToFrame(cue.start, fps),
              end: snapSecondsToFrame(cue.end, fps),
            }),
          );
          for (let i = 1; i < snapped.length; i += 1) {
            expect(
              snapped[i]!.start,
              `seed ${String(seed)} ${preset} @ ${String(fps)}fps cue ${String(i)}`,
            ).toBeGreaterThanOrEqual(snapped[i - 1]!.end);
          }
        }
      }
    }
  });

  it('captions every surviving word exactly once, in order', () => {
    for (let seed = 201; seed <= 240; seed += 1) {
      const rng = mulberry32(seed);
      const words = generateTranscript(rng, 40 + Math.floor(rng() * 60));
      const map = mapFor(words[words.length - 1]!.end + 1);
      // Zero-duration words are dropped by the segmenter by design; the generator makes
      // none, so every word must survive.
      for (const fps of FRAME_RATES) {
        const cues = deriveCaptionCues(map, words, captionSegmentConfig('short-form'), fps);
        expect(
          cues.flatMap((cue) => cue.words.map((word) => word.word)),
          `seed ${String(seed)} @ ${String(fps)}fps`,
        ).toEqual(words.map((word) => word.word));
      }
    }
  });
});
