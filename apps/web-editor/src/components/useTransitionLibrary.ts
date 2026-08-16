/**
 * Transitions-library browsing and personalisation state.
 *
 * Favourites, recents, use counts and saved presets are USER state, not project
 * state: they follow the editor across projects the way a tool palette does, so
 * they live in `localStorage` rather than in `project.fp.json`. Putting them in
 * the project file would also make opening someone else's edit silently rewrite
 * your own shelves — the same reasoning `useEffectLibrary` records.
 *
 * Extracted from the panel so the filtering and preset rules are testable without
 * mounting React, and so both the panel and the on-cut popover can share one
 * definition of "what is on my Favourites shelf".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TRANSITION_CATALOG,
  TRANSITION_CATEGORIES,
  type CatalogTransition,
  type TransitionCategory,
  getTransition,
  searchTransitions,
} from '@framepilot/timeline-schema/transition-catalog';

/** How many recent transitions to remember. Enough to cover a working session. */
export const MAX_RECENTS = 12;

/** How many saved presets to keep. A cap, so a runaway save loop cannot fill storage. */
export const MAX_PRESETS = 60;

/**
 * Storage keys, exported so tests can reset them.
 *
 * This state deliberately OUTLIVES a component, which means it also outlives a
 * test in a shared jsdom environment — a suite that applies a transition in one
 * test and asserts an empty Recents shelf in the next becomes order-dependent.
 */
export const TRANSITION_LIBRARY_STORAGE_KEYS = [
  'framepilot.transitions.favourites',
  'framepilot.transitions.recents',
  'framepilot.transitions.uses',
  'framepilot.transitions.presets',
  'framepilot.transitions.defaults',
] as const;

const [FAVOURITES_KEY, RECENTS_KEY, USES_KEY, PRESETS_KEY, DEFAULTS_KEY] =
  TRANSITION_LIBRARY_STORAGE_KEYS;

/**
 * A user's saved transition — a catalog entry plus every value they tuned.
 *
 * Stored as loose params rather than a typed shape because that is exactly what a
 * transition effect stores: a preset IS the params of a transition someone liked,
 * and re-encoding it into a second vocabulary would mean two things to keep in
 * agreement for no gain.
 */
export interface TransitionPreset {
  readonly id: string;
  readonly name: string;
  /** The catalog id this was built from. */
  readonly kind: string;
  /** Everything else the transition carried — duration, alignment, look params. */
  readonly params: Readonly<Record<string, unknown>>;
}

/** The shelves and category filters the rail offers, in display order. */
export type TransitionFilter =
  | 'all'
  | 'recommended'
  | 'popular'
  | 'favourites'
  | 'recents'
  | 'most-used'
  | 'presets'
  | TransitionCategory;

export interface TransitionShelf {
  readonly id: TransitionFilter;
  readonly label: string;
  readonly blurb: string;
}

/**
 * `all` is first because it is the honest default: someone who has favourited
 * nothing and used nothing must not land on an empty view.
 */
export const TRANSITION_SHELVES: readonly TransitionShelf[] = [
  { id: 'all', label: 'All transitions', blurb: 'Everything in the library.' },
  { id: 'recommended', label: 'Recommended', blurb: 'Safe on almost any cut.' },
  { id: 'popular', label: 'Popular', blurb: 'What gets reached for most.' },
  { id: 'favourites', label: 'Favourites', blurb: 'Transitions you starred.' },
  { id: 'recents', label: 'Recently used', blurb: 'Your last few, newest first.' },
  { id: 'most-used', label: 'Most used', blurb: 'The ones you actually keep using.' },
  { id: 'presets', label: 'My presets', blurb: 'Transitions you tuned and saved.' },
];

/** Read JSON from localStorage, tolerating absence and corruption. */
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // A quota error, a disabled-storage browser, or hand-edited JSON must not stop
    // the panel from opening — an empty shelf is a fine degradation.
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Ignored for the same reason: losing a favourite is not worth an error surface.
  }
}

/** Ids the catalog still has — a delisted transition must not linger on a shelf. */
function readIds(key: string): readonly string[] {
  const parsed = readJson<unknown>(key, []);
  return Array.isArray(parsed)
    ? parsed.filter((v): v is string => typeof v === 'string' && getTransition(v) !== undefined)
    : [];
}

function readUses(key: string): Readonly<Record<string, number>> {
  const parsed = readJson<unknown>(key, {});
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: Record<string, number> = {};
  for (const [id, count] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof count === 'number' && Number.isFinite(count) && getTransition(id) !== undefined) {
      out[id] = count;
    }
  }
  return out;
}

