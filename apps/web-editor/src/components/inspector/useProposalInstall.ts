/**
 * Approve-and-install one signed Capability Pack proposal.
 *
 * Shared by the Inspector's job flow and the AI sidebar's pack_missing card:
 * the approval must match the displayed proposal exactly (the host rejects a
 * stale one), progress is keyed by operation id, and the promise settles only
 * on a terminal install state. Nothing downloads without this approval.
 */
import { useCallback, useState } from 'react';
import type {
  CapabilityPackInstallProposalWire,
  CapabilityPackProgressWire,
  CapabilityPackProposalResultWire,
  CapabilityPackInstallStartResultWire,
} from '@framepilot/shared-types';
import { getBridge } from '../../editor/bridge.js';

export function useProposalInstall(): {
  readonly installing: boolean;
  readonly error: string | null;
  /** Resolves once installed; rejects on typed failure, cancellation, or drift. */
  readonly approve: (proposal: CapabilityPackInstallProposalWire) => Promise<void>;
} {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = useCallback(async (proposal: CapabilityPackInstallProposalWire): Promise<void> => {
    const bridge = getBridge();
    if (!bridge?.capabilityPackPropose || !bridge.capabilityPackInstall) return;
    setInstalling(true);
    setError(null);
    try {
      const started = await new Promise<CapabilityPackInstallStartResultWire & { ok: true }>(
        (resolve, reject) => {
          void bridge
            .capabilityPackPropose!(proposal.capabilities[0] ?? 'tracking.region')
            .then((fresh: CapabilityPackProposalResultWire) => {
              // Mirror the host's approval matching exactly: id, size, and
              // license roster must all still agree, or the offer is stale.
              const same =
                fresh.ok &&
                fresh.proposal.proposalId === proposal.proposalId &&
                fresh.proposal.downloadBytes === proposal.downloadBytes &&
                JSON.stringify(fresh.proposal.identity) === JSON.stringify(proposal.identity) &&
                JSON.stringify(fresh.proposal.licenses.map((l) => l.spdx)) ===
                  JSON.stringify(proposal.licenses.map((l) => l.spdx));
              if (!same) {
                reject(new Error('The install offer changed — review it again.'));
                return;
              }
              void bridge
                .capabilityPackInstall!({
                  proposalId: proposal.proposalId,
                  identity: proposal.identity,
                  approvedSizeBytes: proposal.downloadBytes,
                  approvedLicenseSpdx: proposal.licenses.map((license) => license.spdx),
                  approvedMediaEgress: proposal.privacy.mediaLeavesDevice,
                  approvedAt: new Date().toISOString(),
                })
                .then((start: CapabilityPackInstallStartResultWire) => {
                  if (start.ok) resolve(start);
                  else reject(new Error(start.error));
                })
                .catch(reject);
            })
            .catch(reject);
        },
      );
      await new Promise<void>((resolve, reject) => {
        const stop = bridge.onCapabilityPackProgress?.((message: CapabilityPackProgressWire) => {
          if (message.operationId !== started.operationId) return;
          if (message.phase === 'installed') {
            stop?.();
            resolve();
          } else if (message.phase === 'failed' || message.phase === 'cancelled') {
            stop?.();
            reject(new Error(message.detail ?? `Install ${message.phase}.`));
          }
        });
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    } finally {
      setInstalling(false);
    }
  }, []);

  return { installing, error, approve };
}
