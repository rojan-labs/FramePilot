import { describe, expect, it } from 'vitest';
import { parseCandidateId } from './candidate-id.js';
import { MaskTargetsResultSchema } from './contracts.js';
import {
  candidatesOnFrame,
  parseTargetRequest,
  resolveMaskTargets,
  type ResolveTargetsInput,
  type TargetDetection,
} from './target-resolution.js';

const FRAMES = [0, 8, 16, 24, 32, 40, 48, 56];

/** A thing that stays put across the sampled frames, drifting slightly. */
function steady(
  label: TargetDetection['label'],
  x: number,
  y: number,
  size = 0.15,
  frames = FRAMES,
  confidence = 0.9,
): TargetDetection[] {
  return frames.map((frame, index) => ({
    frame,
    label,
    box: { x: x + index * 0.002, y, width: size, height: size },
    confidence,
  }));
}

const resolve = (
  description: string,
  detections: TargetDetection[],
  evidence?: ResolveTargetsInput['evidence'],
) =>
  resolveMaskTargets({
    clipId: 'shot',
    assetId: 'asset',
    description,
    fps: 24,
    sampledFrames: FRAMES,
    detections,
    engine: 'framepilot.subject-intelligence@1.0.0',
    ...(evidence === undefined ? {} : { evidence }),
  });

describe('parseTargetRequest', () => {
  it('reads class, quantifier, selector and identity from the editor’s words', () => {
    expect(parseTargetRequest('blur her face')).toMatchObject({
      targetClass: 'face',
      all: false,
      identity: false,
    });
    expect(parseTargetRequest("everyone's faces")).toMatchObject({
      targetClass: 'face',
      all: true,
    });
    expect(parseTargetRequest('the person on the left')).toMatchObject({
      targetClass: 'person',
      selector: 'left',
    });
    expect(parseTargetRequest('the man holding the phone')).toMatchObject({
      targetClass: 'person',
    });
    expect(parseTargetRequest('the red car')).toMatchObject({
      targetClass: 'object',
      appearance: ['red'],
    });
    expect(parseTargetRequest('all the cars')).toMatchObject({ targetClass: 'object', all: true });
    expect(parseTargetRequest('everyone except the host')).toMatchObject({
      targetClass: 'person',
      all: true,
      identity: true,
    });
    expect(parseTargetRequest('grade only the sky')).toMatchObject({
      targetClass: 'out_of_vocabulary',
    });
    expect(parseTargetRequest('the licence plate')).toMatchObject({
      targetClass: 'out_of_vocabulary',
    });
    expect(parseTargetRequest('that bit there')).toMatchObject({ targetClass: 'unknown' });
  });
});

describe('unambiguous requests resolve to the target', () => {
  it('picks the only face', () => {
    const result = resolve('blur her face', [
      ...steady('face', 0.4, 0.2),
      ...steady('person', 0.3, 0.1, 0.5),
    ]);
    expect(result.status).toBe('resolved');
    expect(result.chosenCandidateIds).toHaveLength(1);
    expect(parseCandidateId(result.chosenCandidateIds[0]!)).toMatchObject({
      label: 'face',
      pickRequired: false,
    });
    expect(MaskTargetsResultSchema.safeParse(result).success).toBe(true);
  });

  it('picks every face when the request asks for all of them', () => {
    const result = resolve('blur all the faces', [
      ...steady('face', 0.1, 0.2),
      ...steady('face', 0.6, 0.2),
    ]);
    expect(result.status).toBe('resolved');
    expect(result.chosenCandidateIds).toHaveLength(2);
  });

  it('lets a clear positional selector decide between two people', () => {
    const result = resolve('the person on the left', [
      ...steady('person', 0.05, 0.2, 0.3),
      ...steady('person', 0.6, 0.2, 0.3),
    ]);
    expect(result.status).toBe('resolved');
    const chosen = result.candidates.find(
      (candidate) => candidate.candidateId === result.chosenCandidateIds[0],
    );
    expect(chosen?.box.x).toBeLessThan(0.3);
    // The runner-up is listed, but only the editor can choose it.
    const other = result.candidates.find(
      (candidate) => candidate.candidateId !== result.chosenCandidateIds[0],
    );
    expect(parseCandidateId(other!.candidateId)?.pickRequired).toBe(true);
  });

  it('lets size decide "the main subject" when one is clearly bigger', () => {
    const result = resolve('the main person', [
      ...steady('person', 0.3, 0.1, 0.5),
      ...steady('person', 0.8, 0.4, 0.1),
    ]);
    expect(result.status).toBe('resolved');
  });

  it('uses a re-ranker margin to pick the described object', () => {
    const cars = [...steady('object', 0.1, 0.5, 0.2), ...steady('object', 0.6, 0.5, 0.2)];
    const ids = resolve('the red car', cars).candidates.map(
      (candidate) => parseCandidateId(candidate.candidateId)!.measuredId,
    );
    const rerank = new Map([
      [ids[0]!, 0.9],
      [ids[1]!, 0.3],
    ]);
    const result = resolve('the red car', cars, { rerank });
    expect(result.status).toBe('resolved');
    expect(result.reranker).toBe('siglip');
    expect(result.chosenCandidateIds).toEqual([ids[0]]);
  });
});

