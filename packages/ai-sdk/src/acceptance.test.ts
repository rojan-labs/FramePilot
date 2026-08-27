/**
 * Tests for reading checkable acceptance out of a request.
 *
 * The bar for adding a criterion is high on purpose: a wrong one fails a run that did the
 * work, which is worse than a missing one. The captured run's own words are the primary case —
 * "can you use at least of 20+ different best moments" was satisfied, as far as the run's
 * ledger knew, by an eight-shot timeline.
 */
import { describe, expect, it } from 'vitest';
import {
  JUDGEMENT_CRITERION,
  acceptanceCriteria,
  asksForRenderedFile,
  checkableAcceptance,
  explicitCoverage,
  explicitMinShotCount,
  hasCheckableAcceptance,
  unmeetableDeliverables,
} from './acceptance.js';

describe('explicitMinShotCount', () => {
  it('reads a shot count from the way editors actually ask', () => {
    expect(
      explicitMinShotCount(
        'can you use at least of 20+ different best moments and combine and prepare a nice video',
      ),
    ).toBe(20);
    expect(explicitMinShotCount('use 12 clips')).toBe(12);
    expect(explicitMinShotCount('I want at least 8 different shots in this')).toBe(8);
    expect(explicitMinShotCount('cut it into 15 segments')).toBe(15);
  });

  it('does not mistake a duration for a shot count', () => {
    // "30 second cuts" names a length, not a number of shots — and reading it as one would
    // fail every montage that used fewer than thirty clips.
    expect(explicitMinShotCount('make a 30 second video')).toBeUndefined();
    expect(explicitMinShotCount('use 30 second cuts')).toBeUndefined();
    expect(explicitMinShotCount('prepare a 30s instagram story')).toBeUndefined();
  });

  it('ignores numbers that are not counts of shots', () => {
    expect(explicitMinShotCount('export at 1080p')).toBeUndefined();
    expect(explicitMinShotCount('a few clips from the middle')).toBeUndefined();
    // Below the meaningful floor: "2 clips" describes an edit, it is not an acceptance bar.
    expect(explicitMinShotCount('join these 2 clips')).toBeUndefined();
    // Absurdly high: not a shot count.
    expect(explicitMinShotCount('grow to 1000 clips')).toBeUndefined();
  });

  it('has nothing to say about an empty request', () => {
    expect(explicitMinShotCount('   ')).toBeUndefined();
  });
});

describe('explicitCoverage', () => {
  it("reads the treatments run 2's brief demanded of every clip", () => {
    // Verbatim from the brief that was answered with one graded clip and one moved clip out
    // of forty-seven, while every criterion the run had was satisfied.
    const brief = [
      '- Every clip must be **reframed to fill the full 1080x1920 vertical canvas**: crop in',
      '  on the subject, and apply a **subtle dynamic zoom/pan (Ken Burns style)** per clip',
      '- Light color grade for consistency across clips (unify exposure/contrast)',
    ].join('\n');
    expect([...explicitCoverage(brief)].sort()).toEqual(['crop', 'grade', 'motion']);
  });

  it('needs BOTH a universal quantifier and a clip noun on the line', () => {
    // One moment, not the whole cut.
    expect(explicitCoverage('punch in on the reveal')).toEqual([]);
    expect(explicitCoverage('grade the opening shot')).toEqual([]);
    // A quantifier with no clip noun is about something else entirely.
    expect(explicitCoverage('crop every image in the bin')).toEqual([]);
    // A clip noun with no quantifier is not a whole-cut demand.
    expect(explicitCoverage('reframe the second clip')).toEqual([]);
  });

  it('does not let a quantifier on one line reach a treatment on another', () => {
    const prompt = 'Every clip must be trimmed tight.\nAdd a speed ramp to the fall.';
    expect(explicitCoverage(prompt)).toEqual([]);
  });

  it('reads a speed demand made of every clip', () => {
    expect(explicitCoverage('slow-mo on each clip')).toEqual(['speed']);
  });
});

describe('asksForRenderedFile', () => {
  it('recognises a request for a file, in the ways briefs write it', () => {
    // Run 2's brief closed with exactly this, and the run reported completed without ever
    // mentioning that the panel cannot render.
    expect(asksForRenderedFile('One final rendered 30s vertical MP4, fully cropped')).toBe(true);
    expect(asksForRenderedFile('export the video when done')).toBe(true);
    expect(asksForRenderedFile('deliver an mp4')).toBe(true);
    expect(asksForRenderedFile('render out a mov file')).toBe(true);
  });

  it('is not fooled by the words used about something that is not a file', () => {
    expect(asksForRenderedFile('render the captions legible')).toBe(false);
    expect(asksForRenderedFile('make it 30 seconds and punchy')).toBe(false);
    expect(asksForRenderedFile('export settings should be 9:16')).toBe(false);
  });
});