function readPresets(key: string): readonly TransitionPreset[] {
  const parsed = readJson<unknown>(key, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (value): value is TransitionPreset =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as TransitionPreset).id === 'string' &&
      typeof (value as TransitionPreset).name === 'string' &&
      // A preset built on a transition this build no longer has cannot be applied,
      // so it is dropped rather than shown as an entry that fails on click.
      getTransition(String((value as TransitionPreset).kind)) !== undefined,
  );
}

/** The user's own default duration, or `null` to use each entry's own. */
interface LibraryDefaults {
  readonly durationSeconds: number | null;
  readonly rememberLastDuration: boolean;
  readonly lastDurationSeconds: number | null;
}

const DEFAULTS: LibraryDefaults = {
  durationSeconds: null,
  rememberLastDuration: true,
  lastDurationSeconds: null,
};

export interface TransitionLibrary {
  readonly query: string;
  readonly setQuery: (next: string) => void;
  readonly filter: TransitionFilter;
  readonly setFilter: (next: TransitionFilter) => void;
  /** The transitions to show, after search + shelf/category filtering. */
  readonly results: readonly CatalogTransition[];
  readonly favourites: readonly string[];
  readonly isFavourite: (id: string) => boolean;
  readonly toggleFavourite: (id: string) => void;
  readonly recents: readonly string[];
  readonly uses: Readonly<Record<string, number>>;
  /** Record a use. Called on apply, not on hover. */
  readonly noteUsed: (id: string) => void;
  readonly presets: readonly TransitionPreset[];
  readonly savePreset: (preset: Omit<TransitionPreset, 'id'>) => TransitionPreset;
  readonly renamePreset: (id: string, name: string) => void;
  readonly deletePreset: (id: string) => void;
  /** Shelves + categories for the rail, with live counts. */
  readonly rail: readonly (TransitionShelf & { readonly count: number })[];
  /** Why the current view is empty, or `null` when it is not. */
  readonly emptyReason: 'no-matches' | 'no-favourites' | 'no-recents' | 'no-presets' | null;
  /** The duration a newly-added transition should get, given this entry. */
  readonly durationFor: (entry: CatalogTransition) => number;
  readonly defaults: LibraryDefaults;
  readonly setDefaultDuration: (seconds: number | null) => void;
  readonly setRememberLastDuration: (remember: boolean) => void;
  readonly noteDuration: (seconds: number) => void;
}

