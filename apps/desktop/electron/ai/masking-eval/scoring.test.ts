import { describe, expect, it } from 'vitest';
import { checkRequestSet, type EvalRequest, type RequestSet } from './fixture.js';
import { judge, summarise, traceMaskBox, type ItemRun, type MaskTrace } from './scoring.js';

const BOX = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const request = (overrides: Partial<EvalRequest> = {}): EvalRequest => ({
  id: 'r1',
  category: 'faces',
  scene: 's',
  request: 'blur the face',
  description: 'the face',
  expect: { outcome: 'target', things: ['face_a'] },
  purpose: 'hide',
  ...overrides,
});
const run = (
  status: ItemRun['status'],
  landed: MaskTrace[],
  overrides: Partial<EvalRequest> = {},
): ItemRun => ({ request: request(overrides), status, landed });
const thing = (thingId: string): MaskTrace => ({ kind: 'thing', thingId });

describe('tracing a landed mask', () => {
  it('traces to the emitted box it equals, or to the typed shape, or to nothing', () => {
    const emitted = [{ thingId: 'face_a', box: BOX }];
    expect(traceMaskBox(BOX, emitted, undefined)).toEqual(thing('face_a'));
    expect(traceMaskBox({ ...BOX, x: 0.1 + 1e-7 }, emitted, undefined)).toEqual(thing('face_a'));
    const moved = { ...BOX, x: 0.2 };
    expect(traceMaskBox(moved, emitted, undefined).kind).toBe('untraced');
    expect(traceMaskBox(moved, emitted, { shape: 'rectangle', ...moved })).toEqual({
      kind: 'typed',
    });
    expect(traceMaskBox(null, emitted, undefined).kind).toBe('untraced');
  });
});

describe('judging one run', () => {
  it('a target is right only when exactly the labelled things were masked after a resolution', () => {
    expect(judge(run('resolved', [thing('face_a')])).correct).toBe(true);
    expect(judge(run('resolved', [])).correct).toBe(false);
    const both = { expect: { outcome: 'target' as const, things: ['face_a', 'face_b'] } };
    expect(judge(run('resolved', [thing('face_a')], both)).correct).toBe(false);
    expect(judge(run('ambiguous_target', [], both)).correct).toBe(false);
  });

  it('a mask on the wrong thing is a confident wrong pick, never an ask', () => {
    const verdict = judge(run('resolved', [thing('face_b')]));
    expect(verdict).toMatchObject({ correct: false, confidentWrong: true });
    const askItem = { expect: { outcome: 'ask' as const } };
    expect(judge(run('ambiguous_target', [thing('face_a')], askItem))).toMatchObject({
      correct: false,
      confidentWrong: true,
    });
    expect(judge(run('ambiguous_target', [], askItem)).correct).toBe(true);
  });

  it('any untraced geometry fails the item and is counted', () => {
    const verdict = judge(
      run('resolved', [thing('face_a'), { kind: 'untraced', operation: 'add_mask' }]),
    );
    expect(verdict).toMatchObject({ correct: false, inventedGeometry: 1 });
  });

  it('clicks, face picks, refusals and typed shapes each need their own outcome', () => {
    const as = (outcome: EvalRequest['expect']['outcome']) => ({ expect: { outcome } });
    expect(judge(run('needs_click', [], as('click'))).correct).toBe(true);
    expect(judge(run('ambiguous_target', [], as('click'))).correct).toBe(false);
    expect(judge(run('needs_face_selection', [], as('face_selection'))).correct).toBe(true);
    expect(judge(run('ambiguous_target', [], as('face_selection'))).correct).toBe(false);
    expect(judge(run('not_called', [], as('refuse'))).correct).toBe(true);
    expect(judge(run('not_called', [{ kind: 'typed' }], as('typed_shape'))).correct).toBe(true);
    expect(judge(run('not_called', [], as('typed_shape'))).correct).toBe(false);
  });
});

describe('the gate summary', () => {
  it('scores each gate on its own denominator and never lets a miss pass', () => {
    const verdicts = [
      judge(run('resolved', [thing('face_a')])),
      judge(run('ambiguous_target', [], { id: 'r2', requires: 'object_class' })),
      judge(run('ambiguous_target', [], { id: 'r3', expect: { outcome: 'ask' } })),
      judge(run('resolved', [thing('face_a')], { id: 'r4', expect: { outcome: 'ask' } })),
    ];
    const summary = summarise(verdicts);
    expect(summary.targetAccuracy).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(summary.unnecessaryAsks).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(summary.ambiguousAskRate).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(summary.confidentWrong).toBe(1);
    expect(summary.targetMissesByRequirement).toEqual({ object_class: 1 });
    expect(summary.targetAccuracyByRequirement).toEqual({
      none: { passed: 1, total: 1, rate: 1 },
      object_class: { passed: 0, total: 1, rate: 0 },
    });
    expect(summary.gates.targetAccuracy.pass).toBe(false);
    expect(summary.gates.inventedGeometry.pass).toBe(true);
    expect(summary.gates.confidentWrong.pass).toBe(false);
  });
});

describe('checking the request set', () => {
  const set = (overrides: Partial<RequestSet> = {}): RequestSet => ({
    labelling: 'by construction',
    clip: { fps: 24, seconds: 2, width: 1920, height: 1080 },
    scenes: {
      s: {
        picture: 'one face',
        things: [
          {
            id: 'face_a',
            truth: 'face',
            detector: 'face',
            box: [0.1, 0.2, 0.3, 0.4],
            confidence: 0.9,
          },
          { id: 'sky', truth: 'sky', detector: null },
        ],
      },
    },
    requests: [request()],
    ...overrides,
  });

  it('accepts a well-formed set', () => {
    expect(() => checkRequestSet(set())).not.toThrow();
  });

  it('refuses labels that do not exist, cannot be detected, or are duplicated', () => {
    expect(() =>
      checkRequestSet(
        set({ requests: [request({ expect: { outcome: 'target', things: ['x'] } })] }),
      ),
    ).toThrow(/names x/);
    expect(() =>
      checkRequestSet(
        set({ requests: [request({ expect: { outcome: 'target', things: ['sky'] } })] }),
      ),
    ).toThrow(/cannot box/);
    expect(() => checkRequestSet(set({ requests: [request(), request()] }))).toThrow(/duplicate/);
    expect(() => checkRequestSet(set({ requests: [request({ scene: 'nope' })] }))).toThrow(
      /unknown scene/,
    );
    expect(() => checkRequestSet(set({ labelling: '' }))).toThrow(/how its labels were made/);
  });

  it('refuses a detectable thing without a usable box', () => {
    const bad = set();
    const scene = bad.scenes.s!;
    const broken = {
      ...bad,
      scenes: {
        s: {
          ...scene,
          things: [
            {
              id: 'face_a',
              truth: 'face',
              detector: 'face' as const,
              box: [0.1, 0.2, 0, 0.4] as const,
              confidence: 0.9,
            },
          ],
        },
      },
    };
    expect(() => checkRequestSet(broken)).toThrow(/no area/);
  });
});
