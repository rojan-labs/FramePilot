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
  type ValidationResult,
  PatchError,
  applyProjectPatch,
  assertOperationContract,
  diffProject,
  isProjectOperation,
  validatePatch,
} from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
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

/**
 * Validate semantic operation contracts against the speculative state in operation order.
 * Raw operations are checked before frame normalization so quantization can never repair
 * invalid intent. `applyProjectPatch` independently enforces the same contract as the
 * canonical final authority; the explicit call here exists to return an ordinary invalid
 * edit result instead of making assembly throw.
 */
function assertEngineContracts(project: Project, operations: readonly AnyOperation[]): void {
  let working = project;
  for (const operation of operations) {
    if (!isProjectOperation(operation)) assertOperationContract(working.timeline, operation);
    working = applyProjectPatch(working, {
      patchId: asId<'PatchId'>(patchIdFor([operation])),
      createdBy: 'agent',
      reason: 'Contract replay',
      operations: [operation],
    });
  }
}

function contractFailure(message: string): ValidationResult {
  return {
    valid: false,
    issues: [
      {
        code: 'unsupported_operation',
        severity: 'error',
        message,
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
  try {
    assertEngineContracts(project, operations);
    return undefined;
  } catch (cause) {
    const message = contractRejectionMessage(cause);
    log.warn('assembleEdit → operation contract rejected patch', { message });
    return { patch, validation: contractFailure(message), text: reason };
  }
}

/**
 * The reason an editor should read, not the envelope the replay threw it in.
 *
 * The contract replay applies each operation through the canonical patch authority,
 * so a rejection arrives wrapped as `Patch <id> failed at operation <n>: <reason>`.
 * That id and index are internal — the replay is one operation at a time, so the index
 * is always 0 — and this message reaches the user and the model verbatim. Both are
 * better served by "Clip not found: intro" than by a hash they cannot act on.
 */
function contractRejectionMessage(cause: unknown): string {
  const unwrapped = cause instanceof PatchError ? cause.cause : cause;
  /* v8 ignore next -- the contract and patch authorities always reject with Errors. */
  return unwrapped instanceof Error ? unwrapped.message : String(unwrapped);
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
 * The semantic contract stays on RAW intent, where it belongs: it judges what the model
 * meant, and grid arithmetic has nothing to do with that.
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
  // Unreachable today: snapping cannot make a value the raw contract accepted violate that
  // contract. Kept so a new quantization rule cannot bypass the semantic gate.
  /* v8 ignore next */
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
