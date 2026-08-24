import { z } from 'zod/v4';
import type { CapabilityPackPlatform } from '@framepilot/capability-packs';
import { EDITOR_CAPABILITIES } from './editor-capabilities.js';

export const EditorCapabilityPackDependencySchema = z.object({
  capabilityId: z.string().min(1),
  packId: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  minimumVersion: z
    .string()
    .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/),
  packCapabilityId: z.string().min(1),
  requiredFor: z.enum(['render', 'edit', 'analysis']),
  supportedPlatforms: z.array(
    z.object({ os: z.enum(['darwin', 'win32']), arch: z.enum(['arm64', 'x64']) }),
  ),
});

export type EditorCapabilityPackDependency = z.infer<
  typeof EditorCapabilityPackDependencySchema
>;

const intendedDependencies = [
  {
    capabilityId: 'tracking_mask.automatic_subject_track',
    packId: 'framepilot.subject-intelligence',
    minimumVersion: '1.0.0',
    packCapabilityId: 'subject.detect',
    requiredFor: 'analysis',
    supportedPlatforms: [
      { os: 'darwin', arch: 'arm64' },
      { os: 'win32', arch: 'x64' },
    ] satisfies CapabilityPackPlatform[],
  },
] as const;

/**
 * The generated dependency projection used by discovery and install proposals.
 *
 * The release digest is deliberately absent: this manifest states product compatibility,
 * while the verified catalog resolves an exact immutable release at installation time.
 */
export const EDITOR_CAPABILITY_PACK_DEPENDENCIES: readonly EditorCapabilityPackDependency[] = z
  .array(EditorCapabilityPackDependencySchema)
  .parse(intendedDependencies);

export interface CapabilityPackDependencyDriftIssue {
  readonly capabilityId: string;
  readonly message: string;
}

export function capabilityPackDependencyDriftIssues(
  dependencies: readonly EditorCapabilityPackDependency[] = EDITOR_CAPABILITY_PACK_DEPENDENCIES,
): CapabilityPackDependencyDriftIssue[] {
  const issues: CapabilityPackDependencyDriftIssue[] = [];
  const capabilityById = new Map(EDITOR_CAPABILITIES.map((capability) => [capability.id, capability]));
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    const capability = capabilityById.get(dependency.capabilityId);
    if (seen.has(dependency.capabilityId)) {
      issues.push({ capabilityId: dependency.capabilityId, message: 'Duplicate pack dependency.' });
    }
    seen.add(dependency.capabilityId);
    if (capability === undefined) {
      issues.push({ capabilityId: dependency.capabilityId, message: 'Capability does not exist.' });
    }
    // An AVAILABLE capability declaring a pack dependency is exactly right since
    // 2026-08: pack-backed capabilities are executable end to end, and this
    // manifest is what drives the prompted install proposal when the pack is
    // missing. What would be drift is a dependency for a PLANNED capability.
    else if (capability.availability.state === 'planned') {
      issues.push({
        capabilityId: dependency.capabilityId,
        message: 'A planned capability has no runtime to back a pack install yet.',
      });
    }
  }
  return issues;
}
