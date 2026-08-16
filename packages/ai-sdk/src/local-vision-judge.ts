/**
 * A local, deterministic vision reviewer backed by the Subject Intelligence pack.
 *
 * ## What this is, and what it deliberately is not
 *
 * The vision reviewer exists for semantic questions a measurement cannot settle.
 * Most of those genuinely need a vision-language model: whether a transition
 * reads, whether a grade looks like the same room, whether a mask spills. This
 * reviewer answers **none** of those.
 *
 * What it does answer is the one family a detector can settle honestly: *framing*.
 * "Is the subject still in frame after the move?" and "did the crop cut someone's
 * head off?" are questions about where a person is in the picture, and a face and
 * person detector knows where people are. Answering those locally means the
 * commonest semantic objectives can be confirmed on a laptop with no cloud call,
 * no media egress, and no per-check billing.
 *
 * Everything else returns `cannot_tell`, which settles as *unverified* and fails
 * the gate that asked. That is the correct outcome: a detector that guessed at
 * "does this transition read?" would be inventing an answer, and an invented pass
 * is exactly what lets a bad edit commit.
 *
 * ## Why it can fail an edit
 *
 * A detected subject whose box runs off the edge of the frame is genuinely cut
 * off, and that is reported as `fail` naming the frame. But *finding nobody* is
 * `cannot_tell`, never `fail`: an empty result means the detector saw no person,
 * which is not the same as the person having left — the shot may simply not be of
 * a person at all.
 */
import { createLogger } from '@framepilot/shared-types';
import type { VisionFrame, VisionJudge, VisionVerdict } from './vision-review.js';

const log = createLogger('ai-sdk:local-vision-judge');

/** One detection from the pack, in normalized frame coordinates. */
export interface LocalDetection {
  readonly label: 'face' | 'person' | 'object';
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly confidence: number;
}

/** Runs `subject.detect` over one composited frame. Supplied by the host. */
export type LocalSubjectDetector = (frame: VisionFrame) => Promise<readonly LocalDetection[]>;

/**
 * Objective kinds this reviewer will answer.
 *
 * Request ids are `${patchId}:${kind}:${clipId}`, so the kind is read from the
 * id rather than guessed from the wording of the question.
 */
export const LOCALLY_ANSWERABLE_KINDS: readonly string[] = ['motion-framing', 'crop-framing'];

/**
 * How close to the edge a subject may sit before it counts as cut off.
 *
 * Not zero: detector boxes are approximate, and a subject legitimately standing
 * at the edge of frame would otherwise read as cropped on every shot.
 */
export const EDGE_TOLERANCE = 0.004;

/** Detections below this are not confident enough to fail somebody's edit on. */
export const MIN_SUBJECT_CONFIDENCE = 0.5;

function kindOf(requestId: string): string {
  const parts = requestId.split(':');
  return parts.length >= 2 ? parts[parts.length - 2]! : '';
}

function isClipped(detection: LocalDetection): readonly string[] {
  const { x, y, width, height } = detection.box;
  const edges: string[] = [];
  if (x <= EDGE_TOLERANCE) edges.push('left');
  if (y <= EDGE_TOLERANCE) edges.push('top');
  if (x + width >= 1 - EDGE_TOLERANCE) edges.push('right');
  if (y + height >= 1 - EDGE_TOLERANCE) edges.push('bottom');
  return edges;
}

/**
 * Build a {@link VisionJudge} that answers framing objectives from real detections.
 *
 * @param detect - Runs the Subject Intelligence pack over one frame.
 */
export function createLocalVisionJudge(detect: LocalSubjectDetector): VisionJudge {
  return async ({ frames, requestId }): Promise<VisionVerdict> => {
    const kind = kindOf(requestId);
    if (!LOCALLY_ANSWERABLE_KINDS.includes(kind)) {
      return {
        verdict: 'cannot_tell',
        reason: `The local reviewer answers framing questions only, not "${kind}".`,
      };
    }

    let sawSubject = false;
    for (const frame of frames) {
      let detections: readonly LocalDetection[];
      try {
        detections = await detect(frame);
      } catch (error) {
        log.warn('Local subject detection failed', { requestId, frame: frame.frame });
        return {
          verdict: 'cannot_tell',
          reason: `Subject detection failed on frame ${String(frame.frame)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      // Faces are the reliable framing signal: a person box legitimately runs off
      // the bottom of frame in almost every medium shot, so failing on that would
      // fail nearly every correct edit.
      const faces = detections.filter(
        (detection) => detection.label === 'face' && detection.confidence >= MIN_SUBJECT_CONFIDENCE,
      );
      if (faces.length === 0) continue;
      sawSubject = true;
      for (const face of faces) {
        const edges = isClipped(face);
        if (edges.length > 0) {
          return {
            verdict: 'fail',
            reason: `A subject is cut off at the ${edges.join(' and ')} edge of frame.`,
            frame: frame.frame,
          };
        }
      }
    }

    if (!sawSubject) {
      // Not a failure. No detected person is not proof of bad framing — it may
      // simply not be a shot of a person.
      return {
        verdict: 'cannot_tell',
        reason: 'No recognizable subject was found in the sampled frames.',
      };
    }
    return {
      verdict: 'pass',
      reason: 'Every detected subject stayed clear of the frame edges.',
    };
  };
}
