/**
 * @framepilot/ai-sdk/assemble — turn typed operations into a reviewable patch.
 *
 * This is the single source of patch-assembly truth (AGENTS.md invariant 5): a
 * caller that has produced typed operations turns them into a Patch, runs the
 * patch validator, and only when valid computes a before/after project diff.
 */
import { asId, createLogger } from '@framepilot/shared-types';
import {
  type AnyOperation,
  type Patch,
  type PatchAuthor,
  type TimelineDiff,
  type ValidationIssue,
  type ValidationResult,
  PatchError,
  applyProjectPatch,
  assertOperationContract,
  diffProject,
  isProjectOperation,
  validatePatch,
} from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { describeOperation } from './describe.js';
import { normalizeOperationTimes, operationTimeChanged } from './frame-time.js';

const log = createLogger('ai-sdk:assemble');

export interface EditResult {
  readonly patch: Patch;
  readonly validation: ValidationResult;
  readonly diff?: TimelineDiff;
  readonly text: string;
}

/** Deterministic patch id from operation content (no clock/random). */
export function patchIdFor(operations: readonly AnyOperation[]): string {
  const json = JSON.stringify(operations);
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) hash = (hash * 33) ^ json.charCodeAt(i);
  return `patch_${(hash >>> 0).toString(16)}`;
}

function validationContext(project: Project): {
  readonly assetIds: readonly string[];
  readonly folders: Project['folders'];
  readonly markers: Project['markers'];
} {
  return {
    assetIds: project.assets.map((asset) => asset.id),
    folders: project.folders,
    markers: project.markers,
  };
}

/** The first operation the semantic contract refused, and why. */
interface ContractRejection {
  readonly operationIndex: number;
  readonly reason: string;
}

/**
 * Replay the semantic operation contracts against the speculative state in operation
 * order, returning the FIRST rejection together with the index of the operation that
 * caused it.
 *
 * Raw operations are checked before frame normalization so quantization can never repair
 * invalid intent. `applyProjectPatch` independently enforces the same contract as the
 * canonical final authority; the explicit replay here exists to return an ordinary invalid
 * edit result instead of making assembly throw.
 *
 * The index is the point of replaying one operation at a time, not a by-product of it: a
 * caption pass builds one operation per cue, so a reason without a position is the same
 * sentence for every cue in the patch. See {@link describeValidationIssue}.
 */
function firstContractRejection(
  project: Project,
  operations: readonly AnyOperation[],
): ContractRejection | undefined {
  let working = project;
  for (const [operationIndex, operation] of operations.entries()) {
    try {
      if (!isProjectOperation(operation)) assertOperationContract(working.timeline, operation);
      working = applyProjectPatch(working, {
        patchId: asId<'PatchId'>(patchIdFor([operation])),
        createdBy: 'agent',
        reason: 'Contract replay',
        operations: [operation],
      });
    } catch (cause) {
      return { operationIndex, reason: contractRejectionMessage(cause) };
    }
  }
  return undefined;
}

function contractFailure(rejection: ContractRejection): ValidationResult {
  return {
    valid: false,
    issues: [
      {
        code: 'unsupported_operation',
        severity: 'error',
        message: rejection.reason,
        // Carried, not formatted in: every consumer of a ValidationResult decides how to
        // render a location, and the structural validator already populates this field.
        operationIndex: rejection.operationIndex,
      },
    ],
  };
}

function validateContracts(
  project: Project,
  operations: readonly AnyOperation[],
  patch: Patch,
  reason: string,
): EditResult | undefined {
  const rejection = firstContractRejection(project, operations);
  if (!rejection) return undefined;
  log.warn('assembleEdit → operation contract rejected patch', {
    message: rejection.reason,
    operationIndex: rejection.operationIndex,
    operations: operations.length,
  });
  return { patch, validation: contractFailure(rejection), text: reason };
}

