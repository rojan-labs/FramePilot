/**
 * Tests for the checkable acceptance a run is held to.
 *
 * The bar for a criterion is high on purpose: a wrong one fails a run that did the work, or
 * passes one that did not. Since issue #136 nothing here reads the request's words; a
 * criterion comes only from the router-grounded length, a host target, or a measured
 * reference. The request's parts are the model's own plan.
 */
import { describe, expect, it } from 'vitest';
import {
  JUDGEMENT_CRITERION,
  acceptanceCriteria,
  asksForPreview,
  asksForRenderedFile,
  asksToRememberPreference,
  checkableAcceptance,
  explicitCutawayCount,
  hasCheckableAcceptance,
  statedDuration,
} from './acceptance.js';
import { referenceDirectives } from './references/directives.js';
import { buildReferenceProfile } from './references/profile.js';
import { MONTAGE_BRIEF_E36235CC } from './__fixtures__/montage-brief-e36235cc.js';
import { MONTAGE_BRIEF_FC10301A } from './__fixtures__/montage-brief-fc10301a.js';

describe('statedDuration', () => {
  it("takes the host's target over the router's reading, and nothing from neither", () => {
    const reading = { deliverableLength: { seconds: 60, toleranceSeconds: 2, statedAs: '58–62s' } };
    expect(statedDuration({ durationTargetSeconds: 45, requestReading: reading })).toEqual({
      seconds: 45,
    });
    expect(statedDuration({ requestReading: reading })).toEqual(reading.deliverableLength);
    expect(statedDuration({})).toBeUndefined();
  });
});

describe('checkableAcceptance', () => {
  it("names the request's own words for the length, so a target can be traced to its source", () => {
    // Run 6cb12e30 was held to "about 3s" read from "Use only the best 2–4s of each" (per
    // shot), and argued with a bare number five times. A criterion that quotes its source
    // makes a misreading visible to the run and to the editor.
    const acceptance = checkableAcceptance('a travel reel, 58–62s master', {
      seconds: 60,
      toleranceSeconds: 2,
      statedAs: '58–62s',
    });
    expect(acceptance).toEqual({
      durationSeconds: 60,
      durationToleranceSeconds: 2,
      durationStatedAs: '58–62s',
    });
    expect(hasCheckableAcceptance(acceptance)).toBe(true);
    expect(acceptanceCriteria(acceptance)).toEqual([
      'The finished sequence runs 58–62s (the request says “58–62s”).',
      JUDGEMENT_CRITERION,
    ]);
  });

  it('states a host target with no quoted words', () => {
    expect(acceptanceCriteria(checkableAcceptance('anything', { seconds: 45 }))[0]).toBe(
      'The finished sequence runs about 45s.',
    );
  });

  it('never reads a length out of the prompt itself', () => {
    expect(
      checkableAcceptance('Use only the best 2–4s of each. Make a 30 second reel.', undefined),
    ).toEqual({});
  });

  it('is empty for a request with no router length, host target or reference', () => {
    const acceptance = checkableAcceptance('make this look nicer', undefined);
    expect(acceptance).toEqual({});
    expect(hasCheckableAcceptance(acceptance)).toBe(false);
    expect(acceptanceCriteria(acceptance)).toEqual([JUDGEMENT_CRITERION]);
  });
});

/**
 * Issue #136. Every one of these used to become a run-stopping criterion (or a runtime cap)
 * read by regex. Run `d8d2e445`: "A tiny animated compass or arrow … (optional)" became "A
 * callout is on the timeline", a brief with no stated count became "at least 3 distinct
 * shots", and "every picture clip carries its own reframe" was met by automatic centred
 * crops — four criteria satisfied by one add_clips and one arrow, over the model's own "not
 * done yet" list. Only the router's length may survive.
 */
