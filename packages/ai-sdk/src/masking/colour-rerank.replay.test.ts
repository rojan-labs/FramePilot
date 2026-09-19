/**
 * AM2.7: every colour request of the calibration and held-out crop sets, through the shipped path.
 *
 * `reports/ai-masking/colour-rerank-replay.json` holds, for every generated crop (and three real
 * ones), its real SigLIP 2 cosine with each palette prompt and the engine's CIELAB measurement
 * (`engine/python/tests/colour_rerank_replay.py`). Each crop's twelve cosines are embedded in a
 * 13-d unit vector (the cosines, then whatever makes the norm 1) and the prompts are the first
 * twelve unit axes, so `colourRerankScores` sees exactly the cosines the worker's vectors gave.
 * Every request — each colour on a frame (must pick it) and each colour not on it (must ask) —
 * goes through plan, scores and resolver, and must meet the AM5 gates and agree with the report.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CropColourMeasurement } from './colour-measure.js';
import { colourRerankPlan, colourRerankScores } from './colour-rerank.js';
import type { CocoClassName } from './contracts.js';
import { rankCandidates, resolveMaskTargets, type TargetDetection } from './target-resolution.js';
import { COLOUR_WORDS } from './target-vocabulary.js';

interface ReplaySet {
  readonly role: 'calibration' | 'heldOut';
  readonly frames: readonly {
    readonly noun: string;
    readonly crops: readonly { readonly id: string; readonly colour: string }[];
  }[];
  readonly crops: Readonly<
    Record<
      string,
      { readonly cosines: readonly number[]; readonly measurement: CropColourMeasurement | null }
    >
  >;
}
interface Replay {
  readonly colours: readonly string[];
  readonly sets: Readonly<Record<string, ReplaySet>>;
}
interface Rate {
  readonly passed: number;
  readonly total: number;
}
interface ReportRule {
  readonly summary: {
    readonly targetAccuracy: Rate;
    readonly unnecessaryAsks: Rate;
    readonly absentColourAskRate: Rate;
    readonly confidentWrong: number;
    readonly achromaticTargetAccuracy: Rate;
  };
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(REPO, 'reports', 'ai-masking', name), 'utf8')) as T;
const replay = read<Replay>('colour-rerank-replay.json');
const report = read<{ 'am2.7': { sets: Record<string, Record<'am2.6' | 'am2.7', ReportRule>> } }>(
  'colour-rerank.json',
)['am2.7'].sets;

const CLASS_OF: Readonly<Record<string, CocoClassName>> = {
  car: 'car',
  ball: 'sports ball',
  // "object" accepts any class; the real crops were a monitor, a microphone and a lamp.
  object: 'tv',
};
const FRAMES = [0, 8, 16, 24];
const PROMPTS = COLOUR_WORDS.map((_colour, index) =>
  Array.from({ length: COLOUR_WORDS.length + 1 }, (_zero, axis) => (axis === index ? 1 : 0)),
);

function embedded(cosines: readonly number[]): number[] {
  const squares = cosines.reduce((sum, value) => sum + value * value, 0);
  return [...cosines, Math.sqrt(1 - squares)];
}

type Outcome = 'correct' | 'asked' | 'wrong';

interface Tally {
  present: number;
  correct: number;
  asked: number;
  wrong: number;
  absent: number;
  absentAsked: number;
  neutralPresent: number;
  neutralCorrect: number;
  misses: string[];
}

const NEUTRAL = new Set(['white', 'grey', 'silver', 'black']);

function decide(
  set: ReplaySet,
  noun: string,
  colour: string,
  ids: readonly string[],
  measured: boolean,
): string | null {
  const description = `the ${colour} ${noun}`;
  const detections: TargetDetection[] = ids.flatMap((_id, index) =>
    FRAMES.map((frame) => ({
      frame,
      label: 'object' as const,
      box: { x: 0.02 + index * 0.33, y: 0.4, width: 0.3, height: 0.35 },
      confidence: 0.9,
      objectClass: CLASS_OF[noun]!,
      classScore: 0.9,
    })),
  );
  const input = {
    clipId: 'shot',
    assetId: 'asset',
    fps: 24,
    sampledFrames: FRAMES,
    detections,
    engine: 'replay',
    description,
  };
  const ranked = rankCandidates(input);
  const plan = colourRerankPlan(description, ranked)!;
  const cropOf = (candidateId: string): string => {
    const box = ranked.find((each) => each.candidateId === candidateId)!.box;
    return ids[Math.round((box.x - 0.02) / 0.33)]!;
  };
  const crops = plan.candidates.map((candidate) => set.crops[cropOf(candidate.candidateId)]!);
  const rerank = colourRerankScores(
    plan,
    crops.map((crop) => embedded(crop.cosines)),
    PROMPTS,
    measured ? crops.map((crop) => crop.measurement ?? undefined) : undefined,
  );
  const result = resolveMaskTargets({ ...input, evidence: { rerank } });
  return result.status === 'resolved' ? cropOf(result.chosenCandidateIds[0]!) : null;
}

function tally(set: ReplaySet, measured: boolean): Tally {
  const out: Tally = {
    present: 0,
    correct: 0,
    asked: 0,
    wrong: 0,
    absent: 0,
    absentAsked: 0,
    neutralPresent: 0,
    neutralCorrect: 0,
    misses: [],
  };
  for (const frame of set.frames) {
    const ids = frame.crops.map((crop) => crop.id);
    for (const colour of COLOUR_WORDS) {
      const expected = frame.crops.find((crop) => crop.colour === colour)?.id ?? null;
      const pick = decide(set, frame.noun, colour, ids, measured);
      const outcome: Outcome = pick === null ? 'asked' : pick === expected ? 'correct' : 'wrong';
      if (expected === null) {
        out.absent += 1;
        if (outcome === 'asked') out.absentAsked += 1;
        else out.wrong += 1;
      } else {
        out.present += 1;
        out[outcome] += 1;
        if (NEUTRAL.has(colour)) {
          out.neutralPresent += 1;
          if (outcome === 'correct') out.neutralCorrect += 1;
        }
      }
      if (outcome === 'wrong' || (expected !== null && outcome === 'asked')) {
        out.misses.push(`${outcome}: the ${colour} ${frame.noun} [${ids.join(',')}] -> ${pick}`);
      }
    }
  }
  return out;
}

const measuredTallies = new Map(
  Object.entries(replay.sets).map(([name, set]) => [name, tally(set, true)]),
);

describe('the colour replay sets (AM2.7)', () => {
  it('scores the palette the cosines were taken against', () => {
    expect(replay.colours).toEqual(COLOUR_WORDS);
    expect(Object.values(replay.sets).some((set) => set.role === 'heldOut')).toBe(true);
  });

  it.each(Object.keys(replay.sets))('%s meets every AI masking gate', (name) => {
    const measured = measuredTallies.get(name)!;
    expect(measured.misses).toEqual([]);
    expect(measured.wrong).toBe(0);
    expect(measured.correct / measured.present).toBeGreaterThanOrEqual(0.99);
    expect(measured.asked / measured.present).toBeLessThanOrEqual(0.03);
    expect(measured.absentAsked / measured.absent).toBeGreaterThanOrEqual(0.97);
  });

  it.each(Object.keys(replay.sets))('%s agrees with the Python report, both rules', (name) => {
    for (const [rule, measured] of [
      ['am2.6', false],
      ['am2.7', true],
    ] as const) {
      const ours = measured ? measuredTallies.get(name)! : tally(replay.sets[name]!, false);
      const theirs = report[name]![rule].summary;
      expect(
        {
          target: [ours.correct, ours.present],
          asked: [ours.asked, ours.present],
          absentAsked: [ours.absentAsked, ours.absent],
          wrong: ours.wrong,
          neutral: [ours.neutralCorrect, ours.neutralPresent],
        },
        `${name} ${rule}`,
      ).toEqual({
        target: [theirs.targetAccuracy.passed, theirs.targetAccuracy.total],
        asked: [theirs.unnecessaryAsks.passed, theirs.unnecessaryAsks.total],
        absentAsked: [theirs.absentColourAskRate.passed, theirs.absentColourAskRate.total],
        wrong: theirs.confidentWrong,
        neutral: [theirs.achromaticTargetAccuracy.passed, theirs.achromaticTargetAccuracy.total],
      });
    }
  });
});