/**
 * The reason an editor should read, not the envelope the replay threw it in.
 *
 * The contract replay applies each operation through the canonical patch authority, so a
 * rejection arrives wrapped as `Patch <id> failed at operation <n>: <reason>`. That id and
 * index are internal — the replay is one operation at a time, so the wrapped index is
 * always 0 — and this message reaches the user and the model verbatim. Both are better
 * served by "Clip not found: intro" than by a hash they cannot act on. The index that DOES
 * locate the operation is the replay loop's own, captured by {@link firstContractRejection}.
 */
function contractRejectionMessage(cause: unknown): string {
  const unwrapped = cause instanceof PatchError ? cause.cause : cause;
  /* v8 ignore next -- the contract and patch authorities always reject with Errors. */
  return unwrapped instanceof Error ? unwrapped.message : String(unwrapped);
}

/**
 * Point the reader at the operation an issue came from:
 * `op 49 of 126 (add_caption_layer, 18.067s–18.067s): <reason>`.
 *
 * A rejected patch reaches the model as one string. When a caption pass built 126
 * operations and a single cue was degenerate, that string was "add_caption_layer.end must
 * be greater than start." — true, and identical for all 63 cues in the batch. With no way
 * to tell which one was meant, the model reissued the call four times and spent ~10 of the
 * run's 18 model calls re-submitting 584 operations that were rejected the same way. The
 * index existed at both the contract and structural gates and was discarded on the way
 * out; this restores it, which is also what `add_clips` already promises the model when it
 * says a rejection "names the entry".
 *
 * The position is 1-based and phrased "of N": it is read as a place in a list the author
 * can count off, not as an array offset.
 *
 * Identity is appended only when the reason does not already open with the operation type
 * — the semantic contract's messages do (`add_caption_layer.end must …`), and naming it
 * twice costs tokens and reads as two separate facts.
 *
 * @param issue - A validation issue, with or without `operationIndex`.
 * @param operations - The operations the issue was raised against, in patch order.
 * @returns The issue message, prefixed with its location when one can be resolved.
 */
export function describeValidationIssue(
  issue: ValidationIssue,
  operations: readonly AnyOperation[],
): string {
  const index = issue.operationIndex;
  if (index === undefined) return issue.message;
  const operation = operations[index];
  // An issue can outlive the operation list it was raised against (a caller that re-reads a
  // stored result against a different patch). Say only what is still true.
  if (!operation) return issue.message;
  const position = `op ${String(index + 1)} of ${String(operations.length)}`;
  if (issue.message.startsWith(operation.type)) return `${position}: ${issue.message}`;
  const { detail } = describeOperation(operation);
  const identity = detail ? `${operation.type}, ${detail}` : operation.type;
  return `${position} (${identity}): ${issue.message}`;
}

/**
 * Build, normalize, validate, and diff a patch from typed operations.
 *
 * Ordering is deliberate:
 * 1. semantic contract on RAW intent — what the model MEANT (wipe guards, referents);
 * 2. frame quantization;
 * 3. semantic + structural validation on normalized values;
 * 4. canonical project apply + canonical project diff.
 *
 * ## Why structural validation waits for the grid
 *
 * There used to be a structural pass on raw intent as step 2, so an invalid edit was
 * reported in the model's own numbers before snapping could move them. The trouble is what
 * it compared: the timeline is ALWAYS on the grid (nothing is applied before
 * `quantizePatch`), so validating an ungridded operation against it measures a discrepancy
 * that does not survive to the thing being validated.
 *
 * That is not theoretical. A turn placing abutting clips on detected beats — 0→0.75,
 * 0.75→1.75 at 30fps — had its second call rejected for overlapping its first: 0.75s is
 * frame 22.5, clip one's end had already snapped to frame 23, and the raw 0.75 now sat
 * inside it. Both times snap to frame 23 and abut exactly. The seam was between raw and
 * normalized, never between the two clips.
 *
 * Snapping cannot repair a real defect into validity: it moves a value by less than half a
 * frame, so the only "overlap" it can remove is one smaller than a frame — which is not an
 * overlap on a frame grid, it is one edit point described twice. Everything a structural
 * check exists to catch (an unknown id, a negative duration, a clip off the end of its
 * source) is unaffected by a sub-frame nudge, and `normalizeOperationTimes` still refuses
 * to normalize intent that is invalid on its face rather than repairing it.
 *
 * ## Why the contract runs AGAIN after the grid
 *
 * The converse does not hold, and step 4 below depends on it. Snapping cannot repair a
 * defect, but it CAN create one: any range shorter than a frame can have both ends land on
 * the same frame, and a range that occupies no time is invalid however honest the intent
 * behind it was. That is not theoretical either — a caption pass emitted a 0.02s cue at
 * 30fps and the whole 126-operation patch was refused after normalization. So the semantic
 * contract runs on raw intent AND on the normalized operations, and the two rejections mean
 * different things: the first is "you asked for something impossible", the second is "what
 * you asked for does not survive this project's frame grid".
 *
 * The semantic contract still judges RAW intent first, where it belongs: it judges what the
 * model meant, and grid arithmetic has nothing to do with that.
 */
