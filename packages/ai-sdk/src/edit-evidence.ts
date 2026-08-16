/**
 * Frame-safe evidence normalization for edit decisions.
 *
 * Provider and engine observations arrive in seconds. Autonomous cutting must not
 * reason over arbitrary floating-point boundaries, so every word, silence, shot,
 * and visual event is converted to an explicit half-open integer-frame range.
 */
import { frameToSeconds, secondsToFrame } from './frame-time.js';

export type EditEvidenceKind = 'word' | 'silence' | 'shot' | 'visual-event';

export interface TimedEditObservation {
  readonly id: string;
  readonly kind: EditEvidenceKind;
  readonly assetId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text?: string;
  readonly label?: string;
  readonly confidence?: number;
}

export interface FrameEditObservation {
  readonly id: string;
  readonly kind: EditEvidenceKind;
  readonly assetId: string;
  /** Inclusive source frame. */
  readonly startFrame: number;
  /** Exclusive source frame. */
  readonly endFrame: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text?: string;
  readonly label?: string;
  readonly confidence?: number;
}

export interface SafeCutWindow {
  readonly afterWordId: string;
  readonly beforeWordId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly preferredFrame: number;
  readonly durationFrames: number;
}

function assertObservation(input: TimedEditObservation): void {
  if (!input.id.trim()) throw new RangeError('Evidence id must not be empty.');
  if (!input.assetId.trim()) throw new RangeError('Evidence assetId must not be empty.');
  if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0) {
    throw new RangeError('Evidence startSeconds must be finite and non-negative.');
  }
  if (!Number.isFinite(input.endSeconds) || input.endSeconds <= input.startSeconds) {
    throw new RangeError('Evidence endSeconds must be finite and greater than startSeconds.');
  }
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
  ) {
    throw new RangeError('Evidence confidence must be within [0, 1].');
  }
}

/**
 * Convert one provider observation to a conservative half-open frame range.
 * Start floors and end ceils so a retained word or event is never cut because of
 * rounding. The canonical seconds are then derived from those exact frames.
 */
export function normalizeEditObservation(
  input: TimedEditObservation,
  fps: number,
): FrameEditObservation {
  assertObservation(input);
  const startFrame = secondsToFrame(input.startSeconds, fps, 'floor');
  const endFrame = Math.max(startFrame + 1, secondsToFrame(input.endSeconds, fps, 'ceil'));
  return {
    id: input.id,
    kind: input.kind,
    assetId: input.assetId,
    startFrame,
    endFrame,
    startSeconds: frameToSeconds(startFrame, fps),
    endSeconds: frameToSeconds(endFrame, fps),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  };
}

/** Normalize, sort, and reject duplicate evidence ids for one media result. */
export function normalizeEditEvidence(
  observations: readonly TimedEditObservation[],
  fps: number,
): FrameEditObservation[] {
  const seen = new Set<string>();
  const normalized = observations.map((observation) => {
    if (seen.has(observation.id)) {
      throw new Error(`Duplicate evidence id "${observation.id}".`);
    }
    seen.add(observation.id);
    return normalizeEditObservation(observation, fps);
  });
  return normalized.sort(
    (left, right) =>
      left.startFrame - right.startFrame ||
      left.endFrame - right.endFrame ||
      left.id.localeCompare(right.id),
  );
}

/** True when an integer-frame cut would split the interior of a retained word. */
export function cutSplitsWord(cutFrame: number, words: readonly FrameEditObservation[]): boolean {
  if (!Number.isInteger(cutFrame) || cutFrame < 0) {
    throw new RangeError('cutFrame must be a non-negative integer.');
  }
  return words.some(
    (word) => word.kind === 'word' && cutFrame > word.startFrame && cutFrame < word.endFrame,
  );
}

/**
 * Build safe cut windows between adjacent retained words. A preferred cut is the
 * center of the gap, which preserves equal handles on both sides when possible.
 */
export function safeCutWindowsBetweenWords(
  words: readonly FrameEditObservation[],
  minimumGapFrames = 1,
): SafeCutWindow[] {
  if (!Number.isInteger(minimumGapFrames) || minimumGapFrames < 0) {
    throw new RangeError('minimumGapFrames must be a non-negative integer.');
  }
  const ordered = words
    .filter((word) => word.kind === 'word')
    /* v8 ignore next 4 -- the endFrame tie-break needs two words starting on the same
       frame, which overlapping speech does not produce in practice */
    .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
  const windows: SafeCutWindow[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const left = ordered[index - 1]!;
    const right = ordered[index]!;
    if (left.assetId !== right.assetId) continue;
    const durationFrames = right.startFrame - left.endFrame;
    if (durationFrames < minimumGapFrames) continue;
    windows.push({
      afterWordId: left.id,
      beforeWordId: right.id,
      startFrame: left.endFrame,
      endFrame: right.startFrame,
      preferredFrame: left.endFrame + Math.floor(durationFrames / 2),
      durationFrames,
    });
  }
  return windows;
}

/**
 * Resolve a desired cut to the nearest legal frame boundary without crossing a
 * retained word. Candidate boundaries include word edges plus silence, shot, and
 * visual-event edges. Returns undefined when no legal boundary exists.
 */
export function nearestSafeCutFrame(
  targetFrame: number,
  evidence: readonly FrameEditObservation[],
  maximumDistanceFrames = Number.POSITIVE_INFINITY,
): number | undefined {
  if (!Number.isInteger(targetFrame) || targetFrame < 0) {
    throw new RangeError('targetFrame must be a non-negative integer.');
  }
  if (maximumDistanceFrames < 0 || Number.isNaN(maximumDistanceFrames)) {
    throw new RangeError('maximumDistanceFrames must be non-negative.');
  }
  const words = evidence.filter((item) => item.kind === 'word');
  const candidates = new Set<number>();
  for (const item of evidence) {
    candidates.add(item.startFrame);
    candidates.add(item.endFrame);
  }
  const legal = [...candidates]
    .filter((candidate) => !cutSplitsWord(candidate, words))
    .map((candidate) => ({ candidate, distance: Math.abs(candidate - targetFrame) }))
    .filter(({ distance }) => distance <= maximumDistanceFrames)
    .sort((left, right) => left.distance - right.distance || left.candidate - right.candidate);
  return legal[0]?.candidate;
}

/** Select observations that overlap a half-open integer-frame range. */
export function evidenceOverlappingRange(
  evidence: readonly FrameEditObservation[],
  startFrame: number,
  endFrame: number,
): FrameEditObservation[] {
  if (!Number.isInteger(startFrame) || startFrame < 0) {
    throw new RangeError('startFrame must be a non-negative integer.');
  }
  if (!Number.isInteger(endFrame) || endFrame <= startFrame) {
    throw new RangeError('endFrame must be an integer greater than startFrame.');
  }
  return evidence.filter((item) => item.startFrame < endFrame && startFrame < item.endFrame);
}
