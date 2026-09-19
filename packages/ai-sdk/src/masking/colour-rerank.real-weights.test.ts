/**
 * AM2.6: the colour re-ranker on REAL SigLIP 2 vectors, without the weights.
 *
 * `reports/ai-masking/colour-rerank-siglip2-vectors.json` holds the fp16 vectors the Visual Embed
 * worker produced for 36 generated crops (cars and balls in the twelve palette colours, H.264,
 * cropped by `visual.embed` shot regions) and for the palette prompts, plus the decision the eval
 * tool (`workers/visual-embed/tools/colour_rerank_eval.py`) took for every request on those frames:
 * each colour on the frame, and each of the nine that is not. This file puts the same vectors
 * through the shipped path — plan, scores, resolver — and must take the same decisions.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colourRerankPlan, colourRerankScores } from './colour-rerank.js';
import type { CocoClassName } from './contracts.js';
import { rankCandidates, resolveMaskTargets, type TargetDetection } from './target-resolution.js';
import { COLOUR_WORDS } from './target-vocabulary.js';

interface Fixture {
  readonly colours: readonly string[];
  readonly prompts: Readonly<Record<string, readonly string[]>>;
  readonly crops: Readonly<Record<string, string>>;
  readonly items: readonly {
    readonly request: string;
    readonly noun: string;
    readonly candidates: readonly string[];
    readonly expected: string | null;
    readonly pick: string | null;
  }[];
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fixture = JSON.parse(
  readFileSync(join(REPO, 'reports', 'ai-masking', 'colour-rerank-siglip2-vectors.json'), 'utf8'),
) as Fixture;

/** IEEE 754 half precision, little endian, as the worker protocol packs vectors. */
function unpackFp16(packed: string): number[] {
  const bytes = Buffer.from(packed, 'base64');
  const out: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const half = bytes.readUInt16LE(offset);
    const sign = half & 0x8000 ? -1 : 1;
    const exponent = (half >> 10) & 0x1f;
    const fraction = half & 0x3ff;
    out.push(
      exponent === 0
        ? sign * 2 ** -14 * (fraction / 1024)
        : sign * 2 ** (exponent - 15) * (1 + fraction / 1024),
    );
  }
  return out;
}

const CLASS_OF: Readonly<Record<string, CocoClassName>> = { car: 'car', ball: 'sports ball' };
const FRAMES = [0, 8, 16, 24];

/** The crop id the resolver chose, or `null` when it asked. */
function decide(item: Fixture['items'][number]): string | null {
  // One detection track per crop, left to right, so candidate order is the crops' order.
  const detections: TargetDetection[] = item.candidates.flatMap((_crop, index) =>
    FRAMES.map((frame) => ({
      frame,
      label: 'object' as const,
      box: { x: 0.05 + index * 0.32, y: 0.4, width: 0.28, height: 0.35 },
      confidence: 0.9,
      objectClass: CLASS_OF[item.noun]!,
      classScore: 0.9,
    })),
  );
  const input = {
    clipId: 'shot',
    assetId: 'asset',
    fps: 24,
    sampledFrames: FRAMES,
    detections,
    engine: 'test',
    description: item.request,
  };
  const ranked = rankCandidates(input);
  const plan = colourRerankPlan(item.request, ranked);
  expect(plan, item.request).toBeDefined();
  const cropOf = (candidateId: string): string => {
    const candidate = ranked.find((each) => each.candidateId === candidateId)!;
    return item.candidates[Math.round((candidate.box.x - 0.05) / 0.32)]!;
  };
  const rerank = colourRerankScores(
    plan!,
    plan!.candidates.map((candidate) => unpackFp16(fixture.crops[cropOf(candidate.candidateId)]!)),
    fixture.prompts[item.noun]!.map(unpackFp16),
  );
  const result = resolveMaskTargets({ ...input, evidence: { rerank } });
  return result.status === 'resolved' ? cropOf(result.chosenCandidateIds[0]!) : null;
}

describe('colour re-ranking on real SigLIP 2 vectors (AM2.6)', () => {
  it('uses the palette the vectors were made for', () => {
    expect(fixture.colours).toEqual(COLOUR_WORDS);
  });

  it('takes exactly the decisions the eval tool recorded', () => {
    const differing = fixture.items.filter((item) => decide(item) !== item.pick);
    expect(differing.map((item) => `${item.request} ${item.candidates.join(',')}`)).toEqual([]);
  });

  it('never picks a crop that is not the named colour, and asks for every absent colour', () => {
    const wrong = fixture.items.filter((item) => item.pick !== null && item.pick !== item.expected);
    expect(wrong).toEqual([]);
    const absent = fixture.items.filter((item) => item.expected === null);
    expect(absent.length).toBe(108);
    expect(absent.every((item) => item.pick === null)).toBe(true);
    const present = fixture.items.filter((item) => item.expected !== null);
    expect(present.filter((item) => item.pick === item.expected).length).toBe(28);
  });
});