export function useTransitionLibrary(): TransitionLibrary {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TransitionFilter>('all');
  const [favourites, setFavourites] = useState<readonly string[]>(() => readIds(FAVOURITES_KEY));
  const [recents, setRecents] = useState<readonly string[]>(() => readIds(RECENTS_KEY));
  const [uses, setUses] = useState<Readonly<Record<string, number>>>(() => readUses(USES_KEY));
  const [presets, setPresets] = useState<readonly TransitionPreset[]>(() =>
    readPresets(PRESETS_KEY),
  );
  const [defaults, setDefaults] = useState<LibraryDefaults>(() =>
    readJson<LibraryDefaults>(DEFAULTS_KEY, DEFAULTS),
  );

  useEffect(() => writeJson(FAVOURITES_KEY, favourites), [favourites]);
  useEffect(() => writeJson(RECENTS_KEY, recents), [recents]);
  useEffect(() => writeJson(USES_KEY, uses), [uses]);
  useEffect(() => writeJson(PRESETS_KEY, presets), [presets]);
  useEffect(() => writeJson(DEFAULTS_KEY, defaults), [defaults]);

  const toggleFavourite = useCallback((id: string): void => {
    setFavourites((current) =>
      current.includes(id) ? current.filter((other) => other !== id) : [...current, id],
    );
  }, []);

  const noteUsed = useCallback((id: string): void => {
    setRecents((current) => [id, ...current.filter((other) => other !== id)].slice(0, MAX_RECENTS));
    setUses((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  }, []);

  const savePreset = useCallback((preset: Omit<TransitionPreset, 'id'>): TransitionPreset => {
    // Time-based rather than random so a preset id sorts by when it was made,
    // which is the order the shelf shows them in.
    const saved: TransitionPreset = { ...preset, id: `preset_${Date.now().toString(36)}` };
    setPresets((current) => [saved, ...current].slice(0, MAX_PRESETS));
    return saved;
  }, []);

  const renamePreset = useCallback((id: string, name: string): void => {
    setPresets((current) => current.map((p) => (p.id === id ? { ...p, name } : p)));
  }, []);

  const deletePreset = useCallback((id: string): void => {
    setPresets((current) => current.filter((p) => p.id !== id));
  }, []);

  /**
   * Presets as catalog entries, so one grid renders both.
   *
   * A preset borrows its base entry's render kind, thumbnail and description —
   * everything a tile needs to animate — and overrides only what the user chose.
   * The alternative is a second tile component for a thing that is, visually,
   * the same transition.
   */
  const presetEntries = useMemo<readonly CatalogTransition[]>(
    () =>
      presets.flatMap((preset) => {
        const base = getTransition(preset.kind);
        if (base === undefined) return [];
        const duration = Number(preset.params.durationSeconds);
        return [
          {
            ...base,
            id: preset.id,
            label: preset.name,
            description: `Your preset, built on ${base.label}.`,
            defaultDuration: Number.isFinite(duration) ? duration : base.defaultDuration,
            tags: [...base.tags, 'preset', 'saved'],
          },
        ];
      }),
    [presets],
  );

  const applyFilter = useCallback(
    (
      source: readonly CatalogTransition[],
      which: TransitionFilter,
    ): readonly CatalogTransition[] => {
      switch (which) {
        case 'all':
          return source;
        case 'recommended':
          return source.filter((t) => t.recommended === true);
        case 'popular':
          return source.filter((t) => t.popular === true);
        case 'favourites':
          return source.filter((t) => favourites.includes(t.id));
        case 'recents': {
          // Newest first — recency order, not catalog order, which is the point.
          const inSource = new Set(source.map((t) => t.id));
          return recents
            .filter((id) => inSource.has(id))
            .map((id) => getTransition(id))
            .filter((t): t is CatalogTransition => t !== undefined);
        }
        case 'most-used': {
          const inSource = new Set(source.map((t) => t.id));
          return Object.entries(uses)
            .filter(([id]) => inSource.has(id))
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => getTransition(id))
            .filter((t): t is CatalogTransition => t !== undefined);
        }
        case 'presets':
          return presetEntries;
        default:
          return source.filter((t) => t.category === which);
      }
    },
    [favourites, presetEntries, recents, uses],
  );

  const results = useMemo(() => {
    if (filter === 'presets') {
      const terms = query.trim().toLowerCase();
      return terms === ''
        ? presetEntries
        : presetEntries.filter((p) => p.label.toLowerCase().includes(terms));
    }
    const searched = query.trim() === '' ? TRANSITION_CATALOG : searchTransitions(query);
    return applyFilter(searched, filter);
  }, [applyFilter, filter, presetEntries, query]);

  const rail = useMemo(() => {
    const counts = (which: TransitionFilter): number =>
      applyFilter(TRANSITION_CATALOG, which).length;
    return [
      ...TRANSITION_SHELVES.map((shelf) => ({ ...shelf, count: counts(shelf.id) })),
      ...TRANSITION_CATEGORIES.map((category) => ({
        id: category.id as TransitionFilter,
        label: category.label,
        blurb: category.blurb,
        count: counts(category.id),
      })),
    ];
  }, [applyFilter]);

  const emptyReason = useMemo<TransitionLibrary['emptyReason']>(() => {
    if (results.length > 0) return null;
    // Distinguished so the empty state can say something useful: "star one" is
    // actionable, "no matches for X" is a different message entirely.
    if (query.trim() !== '') return 'no-matches';
    if (filter === 'favourites') return 'no-favourites';
    if (filter === 'recents' || filter === 'most-used') return 'no-recents';
    if (filter === 'presets') return 'no-presets';
    return 'no-matches';
  }, [filter, query, results.length]);

  const durationFor = useCallback(
    (entry: CatalogTransition): number => {
      // A hard cut has no length, whatever anyone's default says.
      if (entry.isCut) return 0;
      if (defaults.durationSeconds !== null) return defaults.durationSeconds;
      if (defaults.rememberLastDuration && defaults.lastDurationSeconds !== null) {
        return defaults.lastDurationSeconds;
      }
      // Each entry's own default is the last resort AND the best one: a whip pan
      // wants 0.28s and a soft dissolve wants 1.2s, and one global number cannot
      // be right for both.
      return entry.defaultDuration;
    },
    [defaults],
  );

  return {
    query,
    setQuery,
    filter,
    setFilter,
    results,
    favourites,
    isFavourite: (id: string) => favourites.includes(id),
    toggleFavourite,
    recents,
    uses,
    noteUsed,
    presets,
    savePreset,
    renamePreset,
    deletePreset,
    rail,
    emptyReason,
    durationFor,
    defaults,
    setDefaultDuration: (seconds) =>
      setDefaults((current) => ({ ...current, durationSeconds: seconds })),
    setRememberLastDuration: (remember) =>
      setDefaults((current) => ({ ...current, rememberLastDuration: remember })),
    noteDuration: (seconds) =>
      setDefaults((current) =>
        current.rememberLastDuration ? { ...current, lastDurationSeconds: seconds } : current,
      ),
  };
}
