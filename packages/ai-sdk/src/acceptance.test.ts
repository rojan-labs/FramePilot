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
  mentionsUnreadableShotCount,
  unmeetableDeliverables,
} from './acceptance.js';
import { MONTAGE_BRIEF_E36235CC } from './__fixtures__/montage-brief-e36235cc.js';
import { MONTAGE_BRIEF_FC10301A } from './__fixtures__/montage-brief-fc10301a.js';

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
    // A quantifier with no PICTURE noun is about something else entirely. ("every beat"
    // is a statement about the music, not about the cut.)
    expect(explicitCoverage('push in on every beat')).toEqual([]);
    // A clip noun with no quantifier is not a whole-cut demand.
    expect(explicitCoverage('reframe the second clip')).toEqual([]);
  });

  // GAP-006 (run `fc10301a`). The coverage reader used a narrower noun list than the
  // shot-count reader beside it, so a stills brief — which says "photos" and never "clips"
  // — could have its duration and its shot count read while every per-clip demand it made
  // went unseen. Both readers now share one list.
  // The drift guard. The two readers had separate noun lists, one grew stills nouns and
  // the other did not, and nothing noticed for two captured runs. This asserts the
  // property directly rather than the implementation: whatever noun makes a number a shot
  // count must also make a line a whole-cut demand.
  it('every noun the shot-count reader accepts also anchors a coverage demand', () => {
    for (const noun of ['clip', 'shot', 'moment', 'cut', 'scene', 'segment', 'photo', 'image', 'picture', 'still']) {
      expect(explicitMinShotCount(`at least 12 ${noun}s`)).toBe(12);
      expect(explicitCoverage(`grade every ${noun}`)).toEqual(['grade']);
    }
  });

  it('reads a whole-cut demand made of photos, images, pictures and stills', () => {
    expect(explicitCoverage('Apply a unified cinematic grade across all photos.')).toEqual([
      'grade',
    ]);
    expect(explicitCoverage('Crop every image to fill the vertical frame.')).toEqual(['crop']);
    expect(explicitCoverage('A slow push-in on each picture.')).toEqual(['motion']);
    expect(explicitCoverage('Slow-mo on all stills.')).toEqual(['speed']);
  });

  // The motion vocabulary of a STILLS brief. A photograph cannot move on its own, so the
  // brief asks for "animation" and "motion" rather than for a camera move — and naming
  // only the camera-move words meant the one kind of footage whose motion has to be
  // authored was the one kind whose motion requirement was invisible.
  it('reads motion asked for in the words a stills brief uses', () => {
    expect(explicitCoverage('Do not apply the same animation to every image.')).toEqual([
      'motion',
    ]);
    expect(explicitCoverage('Motion should follow the composition of each photo.')).toEqual([
      'motion',
    ]);
    expect(explicitCoverage('Subtle parallax across all shots.')).toEqual(['motion']);
  });

  // A delivery spec states the crop requirement as its consequence.
  it('reads a crop demand stated as "no black bars" across the cut', () => {
    expect(explicitCoverage('Every photo fills the frame — no black bars.')).toEqual(['crop']);
  });

  // The whole brief, unedited. Every treatment it demands is stated in the vocabulary of
  // stills, and the run that received it applied none of them — motion, grade and crop
  // were the three things it omitted entirely, and the three no criterion could see.
  it('reads every per-photo demand the captured stills brief actually makes', () => {
    // "Apply a unified cinematic grade across all photos", "do not apply the same
    // animation to every image", "motion should follow the composition of each photo".
    // Read as `[]` before the two noun lists were unified.
    expect([...explicitCoverage(MONTAGE_BRIEF_FC10301A)].sort()).toEqual(['grade', 'motion']);
    // Deliberately NOT 'crop'. The brief demands 9:16 with "no black bars" and "no
    // stretched photos", but never attaches that to a universal quantifier and a picture
    // noun on one line — so reading a crop criterion out of it would be inventing one, and
    // a wrong criterion fails runs that did the work. The letterbox problem on that
    // project is real and is caught where it belongs: `critic.ts#checkReframeCoverage`
    // reads the FRAME, not the prose.
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

describe('round 5 — the beat-map table must not suppress the shot count', () => {
  it('reads 50 from the captured montage brief', () => {
    // The regression. `50+ visually distinct clips` sits at index ~218; `0.50s` appears three
    // times in a beat-map EXAMPLE table thousands of characters later. The guard used to test
    // the WHOLE prompt, so the table invalidated the requirement and the run's only checkable
    // condition vanished — which is how a one-clip timeline reported `completed`.
    expect(explicitMinShotCount(MONTAGE_BRIEF_E36235CC)).toBe(50);
  });

  it('records the shot count as a criterion the ledger reports against', () => {
    expect(acceptanceCriteria(checkableAcceptance(MONTAGE_BRIEF_E36235CC, undefined))).toContain(
      'The cut uses at least 50 distinct shots.',
    );
  });

  it.each([
    ['50+ visually distinct clips', 50],
    ['at least 50 separate video clips', 50],
    ['**Minimum clips:** 50', 50],
    ['use 20+ of the best moments', 20],
    ['use 20 clips', 20],
    // A range promises its NEAR end.
    ['60-80 clips', 60],
    ['60–80 clips', 60],
    ['60 to 80 clips', 60],
    // Durations, resolutions and frame rates are not shot counts.
    ['30 second cuts', undefined],
    ['use 30s clips', undefined],
    ['0.5-1.0s per clip', undefined],
    ['1080p 9:16 30fps', undefined],
    // Out of range, or not a stated number at all.
    ['1000 subscribers', undefined],
    ['2 clips', undefined],
    ['a few clips', undefined],
    ['', undefined],
  ])('reads %j as %s', (prompt, expected) => {
    expect(explicitMinShotCount(prompt)).toBe(expected);
  });

  it('prefers a marked floor over a larger aspiration', () => {
    // "Prefer 60-80" and "Target approximately 80-120 candidate clips" are not floors. Taking
    // the largest number would make the criterion 120 and fail a cut of 80 that did the work.
    expect(
      explicitMinShotCount('At least 50 clips. Prefer 60-80 clips. Target 80-120 candidate clips.'),
    ).toBe(50);
  });

  it('ignores a search-pool size', () => {
    expect(explicitMinShotCount('Target approximately 80-120 candidate clips')).toBeUndefined();
  });

  it('reads the largest marked floor when a brief repeats itself', () => {
    expect(explicitMinShotCount('at least 20 clips … no fewer than 40 clips')).toBe(40);
  });

  it('is not fooled by a throwaway count in the opening line', () => {
    // First-match-wins would have returned 3 here.
    expect(explicitMinShotCount('Open with a few 3-shot sequences, then at least 50 clips.')).toBe(
      50,
    );
  });

  it('reads the same prompt the same way twice (module-level /g regex state)', () => {
    expect(explicitMinShotCount(MONTAGE_BRIEF_E36235CC)).toBe(
      explicitMinShotCount(MONTAGE_BRIEF_E36235CC),
    );
  });
});

describe('mentionsUnreadableShotCount', () => {
  it('is false for the captured brief now that it reads', () => {
    expect(mentionsUnreadableShotCount(MONTAGE_BRIEF_E36235CC)).toBe(false);
  });

  it('is false for a short prompt, however it is phrased', () => {
    expect(mentionsUnreadableShotCount('make it nice')).toBe(false);
  });

  it('flags a spec-length brief whose only count is unreadable', () => {
    const spec = `${'Make a montage. '.repeat(120)} Use 2 clips.`;
    expect(explicitMinShotCount(spec)).toBeUndefined();
    expect(mentionsUnreadableShotCount(spec)).toBe(true);
  });
});

describe('round 6 — a brief made of photos still states a shot count', () => {
  /**
   * Run 4c9b5f82. A 12,000-character brief for 61 hiking photos named its material as
   * "photos" throughout and no shot noun ever appeared, so the only checkable count in it
   * was unreadable. `checkShotCount` reported `skipped`, and a montage that used ten of
   * the sixty-one finished as `completed`.
   */
  it('reads a photo count as a shot count', () => {
    expect(explicitMinShotCount('I have provided approximately 61 hiking photos.')).toBe(61);
    expect(explicitMinShotCount('Use these 24 images for the montage.')).toBe(24);
    expect(explicitMinShotCount('Cut the 12 stills to the beat.')).toBe(12);
  });

  it('treats "use all N" as the floor it plainly is', () => {
    expect(explicitMinShotCount('Attempt to use all approximately 61 hiking photos.')).toBe(61);
    expect(explicitMinShotCount('Every one of the 40 shots must appear.')).toBe(40);
  });

  it('still refuses a photo count that is really a duration or a search pool', () => {
    expect(explicitMinShotCount('Hold each photo for 5 seconds')).toBeUndefined();
    expect(explicitMinShotCount('Gather 80 candidate photos, then cut the best')).toBeUndefined();
  });

  it('reads the whole captured brief as 61 photos over 20–35 seconds', () => {
    const brief = [
      'I have provided **approximately 61 hiking photos**.',
      '# FORMAT',
      'Create the final video for Instagram:',
      '**Aspect ratio:** 9:16 vertical',
      '**Frame rate:** 30fps',
      '**Resolution:** 1080 × 1920 or higher',
      '**Duration:** Approximately 20–35 seconds, depending on the selected music.',
      '# IMPORTANT. USE ALL PHOTOS INTELLIGENTLY',
      'Attempt to use **all approximately 61 hiking photos**.',
    ].join('\n\n');
    expect(checkableAcceptance(brief, 27.5)).toMatchObject({
      minShotCount: 61,
      durationSeconds: 27.5,
    });
  });
});
