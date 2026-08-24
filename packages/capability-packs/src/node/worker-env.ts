/**
 * Shared rules for the FRAMEPILOT_-prefixed extra-environment channel.
 *
 * Both the runtime client and the health check accept pack-required extras
 * (e.g. `FRAMEPILOT_CAPABILITY_PACK_ROOT`) and must obey the same contract:
 * names must be FRAMEPILOT_-prefixed and reasonably sized, and the host-owned
 * protocol keys can never be overridden through this channel.
 */

const FRAMEPILOT_NAME_PATTERN = /^FRAMEPILOT_[A-Z0-9_]+$/;
const MAX_EXTRA_VALUE_BYTES = 4_096;

/**
 * Host-owned keys merged into every worker/health-check environment before
 * extras are applied. An extra carrying one of these names is dropped rather
 * than allowed to weaken the sandbox or spoof the identity check.
 */
const RESERVED_WORKER_ENV_KEYS: ReadonlySet<string> = new Set([
  'FRAMEPILOT_CAPABILITY_PACK_HEALTH_CHECK',
  'FRAMEPILOT_CAPABILITY_PACK_NETWORK',
  'FRAMEPILOT_CAPABILITY_PACK_RUNTIME',
  'FRAMEPILOT_CAPABILITY_PACK_ID',
  'FRAMEPILOT_CAPABILITY_PACK_VERSION',
  'FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST',
  'FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES',
]);

/**
 * Merge host-owned base variables with pack-required extras: extras must be
 * FRAMEPILOT_-prefixed, bounded in size, and never override a reserved key.
 */
export function mergeExtraWorkerEnvironment(
  base: Readonly<Record<string, string>>,
  extraEnvironment?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(extraEnvironment ?? {})) {
    if (!FRAMEPILOT_NAME_PATTERN.test(name) || value.length > MAX_EXTRA_VALUE_BYTES) continue;
    if (RESERVED_WORKER_ENV_KEYS.has(name)) continue;
    env[name] = value;
  }
  return env;
}
