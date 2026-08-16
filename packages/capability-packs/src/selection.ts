import type {
  CapabilityPackArtifact,
  CapabilityPackPlatform,
  CapabilityPackRelease,
} from './contracts.js';

/** Select the one signed artifact for a target host; never fall back across architectures. */
export function artifactForPlatform(
  release: CapabilityPackRelease,
  platform: CapabilityPackPlatform,
): CapabilityPackArtifact | undefined {
  return release.artifacts.find(
    (artifact) => artifact.os === platform.os && artifact.arch === platform.arch,
  );
}
