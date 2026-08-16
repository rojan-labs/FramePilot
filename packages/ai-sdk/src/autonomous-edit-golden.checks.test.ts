/**
 * The autonomous-edit acceptance contract.
 *
 * Each failure code below is a way an edit can look finished and be wrong: a word clipped
 * mid-syllable, a caption drifting off its speech, a transition longer than the handle it
 * has to cross-fade into, a preview that showed the editor a different revision than the
 * one rendered. So every code is exercised, and each test states what the user would see
 * if the check were missing.
 */
import { describe, expect, it } from 'vitest';
import {
  BASELINE_FIXTURE_FPS,
  BASELINE_TARGET_DURATION_FRAMES,
  assessAutonomousEditGolden,
  type AutonomousEditGoldenFixture,
  type GoldenFailureCode,
} from './autonomous-edit-golden.js';

/** A fixture that passes every check; each test breaks exactly one thing. */
const passing = (over: Partial<AutonomousEditGoldenFixture> = {}): AutonomousEditGoldenFixture => ({
  fps: BASELINE_FIXTURE_FPS,
  targetDurationFrames: 100,
  clips: [
    { id: 'c1', trackId: 'v1', startFrame: 0, endFrame: 50 },
    { id: 'c2', trackId: 'v1', startFrame: 50, endFrame: 100 },
  ],
  words: [{ id: 'w1', startFrame: 5, endFrame: 20, retained: true }],
  captions: [{ id: 'cap1', wordIds: ['w1'], startFrame: 5, endFrame: 20 }],
  transitions: [
    {
      id: 't1',
      leftClipId: 'c1',
      rightClipId: 'c2',
      durationFrames: 5,
      leftHandleFrames: 10,
      rightHandleFrames: 10,
    },
  ],
  appliedOperationCount: 3,
  previewRevision: 7,
  renderRevision: 7,
  visualEvidenceCount: 2,
  undoRestoredOriginal: true,
  ...over,
});

const codes = (fixture: AutonomousEditGoldenFixture): GoldenFailureCode[] =>
  assessAutonomousEditGolden(fixture).failures.map((failure) => failure.code);

describe('a correct edit passes', () => {
  it('reports passed with no failures and the measured duration', () => {
    const assessment = assessAutonomousEditGolden(passing());
    expect(assessment.passed).toBe(true);
    expect(assessment.failures).toEqual([]);
    expect(assessment.actualDurationFrames).toBe(100);
  });

  it('exposes the baseline constants the fixtures are written against', () => {
    expect(BASELINE_FIXTURE_FPS).toBe(30);
    expect(BASELINE_TARGET_DURATION_FRAMES).toBe(900);
  });
});

describe('structural checks', () => {
  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'flags invalid_fps for fps %j',
    (fps) => {
      expect(codes(passing({ fps }))).toContain('invalid_fps');
    },
  );

  it('flags no_applied_edit when the run changed nothing', () => {
    // A "successful" run that applied zero operations is the fabricated-✅ failure mode.
    expect(codes(passing({ appliedOperationCount: 0 }))).toContain('no_applied_edit');
  });

  it.each([
    ['a non-integer start', { startFrame: 0.5, endFrame: 50 }],
    ['a negative start', { startFrame: -1, endFrame: 50 }],
    ['an end at the start', { startFrame: 10, endFrame: 10 }],
    ['an end before the start', { startFrame: 20, endFrame: 10 }],
  ])('flags invalid_clip_range for %s', (_label, range) => {
    expect(
      codes(passing({ clips: [{ id: 'c1', trackId: 'v1', ...range }], transitions: [] })),
    ).toContain('invalid_clip_range');
  });

  it('does not count an invalid clip toward the measured duration', () => {
    const assessment = assessAutonomousEditGolden(
      passing({
        clips: [{ id: 'c1', trackId: 'v1', startFrame: 0, endFrame: -5 }],
        transitions: [],
      }),
    );
    expect(assessment.actualDurationFrames).toBe(0);
  });
});

describe('overlap', () => {
  it('flags unintended_overlap between adjacent clips on one track', () => {
    expect(
      codes(
        passing({
          clips: [
            { id: 'c1', trackId: 'v1', startFrame: 0, endFrame: 60 },
            { id: 'c2', trackId: 'v1', startFrame: 50, endFrame: 100 },
          ],
          transitions: [],
        }),
      ),
    ).toContain('unintended_overlap');
  });

  it('allows an overlap either side declared intentional', () => {
    // A cross-dissolve IS an overlap; flagging it would make every transition a failure.
    for (const which of ['left', 'right'] as const) {
      const clips = [
        {
          id: 'c1',
          trackId: 'v1',
          startFrame: 0,
          endFrame: 60,
          ...(which === 'left' ? { allowOverlap: true } : {}),
        },
        {
          id: 'c2',
          trackId: 'v1',
          startFrame: 50,
          endFrame: 100,
          ...(which === 'right' ? { allowOverlap: true } : {}),
        },
      ];
      expect(codes(passing({ clips, transitions: [] }))).not.toContain('unintended_overlap');
    }
  });

  it('does not compare clips across different tracks', () => {
    expect(
      codes(
        passing({
          clips: [
            { id: 'c1', trackId: 'v1', startFrame: 0, endFrame: 100 },
            { id: 'c2', trackId: 'v2', startFrame: 0, endFrame: 100 },
          ],
          transitions: [],
        }),
      ),
    ).not.toContain('unintended_overlap');
  });
});

