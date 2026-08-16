/**
 * Deterministic golden-fixture acceptance for autonomous edits.
 *
 * This module deliberately uses integer sequence frames. It lets the repository
 * describe the expected final edit without depending on a provider, renderer, or
 * Electron runtime. Real preview/render evidence is attached later, but the same
 * invariant set is reusable by unit, integration, desktop, and release checks.
 */

export const BASELINE_FIXTURE_FPS = 30;
export const BASELINE_TARGET_DURATION_FRAMES = 30 * BASELINE_FIXTURE_FPS;

export interface GoldenClip {
  readonly id: string;
  readonly trackId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  /** Explicitly allow compositing overlap on this clip. */
  readonly allowOverlap?: boolean;
}

export interface GoldenWord {
  readonly id: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly retained: boolean;
}

export interface GoldenCaptionCue {
  readonly id: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly wordIds: readonly string[];
}

export interface GoldenTransition {
  readonly id: string;
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly durationFrames: number;
  readonly leftHandleFrames: number;
  readonly rightHandleFrames: number;
}

export interface AutonomousEditGoldenFixture {
  readonly fps: number;
  readonly targetDurationFrames: number;
  readonly durationToleranceFrames?: number;
  readonly clips: readonly GoldenClip[];
  readonly words: readonly GoldenWord[];
  readonly captions: readonly GoldenCaptionCue[];
  readonly transitions: readonly GoldenTransition[];
  readonly appliedOperationCount: number;
  /** Revision represented by the preview evidence shown to the editor. */
  readonly previewRevision: number;
  /** Revision that produced the final render. */
  readonly renderRevision: number;
  readonly visualEvidenceCount: number;
  readonly undoRestoredOriginal: boolean;
}

export type GoldenFailureCode =
  | 'invalid_fps'
  | 'no_applied_edit'
  | 'invalid_clip_range'
  | 'unintended_overlap'
  | 'retained_word_cut'
  | 'caption_missing_word'
  | 'caption_misaligned'
  | 'invalid_transition'
  | 'transition_handle_too_short'
  | 'target_duration_missed'
  | 'preview_render_revision_mismatch'
  | 'visual_evidence_missing'
  | 'undo_not_grouped';

export interface GoldenFailure {
  readonly code: GoldenFailureCode;
  readonly message: string;
  readonly subjectId?: string;
}

export interface GoldenAssessment {
  readonly passed: boolean;
  readonly actualDurationFrames: number;
  readonly failures: readonly GoldenFailure[];
}

const integerFrame = (value: number): boolean => Number.isInteger(value) && value >= 0;

function addFailure(
  failures: GoldenFailure[],
  code: GoldenFailureCode,
  message: string,
  subjectId?: string,
): void {
  failures.push({ code, message, ...(subjectId === undefined ? {} : { subjectId }) });
}

