/**
 * @framepilot/ai-sdk/perceptual-thresholds — the numbers the two perceptual gates judge by,
 * in one place, each with the reason it is what it is.
 *
 * ## Why this file exists
 *
 * FramePilot polices "is this render actually watchable" in two places, and they used to
 * carry independent literals:
 *
 * - **Temporal review** (`temporal-review.ts`) measures the PRE-ENCODE composite through the
 *   render compiler, frame by frame, around every edit the agent made. It exists to catch a
 *   defect while the run can still act on it.
 * - **Export validation** (`engine/python/.../validation/render_validation.py`) measures the
 *   FINISHED FILE with ffmpeg after a real export. It exists to refuse shipping a broken
 *   deliverable.
 *
 * In a captured run those two produced what looked like a contradiction: the review failed an
 * audio window at `+0.089 dBFS` against a `-0.1` ceiling, while the export validator would
 * have passed the same programme (its ceiling is `+1.0`). Both numbers are correct for what
 * they measure — a PCM sum above 0 dBFS has already overflowed, whereas `volumedetect` on a
 * decoded AAC file legitimately reports sub-dB inter-sample overshoot — but nothing said so,
 * and nothing stopped one from being tuned without the other.
 *
 * So the values live here, together, with their stage stated. Two gates measuring two signals
 * may hold two numbers; what they may not do is hold them silently.
 * `engine/python/tests/test_perceptual_thresholds_parity.py` reads this file and fails if the
 * Python side drifts from it.
 */

/** Digital full scale. A pre-encode mix at or above this has already overflowed. */
const FULL_SCALE_DBFS = 0;

export interface PerceptualThreshold {
  /** The value the gate compares against. */
  readonly value: number;
  /** Which signal it is measured on — the two gates do not measure the same thing. */
  readonly stage: 'pre-encode composite' | 'encoded deliverable';
  /** Why this value and not a neighbouring one. */
  readonly because: string;
}

/**
 * Audio peak ceilings.
 *
 * `review` sits just under full scale: it reads the composited PCM window, where anything at
 * or above {@link FULL_SCALE_DBFS} is a mix that summed past the ceiling — a real defect the
 * run can still fix by staging gain. `export` sits above full scale because it reads a lossy
 * decode, where a clean master routinely measures a few tenths over; a `0.0` gate there
 * rejects good files.
 */
export const AUDIO_PEAK_DBFS = {
  review: {
    value: FULL_SCALE_DBFS - 0.1,
    stage: 'pre-encode composite',
    because:
      'The reviewed window is the composited PCM mix. At or above 0 dBFS it has already ' +
      'overflowed, so the ceiling sits one tenth of a dB below full scale.',
  },
  export: {
    value: FULL_SCALE_DBFS + 1,
    stage: 'encoded deliverable',
    because:
      'volumedetect reads a decoded AAC file, where a correct master shows sub-dB ' +
      'inter-sample overshoot. +1 dBFS absorbs codec overshoot and still catches overflow.',
  },
} as const satisfies Record<string, PerceptualThreshold>;

/** How far below full scale a boundary level jump may be before it reads as a click/pop. */
export const MAX_AUDIO_BOUNDARY_JUMP_DB = 12;

/**
 * Black-frame ceilings.
 *
 * `review` is per FRAME: one near-black frame inside an edit boundary is a visible flash, and
 * a flash is exactly what a per-frame reader exists to catch. `export` is a FRACTION OF THE
 * WHOLE RENDER: the deliverable gate's job is to refuse a programme that is essentially black
 * end to end, not to reject a legitimate dark scene or a fade to black.
 */
export const BLACK_FRAME = {
  /** A single sampled frame at or above this black ratio is reported by the review. */
  reviewFrameRatio: {
    value: 0.98,
    stage: 'pre-encode composite',
    because:
      'A frame this black inside an edit boundary is a visible flash. Sampled per frame, so ' +
      'it must not tolerate one.',
  },
  /** This fraction of the whole render being black fails the export. */
  exportDurationRatio: {
    value: 0.95,
    stage: 'encoded deliverable',
    because:
      'The deliverable gate refuses an essentially-black programme. Not 1.0 because ' +
      'blackdetect undercounts the final frame; well under 1.0 would reject dark scenes.',
  },
} as const satisfies Record<string, PerceptualThreshold>;
