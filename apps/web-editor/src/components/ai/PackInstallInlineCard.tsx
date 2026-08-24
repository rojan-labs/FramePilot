/**
 * Inline install approval for a pack a failed AI tool call said it needed.
 *
 * The executor's `pack_missing` outcome carries the exact signed proposal; the
 * model cannot install anything itself, so this card is the human's one-click
 * path from "the AI said it needs a pack" to "installed — ask again". Approval
 * matches the displayed proposal byte-for-byte and nothing downloads without
 * the click.
 */
import { useState } from 'react';
import type { CapabilityPackInstallProposalWire } from '@framepilot/shared-types';
import { Button } from '@framepilot/ui';
import { useProposalInstall } from '../inspector/useProposalInstall.js';

export function packMissingProposal(result: unknown): CapabilityPackInstallProposalWire | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (record.code !== 'pack_missing') return null;
  const proposalResult = record.proposal as Record<string, unknown> | undefined;
  if (
    typeof proposalResult !== 'object' ||
    proposalResult === null ||
    proposalResult.ok !== true
  ) {
    return null;
  }
  const proposal = proposalResult.proposal as CapabilityPackInstallProposalWire | undefined;
  if (
    typeof proposal !== 'object' ||
    proposal === null ||
    typeof proposal.proposalId !== 'string' ||
    typeof proposal.displayName !== 'string'
  ) {
    return null;
  }
  return proposal;
}

export function PackInstallInlineCard({
  proposal,
}: {
  proposal: CapabilityPackInstallProposalWire;
}): JSX.Element {
  const { installing, error, approve } = useProposalInstall();
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return <></>;

  const sizeMb = (proposal.downloadBytes / 1_000_000).toFixed(1);
  const licenses = proposal.licenses.map((license) => license.spdx).join(', ');

  if (installed) {
    return (
      <div className="ai-pack-install" role="status">
        {proposal.displayName} installed. Run the request again to continue.
      </div>
    );
  }

  return (
    <div className="ai-pack-install" role="dialog" aria-label="capability pack install">
      <p>
        <strong>{proposal.displayName}</strong> — {sizeMb} MB download. Licenses: {licenses}.
        {proposal.privacy.mediaLeavesDevice ? '' : ' Media never leaves this machine.'}
      </p>
      <span className="ai-pack-install__actions">
        <Button
          variant="secondary"
          type="button"
          disabled={installing}
          onClick={() => {
            void approve(proposal)
              .then(() => setInstalled(true))
              .catch(() => undefined);
          }}
        >
          {installing ? 'Installing…' : `Install ${sizeMb} MB`}
        </Button>
        <Button variant="ghost" type="button" onClick={() => setDismissed(true)}>
          Not now
        </Button>
      </span>
      {error !== null && (
        <p role="alert" className="ai-pack-install__error">
          {error}
        </p>
      )}
    </div>
  );
}
