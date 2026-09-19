/**
 * What a pack-backed tool says when it cannot run, in one place (BR6.1, BR6.2, plan 05).
 *
 * Background removal, AI Object, AI Brush and Track mask all depend on a downloadable pack, and
 * they must all fail the SAME way: the tool stays visible so the editor can see the capability
 * exists, it is disabled with a reason, and the reason names what would fix it. One function
 * decides that, so a new pack-backed tool cannot invent its own vocabulary.
 *
 * The sentences are deliberately short and free of jargon: "pack", "install" and the size are the
 * only technical words an editor needs, and nothing here mentions a model, a runtime or an
 * execution provider.
 */
import type { CapabilityPackHardwareWire } from '@framepilot/shared-types';
import { formatBytes } from './matteEstimate.js';
import type { PackStatus } from './usePackStatus.js';

/** The pack a tool needs, as the editor sees it named. */
export const SMART_MASK_PACK = 'Smart Mask';
export const TRACKING_LITE_PACK = 'Tracking Lite';

export interface PackToolCopy {
  /** The first line of the warning. Empty when the tool can run. */
  readonly headline: string;
  /** The rest of the explanation, or `null`. */
  readonly detail: string | null;
  /** Which action the warning offers, if any. */
  readonly action: 'install' | 'reinstall' | null;
  /** The label of that action. */
  readonly actionLabel: string | null;
  /** The tooltip on the disabled tool. */
  readonly tooltip: string;
  /** Whether the tool must be disabled. */
  readonly blocked: boolean;
}

const READY: PackToolCopy = {
  headline: '',
  detail: null,
  action: null,
  actionLabel: null,
  tooltip: '',
  blocked: false,
};

export interface PackToolCopyOptions {
  /** The pack the tool needs, e.g. {@link SMART_MASK_PACK}. */
  readonly pack: string;
  /** The tool as the editor names it, e.g. "Background removal". */
  readonly tool: string;
  /** Development builds may register a pack from disk; releases never can. */
  readonly developmentBuild?: boolean;
}

/**
 * The warning, action and tooltip for one pack-backed tool in one pack state.
 *
 * @param status - What {@link usePackStatus} last heard from main.
 * @param options - The pack and tool names, and whether this is a development build.
 * @returns The copy to render. `blocked: false` means the tool can run.
 */
export function packToolCopy(status: PackStatus, options: PackToolCopyOptions): PackToolCopy {
  const { pack, tool } = options;
  const needsIt = `Install the ${pack} pack first`;
  switch (status.kind) {
    case 'ready':
      return READY;
    case 'checking':
      return {
        headline: 'Checking what this computer can do…',
        detail: null,
        action: null,
        actionLabel: null,
        tooltip: 'Checking…',
        blocked: true,
      };
    case 'unavailable':
      return {
        headline: `${tool} needs the FramePilot desktop app.`,
        detail: 'The browser version cannot run it.',
        action: null,
        actionLabel: null,
        tooltip: `${tool} needs the FramePilot desktop app`,
        blocked: true,
      };
    case 'missing': {
      if (status.proposal === null) {
        return {
          headline: `${tool} isn't installed.`,
          detail:
            status.proposalError === null
              ? `Can't reach the pack catalog. Check your connection, or install ${pack} later from Settings → Storage.`
              : `Can't reach the pack catalog (${status.proposalError}). Check your connection, or install ${pack} later from Settings → Storage.`,
          action: null,
          actionLabel: null,
          tooltip: needsIt,
          blocked: true,
        };
      }
      const size = formatBytes(status.proposal.downloadBytes);
      const licences = status.proposal.licenses.map((licence) => licence.spdx).join(', ');
      return {
        headline: `${tool} isn't installed.`,
        detail: `It won't work until you install the ${pack} pack (${size} download, runs entirely on this computer; nothing is uploaded). Licences: ${licences}.`,
        action: 'install',
        actionLabel: `Install ${size}`,
        tooltip: needsIt,
        blocked: true,
      };
    }
    case 'unhealthy':
      return {
        headline: `The ${pack} pack is installed but failed its health check.`,
        detail: status.reason,
        action: status.proposal === null ? null : 'reinstall',
        actionLabel: status.proposal === null ? null : 'Reinstall',
        tooltip: `The ${pack} pack needs reinstalling`,
        blocked: true,
      };
    case 'unsupported_platform':
      return {
        headline: `${tool} isn't available for this computer yet.`,
        detail:
          status.hardware === null
            ? 'It needs an Apple Silicon Mac or a Windows x64 PC.'
            : `It needs ${status.hardware.requirement}.`,
        action: null,
        actionLabel: null,
        tooltip: `${tool} isn't available for this computer`,
        blocked: true,
      };
    case 'catalog_unconfigured':
      return {
        headline: `${pack} can't be installed from this build.`,
        detail:
          options.developmentBuild === true
            ? 'Use a locally registered pack (framepilot-pack register-local).'
            : null,
        action: null,
        actionLabel: null,
        tooltip: `${pack} can't be installed from this build`,
        blocked: true,
      };
    case 'invalid':
      return {
        headline: `${tool} could not be checked.`,
        detail: status.error,
        action: null,
        actionLabel: null,
        tooltip: `${tool} could not be checked`,
        blocked: true,
      };
  }
}

/**
 * The hardware line shown BEFORE any download, when this machine is at or below the minimum.
 *
 * Returns `null` when the machine comfortably meets it: an editor with a capable computer should
 * never read a specification they do not need.
 */
export function hardwareNotice(hardware: CapabilityPackHardwareWire | null): string | null {
  if (hardware === null) return null;
  if (!hardware.platformSupported) return `Needs ${hardware.requirement}.`;
  if (hardware.memoryBytes < hardware.minMemoryBytes) {
    const need = Math.round(hardware.minMemoryBytes / 1_000_000_000);
    const have = Math.round(hardware.memoryBytes / 1_000_000_000);
    return `Needs ${String(need)} GB of memory; this computer has ${String(have)} GB, so it will run slower.`;
  }
  return null;
}
