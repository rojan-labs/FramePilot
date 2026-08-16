import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_CAPTION_TEMPLATE_ID,
  getCaptionTemplate,
} from '@framepilot/timeline-schema/caption-templates';
import {
  activeWordIndex,
  generateCaptionsPatch,
  groupTranscriptIntoReadableLines,
  highlightKeywords,
  keywordAccentStyle,
  parseKeywords,
  resolveGenerationConfig,
} from './captions.js';
import { demoTranscript } from './demo.js';

/**
 * An empty caption track, plus the footage the transcript came from.
 *
 * The video track is not decoration: since v12, cues are derived by mapping
 * transcript words through the clips that actually play (ADR 0076), so a
 * timeline with no media has nothing to caption and correctly produces no cues.
 * A caption-track-only fixture would test a state no real project is ever in.
 */
const emptyTimeline = (): Timeline => ({
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        {
          id: 'clip_1',
          assetId: 'asset_1',
          trackId: 'video_1',
          start: 0,
          end: 5,
          sourceStart: 0,
          sourceEnd: 5,
          effects: [],
          keyframes: [],
        },
      ],
    },
    { id: 'caption_1', type: 'caption', clips: [] },
  ],
});

describe('groupTranscriptIntoReadableLines', () => {
  it('chunks the transcript into lines of at most N words', () => {
    const lines = groupTranscriptIntoReadableLines(demoTranscript, 4);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ text: 'Welcome to FramePilot the', start: 0 });
    expect(lines[1]?.text).toBe('cursor for video editing');
  });

  it('treats a non-positive size as one word per line', () => {
    expect(groupTranscriptIntoReadableLines(demoTranscript, 0)).toHaveLength(demoTranscript.length);
  });

  it('returns no lines for an empty transcript', () => {
    expect(groupTranscriptIntoReadableLines([], 4)).toEqual([]);
  });
});

describe('activeWordIndex', () => {
  it('finds the word spoken at a time', () => {
    expect(activeWordIndex(demoTranscript, 0.3)).toBe(0);
    expect(activeWordIndex(demoTranscript, 1.0)).toBe(2); // FramePilot 0.8–1.8
  });

  it('returns -1 in a silent gap or past the end', () => {
    expect(activeWordIndex(demoTranscript, 1.9)).toBe(-1); // gap 1.8–2.0
    expect(activeWordIndex(demoTranscript, 100)).toBe(-1);
  });
});

describe('templates', () => {
  it('come from the shared caption template catalog', () => {
    expect(getCaptionTemplate(DEFAULT_CAPTION_TEMPLATE_ID)).toBeDefined();
    expect(getCaptionTemplate('does-not-exist')).toBeUndefined();
  });
});

describe('parseKeywords', () => {
  it('splits on whitespace/commas, lowercases, and de-duplicates', () => {
    expect(parseKeywords('FramePilot, video  Video,,')).toEqual(['framepilot', 'video']);
    expect(parseKeywords('   ')).toEqual([]);
  });
});

describe('highlightKeywords', () => {
  it('returns a single unflagged segment when there are no keywords', () => {
    expect(highlightKeywords('hello world', [])).toEqual([
      { text: 'hello world', highlight: false },
    ]);
    expect(highlightKeywords('', [])).toEqual([]);
  });

  it('flags matching tokens, ignoring case and punctuation', () => {
    const segments = highlightKeywords('Welcome to FramePilot!', ['framepilot']);
    expect(segments).toEqual([
      { text: 'Welcome', highlight: false },
      { text: 'to', highlight: false },
      { text: 'FramePilot!', highlight: true },
    ]);
  });
});

describe('resolveGenerationConfig', () => {
  it('follows the template’s suggested grouping by default', () => {
    // 'punchline' is a one-word template, so it gets the one-word register.
    expect(resolveGenerationConfig({ templateId: 'punchline' }).maxWordsPerCue).toBe(1);
  });

  it('lets an explicit preset override the template', () => {
    const config = resolveGenerationConfig({ templateId: 'punchline', preset: 'subtitle' });
    expect(config.maxCharsPerLine).toBe(42);
  });

  it('applies per-field overrides on top', () => {
    expect(resolveGenerationConfig({ overrides: { maxWordsPerCue: 3 } }).maxWordsPerCue).toBe(3);
  });
});