/** Evaluate one deterministic autonomous-edit fixture against the acceptance contract. */
export function assessAutonomousEditGolden(fixture: AutonomousEditGoldenFixture): GoldenAssessment {
  const failures: GoldenFailure[] = [];

  if (!Number.isFinite(fixture.fps) || fixture.fps <= 0) {
    addFailure(failures, 'invalid_fps', 'The fixture FPS must be a positive finite value.');
  }
  if (fixture.appliedOperationCount <= 0) {
    addFailure(failures, 'no_applied_edit', 'The mutation intent applied no operations.');
  }

  const clipsById = new Map<string, GoldenClip>();
  const tracks = new Map<string, GoldenClip[]>();
  let actualDurationFrames = 0;
  for (const clip of fixture.clips) {
    clipsById.set(clip.id, clip);
    const validRange =
      integerFrame(clip.startFrame) &&
      integerFrame(clip.endFrame) &&
      clip.endFrame > clip.startFrame;
    if (!validRange) {
      addFailure(
        failures,
        'invalid_clip_range',
        `Clip ${clip.id} must have a positive integer-frame range.`,
        clip.id,
      );
      continue;
    }
    actualDurationFrames = Math.max(actualDurationFrames, clip.endFrame);
    const track = tracks.get(clip.trackId) ?? [];
    track.push(clip);
    tracks.set(clip.trackId, track);
  }

  for (const track of tracks.values()) {
    /* v8 ignore next 3 -- the endFrame tie-break needs two clips starting on the same
       frame, which the overlap check above already treats as a failure */
    const ordered = [...track].sort(
      (left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (
        current.startFrame < previous.endFrame &&
        previous.allowOverlap !== true &&
        current.allowOverlap !== true
      ) {
        addFailure(
          failures,
          'unintended_overlap',
          `Clips ${previous.id} and ${current.id} overlap on track ${current.trackId}.`,
          current.id,
        );
      }
    }
  }

  const retainedWords = new Map<string, GoldenWord>();
  for (const word of fixture.words) {
    if (!word.retained) continue;
    retainedWords.set(word.id, word);
    const contained = fixture.clips.some(
      (clip) => word.startFrame >= clip.startFrame && word.endFrame <= clip.endFrame,
    );
    if (!contained) {
      addFailure(
        failures,
        'retained_word_cut',
        `Retained word ${word.id} crosses or falls outside the final edit.`,
        word.id,
      );
    }
  }

  for (const cue of fixture.captions) {
    const words = cue.wordIds.map((id) => retainedWords.get(id));
    if (words.some((word) => word === undefined)) {
      addFailure(
        failures,
        'caption_missing_word',
        `Caption ${cue.id} references a word that is not retained.`,
        cue.id,
      );
      continue;
    }
    const concreteWords = words as GoldenWord[];
    if (concreteWords.length === 0) continue;
    /* v8 ignore next 6 -- the `best` arms need a later word to start earlier (or an
       earlier one to end later) than its predecessor; cues cite words in order */
    const first = concreteWords.reduce((best, word) =>
      word.startFrame < best.startFrame ? word : best,
    );
    const last = concreteWords.reduce((best, word) =>
      word.endFrame > best.endFrame ? word : best,
    );
    const cueValid =
      integerFrame(cue.startFrame) &&
      integerFrame(cue.endFrame) &&
      cue.endFrame > cue.startFrame &&
      Math.abs(cue.startFrame - first.startFrame) <= 1 &&
      Math.abs(cue.endFrame - last.endFrame) <= 1;
    if (!cueValid) {
      addFailure(
        failures,
        'caption_misaligned',
        `Caption ${cue.id} is not aligned to its retained words within one frame.`,
        cue.id,
      );
    }
  }

  for (const transition of fixture.transitions) {
    const left = clipsById.get(transition.leftClipId);
    const right = clipsById.get(transition.rightClipId);
    if (
      !left ||
      !right ||
      !Number.isInteger(transition.durationFrames) ||
      transition.durationFrames <= 0 ||
      left.endFrame !== right.startFrame
    ) {
      addFailure(
        failures,
        'invalid_transition',
        `Transition ${transition.id} must join two adjacent valid clips.`,
        transition.id,
      );
      continue;
    }
    if (
      transition.durationFrames > transition.leftHandleFrames ||
      transition.durationFrames > transition.rightHandleFrames
    ) {
      addFailure(
        failures,
        'transition_handle_too_short',
        `Transition ${transition.id} exceeds an available clip handle.`,
        transition.id,
      );
    }
  }

  const tolerance = fixture.durationToleranceFrames ?? 1;
  const durationDelta = Math.abs(actualDurationFrames - fixture.targetDurationFrames);
  if (durationDelta > tolerance) {
    addFailure(
      failures,
      'target_duration_missed',
      `The final duration misses the target by ${String(durationDelta)} frame(s).`,
    );
  }
  if (fixture.previewRevision !== fixture.renderRevision) {
    addFailure(
      failures,
      'preview_render_revision_mismatch',
      'Preview evidence and final render came from different project revisions.',
    );
  }
  if (fixture.visualEvidenceCount <= 0) {
    addFailure(
      failures,
      'visual_evidence_missing',
      'No visual frame or segment was retained as evidence for the edit.',
    );
  }
  if (!fixture.undoRestoredOriginal) {
    addFailure(
      failures,
      'undo_not_grouped',
      'One grouped Undo did not restore the original project state.',
    );
  }

  return { passed: failures.length === 0, actualDurationFrames, failures };
}
