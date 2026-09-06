import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  brewedLabel,
  formatDurationDelta,
  formatRunChangeGroups,
  summarizeRunChanges,
  timelineDurationSeconds,
} from './runSummary.js';

const clip = (id: string, start: number, end: number): Record<string, unknown> => ({
  id,
  assetId: 'a',
  trackId: 't1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const timeline = (...ends: number[]): Timeline =>
  ({
    tracks: [
      {
        id: 't1',
        type: 'video',
        clips: ends.map((end, index) =>
          clip(`c${String(index)}`, index === 0 ? 0 : ends[index - 1]!, end),
        ),
      },
    ],
  }) as unknown as Timeline;

const op = (type: string, clipId = 'c0'): AnyOperation =>
  ({ type, clipId }) as unknown as AnyOperation;

describe('summarizeRunChanges (P8.2 "changed")', () => {
  it('groups the run’s operations by semantic action, most frequent first', () => {
    const summary = summarizeRunChanges([
      { operations: [op('trim_clip'), op('add_transition')] },
      { operations: [op('trim_clip'), op('trim_clip')] },
    ]);
    expect(summary.groups).toEqual([
      { action: 'Trimmed clip', count: 3 },
      { action: 'Added transition', count: 1 },
    ]);
  });

  it('reports the programme-length change across the whole run, not per edit', () => {
    const summary = summarizeRunChanges([
      { operations: [op('trim_clip')], before: timeline(60), after: timeline(50) },
      { operations: [op('trim_clip')], before: timeline(50), after: timeline(41.5) },
    ]);
    expect(summary.durationAfterSeconds).toBe(41.5);
    expect(summary.durationDeltaSeconds).toBe(-18.5);
  });

  // A delta of "unknown" rendering as 0 would be a claim the run changed nothing.
  it('omits the duration entirely when the edits carried no timelines', () => {
    const summary = summarizeRunChanges([{ operations: [op('set_caption_style')] }]);
    expect(summary.durationDeltaSeconds).toBeUndefined();
    expect(summary.durationAfterSeconds).toBeUndefined();
  });

  it('falls back to a humanized label for an operation type with no action label', () => {
    expect(summarizeRunChanges([{ operations: [op('do_something_new')] }]).groups[0]?.action).toBe(
      'Do something new',
    );
  });
});

describe('timelineDurationSeconds', () => {
  it('is the last frame any clip ends on, and 0 for an empty timeline', () => {
    expect(timelineDurationSeconds(timeline(3, 9))).toBe(9);
    expect(timelineDurationSeconds({ tracks: [] } as unknown as Timeline)).toBe(0);
  });
});

describe('formatRunChangeGroups', () => {
  it('drops the multiplier for a single occurrence', () => {
    expect(
      formatRunChangeGroups([
        { action: 'Trimmed clip', count: 2 },
        { action: 'Added captions', count: 1 },
      ]),
    ).toBe('Trimmed clip ×2 · Added captions');
  });
});

describe('formatDurationDelta', () => {
  it('signs the delta and rounds to a tenth', () => {
    expect(formatDurationDelta(-18.46)).toBe('−18.5s');
    expect(formatDurationDelta(3)).toBe('+3.0s');
  });

  // "+0.0s" reads as a claim that the length moved; a caption restyle only moves
  // it by float noise.
  it('says nothing at all when the length did not really move', () => {
    expect(formatDurationDelta(0)).toBeNull();
    expect(formatDurationDelta(0.02)).toBeNull();
  });
});

/**
 * The sidebar showed what a run CHANGED and never what it cost the person waiting, so a
 * three-second answer and a fifty-minute one closed identically.
 */
describe('brewedLabel', () => {
  it('reads in whole seconds under a minute', () => {
    expect(brewedLabel(3_000)).toBe('Brewed for 3s');
    expect(brewedLabel(59_400)).toBe('Brewed for 59s');
  });

  it('reads in minutes and seconds above one', () => {
    expect(brewedLabel(74_000)).toBe('Brewed for 1m 14s');
    expect(brewedLabel(120_000)).toBe('Brewed for 2m');
    expect(brewedLabel(49 * 60_000)).toBe('Brewed for 49m');
  });

  it('never claims a run took no time', () => {
    expect(brewedLabel(1)).toBe('Brewed for <1s');
    expect(brewedLabel(999)).toBe('Brewed for <1s');
  });
});
