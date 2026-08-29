/**
 * One attached reference, as a tile (plan/system-mission P3.1, P3.6).
 *
 * A reference is a picture before it is a filename. The chip this replaces said
 * `fast-cut-vertical.mp4 · pacing` and left the editor to remember which of the three
 * videos they attached that was — so the tile leads with the thing itself: the image, or
 * the first frame of the video, resolved by the SAME `useAssetThumbnail` the media bin
 * uses (the imported copy under the projects root is an asset in every way that hook
 * cares about). Beside it: the name, the runtime for a video, the role the classifier
 * guessed, and the remove button.
 *
 * The tile is also a disclosure. Open it and it shows the profile's `constraints`
 * verbatim — the exact lines the planner reads, not a summary of them — the analysis
 * timestamp, a role selector, and Re-analyze. A failed analysis states its reason there
 * with the retry beside it, instead of a toast that is gone by the time anyone reads it.
 */
import { useMemo, useState, type JSX } from 'react';
import type { ReferenceRole } from '@framepilot/ai-sdk';
import type { Asset } from '@framepilot/timeline-schema';
import type { AiStreamReferenceProfile } from '@framepilot/shared-types';
import type { Attachment } from '../../ai/conversation.js';
import { useAssetThumbnail } from '../../editor/useAssetThumbnail.js';
import { formatClock } from '../../editor/captions.js';
import { Film, Image as ImageGlyph, X } from '../icons.js';

/** Every role the classifier can assign; the tile lets the editor correct it (P3.6). */
const REFERENCE_ROLES: readonly ReferenceRole[] = [
  'style',
  'pacing',
  'caption-style',
  'color',
  'brand-logo',
  'thumbnail',
  'b-roll',
  'character',
  'design',
];

/**
 * The measured runtime, when the analysis produced one.
 *
 * `profile.video` crosses the IPC bridge as an opaque record (the sidecar's payload is
 * validated by the ai-sdk schema in main, not re-declared here), so the read is narrowed
 * rather than cast: a duration that is not a positive finite number is no duration.
 */
export function referenceDurationSeconds(
  profile: AiStreamReferenceProfile | undefined,
): number | undefined {
  const raw = profile?.video?.['durationS'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export interface ReferenceTileProps {
  readonly attachment: Attachment;
  readonly onRemove: (id: string) => void;
  /** Measure this reference again (P3.6) — e.g. after a failed analysis. */
  readonly onReanalyze?: (id: string) => void;
  /** Correct the role the classifier guessed (P3.6). */
  readonly onChangeRole?: (id: string, role: ReferenceRole) => void;
}

/**
 * The tile's picture: the image itself, a captured first frame for a video, or the type
 * glyph when neither is available (a browser build, or an attachment whose import failed
 * before it had a path). The glyph is the honest fallback — a grey rectangle pretending
 * to be a frame would be worse than saying "video".
 */
function ReferenceThumb({ attachment }: { readonly attachment: Attachment }): JSX.Element {
  const [broken, setBroken] = useState(false);
  // A stable identity per (id, path, kind): `useAssetThumbnail` keys its capture effect
  // on the asset object, so rebuilding it every render would restart the video decode
  // on every keystroke in the composer.
  const asset = useMemo<Asset | undefined>(() => {
    if (!attachment.path) return undefined;
    if (attachment.kind !== 'video' && attachment.kind !== 'image') return undefined;
    return { id: attachment.id, path: attachment.path, kind: attachment.kind };
  }, [attachment.id, attachment.path, attachment.kind]);
  const thumb = useAssetThumbnail(asset);
  const Glyph = attachment.kind === 'image' ? ImageGlyph : Film;

  if (thumb.status === 'ready' && !broken) {
    return (
      <img
        className="ai-ref-tile-img"
        src={thumb.url}
        alt=""
        aria-hidden="true"
        onError={() => setBroken(true)}
      />
    );
  }
  return <Glyph size={14} aria-hidden="true" className="ai-ref-tile-glyph" />;
}

export function ReferenceTile(props: ReferenceTileProps): JSX.Element {
  const { attachment } = props;
  const [open, setOpen] = useState(false);
  const analyzed = attachment.profile?.analyzedAt;
  const constraints = attachment.profile?.constraints ?? [];
  const expandable = attachment.status === 'ready' || attachment.status === 'failed';
  const durationS = referenceDurationSeconds(attachment.profile);

  return (
    <div
      className="ai-ref-tile"
      data-kind={attachment.kind}
      data-status={attachment.status}
      data-open={open ? '' : undefined}
    >
      <span className="ai-ref-tile-thumb">
        <ReferenceThumb attachment={attachment} />
      </span>
      <span className="ai-ref-tile-body">
        {expandable ? (
          <button
            type="button"
            className="ai-ref-tile-name ai-chip-disclosure"
            aria-expanded={open}
            aria-label={`What FramePilot learned from ${attachment.name}`}
            onClick={() => setOpen((value) => !value)}
          >
            {attachment.name}
          </button>
        ) : (
          <span className="ai-ref-tile-name" title={attachment.name}>
            {attachment.name}
          </span>
        )}
        <span className="ai-ref-tile-meta">
          {durationS !== undefined && attachment.kind === 'video' ? (
            <span className="ai-ref-tile-duration tabular">{formatClock(durationS)}</span>
          ) : null}
          {attachment.role ? (
            <span className="ai-chip-badge" data-role={attachment.role}>
              {attachment.role}
            </span>
          ) : null}
          {attachment.status && attachment.status !== 'ready' ? (
            <span
              className="ai-chip-status"
              data-status={attachment.status}
              title={attachment.error ?? attachment.status}
            >
              {attachment.status === 'analyzing' ? 'analyzing…' : attachment.status}
            </span>
          ) : null}
        </span>
      </span>
      <button
        type="button"
        className="ai-ref-tile-remove"
        aria-label={`Remove ${attachment.name}`}
        onClick={() => props.onRemove(attachment.id)}
      >
        <X size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="ai-chip-detail" role="group" aria-label={`${attachment.name} reference`}>
          {attachment.status === 'failed' ? (
            <p className="ai-chip-detail-error">
              {attachment.error ?? 'The analysis did not finish.'}
            </p>
          ) : (
            <>
              <p className="ai-chip-detail-meta">
                {analyzed === undefined
                  ? 'Not analyzed yet.'
                  : `Analyzed ${new Date(analyzed).toLocaleString()}`}
              </p>
              {constraints.length > 0 ? (
                <ul className="ai-chip-detail-list">
                  {constraints.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="ai-chip-detail-meta">
                  Nothing measurable was found in this file, so it adds no constraints.
                </p>
              )}
            </>
          )}
          <div className="ai-chip-detail-actions">
            {props.onChangeRole && (
              <label className="ai-chip-detail-role">
                <span>Use as</span>
                <select
                  aria-label={`Role for ${attachment.name}`}
                  value={attachment.role ?? 'style'}
                  onChange={(event) =>
                    props.onChangeRole?.(attachment.id, event.target.value as ReferenceRole)
                  }
                >
                  {REFERENCE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {props.onReanalyze && attachment.path !== undefined && (
              <button
                type="button"
                className="ai-btn ai-btn--quiet"
                onClick={() => props.onReanalyze?.(attachment.id)}
              >
                Re-analyze
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
