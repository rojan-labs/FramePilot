import { describe, expect, it } from 'vitest';
import {
  EDITOR_CAPABILITY_PACK_DEPENDENCIES,
  capabilityPackDependencyDriftIssues,
} from './editor-capability-pack-dependencies.js';

describe('editor capability → on-demand pack dependencies', () => {
  it('has no orphan, duplicate, or already-available dependency', () => {
    expect(capabilityPackDependencyDriftIssues()).toEqual([]);
  });

  it('maps automatic subject tracking to both first-release desktop targets', () => {
    expect(EDITOR_CAPABILITY_PACK_DEPENDENCIES).toEqual([
      expect.objectContaining({
        capabilityId: 'tracking_mask.automatic_subject_track',
        packId: 'framepilot.subject-intelligence',
        supportedPlatforms: [
          { os: 'darwin', arch: 'arm64' },
          { os: 'win32', arch: 'x64' },
        ],
      }),
    ]);
  });

  it('reports an orphan and duplicate rather than silently shrinking coverage', () => {
    const real = EDITOR_CAPABILITY_PACK_DEPENDENCIES[0]!;
    expect(
      capabilityPackDependencyDriftIssues([
        real,
        real,
        { ...real, capabilityId: 'tracking_mask.does_not_exist' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { capabilityId: real.capabilityId, message: 'Duplicate pack dependency.' },
        {
          capabilityId: 'tracking_mask.does_not_exist',
          message: 'Capability does not exist.',
        },
      ]),
    );
  });
});
