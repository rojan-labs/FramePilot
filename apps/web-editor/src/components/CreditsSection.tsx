/**
 * Credits — every asset in this project that obliges a credit, and one action
 * that puts them all on the clipboard.
 *
 * ## Why this is part of export and not a settings page
 *
 * `Asset.source` (schema v20) records a licence obligation at the moment a track
 * is fetched. The obligation itself lands weeks later, when the user publishes.
 * A badge in a search panel they closed cannot discharge it — so the project
 * remembers, and this is where it says so, next to the button that produces the
 * file they are about to upload (ADR 0138,
 * `plan/3rd-party-sourcing/PHASE-1-provenance-schema.md`).
 *
 * The empty state is a positive confirmation, not a blank panel: "nothing needs
 * crediting" is the answer to a real question, and leaving it unanswered would
 * make the user go and check by hand.
 *
 * Credits are **not** burned into the rendered video. That is a compositing
 * decision with layout, duration and style implications, and most creators
 * credit in a description instead. Its absence is a decision, not an omission.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Asset } from '@framepilot/timeline-schema';
import { Button } from '@framepilot/ui';

export interface CreditsSectionProps {
  /** The project's media bin. Assets with no `source` are ignored entirely. */
  readonly assets: readonly Asset[];
}

/** An asset that obliges a credit, reduced to what the list renders. */
interface CreditRow {
  readonly assetId: string;
  /** The ready-to-paste line the provider supplied, or one assembled from what it did. */
  readonly line: string;
  readonly license: string;
  readonly licenseUrl?: string | undefined;
}

/**
 * The credit line for one asset.
 *
 * The provider's own `attribution` string is preferred verbatim — Openverse
 * composes a correct one per licence, and rewriting it risks producing a credit
 * that does not satisfy the terms. The fallback assembles the same three facts
 * for a provider that supplies none, and degrades a field at a time rather than
 * dropping the whole line: an incomplete credit the user can finish beats no
 * credit at all.
 */
function creditLine(asset: Asset): string {
  const source = asset.source;
  if (!source) return '';
  if (source.attribution) return source.attribution;
  const who = source.creator ?? 'Unknown creator';
  return `"${asset.path.split(/[/\\]/).pop() ?? asset.id}" by ${who} — ${source.license}`;
}

/** Rows for every asset whose licence obliges a credit, in bin order. */
export function creditRows(assets: readonly Asset[]): CreditRow[] {
  return assets
    .filter((asset) => asset.source?.attributionRequired === true)
    .map((asset) => ({
      assetId: asset.id,
      line: creditLine(asset),
      license: asset.source?.license ?? '',
      licenseUrl: asset.source?.licenseUrl ?? undefined,
    }));
}

/** Every credit as one plain-text block, ready to paste into a video description. */
export function creditsText(assets: readonly Asset[]): string {
  return creditRows(assets)
    .map((row) => row.line)
    .join('\n');
}

export function CreditsSection({ assets }: CreditsSectionProps): JSX.Element {
  const rows = useMemo(() => creditRows(assets), [assets]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(creditsText(assets)).then(() => setCopied(true));
  }, [assets]);

  if (rows.length === 0) {
    return (
      <section className="export-credits" aria-labelledby="export-credits-heading">
        <h3 id="export-credits-heading">Credits</h3>
        <p className="export-credits-empty">No tracks in this project require credit.</p>
      </section>
    );
  }

  return (
    <section className="export-credits" aria-labelledby="export-credits-heading">
      <h3 id="export-credits-heading">Credits</h3>
      <p className="export-credits-note">
        {rows.length === 1
          ? '1 track in this project requires credit. Paste this into your video description.'
          : `${rows.length} tracks in this project require credit. Paste these into your video description.`}
      </p>
      <ul className="export-credits-list">
        {rows.map((row) => (
          <li key={row.assetId} className="export-credits-item">
            <span className="export-credits-line">{row.line}</span>
            {row.licenseUrl ? (
              <a
                className="export-credits-license"
                href={row.licenseUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {row.license}
              </a>
            ) : (
              <span className="export-credits-license">{row.license}</span>
            )}
          </li>
        ))}
      </ul>
      <Button variant="ghost" type="button" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy all credits'}
      </Button>
      {/* The label flip is invisible to a screen reader; announce the result
          separately, outside the button so it never joins its accessible name. */}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Credits copied' : ''}
      </span>
    </section>
  );
}