describe('checkableAcceptance', () => {
  it('carries the duration its caller already read, plus any shot count', () => {
    const acceptance = checkableAcceptance('a 30s reel from at least 20 moments', 30);
    expect(acceptance).toEqual({ durationSeconds: 30, minShotCount: 20 });
    expect(hasCheckableAcceptance(acceptance)).toBe(true);
  });

  it('is empty for a request that states no measurable condition', () => {
    const acceptance = checkableAcceptance('make this look nicer', undefined);
    expect(acceptance).toEqual({});
    expect(hasCheckableAcceptance(acceptance)).toBe(false);
  });

  it('records a requested file as a condition, so the run can say it cannot make one', () => {
    const prompt = 'a 30s reel, delivered as a rendered mp4';
    const acceptance = checkableAcceptance(prompt, 30);
    expect(acceptance.deliverableFile).toBe(true);
    const criteria = acceptanceCriteria(acceptance);
    expect(criteria.some((line) => line.includes('Export dialog'))).toBe(true);
  });

  it('carries a coverage demand as a checkable condition of its own', () => {
    const acceptance = checkableAcceptance('reframe every clip to fill the frame', undefined);
    expect(acceptance).toEqual({ coverage: ['crop'] });
    expect(hasCheckableAcceptance(acceptance)).toBe(true);
    expect(acceptanceCriteria(acceptance)[0]).toContain(
      'Every picture clip carries its own reframe',
    );
  });
});

/**
 * GAP-009. A captured brief specified, per scene, a voiceover and sound effects — and told
 * the agent it had a sound-effects search tool. Neither exists in the registry: no
 * text-to-speech, and no SFX catalogue (`search_music` is music, `search_stock` is picture).
 * The run searched for neither, mentioned neither, and would have delivered a silent,
 * effect-less cut against a brief whose every scene asked for both.
 *
 * The precedent is `deliverableFile`, which exists for exactly this reason and covered
 * exactly one case. This is disclosure, not capability.
 */
describe('unmeetableDeliverables', () => {
  it('spots a request to generate narration', () => {
    expect(unmeetableDeliverables('add a voiceover explaining the story')).toEqual(['voiceover']);
    expect(unmeetableDeliverables('I need AI narration over the b-roll')).toEqual(['voiceover']);
  });

  // The narrow half of the rule. Cutting to narration the project ALREADY has is ordinary
  // work the agent does well, and flagging it would be a false alarm on a normal request.
  it('does not flag editing against a voiceover that already exists', () => {
    expect(unmeetableDeliverables('cut on the beats of the voiceover')).toEqual([]);
    expect(unmeetableDeliverables('duck the music under the narration')).toEqual([]);
  });

  it('spots sound-effect sourcing by the words editors actually use', () => {
    expect(unmeetableDeliverables('whoosh transitions and a bass hit on the reveal')).toEqual([
      'soundEffects',
    ]);
    expect(unmeetableDeliverables('add sfx for each cut')).toEqual(['soundEffects']);
  });

  it('reports both when a brief asks for both', () => {
    expect(
      unmeetableDeliverables('Add a voiceover, plus sound effects on every transition.'),
    ).toEqual(['voiceover', 'soundEffects']);
  });

  // How the captured brief actually asked: a scene template with a "Voiceover:" field the
  // writer expects filled in. No verb, no article — invisible to both rules above.
  it('spots a scene template’s own voiceover field', () => {
    expect(unmeetableDeliverables('## SCENE 1\n\n**Voiceover:** "One tiny mistake."')).toEqual([
      'voiceover',
    ]);
    expect(unmeetableDeliverables('For every scene specify:\n* Voiceover or dialogue:')).toEqual([
      'voiceover',
    ]);
  });

  it('says nothing about an ordinary editing request', () => {
    expect(unmeetableDeliverables('cut this to 60 seconds and caption it')).toEqual([]);
  });

  it('becomes a criterion the run has to answer for, naming the way forward', () => {
    const prompt = 'a 30s reel with a voiceover and whoosh transitions';
    const acceptance = checkableAcceptance(prompt, 30);
    expect(acceptance.unmeetable).toEqual(['voiceover', 'soundEffects']);
    expect(hasCheckableAcceptance(acceptance)).toBe(true);
    const criteria = acceptanceCriteria(acceptance).join('\n');
    // Not just "cannot": what the editor can do instead.
    expect(criteria).toMatch(/no text-to-speech/i);
    expect(criteria).toMatch(/Record or import a voice track/i);
    expect(criteria).toMatch(/Import the effects you want/i);
  });
});

describe('acceptanceCriteria', () => {
  it('lists each checkable condition and keeps the judgement criterion last', () => {
    const criteria = acceptanceCriteria({ durationSeconds: 30, minShotCount: 20 });
    expect(criteria).toHaveLength(3);
    expect(criteria[0]).toContain('30s');
    expect(criteria[1]).toContain('20 distinct shots');
    // The unmeasurable half of the ask is still recorded — as a pointer, not a copy.
    expect(criteria.at(-1)).toBe(JUDGEMENT_CRITERION);
  });

  it('is only the judgement criterion when nothing is measurable', () => {
    expect(acceptanceCriteria({})).toEqual([JUDGEMENT_CRITERION]);
  });

  // The regression. `criteria.push(prompt)` copied the whole brief into the objective, from
  // where it rode into decisions, objectives, nextAction and every telemetry row carrying the
  // working state. A captured run stored a ~7,000-token prompt five times over, and
  // `briefing.ts` filters four of those copies back out as noise before rendering anything.
  // The request is already persisted verbatim as `objective.request`, one field away.
  it('never copies the request into a criterion, however long the brief', () => {
    const brief = `${'Make a high-retention vertical reel. '.repeat(200)}30 seconds.`;
    const criteria = acceptanceCriteria(checkableAcceptance(brief, 30));
    expect(criteria.some((line) => line.includes('high-retention'))).toBe(false);
    expect(criteria.join('').length).toBeLessThan(400);
  });
});