describe('the request is not read for criteria (issue #136)', () => {
  const routerLength = { seconds: 60, toleranceSeconds: 2, statedAs: '58–62s' };
  const onlyTheLength = [
    'The finished sequence runs 58–62s (the request says “58–62s”).',
    JUDGEMENT_CRITERION,
  ];

  it.each([
    ['an optional callout', 'A tiny animated compass or arrow in the corner (optional).'],
    ['a stated shot count', 'Use 3 shots from the summit, then at least 20 moments overall.'],
    ['a per-clip reframe', 'Every clip reframed to fill the 9:16 frame — no black bars.'],
    ['a per-clip grade and motion', 'Grade every clip and add a slow push-in on each photo.'],
    ['a sticker', "Add a fire emoji when I say 'this is fire'."],
    ['a rendered file', 'Export both — the 16:9 at 1080p and the vertical MP4.'],
    ['a preview', 'Show me a preview before you render.'],
    ['a lasting preference', 'Remember for future edits: no fade to black mid-action.'],
    ['a cutaway count', "I'm missing two cutaways I never shot: a chairlift, and snow."],
  ])('adds nothing beyond the router length for %s', (_what, request) => {
    const acceptance = checkableAcceptance(`MASTER: 58–62s. ${request}`, routerLength);
    expect(acceptanceCriteria(acceptance)).toEqual(onlyTheLength);
    expect(Object.keys(acceptance).sort()).toEqual([
      'durationSeconds',
      'durationStatedAs',
      'durationToleranceSeconds',
    ]);
  });

  it('adds nothing at all without a router length, however much the brief asks for', () => {
    const acceptance = checkableAcceptance(
      'Use 3 shots. Every clip reframed. Add an arrow (optional). Export an MP4.',
      undefined,
    );
    expect(acceptance).toEqual({});
    expect(hasCheckableAcceptance(acceptance)).toBe(false);
  });

  it('reads nothing out of the captured long briefs', () => {
    // e36235cc read "at least 50 distinct shots"; fc10301a read a grade, a motion demand and
    // a rendered-file deliverable. Both are whole and unedited.
    for (const brief of [MONTAGE_BRIEF_E36235CC, MONTAGE_BRIEF_FC10301A]) {
      expect(acceptanceCriteria(checkableAcceptance(brief, undefined))).toEqual([
        JUDGEMENT_CRITERION,
      ]);
    }
  });

  // The receipt caveats and the stock cutaway cap `orchestrator.ts` builds from these no
  // longer fire: each answers "the request did not say" whatever it is given.
  it('leaves the retired readers inert', () => {
    expect(asksForRenderedFile('One final rendered 30s vertical MP4')).toBe(false);
    expect(asksForPreview('Show me a preview before you render.')).toBe(false);
    expect(asksToRememberPreference('From now on, always big yellow captions')).toBe(false);
    expect(explicitCutawayCount('two cutaways please')).toBeUndefined();
  });
});

describe('capability claims are not read off the request', () => {
  // Run 6cb12e30: keyword-triggered sentences ("track_object only ATTACHES a tracker …",
  // "Sound effects cannot be sourced here") rode into the criteria, were false on the
  // desktop, and the run believed them.
  it('puts no capability sentence into the criteria, whatever the brief says', () => {
    const acceptance = checkableAcceptance(
      'Follow the runner, add a voiceover, whoosh on every transition, show me a preview',
      undefined,
    );
    const criteria = acceptanceCriteria(acceptance).join('\n');
    expect(criteria).not.toMatch(/cannot|draw the mask|no text-to-speech/i);
  });
});

describe('acceptanceCriteria', () => {
  // The regression. `criteria.push(prompt)` copied the whole brief into the objective, from
  // where it rode into decisions, objectives, nextAction and every telemetry row carrying the
  // working state. The request is already persisted verbatim as `objective.request`.
  it('never copies the request into a criterion, however long the brief', () => {
    const brief = `${'Make a high-retention vertical reel. '.repeat(200)}30 seconds.`;
    const criteria = acceptanceCriteria(checkableAcceptance(brief, { seconds: 30 }));
    expect(criteria.some((line) => line.includes('high-retention'))).toBe(false);
    expect(criteria.join('').length).toBeLessThan(400);
  });
});

describe('acceptance from a measured reference (P3.4)', () => {
  const directives = referenceDirectives([
    buildReferenceProfile({
      id: 'ref_1',
      role: 'pacing',
      kind: 'video',
      fileName: 'fast-cut.mp4',
      contentHash: 'abcdef0123456789',
      analyzedAt: '2026-08-29T00:00:00Z',
      video: {
        durationS: 20,
        shotCount: 18,
        medianShotS: 1.1,
        shotLengthP10S: 0.6,
        shotLengthP90S: 2.4,
      },
    }),
  ]);

  it('states the reference pace as a criterion the run is told it must hold', () => {
    const acceptance = checkableAcceptance('make it feel like this', undefined, directives);
    expect(acceptance.medianShotSeconds).toBe(1.1);
    expect(acceptance.medianShotSource).toBe('ref_1');
    expect(acceptanceCriteria(acceptance)).toContain(
      'The median picture clip runs about 1.1s, matching the attached reference (ref_1).',
    );
    // A request with no numbers in it is checkable, because the reference has them.
    expect(hasCheckableAcceptance(acceptance)).toBe(true);
  });

  it('adds nothing when no reference is attached', () => {
    const acceptance = checkableAcceptance('make it feel like this', undefined);
    expect(acceptance.medianShotSeconds).toBeUndefined();
    expect(hasCheckableAcceptance(acceptance)).toBe(false);
  });
});
