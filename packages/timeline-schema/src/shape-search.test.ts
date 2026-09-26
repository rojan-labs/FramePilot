/**
 * The shared shape search (plan/elements EL5.6): every word must match, name word-starts rank
 * first, the staples lead ties, icons join only a search, and a scope narrows it. The table in
 * `tests/fixtures/shape-search.json` is what the engine's `search_shapes` must return too; run
 * with `FRAMEPILOT_FIXTURE_UPDATE=1` to rewrite it after changing the catalogue or the ranking.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEATURED_SHAPE_PRESET_IDS, SHAPE_PRESETS } from './shape-catalog.js';
import { searchShapes, type ShapeSearchScope } from './shape-search.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'shape-search.json',
);

const QUERIES: readonly (readonly [string, ShapeSearchScope | null])[] = [
  ['box', null],
  ['arrow', null],
  ['curved arr', null],
  ['star', null],
  ['check', null],
  ['speech bubble', null],
  ['badge', null],
  ['circle', 'highlights'],
  ['heart', 'icons'],
  ['', 'numbers'],
  ['', 'arrows'],
  ['zzz', null],
  ['BOX', null],
];

const LIMIT = 12;

function table() {
  return QUERIES.map(([query, scope]) => {
    const result = searchShapes(query, scope ?? undefined, LIMIT);
    return {
      query,
      scope,
      limit: LIMIT,
      ids: result.hits.map(({ preset }) => preset.id),
      total: result.total,
    };
  });
}

describe('searchShapes', () => {
  it('lists the staples first when nothing is typed', () => {
    const { hits, total } = searchShapes('');
    expect(hits.slice(0, 6).map(({ preset }) => preset.id)).toEqual(FEATURED_SHAPE_PRESET_IDS);
    // Without a word, the icons stay out of the unscoped list.
    expect(total).toBe(SHAPE_PRESETS.length);
  });

  it('needs every word, ranks a name word-start over a tag, and reaches the icons', () => {
    const bubble = searchShapes('speech bubble').hits.map(({ preset }) => preset.id);
    expect(bubble[0]).toBe('speech-bubble/white');
    expect(bubble.every((id) => id.includes('speech') || id.startsWith('icon/'))).toBe(true);
    const check = searchShapes('check').hits.map(({ preset }) => preset.id);
    expect(check[0]).toBe('check/white');
    expect(check.some((id) => id.startsWith('icon/'))).toBe(true);
    expect(searchShapes('zzz').total).toBe(0);
  });

  it('keeps to a scope', () => {
    const icons = searchShapes('heart', 'icons').hits;
    expect(icons.every(({ shape }) => shape.id.startsWith('icon/'))).toBe(true);
    expect(
      searchShapes('', 'numbers').hits.every(({ shape }) => shape.category === 'numbers'),
    ).toBe(true);
  });

  it('matches the committed cross-runtime table', () => {
    const live = table();
    if (process.env.FRAMEPILOT_FIXTURE_UPDATE === '1') {
      const spec =
        'searchShapes (TS, packages/timeline-schema/src/shape-search.ts) and search_shapes ' +
        '(engine, render/shape_catalog.py) must return exactly `ids` and `total` for each row. ' +
        'Written by shape-search.test.ts with FRAMEPILOT_FIXTURE_UPDATE=1.';
      writeFileSync(FIXTURE, `${JSON.stringify({ spec, cases: live }, null, 2)}\n`);
    }
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: unknown };
    expect(committed.cases).toEqual(live);
  });
});
