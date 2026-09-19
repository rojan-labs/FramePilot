/**
 * Renderer side of a mask-tracking job (MK7.4).
 *
 * The same contract as `usePackJob`, which it deliberately mirrors: subscribe to progress BEFORE
 * starting, key everything by the request id, and surface a missing pack as the exact signed
 * install proposal the user can approve in place — nothing downloads without that approval, and
 * an approved install re-runs the original job rather than pretending the first attempt worked.
 *
 * What is different is the result: a mask track is not a list of samples the renderer converts,
 * it is an artifact main already measured, verified and committed. The hook therefore hands the
 * panel the pin (`{key, sha256}`) and the ranges to review, and the panel turns those into one
 * reversible `set_mask_track` command.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CapabilityPackInstallProposalWire,
  MaskTrackIntentWire,
  TrackingProgressWire,
} from '@framepilot/shared-types';
import { getBridge } from '../../../editor/bridge.js';
import { useProposalInstall } from '../useProposalInstall.js';

export type MaskTrackPhase = 'idle' | 'running' | 'cancelling';

export interface MaskTrackProgress {
  readonly completed: number;
  readonly total: number;
}

/** What a finished track gives the panel. */
export interface MaskTrackOutcome {
  readonly clipId: string;
  readonly maskId: string;
  readonly method: MaskTrackIntentWire['method'];
  readonly referenceSourceTime: number;
  readonly artifact: { readonly key: string; readonly sha256: string };
  readonly flagged: readonly { readonly start: number; readonly end: number }[];
  /** Constraints the request was measured from; kept so a re-track does not drop them. */
  readonly constraints: readonly { readonly sourceTime: number }[];
  readonly frames: number;
  readonly worstResidualPx: number;
}

export type MaskTrackIntentInput = Omit<MaskTrackIntentWire, 'requestId'>;

export function useMaskTrackJob(options: {
  readonly onComplete: (outcome: MaskTrackOutcome) => void;
  /** Constraints already on the mask, carried into the result. */
  readonly constraints?: readonly { readonly sourceTime: number }[];
}): {
  readonly phase: MaskTrackPhase;
  readonly progress: MaskTrackProgress | null;
  readonly error: string | null;
  readonly proposal: CapabilityPackInstallProposalWire | null;
  readonly installing: boolean;
  readonly run: (intent: MaskTrackIntentInput) => Promise<void>;
  readonly cancel: () => void;
  readonly dismissProposal: () => void;
  readonly approveInstall: () => Promise<void>;
} {
  const { onComplete } = options;
  const [phase, setPhase] = useState<MaskTrackPhase>('idle');
  const [progress, setProgress] = useState<MaskTrackProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<CapabilityPackInstallProposalWire | null>(null);
  const activeRequestId = useRef<string | null>(null);
  const lastIntent = useRef<MaskTrackIntentInput | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.onCapabilityPackTrackProgress) return;
    return bridge.onCapabilityPackTrackProgress((message: TrackingProgressWire) => {
      if (message.requestId !== activeRequestId.current) return;
      setProgress({ completed: message.completed, total: message.total });
    });
  }, []);

  const run = useCallback(
    async (intent: MaskTrackIntentInput): Promise<void> => {
      const bridge = getBridge();
      if (!bridge?.capabilityPackTrackMask) {
        setError('Mask tracking runs in the desktop app.');
        return;
      }
      const requestId = `mask-track-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      activeRequestId.current = requestId;
      lastIntent.current = intent;
      setPhase('running');
      setProgress(null);
      setError(null);
      setProposal(null);
      try {
        const result = await bridge.capabilityPackTrackMask({ ...intent, requestId });
        if (activeRequestId.current !== requestId) return;
        if (result.ok) {
          onComplete({
            clipId: intent.clipId,
            maskId: intent.maskId,
            method: result.method,
            referenceSourceTime: intent.referenceSourceTime,
            artifact: result.artifact,
            flagged: result.flagged,
            constraints: options.constraints ?? [],
            frames: result.frames,
            worstResidualPx: result.worstResidualPx,
          });
        } else if ('proposal' in result) {
          // A missing pack is an offer, not a failure: nothing downloads until the user
          // approves this exact signed proposal.
          setProposal(result.proposal.ok ? result.proposal.proposal : null);
          if (!result.proposal.ok) setError(result.proposal.error);
        } else {
          setError(result.error);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Tracking failed.');
      } finally {
        if (activeRequestId.current === requestId) {
          activeRequestId.current = null;
          setPhase('idle');
          setProgress(null);
        }
      }
    },
    [onComplete, options.constraints],
  );

  const cancel = useCallback((): void => {
    const requestId = activeRequestId.current;
    if (requestId === null) return;
    setPhase('cancelling');
    getBridge()?.capabilityPackCancelTrack?.(requestId);
  }, []);

  const install = useProposalInstall();
  /**
   * Install the exact proposal that was shown, then re-run the request that needed it: an
   * approved install must produce the track the editor asked for, not a silent no-op.
   */
  const approveInstall = useCallback(async (): Promise<void> => {
    if (proposal === null) return;
    try {
      await install.approve(proposal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The install did not finish.');
      return;
    }
    setProposal(null);
    const intent = lastIntent.current;
    if (intent !== null) await run(intent);
  }, [install, proposal, run]);

  return {
    phase,
    progress,
    error: error ?? install.error,
    proposal,
    installing: install.installing,
    run,
    cancel,
    dismissProposal: () => setProposal(null),
    approveInstall,
  };
}
