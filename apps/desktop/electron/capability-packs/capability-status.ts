/**
 * Generic "can this machine use capability X right now?" (plan 03, `capabilityPackStatus`).
 *
 * Any capability id, not only `subject.matte`: every pack-backed tool shows the same warning
 * states (05-INSPECTOR-UX). Main answers from its own storage index; the catalog is asked for
 * an install proposal only when nothing usable is installed, and nothing ever downloads here.
 */
import type {
  CapabilityPackProposalResultWire,
  CapabilityPackStatusWire,
} from '@framepilot/shared-types';
import { CapabilityIdSchema, type InstalledCapabilityPack } from '@framepilot/capability-packs';
import { compareSemver } from './pack-paths.js';

/**
 * Which pack answers each capability the host knows how to run. Installed records do not carry
 * their capability roster, so the binding lives here, next to the hosts that run them.
 */
export const CAPABILITY_PACK_BINDINGS: Readonly<Record<string, string>> = {
  'tracking.point': 'framepilot.tracking-lite',
  'tracking.region': 'framepilot.tracking-lite',
  'tracking.planar': 'framepilot.tracking-lite',
  'subject.detect': 'framepilot.subject-intelligence',
  'subject.segment': 'framepilot.subject-intelligence',
  'subject.matte': 'framepilot.smart-mask',
  'subject.segment_frame': 'framepilot.smart-mask',
  'visual.embed': 'framepilot.visual-embed',
  'visual.text': 'framepilot.visual-embed',
  'visual.describe': 'framepilot.visual-describe',
  'asr.whisper.local': 'framepilot.local-whisper',
};

/** Platforms packs publish artifacts for (ADR 0114); anything else is unsupported, not missing. */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(['darwin/arm64', 'darwin/x64', 'win32/x64', 'win32/arm64']);

export interface CapabilityStatusDependencies {
  readonly records: readonly InstalledCapabilityPack[];
  readonly platform: { readonly os: string; readonly arch: string };
  readonly propose: (capabilityId: string) => Promise<CapabilityPackProposalResultWire>;
}

export async function resolveCapabilityPackStatus(
  capabilityInput: unknown,
  dependencies: CapabilityStatusDependencies,
): Promise<CapabilityPackStatusWire> {
  const parsed = CapabilityIdSchema.safeParse(capabilityInput);
  if (!parsed.success) {
    return { state: 'invalid', capability: String(capabilityInput).slice(0, 128), error: 'Capability id is invalid.' };
  }
  const capability = parsed.data;
  if (!SUPPORTED_PLATFORMS.has(`${dependencies.platform.os}/${dependencies.platform.arch}`)) {
    return { state: 'unsupported_platform', capability };
  }
  const packId = CAPABILITY_PACK_BINDINGS[capability];
  const candidates =
    packId === undefined ? [] : dependencies.records.filter((record) => record.identity.id === packId);
  const ready = candidates
    .filter((record) => record.state === 'installed' && record.health.status === 'healthy')
    .sort((left, right) => compareSemver(right.identity.version, left.identity.version))[0];
  if (ready !== undefined) return { state: 'ready', capability, pack: ready.identity };
  const proposal = await dependencies.propose(capability);
  const present = candidates[0];
  if (present !== undefined) {
    return {
      state: 'unhealthy',
      capability,
      reason: present.health.detail ?? unhealthyReason(present),
      ...(proposal.ok ? { proposal } : {}),
    };
  }
  // `platform_unsupported` from the catalog also means "no release provides this capability",
  // so it stays `missing` with the typed refusal; only the host platform check above is
  // authoritative for `unsupported_platform`.
  return { state: 'missing', capability, proposal };
}

function unhealthyReason(record: InstalledCapabilityPack): string {
  if (record.state === 'quarantined') return 'The pack was quarantined after failing verification.';
  if (record.state === 'pending_removal') return 'The pack is being removed.';
  return 'The pack failed its health check.';
}
