/**
 * Renderer side of a media-intelligence Capability Pack job.
 *
 * Mirrors the ExportDialog contract: subscribe BEFORE starting, buffer any
 * progress that arrives before the invoke answers, then key everything by the
 * request id. A missing pack surfaces as an exact, signed install proposal the
 * user can approve in place — nothing ever downloads without that approval,
 * and an approved install re-runs the original job instead of pretending the
 * first attempt succeeded.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CapabilityPackInstallProposalWire,
  TrackingProgressWire,
  TrackingRequestIntentWire,
  TrackingRunResultWire,
} from '@framepilot/shared-types';
import { getBridge } from '../../editor/bridge.js';
import { useProposalInstall } from './useProposalInstall.js';

export type PackJobPhase = 'idle' | 'running' | 'cancelling';

export interface PackJobProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
}

const PROPOSAL_TTL_MS = 15 * 60 * 1_000;

export function usePackJob(options: {
  readonly onComplete: (result: Extract<TrackingRunResultWire, { ok: true }>) => void;
}): {
  readonly phase: PackJobPhase;
  readonly progress: PackJobProgress | null;
  /** Typed refusal from main (`stale_revision`, `target_lost`, …) or transport failure. */
  readonly error: string | null;
  readonly proposal: CapabilityPackInstallProposalWire | null;
  readonly installing: boolean;
  readonly run: (intent: Omit<TrackingRequestIntentWire, 'requestId'>) => Promise<void>;
  readonly cancel: () => void;
  readonly dismissProposal: () => void;
  readonly approveInstall: () => Promise<void>;
} {
  const { onComplete } = options;
  const [phase, setPhase] = useState<PackJobPhase>('idle');
  const [progress, setProgress] = useState<PackJobProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<CapabilityPackInstallProposalWire | null>(null);
  const activeRequestId = useRef<string | null>(null);
  /** Progress that arrived between spawn and the invoke's answer. */
  const inbox = useRef<TrackingProgressWire[]>([]);
  const lastIntent = useRef<Omit<TrackingRequestIntentWire, 'requestId'> | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.onCapabilityPackTrackProgress) return;
    return bridge.onCapabilityPackTrackProgress((message: TrackingProgressWire) => {
      if (activeRequestId.current === null || message.requestId !== activeRequestId.current) {
        // Not ours yet (invoke has not answered) — replay it once we know the id.
        inbox.current.push(message);
        return;
      }
      setProgress({ phase: message.phase, completed: message.completed, total: message.total });
    });
  }, []);

  const run = useCallback(
    async (intent: Omit<TrackingRequestIntentWire, 'requestId'>): Promise<void> => {
      const bridge = getBridge();
      if (!bridge?.capabilityPackTrack) {
        setError('Running pack jobs needs the FramePilot desktop app.');
        return;
      }
      lastIntent.current = intent;
      setError(null);
      setProposal(null);
      setProgress(null);
      inbox.current = [];
      const requestId = `job_${crypto.randomUUID()}`;
      activeRequestId.current = requestId;
      setPhase('running');
      try {
        const result = await bridge.capabilityPackTrack({ ...intent, requestId });
        if (result.ok) {
          onComplete(result);
          return;
        }
        if ('proposal' in result) {
          setProposal(result.proposal.ok ? result.proposal.proposal : null);
          if (!result.proposal.ok) {
            setError(`No installable pack provides this capability: ${result.proposal.error}`);
          }
          return;
        }
        setError(result.retryable ? `${result.error} (You can retry.)` : result.error);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        activeRequestId.current = null;
        setPhase('idle');
      }
    },
    [onComplete],
  );

  const cancel = useCallback((): void => {
    const bridge = getBridge();
    if (!bridge?.capabilityPackCancelTrack || activeRequestId.current === null) return;
    setPhase('cancelling');
    bridge.capabilityPackCancelTrack(activeRequestId.current);
  }, []);

  const dismissProposal = useCallback((): void => {
    setProposal(null);
    setError(null);
  }, []);

  const { installing, error: installError, approve } = useProposalInstall();

  const approveInstall = useCallback(async (): Promise<void> => {
    if (proposal === null) return;
    setError(null);
    try {
      await approve(proposal);
      setProposal(null);
      if (lastIntent.current !== null) await run(lastIntent.current);
    } catch {
      setError(installError ?? 'The install did not finish.');
    }
  }, [proposal, approve, installError, run]);

  // Signed proposals expire; drop the card rather than show an unapprovable one.
  useEffect(() => {
    if (proposal === null) return;
    const timer = setTimeout(() => setProposal(null), PROPOSAL_TTL_MS);
    return () => clearTimeout(timer);
  }, [proposal]);

  return { phase, progress, error, proposal, installing, run, cancel, dismissProposal, approveInstall };
}
