/**
 * Credits — every asset in this project that carries a credit, and the actions
 * that put them on the clipboard.
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
 * ## Two groups, because there are two different obligations
 *
 * **Required** is a licence term: a CC-BY track is not licensed unless the
 * credit appears. **Suggested** is a courtesy: Pexels' content licence obliges
 * the end user to credit nobody, while its API guidelines ask the *app* to link
 * to Pexels and to name photographers "when possible" — two obligations landing
 * on two different parties.
 *
 * Collapsing them either way is wrong. Marking Pexels items "required" would
 * tell users their video needs a credit line it does not, which teaches them to
 * ignore the badge on the CC-BY track where it is real. Dropping the credit
 * entirely would throw away the photographer's name the provider took care to
 * send (`plan/3rd-party-sourcing/photo-video/README.md` §D4).
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

/** An asset that carries a credit, reduced to what the list renders. */
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

function toRow(asset: Asset): CreditRow {
  return {
    assetId: asset.id,
    line: creditLine(asset),
    license: asset.source?.license ?? '',
    licenseUrl: asset.source?.licenseUrl ?? undefined,
  };
}

/** Rows for every asset whose **licence** obliges a credit, in bin order. */
export function creditRows(assets: readonly Asset[]): CreditRow[] {
  return assets.filter((asset) => asset.source?.attributionRequired === true).map(toRow);
}

/**
 * Rows for assets that carry a credit without requiring one.
 *
 * An asset only appears here if the provider actually supplied a name — a
 * "suggested credit" with nobody in it is not a suggestion, it is a blank line
 * the user would paste into their description.
 */
export function suggestedCreditRows(assets: readonly Asset[]): CreditRow[] {
  return assets
    .filter(
      (asset) =>
        asset.source !== undefined &&
        asset.source !== null &&
        asset.source.attributionRequired !== true &&
        (Boolean(asset.source.attribution) || Boolean(asset.source.creator)),
    )
    .map(toRow);
}

/** Every required credit as one plain-text block, ready to paste. */
export function creditsText(assets: readonly Asset[]): string {
  return creditRows(assets)
    .map((row) => row.line)
    .join('\n');
}

/** Every suggested credit as one plain-text block. */
export function suggestedCreditsText(assets: readonly Asset[]): string {
  return suggestedCreditRows(assets)
    .map((row) => row.line)
    .join('\n');
}

export function CreditsSection({ assets }: CreditsSectionProps): JSX.Element {
  const required = useMemo(() => creditRows(assets), [assets]);
  const suggested = useMemo(() => suggestedCreditRows(assets), [assets]);

  if (required.length === 0 && suggested.length === 0) {
    return (
      <section className="export-credits" aria-labelledby="export-credits-heading">
        <h3 id="export-credits-heading">Credits</h3>
        <p className="export-credits-empty">Nothing in this project requires credit.</p>
      </section>
    );
  }

  return (
    <section className="export-credits" aria-labelledby="export-credits-heading">
      <h3 id="export-credits-heading">Credits</h3>

      {required.length > 0 ? (
        <CreditGroup
          rows={required}
          text={creditsText(assets)}
          note={
            required.length === 1
              ? '1 track in this project requires credit. Paste this into your video description.'
              : `${required.length} tracks in this project require credit. Paste these into your video description.`
          }
          copyLabel="Copy all credits"
          copyAriaLabel="Copy required credits"
        />
      ) : (
        // Said out loud rather than left as an absence: with only Pexels media in
        // the project, "do I owe anyone a credit?" still has an answer.
        <p className="export-credits-empty">Nothing in this project requires credit.</p>
      )}

      {suggested.length > 0 ? (
        <CreditGroup
          rows={suggested}
          text={suggestedCreditsText(assets)}
          heading="Suggested credits"
          note="Not required by the licence, but appreciated by the creators."
          copyLabel="Copy suggested credits"
          copyAriaLabel="Copy suggested credits"
        />
      ) : null}
    </section>
  );
}

function CreditGroup({
  rows,
  text,
  heading,
  note,
  copyLabel,
  copyAriaLabel,
}: {
  readonly rows: readonly CreditRow[];
  readonly text: string;
  readonly heading?: string;
  readonly note: string;
  readonly copyLabel: string;
  readonly copyAriaLabel: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
  }, [text]);

  return (
    <div className="export-credits-group">
      {heading ? <h4 className="export-credits-subhead">{heading}</h4> : null}
      <p className="export-credits-note">{note}</p>
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
      {/* Two copy buttons can coexist here, so each gets a distinct accessible
          name — "Copy all credits" twice would be ambiguous by name alone. */}
      <Button variant="ghost" type="button" aria-label={copyAriaLabel} onClick={onCopy}>
        {copied ? 'Copied' : copyLabel}
      </Button>
      {/* The label flip is invisible to a screen reader; announce the result
          separately, outside the button so it never joins its accessible name. */}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Credits copied' : ''}
      </span>
    </div>
  );
}