describe('ambiguous requests ask, never guess', () => {
  const asks = (
    description: string,
    detections: TargetDetection[],
    evidence?: ResolveTargetsInput['evidence'],
  ) => {
    const result = resolve(description, detections, evidence);
    expect(result.chosenCandidateIds).toEqual([]);
    for (const candidate of result.candidates) {
      expect(parseCandidateId(candidate.candidateId)?.pickRequired).toBe(true);
    }
    return result;
  };

  it('asks when two people match and nothing separates them', () => {
    expect(
      asks('mask the person', [
        ...steady('person', 0.1, 0.2, 0.3),
        ...steady('person', 0.6, 0.2, 0.3),
      ]).status,
    ).toBe('ambiguous_target');
  });

  it('asks when a selector does not clearly win', () => {
    expect(
      asks('the person on the left', [
        ...steady('person', 0.3, 0.2, 0.3),
        ...steady('person', 0.36, 0.5, 0.3),
      ]).status,
    ).toBe('ambiguous_target');
    expect(
      asks('the biggest person', [
        ...steady('person', 0.1, 0.2, 0.3),
        ...steady('person', 0.6, 0.2, 0.31),
      ]).status,
    ).toBe('ambiguous_target');
  });

  it('asks about an object’s class when no re-ranker can vouch for it — even a lone one', () => {
    // The detector reports every non-person class as `object`: one box is not proof it is a car.
    expect(asks('the red car', steady('object', 0.4, 0.5, 0.2)).status).toBe('ambiguous_target');
    expect(
      asks('all the cars', [...steady('object', 0.1, 0.5, 0.2), ...steady('object', 0.6, 0.5, 0.2)])
        .status,
    ).toBe('ambiguous_target');
  });

  it('asks when the re-ranker’s margin is thin or its best match is poor', () => {
    const cars = [...steady('object', 0.1, 0.5, 0.2), ...steady('object', 0.6, 0.5, 0.2)];
    const ids = resolve('the red car', cars).candidates.map(
      (candidate) => parseCandidateId(candidate.candidateId)!.measuredId,
    );
    expect(
      asks('the red car', cars, {
        rerank: new Map([
          [ids[0]!, 0.62],
          [ids[1]!, 0.58],
        ]),
      }).status,
    ).toBe('ambiguous_target');
    expect(
      asks('the red car', cars, {
        rerank: new Map([
          [ids[0]!, 0.3],
          [ids[1]!, 0.1],
        ]),
      }).status,
    ).toBe('ambiguous_target');
  });

  it('sends an out-of-vocabulary target to a click, and an identity question to the face picker', () => {
    expect(asks('grade only the sky', steady('person', 0.3, 0.1, 0.5)).status).toBe('needs_click');
    expect(asks('the sign on the left', steady('object', 0.1, 0.1, 0.2)).status).toBe(
      'needs_click',
    );
    const crowd = [
      ...steady('face', 0.1, 0.2),
      ...steady('face', 0.5, 0.2),
      ...steady('person', 0.05, 0.1, 0.4),
    ];
    const result = asks('blur everyone except the host', crowd);
    expect(result.status).toBe('needs_face_selection');
    expect(result.candidates.every((candidate) => candidate.label === 'face')).toBe(true);
  });

  it('says so when nothing of that class is on screen, instead of offering something else', () => {
    const result = asks('blur the face', steady('object', 0.4, 0.5, 0.2));
    expect(result.status).toBe('no_candidates');
    expect(result.candidates).toEqual([]);
  });
});

describe('ranking', () => {
  it('drops detector flicker and ranks the persistent thing first', () => {
    const result = resolve('mask the person', [
      ...steady('person', 0.3, 0.1, 0.5),
      {
        frame: 16,
        label: 'person',
        box: { x: 0.85, y: 0.8, width: 0.1, height: 0.1 },
        confidence: 0.95,
      },
    ]);
    expect(result.status).toBe('resolved');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.persistence).toBe(1);
  });

  it('attaches identity only when the host supplied it, which it does only with consent', () => {
    const faces = steady('face', 0.4, 0.2);
    const id = parseCandidateId(resolve('the face', faces).chosenCandidateIds[0]!)!.measuredId;
    expect(resolve('the face', faces).candidates[0]!.identity).toBeUndefined();
    expect(
      resolve('the face', faces, { identities: new Map([[id, 'person_3']]) }).candidates[0]!
        .identity,
    ).toBe('person_3');
  });

  it('demotes, but keeps, a candidate the shot ledger disagrees with', () => {
    const things = [...steady('person', 0.1, 0.2, 0.3), ...steady('object', 0.6, 0.2, 0.3)];
    const plain = resolve('mask the person', things).candidates[0]!.score;
    const demoted = resolve('mask the person', things, { ledgerSubjectKind: 'product' })
      .candidates[0]!.score;
    expect(demoted).toBeLessThan(plain);
    expect(resolve('mask the person', things, { ledgerSubjectKind: 'product' }).status).toBe(
      'resolved',
    );
  });

  it('is deterministic, and re-detecting one frame reproduces a recalled id', () => {
    const faces = [...steady('face', 0.1, 0.2), ...steady('face', 0.6, 0.2)];
    expect(resolve('all faces', faces)).toEqual(resolve('all faces', [...faces].reverse()));
    const [chosen] = resolve('all faces', faces).chosenCandidateIds;
    const frame = parseCandidateId(chosen!)!.frame;
    const again = candidatesOnFrame({ assetId: 'asset', fps: 24, detections: faces }, frame);
    expect(again.map((candidate) => candidate.candidateId)).toContain(chosen);
  });
});
