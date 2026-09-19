/**
 * The warning every pack-backed tool shows when it cannot run (BR6.2, plan 05).
 *
 * Background removal, AI Object, AI Brush and Track mask fail for the same handful of reasons —
 * the pack is missing, it failed its health check, this computer is not supported, this build has
 * no catalog, or there is no desktop app at all — and an editor should recognise the shape of the
 * answer whichever tool they reached for. One component renders all of them:
 *
 * - `role="status"` with `aria-live="polite"`, never `alert`: the Inspector re-renders on every
 *   clip selection, and an alert would re-announce the same sentence each time.
 * - The id is stable, so the disabled control can point at it with `aria-describedby` and a screen
 *   reader reads the reason WITH the control instead of hoping the user finds it nearby.
 * - An unhealthy pack offers Reinstall, a missing one offers Install; the states with nothing to
 *   offer (unsupported hardware, no catalog, no desktop app) show no button rather than a dead one.
 */
import { useState } from 'react';
import { Button } from '@framepilot/ui';
import { formatBytes } from './matteEstimate.js';
import type { PackToolCopy } from './packToolCopy.js';
import { useProposalInstall } from '../useProposalInstall.js';
import type { PackStatus } from './usePackStatus.js';

export interface PackToolWarningProps {
  readonly id: string;
  readonly copy: PackToolCopy;
  readonly status: PackStatus;
  /** Re-check the capability once an install finished. */
  readonly onInstalled: () => void;
}

export function PackToolWarning({
  id,
  copy,
  status,
  onInstalled,
}: PackToolWarningProps): JSX.Element | null {
  const install = useProposalInstall();
  const [showDetails, setShowDetails] = useState(false);
  if (!copy.blocked) return null;
  const proposal =
    status.kind === 'missing' || status.kind === 'unhealthy' ? status.proposal : null;

  const approve = (): void => {
    if (proposal === null) return;
    void install
      .approve(proposal)
      .then(() => onInstalled())
      .catch(() => undefined);
  };

  return (
    <div className="background-removal-warning" role="status" aria-live="polite" id={id}>
      <p className="background-removal-warning-headline">{copy.headline}</p>
      {copy.detail !== null && <p className="inspector-empty">{copy.detail}</p>}
      {copy.action !== null && proposal !== null && (
        <span className="background-removal-actions">
          <Button variant="primary" type="button" disabled={install.installing} onClick={approve}>
            {install.installing ? 'Installing…' : (copy.actionLabel ?? 'Install')}
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((open) => !open)}
          >
            Details
          </Button>
        </span>
      )}
      {showDetails && proposal !== null && (
        <p className="inspector-empty">
          {proposal.description} Licences:{' '}
          {proposal.licenses.map((licence) => licence.spdx).join(', ')}.{' '}
          {proposal.privacy.disclosure}
        </p>
      )}
      {install.installing && install.progress !== null && (
        <p className="inspector-empty">
          {install.progress.phase === 'downloading'
            ? `Downloading ${formatBytes(install.progress.completedBytes)} of ${formatBytes(
                install.progress.totalBytes,
              )}…`
            : install.progress.phase === 'health_checking' || install.progress.phase === 'verifying'
              ? 'Verifying…'
              : 'Installing…'}{' '}
          <button type="button" className="inspector-text-button" onClick={install.cancel}>
            Cancel
          </button>
        </p>
      )}
      {install.error !== null && (
        <p className="inspector-empty" role="alert">
          {install.error}{' '}
          <button type="button" className="inspector-text-button" onClick={approve}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
