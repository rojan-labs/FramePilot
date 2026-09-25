/**
 * The callout evaluation case (plan/elements 07 section 8, case 1): the rubric scores where and
 * when a shape landed against the fixture's ground truth, and the case carries that ground truth
 * exactly as the fixture generator wrote it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { presetShapeParams, type Clip, type Project } from '@framepilot/timeline-schema';
import { GOLDEN_CASES } from './golden-cases.js';
import { calloutHits, scoreMissionScenario, type CalloutTarget } from './mission-rubric.js';

const LABELS = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../tests/fixtures/mission/labels/screen-demo.json',
    ),
    'utf8',
  ),
) as { target: CalloutTarget['box']; wordStart: number };

const TARGET: CalloutTarget = { box: LABELS.target, wordStart: LABELS.wordStart };
const ASPECT = 1280 / 720;

const footage: Clip = {
  id: 'c1',
  assetId: 'a1',
  trackId: 'v1',
  start: 0,
  end: 20,
  sourceStart: 0,
  sourceEnd: 20,
  effects: [],
  keyframes: [],
};

function project(extra: Clip[] = []): Project {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1280, height: 720 },
    assets: [{ id: 'a1', path: 'media/demo.mp4', kind: 'video', durationSeconds: 20 }],
    timeline: {
      tracks: [
        { id: 'o1', type: 'overlay', clips: extra },
        { id: 'v1', type: 'video', clips: [footage] },
      ],
    },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  } as unknown as Project;
}

function shape(params: Record<string, unknown>, start: number, end: number): Clip {
  return {
    id: 'shape__o1',
    assetId: '__shape__',
    trackId: 'o1',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [{ id: 'shape__o1__shape', type: 'shape', params, keyframes: [] }],
    keyframes: [],
  };
}

// A highlight box a little bigger than the Export button (86.9–98.1% × 2.2–7.8%).
const aroundButton = {
  ...presetShapeParams('rounded-rect/highlight')!,
  x: 92.5,
  y: 5,
  width: 25,
  height: 9,
};

describe('the callout case', () => {
  it('carries the ground truth the fixture generator wrote', () => {
    const turn = GOLDEN_CASES.find((c) => c.id === 'callout-export-button')!.turns[0]!;
    expect(turn.calloutTarget).toEqual(TARGET);
    expect(turn.rubric).toBe('callout-on-target');
  });
});

describe('calloutHits', () => {
  it('counts a box that contains the button, and not one that does not', () => {
    expect(calloutHits(aroundButton, TARGET.box, ASPECT).hit).toBe(true);
    expect(calloutHits({ ...aroundButton, x: 50 }, TARGET.box, ASPECT).hit).toBe(false);
  });

  it('does not count a box the size of the frame as "around" the button', () => {
    expect(
      calloutHits({ ...aroundButton, x: 50, y: 50, width: 177, height: 100 }, TARGET.box, ASPECT)
        .hit,
    ).toBe(false);
  });

  it('counts an arrow whose tip ends on the button', () => {
    const arrow = presetShapeParams('line-arrow/red', { x: 90, y: 5 })!;
    expect(calloutHits(arrow, TARGET.box, ASPECT).hit).toBe(true);
    expect(calloutHits({ ...arrow, x2: 40, y2: 40 }, TARGET.box, ASPECT).hit).toBe(false);
  });
});

describe('scoring a run', () => {
  const before = project();

  it('scores a box on the button, on the word, briefly, as a full pass', () => {
    const after = project([shape(aroundButton, TARGET.wordStart + 0.1, TARGET.wordStart + 2.5)]);
    const score = scoreMissionScenario('callout-on-target', {
      before,
      after,
      calloutTarget: TARGET,
    });
    const failed = score.checks.filter((check) => !check.ok).map((check) => check.id);
    expect(failed).toEqual([]);
  });

  it('fails a box placed late and one placed off target', () => {
    const late = project([shape(aroundButton, TARGET.wordStart + 1.5, TARGET.wordStart + 3)]);
    const lateScore = scoreMissionScenario('callout-on-target', {
      before,
      after: late,
      calloutTarget: TARGET,
    });
    expect(lateScore.checks.find((c) => c.id === 'callout-on-word')?.ok).toBe(false);
    const miss = project([
      shape({ ...aroundButton, x: 20, y: 60 }, TARGET.wordStart, TARGET.wordStart + 2),
    ]);
    const missScore = scoreMissionScenario('callout-on-target', {
      before,
      after: miss,
      calloutTarget: TARGET,
    });
    expect(missScore.checks.find((c) => c.id === 'callout-on-target')?.ok).toBe(false);
  });

  it('fails a run that added no shape', () => {
    const score = scoreMissionScenario('callout-on-target', {
      before,
      after: before,
      calloutTarget: TARGET,
    });
    expect(score.checks.find((c) => c.id === 'callout-added')?.ok).toBe(false);
  });
});
