import { describe, expect, it } from 'vitest';
import { parseCandidateId } from './candidate-id.js';
import { MaskTargetsResultSchema } from './contracts.js';
import {
  candidatesOnFrame,
  parseTargetRequest,
  rankCandidates,
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

/** The same thing, as a Subject Intelligence >= 1.1 pack reports it: with its COCO class. */
const as = (
  objectClass: NonNullable<TargetDetection['objectClass']>,
  detections: TargetDetection[],
  classScore = 0.9,
): TargetDetection[] => detections.map((hit) => ({ ...hit, objectClass, classScore }));

const inputOf = (
  description: string,
  detections: TargetDetection[],
  evidence?: ResolveTargetsInput['evidence'],
): ResolveTargetsInput => ({
  clipId: 'shot',
  assetId: 'asset',
  description,
  fps: 24,
  sampledFrames: FRAMES,
  detections,
  engine: 'framepilot.subject-intelligence@1.0.0',
  ...(evidence === undefined ? {} : { evidence }),
});

const resolve = (
  description: string,
  detections: TargetDetection[],
  evidence?: ResolveTargetsInput['evidence'],
) => resolveMaskTargets(inputOf(description, detections, evidence));

/** The plain ids a host's evidence sources are keyed by, best first. */
const plainIds = (detections: TargetDetection[]): string[] =>
  rankCandidates(inputOf('', detections)).map((candidate) => candidate.candidateId);

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

  it('uses a re-ranker margin to pick the described object among the ones of its class', () => {
    const cars = [
      ...as('car', steady('object', 0.1, 0.5, 0.2)),
      ...as('car', steady('object', 0.6, 0.5, 0.2)),
    ];
    const ids = plainIds(cars);
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

  it('asks about an object’s class when the pack reports none — even a lone one', () => {
    // A Subject Intelligence 1.0 pack reports every non-person class as `object`: one box is not
    // proof it is a car, and a re-ranker cannot vouch for the class either (AM2.5) — it only
    // re-ranks among candidates the detector has already classed.
    expect(asks('the red car', steady('object', 0.4, 0.5, 0.2)).status).toBe('ambiguous_target');
    expect(
      asks('all the cars', [...steady('object', 0.1, 0.5, 0.2), ...steady('object', 0.6, 0.5, 0.2)])
        .status,
    ).toBe('ambiguous_target');
    const unclassed = [...steady('object', 0.1, 0.5, 0.2), ...steady('object', 0.6, 0.5, 0.2)];
    const ids = plainIds(unclassed);
    expect(
      asks('the red car', unclassed, {
        rerank: new Map([
          [ids[0]!, 0.95],
          [ids[1]!, 0.05],
        ]),
      }).status,
    ).toBe('ambiguous_target');
  });

  it('asks when the re-ranker’s margin is thin or its best match is poor', () => {
    const cars = [
      ...as('car', steady('object', 0.1, 0.5, 0.2)),
      ...as('car', steady('object', 0.6, 0.5, 0.2)),
    ];
    const ids = plainIds(cars);
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
    const id = parseCandidateId(resolve('the face', faces).chosenCandidateIds[0]!)!.bareId;
    expect(resolve('the face', faces).candidates[0]!.identity).toBeUndefined();
    expect(
      resolve('the face', faces, { identities: new Map([[id, 'person_3']]) }).candidates[0]!
        .identity,
    ).toBe('person_3');
  });

  it('demotes, but keeps, a candidate the shot ledger disagrees with', () => {
    const things = [...steady('person', 0.1, 0.2, 0.3), ...steady('object', 0.6, 0.2, 0.3)];
    const plain = resolve('mask the person', things).candidates[0]!.score;
    const demoted = resolve('mask the person', things, { ledgerSubjectKind: 'vehicle' })
      .candidates[0]!.score;
    expect(demoted).toBeLessThan(plain);
    expect(resolve('mask the person', things, { ledgerSubjectKind: 'vehicle' }).status).toBe(
      'resolved',
    );
    // A kind with no detector equivalent is no opinion, not disagreement.
    expect(
      resolve('mask the person', things, { ledgerSubjectKind: 'place' }).candidates[0]!.score,
    ).toBe(plain);
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

describe('what the AM5 eval found', () => {
  it('a possessive only says whose: "her hair" and "the car\u2019s plate" ask for a click', () => {
    expect(parseTargetRequest('her hair').targetClass).toBe('out_of_vocabulary');
    expect(parseTargetRequest("the car's plate").targetClass).toBe('out_of_vocabulary');
    expect(parseTargetRequest('the man\u2019s shirt').targetClass).toBe('out_of_vocabulary');
    expect(parseTargetRequest("the players' hair").targetClass).toBe('out_of_vocabulary');
    expect(parseTargetRequest("the dog's owner").targetClass).toBe('person');
    // With nothing else named, the possessive's noun is unknown: ask for a click, never guess.
    expect(parseTargetRequest("the car's hubcap").targetClass).toBe('unknown');
  });

  it('a pronoun is still the target when nothing it could own follows it', () => {
    expect(parseTargetRequest('her').targetClass).toBe('person');
    expect(parseTargetRequest('put the title behind her').targetClass).toBe('person');
    expect(parseTargetRequest('her on the left')).toMatchObject({
      targetClass: 'person',
      selector: 'left',
    });
    expect(parseTargetRequest('her and the dog').targetClass).toBe('person');
    expect(parseTargetRequest('her face').targetClass).toBe('face');
    expect(parseTargetRequest("the host's face")).toMatchObject({
      targetClass: 'face',
      identity: true,
    });
  });

  it('names people by what they are doing', () => {
    expect(parseTargetRequest('the pedestrian').targetClass).toBe('person');
    expect(parseTargetRequest('all the cyclists')).toMatchObject({
      targetClass: 'person',
      all: true,
    });
  });

  it('"all the faces" chooses and lists every face in a crowd, not the first twelve', () => {
    const crowd = Array.from({ length: 20 }, (_, index) =>
      steady('face', (index % 5) * 0.19, Math.floor(index / 5) * 0.22, 0.07),
    ).flat();
    const result = resolve('all the faces', crowd);
    expect(result.status).toBe('resolved');
    expect(result.chosenCandidateIds).toHaveLength(20);
    const listed = new Set(result.candidates.map((candidate) => candidate.candidateId));
    expect(result.chosenCandidateIds.every((id) => listed.has(id))).toBe(true);
    expect(MaskTargetsResultSchema.safeParse(result).success).toBe(true);
  });

  it('asks rather than promise "all" at the detector\u2019s per-frame cap', () => {
    const crowd = Array.from({ length: 40 }, (_, index) =>
      steady('face', (index % 8) * 0.12, Math.floor(index / 8) * 0.19, 0.05),
    ).flat();
    const result = resolve('all the faces', crowd);
    expect(result.status).toBe('ambiguous_target');
    expect(result.chosenCandidateIds).toEqual([]);
    expect(result.candidates.length).toBeLessThanOrEqual(12);
  });
});

describe('AM2.5: object classes filter the candidates', () => {
  const car = as('car', steady('object', 0.35, 0.45, 0.3));
  const dog = as('dog', steady('object', 0.7, 0.5, 0.2));
  const person = as('person', steady('person', 0.05, 0.1, 0.3));

  it('maps nouns to COCO classes through the synonym table, plurals included', () => {
    expect([...parseTargetRequest('the sedan').objectClasses!]).toEqual(['car', 'truck', 'bus']);
    expect([...parseTargetRequest('the puppy').objectClasses!]).toEqual(['dog']);
    expect([...parseTargetRequest('the mug').objectClasses!]).toEqual(['cup']);
    expect(parseTargetRequest('all the buses')).toMatchObject({ targetClass: 'object', all: true });
    expect([...parseTargetRequest('all the buses').objectClasses!]).toEqual(['bus']);
    expect(parseTargetRequest('the pets')).toMatchObject({ all: true, noun: 'pets' });
    // Eyewear is not a wine glass.
    expect(parseTargetRequest('her glasses').targetClass).toBe('out_of_vocabulary');
    // A person or face request carries no object classes.
    expect(parseTargetRequest('the man').objectClasses).toBeUndefined();
  });

  it('reads a colour before a noun as the noun’s colour, not as the fruit', () => {
    expect(parseTargetRequest('the orange car')).toMatchObject({
      targetClass: 'object',
      noun: 'car',
      appearance: ['orange'],
    });
    expect([...parseTargetRequest('the orange').objectClasses!]).toEqual(['orange']);
  });

  it('picks the one thing of the named class, whatever else is on screen', () => {
    const result = resolve('the car', [...car, ...dog, ...person]);
    expect(result.status).toBe('resolved');
    const chosen = result.candidates.find((c) => c.candidateId === result.chosenCandidateIds[0]);
    expect(chosen).toMatchObject({ label: 'object', objectClass: 'car' });
    expect(MaskTargetsResultSchema.safeParse(result).success).toBe(true);
    expect(resolve('the puppy', [...car, ...dog]).status).toBe('resolved');
  });

  it('keeps a car out of "the truck", and lets "vehicle" admit both', () => {
    const truck = as('truck', steady('object', 0.05, 0.3, 0.5));
    const small = as('car', steady('object', 0.65, 0.5, 0.2));
    const result = resolve('the truck', [...truck, ...small]);
    expect(result.status).toBe('resolved');
    expect(
      result.candidates.find((c) => c.candidateId === result.chosenCandidateIds[0]),
    ).toMatchObject({ objectClass: 'truck' });
    // "vehicle" admits both, and size then decides only because it clearly can.
    expect(resolve('the biggest vehicle', [...truck, ...small]).status).toBe('resolved');
  });

  it('a class word that could mean several things on screen still asks', () => {
    const cat = as('cat', steady('object', 0.1, 0.5, 0.2));
    expect(resolve('the pet', [...cat, ...dog]).status).toBe('ambiguous_target');
    expect(resolve('the animal', [...cat, ...dog]).status).toBe('ambiguous_target');
    const bottle = as('bottle', steady('object', 0.2, 0.4, 0.1));
    const mug = as('cup', steady('object', 0.45, 0.55, 0.1));
    expect(resolve('the product', [...bottle, ...mug]).status).toBe('ambiguous_target');
    // …and a person is never a product.
    expect(resolve('the product', [...bottle, ...person]).status).toBe('resolved');
  });

  it('says there is none of that class rather than offering another', () => {
    const result = resolve('the dog', [...car, ...person]);
    expect(result.status).toBe('no_candidates');
    expect(result.candidates).toEqual([]);
  });

  it('asks when the detector itself could not settle the class of a thing', () => {
    // Called a dog on five frames and a cat on three: plausibly the cat, not clearly.
    const flicker = steady('object', 0.3, 0.4, 0.3).map((hit, index) => ({
      ...hit,
      objectClass: index < 5 ? ('dog' as const) : ('cat' as const),
      classScore: 0.8,
    }));
    expect(resolve('the cat', flicker).status).toBe('ambiguous_target');
    expect(resolve('the dog', flicker).status).toBe('resolved');
  });

  it('a noun outside the table and the person words asks for a click', () => {
    expect(resolve('the wheelbarrow', [...car, ...dog]).status).toBe('needs_click');
  });

  it('"all the cars" chooses every car, and only cars', () => {
    const other = as('car', steady('object', 0.02, 0.1, 0.15));
    const result = resolve('all the cars', [...car, ...other, ...dog]);
    expect(result.status).toBe('resolved');
    expect(result.chosenCandidateIds).toHaveLength(2);
  });
});
