import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDITOR_CAPABILITIES } from './editor-capabilities.js';
import { PROFESSIONAL_EVAL_MANIFEST } from './professional-evals.js';

/**
 * The published scorecard states how much of the product is actually proved. Hand-maintained counts
 * drift silently the moment a capability is added, which would turn the honest scorecard into a
 * stale marketing claim — so the doc is checked against the live registry here.
 */
const SCORECARD_PATH = new URL(
  '../../../docs/api/professional-operation-scorecard.md',
  import.meta.url,
);

/** Markdown row label → capability domain id. */
const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  Timeline: 'timeline',
  Motion: 'motion',
  Color: 'color',
  'Tracking/mask': 'tracking_mask',
  Audio: 'audio',
};

interface DocumentedCounts {
  readonly registered: number;
  readonly unsupported: number;
}

function parseScorecardTable(markdown: string): Map<string, DocumentedCounts> {
  const rows = new Map<string, DocumentedCounts>();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 3) continue;
    const label = cells[0]!.replaceAll('*', '').trim();
    const registered = Number(cells[1]!.replaceAll('*', '').trim());
    const unsupported = Number(cells[2]!.replaceAll('*', '').trim());
    if (!Number.isFinite(registered) || !Number.isFinite(unsupported)) continue;
    rows.set(label, { registered, unsupported });
  }
  return rows;
}

describe('published professional operation scorecard', () => {
  const markdown = readFileSync(SCORECARD_PATH, 'utf8');
  const documented = parseScorecardTable(markdown);

  it.each(Object.entries(DOMAIN_LABELS))(
    'documents the real %s capability counts',
    (label, domain) => {
      const rows = PROFESSIONAL_EVAL_MANIFEST.filter((row) => row.domain === domain);
      expect(documented.get(label)).toEqual({
        registered: rows.filter((row) => row.availability === 'registered').length,
        unsupported: rows.filter((row) => row.availability === 'unsupported').length,
      });
    },
  );

  it('documents the real totals', () => {
    expect(documented.get('Total')).toEqual({
      registered: PROFESSIONAL_EVAL_MANIFEST.filter((row) => row.availability === 'registered')
        .length,
      unsupported: PROFESSIONAL_EVAL_MANIFEST.filter((row) => row.availability === 'unsupported')
        .length,
    });
  });

  it('covers every capability domain that has rows', () => {
    const documentedDomains = new Set(Object.values(DOMAIN_LABELS));
    const missing = EDITOR_CAPABILITIES.map((capability) => capability.domain).filter(
      (domain) => !documentedDomains.has(domain),
    );
    expect(missing).toEqual([]);
  });

  it('keeps the required stage sequence in the doc identical to the contract', () => {
    expect(markdown).toContain(
      '`resolve → compile → validate → apply → invert → verify → persist/reload → cross-host`',
    );
  });
});