describe('generateCaptionsPatch', () => {
  it('sets the track style ONCE, then adds + cues each caption', () => {
    const patch = generateCaptionsPatch(emptyTimeline(), demoTranscript, 'caption_1');
    const ops = patch!.operations;
    // One track-style op (schema v11) — not one style op per cue, which is what
    // made restyling a finished set a per-cue chore.
    expect(ops.filter((op) => op.type === 'set_track_caption_style')).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: DEFAULT_CAPTION_TEMPLATE_ID },
    });
    const adds = ops.filter((op) => op.type === 'add_caption_layer');
    const cues = ops.filter((op) => op.type === 'set_caption_cue');
    expect(adds.length).toBeGreaterThan(0);
    expect(cues).toHaveLength(adds.length);
  });

  it('gives every cue its own text', () => {
    const patch = generateCaptionsPatch(emptyTimeline(), demoTranscript, 'caption_1');
    const cues = patch!.operations.filter(
      (op): op is Extract<typeof op, { type: 'set_caption_cue' }> => op.type === 'set_caption_cue',
    );
    // Every transcript word survives across the cues, in order.
    const spoken = cues.flatMap((op) => (op.captionCue?.text ?? '').split(/\s+/)).join(' ');
    expect(spoken).toBe(demoTranscript.map((w) => w.word).join(' '));
  });

  it('honours the requested template', () => {
    const patch = generateCaptionsPatch(emptyTimeline(), demoTranscript, 'caption_1', {
      templateId: 'punchline',
    });
    expect(patch!.operations[0]).toMatchObject({
      captionStyle: { templateId: 'punchline' },
    });
    // One-word template ⇒ one cue per word.
    expect(patch!.operations.filter((op) => op.type === 'add_caption_layer')).toHaveLength(
      demoTranscript.length,
    );
  });

  it('persists keywords on the track style so emphasis reaches the render', () => {
    const patch = generateCaptionsPatch(emptyTimeline(), demoTranscript, 'caption_1', {
      keywords: ['framepilot'],
    });
    expect(patch!.operations[0]).toMatchObject({
      captionStyle: {
        accent: {
          mode: 'keywords',
          keywords: ['framepilot'],
          color: '#ffd60a',
          fontScale: 1.18,
        },
      },
    });
  });

  it('preserves a template accent treatment while switching its selection to keywords', () => {
    expect(keywordAccentStyle('motion', ['viral'])).toMatchObject({
      mode: 'keywords',
      keywords: ['viral'],
    });
    const accent = keywordAccentStyle('motion', ['viral']);
    expect(accent?.color).toBeTruthy();
    expect(accent?.fontScale).toBeGreaterThan(1);
  });

  it('omits the accent entirely when there are no keywords', () => {
    const patch = generateCaptionsPatch(emptyTimeline(), demoTranscript, 'caption_1');
    const style = (patch!.operations[0] as { captionStyle: Record<string, unknown> }).captionStyle;
    expect('accent' in style).toBe(false);
  });

  it('derives clip ids from the cue start, so a regeneration cannot collide', () => {
    // The v10 generator used `caption_<track>_<index>`, so pressing Generate
    // twice collided on every id.
    const first = generateCaptionsPatch(emptyTimeline(), demoTranscript, 'caption_1');
    const ids = first!.operations
      .filter(
        (op): op is Extract<typeof op, { type: 'add_caption_layer' }> =>
          op.type === 'add_caption_layer',
      )
      .map((op) => op.clipId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('caption_caption_1_0');
  });

  it('clears existing cues in the SAME patch, so regenerate is one undo', () => {
    const populated: Timeline = {
      tracks: [
        {
          id: 'caption_1',
          type: 'caption',
          clips: [
            {
              id: 'old_a',
              assetId: '__caption__',
              trackId: 'caption_1',
              start: 0,
              end: 1,
              sourceStart: 0,
              sourceEnd: 1,
              effects: [],
              keyframes: [],
            },
            {
              id: 'old_b',
              assetId: '__caption__',
              trackId: 'caption_1',
              start: 1,
              end: 2,
              sourceStart: 0,
              sourceEnd: 1,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    const patch = generateCaptionsPatch(populated, demoTranscript, 'caption_1');
    const clears = patch!.operations.filter((op) => op.type === 'delete_range');
    expect(clears).toHaveLength(2);
    // Back-to-front, so each delete refers to a range still present in the
    // working timeline the validator replays against.
    expect(clears[0]).toMatchObject({ start: 1, end: 2 });
    expect(clears[1]).toMatchObject({ start: 0, end: 1 });
  });

  it('clears the track when the transcript is empty', () => {
    const populated: Timeline = {
      tracks: [
        {
          id: 'caption_1',
          type: 'caption',
          clips: [
            {
              id: 'old_a',
              assetId: '__caption__',
              trackId: 'caption_1',
              start: 0,
              end: 1,
              sourceStart: 0,
              sourceEnd: 1,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    const patch = generateCaptionsPatch(populated, [], 'caption_1');
    expect(patch?.reason).toMatch(/Clear captions/);
    expect(patch!.operations.filter((op) => op.type === 'delete_range')).toHaveLength(1);
  });

  it('returns null when there is nothing to caption and nothing to clear', () => {
    expect(generateCaptionsPatch(emptyTimeline(), [], 'caption_1')).toBeNull();
  });
});
