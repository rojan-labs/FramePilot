/** Shared combined-patch gate for controller-produced professional command batches. */
import {
  applyPatch,
  invertPatch,
  isProjectOperation,
  validatePatch,
  type AnyOperation,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import type { ToolContext } from '../tool-context.js';

function contentWithoutRevision(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return JSON.stringify({ ...(value as Record<string, unknown>), revision: 0 });
}

/**
 * Validate the controller's complete operation batch and prove its generated inverse before the
 * tool returns anything to the orchestrator. Individual compilers may target independent clips,
 * but only this combined check can catch collisions introduced by composing their operations.
 */
export function validateProfessionalOperationBatch(
  ctx: ToolContext,
  toolName: string,
  operations: readonly AnyOperation[],
): Operation[] {
  if (operations.some(isProjectOperation)) {
    throw new Error(`${toolName} emitted a project-scoped operation from a timeline controller.`);
  }
  const timelineOperations = operations as readonly Operation[];
  const patch: Patch = {
    patchId: `professional_batch_${toolName}` as PatchId,
    createdBy: 'agent',
    reason: `${toolName} compiled professional command batch`,
    operations: timelineOperations,
  };
  const validation = validatePatch(ctx.project.timeline, patch, {
    assetIds: ctx.project.assets.map((asset) => asset.id),
  });
  if (!validation.valid) {
    throw new Error(
      `${toolName} combined patch rejected: ${validation.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const edited = applyPatch(ctx.project.timeline, patch);
  const inverse = invertPatch(ctx.project.timeline, patch);
  const restored = applyPatch(edited, inverse);
  if (contentWithoutRevision(restored) !== contentWithoutRevision(ctx.project.timeline)) {
    throw new Error(`${toolName} combined patch failed exact inverse restoration.`);
  }
  return [...timelineOperations];
}
