/**
 * Effects-library browsing state (schema v13, ADR 0088).
 *
 * Favourites and recently-used are USER state, not project state: they follow the
 * editor across projects the way a tool palette does, so they live in
 * `localStorage` rather than in `project.fp.json`. Putting them in the project
 * file would also make opening someone else's edit silently rewrite your own
 * shelves.
 *
 * Extracted from the panel component so the filtering rules are testable without
 * mounting React, and so the panel stays presentation.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EFFECT_CATALOG,
  EFFECT_CATEGORIES,
  type CatalogEffect,
  type EffectCategory,
  findEffect,
  searchEffects,
} from '@framepilot/timeline-schema/effect-catalog';

/** How many recent effects to remember. Enough to cover a working session. */
export const MAX_RECENTS = 12;

/**
 * Storage keys, exported so tests can reset them.
 *
 * This state deliberately OUTLIVES a component, which means it also outlives a
 * test in a shared jsdom environment — a suite that applies an effect in one test
 * and asserts an empty Recents shelf in the next becomes order-dependent. Tests
 * clear these in `beforeEach`; hard-coding the strings there would silently stop
 * working if a key were ever renamed.
 */
export const EFFECT_LIBRARY_STORAGE_KEYS = [
  'framepilot.effects.favourites',
  'framepilot.effects.recents',
] as const;

const [FAVOURITES_KEY, RECENTS_KEY] = EFFECT_LIBRARY_STORAGE_KEYS;

/**
 * The shelves and category filters the rail offers, in display order.
 *
 * `all` is first because it is the honest default: a user who has not favourited
 * anything and used nothing yet must not land on an empty view, which is what
 * defaulting to "Favourites" would do.
 */
export type LibraryFilter =
  | 'all'
  | 'popular'
  | 'recommended'
  | 'favourites'
  | 'recents'
  | EffectCategory;

export interface LibraryShelf {
  readonly id: LibraryFilter;
  readonly label: string;
  readonly blurb: string;
}

export const LIBRARY_SHELVES: readonly LibraryShelf[] = [
  { id: 'all', label: 'All effects', blurb: 'Everything in the library.' },
  { id: 'recommended', label: 'Recommended', blurb: 'Safe, flattering places to start.' },
  { id: 'popular', label: 'Popular', blurb: 'What gets reached for most.' },
  { id: 'favourites', label: 'Favourites', blurb: 'Effects you starred.' },
  { id: 'recents', label: 'Recently used', blurb: 'Your last few, newest first.' },
];

/** Read a string array from localStorage, tolerating absence and corruption. */
function readList(key: string): readonly string[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    // Filtered to ids the catalog still has: a delisted effect must not linger on
    // a shelf as an entry that cannot render.
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && findEffect(v) !== undefined)
      : [];
  } catch {
    // A quota error, a disabled-storage browser, or hand-edited JSON must not
    // stop the panel from opening — an empty shelf is a fine degradation.
    return [];
  }
}

function writeList(key: string, value: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Ignored for the same reason as above: losing a favourite is not worth an
    // error surface.
  }
}

export interface EffectLibrary {
  readonly query: string;
  readonly setQuery: (next: string) => void;
  readonly filter: LibraryFilter;
  readonly setFilter: (next: LibraryFilter) => void;
  /** The effects to show, after search + shelf/category filtering. */
  readonly results: readonly CatalogEffect[];
  readonly favourites: readonly string[];
  readonly isFavourite: (effectId: string) => boolean;
  readonly toggleFavourite: (effectId: string) => void;
  readonly recents: readonly string[];
  /** Record a use. Called on apply, not on hover. */
  readonly noteUsed: (effectId: string) => void;
  /** Shelves + categories for the rail, with live counts. */
  readonly rail: readonly (LibraryShelf & { readonly count: number })[];
  /** Why the current view is empty, or `null` when it is not. */
  readonly emptyReason: 'no-matches' | 'no-favourites' | 'no-recents' | null;
}

export function useEffectLibrary(): EffectLibrary {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [favourites, setFavourites] = useState<readonly string[]>(() => readList(FAVOURITES_KEY));
  const [recents, setRecents] = useState<readonly string[]>(() => readList(RECENTS_KEY));

  useEffect(() => writeList(FAVOURITES_KEY, favourites), [favourites]);
  useEffect(() => writeList(RECENTS_KEY, recents), [recents]);

  const toggleFavourite = useCallback((effectId: string): void => {
    setFavourites((current) =>
      current.includes(effectId) ? current.filter((id) => id !== effectId) : [...current, effectId],
    );
  }, []);

  const noteUsed = useCallback((effectId: string): void => {
    setRecents((current) =>
      [effectId, ...current.filter((id) => id !== effectId)].slice(0, MAX_RECENTS),
    );
  }, []);

  /** Apply the shelf/category filter to a set, preserving recents' own order. */
  const applyFilter = useCallback(
    (source: readonly CatalogEffect[], which: LibraryFilter): readonly CatalogEffect[] => {
      switch (which) {
        case 'all':
          return source;
        case 'popular':
          return source.filter((e) => e.popular === true);
        case 'recommended':
          return source.filter((e) => e.recommended === true);
        case 'favourites':
          return source.filter((e) => favourites.includes(e.id));
        case 'recents': {
          // Newest first — recency order, not catalog order, which is the entire
          // point of the shelf.
          const inSource = new Set(source.map((e) => e.id));
          return recents
            .filter((id) => inSource.has(id))
            .map((id) => findEffect(id))
            .filter((e): e is CatalogEffect => e !== undefined);
        }
        default:
          return source.filter((e) => e.category === which);
      }
    },
    [favourites, recents],
  );

  const results = useMemo(() => {
    const searched = query.trim() === '' ? EFFECT_CATALOG : searchEffects(query);
    return applyFilter(searched, filter);
  }, [applyFilter, filter, query]);

  const rail = useMemo(() => {
    const counts = (which: LibraryFilter): number => applyFilter(EFFECT_CATALOG, which).length;
    return [
      ...LIBRARY_SHELVES.map((shelf) => ({ ...shelf, count: counts(shelf.id) })),
      ...EFFECT_CATEGORIES.map((category) => ({
        id: category.id as LibraryFilter,
        label: category.label,
        blurb: category.blurb,
        count: counts(category.id),
      })),
    ];
  }, [applyFilter]);

  const emptyReason = useMemo<EffectLibrary['emptyReason']>(() => {
    if (results.length > 0) return null;
    // Distinguished so the empty state can say something useful: "star an effect"
    // is actionable, "no matches for X" is not the same message.
    if (query.trim() !== '') return 'no-matches';
    if (filter === 'favourites') return 'no-favourites';
    if (filter === 'recents') return 'no-recents';
    return 'no-matches';
  }, [filter, query, results.length]);

  return {
    query,
    setQuery,
    filter,
    setFilter,
    results,
    favourites,
    isFavourite: (effectId: string) => favourites.includes(effectId),
    toggleFavourite,
    recents,
    noteUsed,
    rail,
    emptyReason,
  };
}