describe('speech and captions', () => {
  it('flags retained_word_cut when a kept word falls outside every clip', () => {
    // The audible symptom: a word clipped mid-syllable.
    expect(
      codes(passing({ words: [{ id: 'w1', startFrame: 200, endFrame: 220, retained: true }] })),
    ).toContain('retained_word_cut');
  });

  it('ignores words the edit deliberately removed', () => {
    expect(
      codes(passing({ words: [{ id: 'w1', startFrame: 200, endFrame: 220, retained: false }] })),
    ).not.toContain('retained_word_cut');
  });

  it('flags caption_missing_word when a cue cites a word that was cut', () => {
    expect(
      codes(
        passing({ captions: [{ id: 'cap1', wordIds: ['gone'], startFrame: 5, endFrame: 20 }] }),
      ),
    ).toContain('caption_missing_word');
  });

  it.each([
    ['drifting more than a frame early', { startFrame: 0, endFrame: 20 }],
    ['drifting more than a frame late', { startFrame: 5, endFrame: 30 }],
    ['a non-integer boundary', { startFrame: 5.5, endFrame: 20 }],
    ['a zero-length cue', { startFrame: 5, endFrame: 5 }],
  ])('flags caption_misaligned for %s', (_label, range) => {
    expect(codes(passing({ captions: [{ id: 'cap1', wordIds: ['w1'], ...range }] }))).toContain(
      'caption_misaligned',
    );
  });

  it('allows a one-frame rounding difference, which is normal', () => {
    expect(
      codes(passing({ captions: [{ id: 'cap1', wordIds: ['w1'], startFrame: 6, endFrame: 21 }] })),
    ).not.toContain('caption_misaligned');
  });

  it('accepts a cue that cites no words at all', () => {
    expect(
      codes(passing({ captions: [{ id: 'cap1', wordIds: [], startFrame: 5, endFrame: 20 }] })),
    ).not.toContain('caption_misaligned');
  });

  it('aligns a multi-word cue to its first and last word', () => {
    expect(
      codes(
        passing({
          words: [
            { id: 'w1', startFrame: 5, endFrame: 10, retained: true },
            { id: 'w2', startFrame: 12, endFrame: 20, retained: true },
          ],
          captions: [{ id: 'cap1', wordIds: ['w2', 'w1'], startFrame: 5, endFrame: 20 }],
        }),
      ),
    ).not.toContain('caption_misaligned');
  });
});

describe('transitions', () => {
  it.each([
    ['an unknown left clip', { leftClipId: 'nope' }],
    ['an unknown right clip', { rightClipId: 'nope' }],
    ['a zero duration', { durationFrames: 0 }],
    ['a non-integer duration', { durationFrames: 1.5 }],
  ])('flags invalid_transition for %s', (_label, over) => {
    const base = passing();
    expect(codes(passing({ transitions: [{ ...base.transitions[0]!, ...over }] }))).toContain(
      'invalid_transition',
    );
  });

  it('flags invalid_transition when the clips are not adjacent', () => {
    expect(
      codes(
        passing({
          clips: [
            { id: 'c1', trackId: 'v1', startFrame: 0, endFrame: 40 },
            { id: 'c2', trackId: 'v1', startFrame: 50, endFrame: 100 },
          ],
        }),
      ),
    ).toContain('invalid_transition');
  });

  it.each([
    ['the left handle', { leftHandleFrames: 2 }],
    ['the right handle', { rightHandleFrames: 2 }],
  ])('flags transition_handle_too_short when it exceeds %s', (_label, over) => {
    const base = passing();
    expect(codes(passing({ transitions: [{ ...base.transitions[0]!, ...over }] }))).toContain(
      'transition_handle_too_short',
    );
  });
});

describe('run-level checks', () => {
  it('flags target_duration_missed beyond the tolerance', () => {
    expect(codes(passing({ targetDurationFrames: 200 }))).toContain('target_duration_missed');
  });

  it('allows a one-frame miss by default', () => {
    expect(codes(passing({ targetDurationFrames: 101 }))).not.toContain('target_duration_missed');
  });

  it('honours an explicit tolerance', () => {
    expect(
      codes(passing({ targetDurationFrames: 110, durationToleranceFrames: 10 })),
    ).not.toContain('target_duration_missed');
  });

  it('flags preview_render_revision_mismatch', () => {
    // The editor approved what they SAW. Rendering a different revision means they
    // approved something other than what shipped.
    expect(codes(passing({ renderRevision: 8 }))).toContain('preview_render_revision_mismatch');
  });

  it('flags visual_evidence_missing', () => {
    expect(codes(passing({ visualEvidenceCount: 0 }))).toContain('visual_evidence_missing');
  });

  it('flags undo_not_grouped', () => {
    // One Undo must restore the original: an autonomous run the user cannot cleanly
    // reverse is worse than one that did nothing.
    expect(codes(passing({ undoRestoredOriginal: false }))).toContain('undo_not_grouped');
  });
});

describe('failure reporting', () => {
  it('reports EVERY failure, not just the first', () => {
    const assessment = assessAutonomousEditGolden(
      passing({ fps: 0, appliedOperationCount: 0, visualEvidenceCount: 0 }),
    );
    expect(assessment.failures.length).toBeGreaterThanOrEqual(3);
    expect(assessment.passed).toBe(false);
  });

  it('attaches the offending subject id where there is one', () => {
    const assessment = assessAutonomousEditGolden(
      passing({ words: [{ id: 'w9', startFrame: 500, endFrame: 520, retained: true }] }),
    );
    expect(assessment.failures.find((f) => f.code === 'retained_word_cut')?.subjectId).toBe('w9');
  });

  it('omits subjectId for run-level failures rather than inventing one', () => {
    const assessment = assessAutonomousEditGolden(passing({ visualEvidenceCount: 0 }));
    const failure = assessment.failures.find((f) => f.code === 'visual_evidence_missing');
    expect(failure).not.toHaveProperty('subjectId');
  });
});
