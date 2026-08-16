/**
 * Reconstruct a host-authoritative compact patch transport against the renderer's full
 * project without losing unchanged media metadata. The patch is validated again at the
 * renderer boundary, applied transactionally, then the host-provided bounded history is
 * installed and the complete result is schema-parsed before entering the editor.
 */
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  applyProjectPatch,
  validatePatch,
  type Patch,
} from '@framepilot/editor-core';
import {
  isProjectPatchTransport,
  type ProjectPatchTransport,
} from '@framepilot/shared-types';

function isPatch(value: unknown): value is Patch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.patchId === 'string' &&
    (record.createdBy === 'user' || record.createdBy === 'agent') &&
    typeof record.reason === 'string' &&
    Array.isArray(record.operations) &&
    record.operations.every(
      (operation) =>
        typeof operation === 'object' &&
        operation !== null &&
        typeof (operation as Record<string, unknown>).type === 'string',
    )
  );
}

export function applyAuthoritativePatchTransport(
  project: Project,
  value: unknown,
): Project | null {
  if (!isProjectPatchTransport(value) || value.id !== project.id || !isPatch(value.patch)) {
    return null;
  }
  const patch = value.patch;
  const validation = validatePatch(project.timeline, patch, {
    assetIds: project.assets.map((asset) => asset.id),
    folders: project.folders,
    markers: project.markers,
  });
  if (!validation.valid) return null;

  try {
    const next = applyProjectPatch(project, patch);
    return parseProject({ ...next, history: value.history });
  } catch {
    return null;
  }
}

export type { ProjectPatchTransport };
