import { useEffect, useMemo, useState } from 'react';
import { Button } from '@framepilot/ui';
import type {
  CapabilityPackInstallProposalWire,
  CapabilityPackProgressWire,
  CapabilityPackProjectDependencyWire,
  CapabilityPackProjectResolutionWire,
} from '@framepilot/shared-types';
import { getBridge } from '../editor/bridge.js';
import { useModalFocusTrap } from './ai/useModalFocusTrap.js';

export interface CapabilityPackDependencyDialogProps {
  readonly projectId: string;
  readonly resolution: CapabilityPackProjectResolutionWire | null;
  readonly onResolutionChange: (resolution: CapabilityPackProjectResolutionWire) => void;
  readonly onOpenDegraded: () => void;
}

/** Explicit project-open gate for immutable on-demand dependencies. */
export function CapabilityPackDependencyDialog({
  projectId,
  resolution,
  onResolutionChange,
  onOpenDegraded,
}: CapabilityPackDependencyDialogProps): JSX.Element | null {
  const bridge = getBridge();
  const unavailable = useMemo(
    () => resolution?.dependencies.filter(({ status }) => status !== 'ready') ?? [],
    [resolution],
  );
  const [selected, setSelected] = useState<CapabilityPackProjectDependencyWire | null>(null);
  const [proposal, setProposal] = useState<CapabilityPackInstallProposalWire | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CapabilityPackProgressWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // It declared `aria-modal="true"` and trapped nothing: Tab walked straight out
  // onto the editor behind a gate the user cannot dismiss. Keyed on `open` rather
  // than on mount, because this component is mounted long before the gate has
  // anything to show — a trap installed at mount would find a null ref and
  // silently do nothing. Deliberately NO Escape handler: this is a gate, and its
  // only exit is the explicit "Open degraded" decision.
  const open = resolution !== null && unavailable.length > 0;
  const dialogRef = useModalFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!bridge?.onCapabilityPackProgress) return;
    return bridge.onCapabilityPackProgress((message) => {
      if (operationId !== null && message.operationId !== operationId) return;
      setProgress(message);
      if (message.phase === 'installed') {
        void bridge.capabilityPackProjectStatus?.(projectId).then((next) => {
          onResolutionChange(next);
          setSelected(null);
          setProposal(null);
          setOperationId(null);
          setProgress(null);
        }).catch((statusError: unknown) => setError(errorMessage(statusError)));
      } else if (message.phase === 'failed' || message.phase === 'cancelled') {
        setBusy(false);
      }
    });
  }, [bridge, onResolutionChange, operationId, projectId]);

  if (!open) return null;

  const reviewDownload = async (dependency: CapabilityPackProjectDependencyWire): Promise<void> => {
    if (!bridge?.capabilityPackProposeProjectDependency) return;
    setBusy(true);
    setError(null);
    setSelected(dependency);
    try {
      const result = await bridge.capabilityPackProposeProjectDependency(projectId, dependency.pin.id);
      if (!result.ok) setError(result.error);
      else setProposal(result.proposal);
    } catch (proposalError) {
      setError(errorMessage(proposalError));
    } finally {
      setBusy(false);
    }
  };

  const approveDownload = async (): Promise<void> => {
    if (!bridge?.capabilityPackInstall || proposal === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.capabilityPackInstall({
        proposalId: proposal.proposalId,
        identity: proposal.identity,
        approvedSizeBytes: proposal.downloadBytes,
        approvedLicenseSpdx: proposal.licenses.map(({ spdx }) => spdx),
        approvedMediaEgress: proposal.privacy.mediaLeavesDevice,
        approvedAt: new Date().toISOString(),
      });
      if (!result.ok) {
        setError(result.error);
        setBusy(false);
      } else {
        setOperationId(result.operationId);
      }
    } catch (installError) {
      setError(errorMessage(installError));
      setBusy(false);
    }
  };

  const cancelInstall = (): void => {
    if (operationId !== null) bridge?.capabilityPackCancel?.(operationId);
  };

  return (
    <div className="overlay-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="new-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Project capabilities required"
        tabIndex={-1}
      >
        <header className="new-project-dialog-head">
          <div>
            <h2>Project capabilities required</h2>
            <p>This project pins exact versions. FramePilot will never substitute or download one silently.</p>
          </div>
        </header>

        <div className="new-project-dialog-body">
          <ul className="capability-pack-list" aria-label="Unavailable project capabilities">
            {unavailable.map((dependency) => (
              <li key={`${dependency.pin.id}/${dependency.pin.releaseDigest}`}>
                <div>
                  <strong>{dependency.pin.id}</strong>
                  <span>v{dependency.pin.version} · required for {dependency.pin.requiredFor}</span>
                  <small>{dependency.status}{dependency.detail ? ` · ${dependency.detail}` : ''}</small>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || operationId !== null}
                  onClick={() => void reviewDownload(dependency)}
                >
                  Review download
                </Button>
              </li>
            ))}
          </ul>

          {proposal !== null && selected !== null ? (
            <section className="capability-cleanup-review" aria-label="Capability Pack approval">
              <strong>{proposal.displayName} · {formatBytes(proposal.downloadBytes)} download</strong>
              <span>{proposal.description}</span>
              <span>{formatBytes(proposal.installedBytes)} after install · {proposal.identity.os}/{proposal.identity.arch}</span>
              <span>Licenses: {proposal.licenses.map(({ spdx }) => spdx).join(', ')}</span>
              <span>{proposal.privacy.disclosure}</span>
              <span>{proposal.privacy.mediaLeavesDevice ? 'Media may leave this device.' : 'Media stays on this device.'}</span>
              <Button type="button" disabled={busy || operationId !== null} onClick={() => void approveDownload()}>
                Approve exact version and download
              </Button>
            </section>
          ) : null}

          {progress !== null ? (
            <div className="capability-pack-progress" role="status" aria-label="Download progress">
              <span>{progress.phase.replaceAll('_', ' ')}</span>
              <strong>{formatBytes(progress.completedBytes)} / {formatBytes(progress.totalBytes)}</strong>
              {progress.detail ? <small>{progress.detail}</small> : null}
              {operationId !== null ? (
                <Button type="button" variant="ghost" onClick={cancelInstall}>Cancel download</Button>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="settings-callout" role="alert">{error}</div> : null}
          <p className="setting-note">Cloud and local-import alternatives appear only when a signed compatible provider exists. None is available for this dependency.</p>
        </div>

        <footer className="new-project-dialog-foot">
          <Button type="button" variant="ghost" disabled={busy} onClick={onOpenDegraded}>
            Open degraded
          </Button>
        </footer>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
