import { describe, expect, it } from 'vitest';
import {
  BASELINE_FIXTURE_FPS,
  BASELINE_TARGET_DURATION_FRAMES,
  assessAutonomousEditGolden,
  type AutonomousEditGoldenFixture,
} from './autonomous-edit-golden.js';

const passingFixture = (): AutonomousEditGoldenFixture => ({
  fps: BASELINE_FIXTURE_FPS,
  targetDurationFrames: BASELINE_TARGET_DURATION_FRAMES,
  clips: [
    { id: 'clip-a', trackId: 'video-1', startFrame: 0, endFrame: 450 },
    { id: 'clip-b', trackId: 'video-1', startFrame: 450, endFrame: 900 },
  ],
  words: [
    { id: 'word-a', startFrame: 30, endFrame: 45, retained: true },
    { id: 'word-b', startFrame: 460, endFrame: 480, retained: true },
  ],
  captions: [
    { id: 'caption-a', startFrame: 30, endFrame: 45, wordIds: ['word-a'] },
    { id: 'caption-b', startFrame: 460, endFrame: 480, wordIds: ['word-b'] },
  ],
  transitions: [
    {
      id: 'transition-a',
      leftClipId: 'clip-a',
      rightClipId: 'clip-b',
      durationFrames: 8,
      leftHandleFrames: 12,
      rightHandleFrames: 12,
    },
  ],
  appliedOperationCount: 4,
  previewRevision: 2,
  renderRevision: 2,
  visualEvidenceCount: 2,
  undoRestoredOriginal: true,
});

describe('assessAutonomousEditGolden', () => {
  it('accepts a frame-precise, reversible 30-second edit', () => {
    const assessment = assessAutonomousEditGolden(passingFixture());

    expect(assessment).toEqual({
      passed: true,
      actualDurationFrames: BASELINE_TARGET_DURATION_FRAMES,
      failures: [],
    });
  });

  it('reports deterministic edit-quality failures without hiding later issues', () => {
    const fixture = passingFixture();
    const assessment = assessAutonomousEditGolden({
      ...fixture,
      clips: [
        { id: 'clip-a', trackId: 'video-1', startFrame: 0, endFrame: 500 },
        { id: 'clip-b', trackId: 'video-1', startFrame: 450, endFrame: 890 },
      ],
      words: [{ id: 'word-cut', startFrame: 895, endFrame: 905, retained: true }],
      captions: [{ id: 'caption-cut', startFrame: 880, endFrame: 889, wordIds: ['word-cut'] }],
      transitions: [
        {
          id: 'transition-bad',
          leftClipId: 'clip-a',
          rightClipId: 'clip-b',
          durationFrames: 20,
          leftHandleFrames: 5,
          rightHandleFrames: 5,
        },
      ],
      appliedOperationCount: 0,
      previewRevision: 2,
      renderRevision: 3,
      visualEvidenceCount: 0,
      undoRestoredOriginal: false,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        'no_applied_edit',
        'unintended_overlap',
        'retained_word_cut',
        'caption_misaligned',
        'invalid_transition',
        'target_duration_missed',
        'preview_render_revision_mismatch',
        'visual_evidence_missing',
        'undo_not_grouped',
      ]),
    );
  });

  it('rejects transitions that exceed either adjacent clip handle', () => {
    const fixture = passingFixture();
    const assessment = assessAutonomousEditGolden({
      ...fixture,
      transitions: [
        {
          id: 'transition-long',
          leftClipId: 'clip-a',
          rightClipId: 'clip-b',
          durationFrames: 14,
          leftHandleFrames: 20,
          rightHandleFrames: 8,
        },
      ],
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.failures).toContainEqual({
      code: 'transition_handle_too_short',
      message: 'Transition transition-long exceeds an available clip handle.',
      subjectId: 'transition-long',
    });
  });
});
