/**
 * Searching the shape catalogue and the icons (plan/elements EL5.2, EL5.6): the one ranking the
 * Shapes tab and the agent's `search_elements` share, so a word typed and a word asked for find
 * the same shapes in the same order. The engine's `shape_catalog.search_shapes` ranks
 * identically, pinned by `tests/fixtures/shape-search.json`.
 *
 * Every word of the query must match. A word scores 0 when it is the shape's (or its style's)
 * whole name, 1 when the name starts with it, 2 when another word of the name does, 3 when the
 * name contains it anywhere, 4 when a tag or the category does; a shape scores its worst word. Icons rank after every
 * catalogue shape (the catalogue is curated; the icons are the long tail), and ties keep
 * catalogue order, the staples first.
 */
import {
  SHAPE_ICON_NAMES,
  SHAPE_ICON_PREFIX,
  SHAPE_PRESETS,
  iconShapeDescriptor,
  type ShapeCategory,
  type ShapeDescriptor,
  type ShapePreset,
} from './shape-catalog.js';

/** A category to search within, or `icons` for the Lucide icons alone. */
export type ShapeSearchScope = ShapeCategory | 'icons';

export interface ShapeSearchHit {
  readonly shape: ShapeDescriptor;
  readonly preset: ShapePreset;
}

export interface ShapeSearchResult {
  /** The best hits, at most `limit`. */
  readonly hits: readonly ShapeSearchHit[];
  /** How many matched in all. */
  readonly total: number;
}

let icons: readonly ShapeSearchHit[] | undefined;
/** Every icon as a hit, built once on first use. */
export function shapeIconHits(): readonly ShapeSearchHit[] {
  icons ??= SHAPE_ICON_NAMES.flatMap((name) => {
    const shape = iconShapeDescriptor(`${SHAPE_ICON_PREFIX}${name}`);
    return shape === undefined ? [] : [{ shape, preset: shape.presets[0]! }];
  });
  return icons;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');

/** Icons rank after every catalogue shape: add this to an icon's score. */
const ICON_RANK_OFFSET = 5;

/** How well `hit` matches every term (lower is better), or `null` when a term misses. */
function score(hit: ShapeSearchHit, terms: readonly string[]): number | null {
  const names = [hit.preset.name.toLowerCase(), hit.shape.name.toLowerCase()];
  const nameWords = names.flatMap(words);
  const otherWords = [...hit.shape.tags.flatMap(words), ...words(hit.shape.category)];
  let worst = 0;
  for (const term of terms) {
    let best: number;
    if (names.some((name) => name === term)) best = 0;
    else if (names.some((name) => name.startsWith(term))) best = 1;
    else if (nameWords.some((word) => word.startsWith(term))) best = 2;
    else if (names.some((name) => name.includes(term))) best = 3;
    else if (otherWords.some((word) => word.includes(term))) best = 4;
    else return null;
    worst = Math.max(worst, best);
  }
  return hit.shape.id.startsWith(SHAPE_ICON_PREFIX) ? worst + ICON_RANK_OFFSET : worst;
}

/**
 * The shapes and icons `query` finds.
 *
 * @param query - Words to find; empty lists the scope (icons join an unscoped list only for a
 *   search, since 1,700 of them would bury the catalogue).
 * @param scope - A category, `icons`, or everything when absent.
 * @param limit - The most hits to return; `total` still counts them all.
 */
export function searchShapes(
  query: string,
  scope?: ShapeSearchScope,
  limit = Number.POSITIVE_INFINITY,
): ShapeSearchResult {
  const terms = words(query);
  const catalogue =
    scope === 'icons'
      ? []
      : scope === undefined
        ? SHAPE_PRESETS
        : SHAPE_PRESETS.filter(({ shape }) => shape.category === scope);
  const withIcons = scope === 'icons' || (scope === undefined && terms.length > 0);
  const pool = withIcons ? [...catalogue, ...shapeIconHits()] : catalogue;
  if (terms.length === 0) return { hits: pool.slice(0, limit), total: pool.length };
  const ranked = pool
    .map((hit, index) => ({ hit, index, rank: score(hit, terms) }))
    .filter((row): row is { hit: ShapeSearchHit; index: number; rank: number } => row.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  return { hits: ranked.slice(0, limit).map((row) => row.hit), total: ranked.length };
}
