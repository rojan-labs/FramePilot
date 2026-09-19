/**
 * "Can this computer use capability X right now?" for every pack-backed tool (BR6.1, plan 05
 * "Pack-backed tools and their warnings").
 *
 * One hook, one capability id, so background removal, AI Object, AI Brush and mask tracking all
 * read the SAME answer from the same place. Two rules make the answer trustworthy:
 *
 * - **It re-checks itself.** `onCapabilityPackInstalled` fires after any install passes its health
 *   check and after any removal, whichever surface performed it — Settings, the AI sidebar card or
 *   this section. The tool that was disabled a second ago becomes usable without a restart.
 * - **It never guesses.** A browser build has no bridge at all, and that is its own state
 *   (`unavailable`) rather than a pretend "missing pack" with an install button that cannot work.
 *
 * View state only: nothing here touches the project, and nothing downloads. An install still needs
 * the editor to approve the exact signed proposal (`useProposalInstall`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CapabilityPackHardwareWire,
  CapabilityPackIdentityWire,
  CapabilityPackInstallProposalWire,
  CapabilityPackProposalResultWire,
  CapabilityPackStatusWire,
} from '@framepilot/shared-types';
import { createLogger } from '@framepilot/shared-types';
import { getBridge } from '../../../editor/bridge.js';

const log = createLogger('web-editor:pack-status');

/** The capability background removal, AI Object and AI Brush all need. */
export const SUBJECT_MATTE_CAPABILITY = 'subject.matte';
/** The capability "Auto (main subject)" needs on top of Smart Mask. */
export const SUBJECT_DETECT_CAPABILITY = 'subject.detect';
/** The capability "Track mask" needs. */
export const TRACKING_CAPABILITY = 'tracking.region';

/** What the row and the monitor toolbar need to know, with nothing inferred. */
export type PackStatus =
  | { readonly kind: 'checking' }
  /** No desktop bridge: the browser build cannot run a pack at all. */
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly pack: CapabilityPackIdentityWire;
      readonly hardware: CapabilityPackHardwareWire | null;
    }
  | {
      readonly kind: 'missing';
      readonly proposal: CapabilityPackInstallProposalWire | null;
      /** Why there is no installable proposal (offline, no catalog entry, signature). */
      readonly proposalError: string | null;
      readonly hardware: CapabilityPackHardwareWire | null;
    }
  | {
      readonly kind: 'unhealthy';
      readonly reason: string;
      readonly proposal: CapabilityPackInstallProposalWire | null;
      readonly hardware: CapabilityPackHardwareWire | null;
    }
  | { readonly kind: 'unsupported_platform'; readonly hardware: CapabilityPackHardwareWire | null }
  /** This build ships no pack catalog, so nothing can be downloaded from it. */
  | { readonly kind: 'catalog_unconfigured'; readonly hardware: CapabilityPackHardwareWire | null }
  | { readonly kind: 'invalid'; readonly error: string };

function proposalOf(result: CapabilityPackProposalResultWire | undefined): {
  proposal: CapabilityPackInstallProposalWire | null;
  proposalError: string | null;
} {
  if (result === undefined) return { proposal: null, proposalError: null };
  return result.ok
    ? { proposal: result.proposal, proposalError: null }
    : { proposal: null, proposalError: result.error };
}

/** Translate one wire answer into the state the UI renders. Total, so no case falls through. */
export function packStatusOf(wire: CapabilityPackStatusWire): PackStatus {
  const hardware = 'hardware' in wire ? (wire.hardware ?? null) : null;
  switch (wire.state) {
    case 'ready':
      return { kind: 'ready', pack: wire.pack, hardware };
    case 'missing':
      return { kind: 'missing', ...proposalOf(wire.proposal), hardware };
    case 'unhealthy':
      return {
        kind: 'unhealthy',
        reason: wire.reason,
        proposal: proposalOf(wire.proposal).proposal,
        hardware,
      };
    case 'unsupported_platform':
      return { kind: 'unsupported_platform', hardware };
    case 'catalog_unconfigured':
      return { kind: 'catalog_unconfigured', hardware };
    case 'invalid':
      return { kind: 'invalid', error: wire.error };
  }
}

export interface UsePackStatus {
  readonly status: PackStatus;
  /** Ask main again (after an install this hook did not see, or a manual retry). */
  readonly refresh: () => void;
}

/**
 * Track one capability's readiness, refreshing itself whenever a pack is installed or removed.
 *
 * @param capability - The capability id, e.g. {@link SUBJECT_MATTE_CAPABILITY}.
 * @returns The current status and a manual re-check.
 */
export function usePackStatus(capability: string): UsePackStatus {
  const [status, setStatus] = useState<PackStatus>({ kind: 'checking' });
  /**
   * Only the newest check may write. A slow first answer must never overwrite the answer to the
   * re-check an install just triggered, or an installed pack reads as missing forever.
   */
  const generation = useRef(0);
  const mounted = useRef(true);

  const check = useCallback((): void => {
    const bridge = getBridge();
    if (!bridge?.capabilityPackStatus) {
      setStatus({ kind: 'unavailable' });
      return;
    }
    const mine = (generation.current += 1);
    void bridge
      .capabilityPackStatus(capability)
      .then((wire) => {
        if (!mounted.current || generation.current !== mine) return;
        setStatus(packStatusOf(wire));
      })
      .catch((cause: unknown) => {
        if (!mounted.current || generation.current !== mine) return;
        log.warn('capability status failed', { capability });
        setStatus({
          kind: 'invalid',
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
  }, [capability]);

  useEffect(() => {
    mounted.current = true;
    check();
    const stop = getBridge()?.onCapabilityPackInstalled?.(() => check());
    return () => {
      mounted.current = false;
      stop?.();
    };
  }, [check]);

  return { status, refresh: check };
}