export function assembleEdit(
  project: Project,
  operations: AnyOperation[],
  reason: string,
  createdBy: PatchAuthor = 'agent',
): EditResult {
  const context = validationContext(project);
  const rawPatch: Patch = {
    patchId: asId<'PatchId'>(patchIdFor(operations)),
    createdBy,
    reason,
    operations,
  };
  const rawContractFailure = validateContracts(project, operations, rawPatch, reason);
  if (rawContractFailure) return rawContractFailure;

  let normalizedOperations: AnyOperation[];
  try {
    normalizedOperations = normalizeOperationTimes(operations, project.fps);
  } catch (cause) {
    /* v8 ignore next -- frame normalization always rejects with a RangeError. */
    const message = cause instanceof Error ? cause.message : String(cause);
    const validation: ValidationResult = {
      valid: false,
      issues: [
        {
          code: 'negative_duration',
          severity: 'error',
          message,
        },
      ],
    };
    log.warn('assembleEdit → timing normalization rejected invalid intent', {
      operations: operations.length,
      fps: project.fps,
      message,
    });
    return { patch: rawPatch, validation, text: reason };
  }

  const normalizedCount = operations.reduce(
    (count, operation, index) =>
      count + (operationTimeChanged(operation, normalizedOperations[index]!) ? 1 : 0),
    0,
  );
  const patch: Patch = {
    patchId: asId<'PatchId'>(patchIdFor(normalizedOperations)),
    createdBy,
    reason,
    operations: normalizedOperations,
  };
  const normalizedContractFailure = validateContracts(project, normalizedOperations, patch, reason);
  // Reachable, and it fires on real work: snapping can turn contract-valid intent into
  // contract-invalid intent. A caption cue of 0.02s at 30fps has both ends land on the same
  // frame, and a range that occupies no time is exactly what the semantic contract refuses.
  // The raw gate above cannot catch it — on the model's own numbers the range was positive.
  if (normalizedContractFailure) return normalizedContractFailure;

  // THE structural gate. It runs on the normalized patch because that is what will be
  // applied, and because the timeline it is compared against is already on the grid — see
  // the ordering note above.
  const validation = validatePatch(project.timeline, patch, context);
  if (!validation.valid) {
    log.warn('assembleEdit → patch failed validation', {
      operations: normalizedOperations.length,
      normalizedTimingOperations: normalizedCount,
      fps: project.fps,
      issues: validation.issues,
    });
    return { patch, validation, text: reason };
  }

  const after = applyProjectPatch(project, patch);
  const diff = diffProject(project, after);
  log.action('assembleEdit → patch assembled', {
    patchId: patch.patchId,
    operations: normalizedOperations.length,
    normalizedTimingOperations: normalizedCount,
    fps: project.fps,
    diffSummary: diff.summary,
  });
  return { patch, validation, diff, text: reason };
}
