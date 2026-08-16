/**
 * Transitions panel — the browsable transition library.
 *
 * Deliberately the same shape as the Effects panel (a search field, a horizontal
 * filter strip, a thumbnail grid whose tiles animate on hover), because they are
 * the same job and an editor should not have to learn two libraries. What differs
 * is what a tile *is*: an effect tile shows a look on one frame, a transition tile
 * shows a cut being treated, which needs two frames and the real shader between
 * them (see {@link TransitionThumbnail}).
 *
 * ## Where a transition lands
 *
 * A transition needs a CUT, and there is no such thing as "the cut you are looking
 * at" in general. So this panel resolves a target in one documented order:
 *
 *   1. an edit point the timeline has selected — the user pointed at a cut;
 *   2. the cut entering the selected clip — selecting a clip and clicking a
 *      transition obviously means "put it on the front of this shot";
 *   3. the cut nearest the playhead — where the user is looking.
 *
 * When none of those exists the tiles stay clickable and say why rather than
 * going grey: "there is no cut here" is information, and a disabled control that
 * cannot explain itself is the thing the brief calls out.
 */
import { useCallback, useMemo, useState } from 'react';
import { Input } from '@framepilot/ui';
import { transitionEligibility } from '@framepilot/editor-core';
import type { CatalogTransition } from '@framepilot/timeline-schema/transition-catalog';
import type { UseEditor } from '../editor/useEditor.js';
import { addTransitionPatch, removeTransitionPatch } from '../editor/patch-builders.js';
import { findClip, trackJunctions } from '../editor/selectors.js';
import { TransitionThumbnail } from './TransitionThumbnail.js';
import { useTransitionLibrary, type TransitionFilter } from './useTransitionLibrary.js';
import { recommendTransitions } from './transition-recommendations.js';
import { TRANSITION_DND_TYPE } from './transition-catalog.js';
import { ICON_SIZE, Search, Sparkles, Star } from './icons.js';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.js';

export interface TransitionsPanelProps {
  readonly editor: UseEditor;
  /**
   * The cut the timeline currently has selected, named by its incoming clip.
   * Absent means nothing is selected there — see the resolution order above.
   */
  readonly selectedCutToClipId?: string | null;
}

/** What the panel will do if a tile is clicked right now, and why. */
interface Target {
  readonly fromClipId: string;
  readonly toClipId: string;
  /** Human sentence for the header and for the tile tooltips. */
  readonly note: string;
  readonly ok: boolean;
}

export function TransitionsPanel({
  editor,
  selectedCutToClipId = null,
}: TransitionsPanelProps): JSX.Element {
  const library = useTransitionLibrary();
  const reducedMotion = usePrefersReducedMotion();
  const { selection, timeline } = editor.state;
  /** The tile under the pointer/focus — only one animates at a time. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable');

  /** Which catalog ids are already on a cut somewhere, for the "in use" marker. */
  const appliedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        const effect = clip.effects.find((e) => e.type === 'transition');
        if (effect) ids.add(String(effect.params?.kind ?? ''));
      }
    }
    return ids;
  }, [timeline]);

  /**
   * Which cut a click lands on, and why. See the module note for the order.
   *
   * A function rather than a value so it can be re-run at click time against a
   * live playhead — see {@link apply}.
   */
  const resolveTarget = useCallback((): Target => {
    // Every real cut in the project, in sequence order. Butt-joined only: a gap
    // is not a cut, and offering a transition across one would be a promise the
    // engine refuses.
    const junctions = timeline.tracks
      .flatMap((track) => trackJunctions(track))
      .filter((junction) => junction.touching)
      .sort((a, b) => a.cutTime - b.cutTime);
    if (junctions.length === 0) {
      return {
        fromClipId: '',
        toClipId: '',
        ok: false,
        note: 'Nothing to transition between yet — a transition treats a cut, so put two clips end to end first.',
      };
    }
    const chosen =
      junctions.find((j) => j.toClipId === selectedCutToClipId) ??
      junctions.find((j) => j.toClipId === selection) ??
      // Nearest cut to the playhead: where the user is actually looking.
      junctions
        .slice()
        .sort(
          (a, b) =>
            Math.abs(a.cutTime - editor.getPlayhead()) - Math.abs(b.cutTime - editor.getPlayhead()),
        )[0];
    if (chosen === undefined) {
      return {
        fromClipId: '',
        toClipId: '',
        ok: false,
        note: 'No cut here yet — a transition treats the boundary between two clips.',
      };
    }
    const clip = findClip(timeline, chosen.toClipId);
    const label = clip ? `“${chosen.toClipId}”` : chosen.toClipId;
    return {
      fromClipId: chosen.fromClipId,
      toClipId: chosen.toClipId,
      ok: true,
      note: `Applies to the cut before ${label}. Drag a tile onto any other cut instead.`,
    };
  }, [editor, selection, selectedCutToClipId, timeline]);

  /** The resolution as of this render — what the header describes. */
  const target = useMemo(() => resolveTarget(), [resolveTarget]);

  const apply = useCallback(
    (entry: CatalogTransition): void => {
      // Resolved again HERE rather than trusting the memo above. This panel is
      // memoised on a key that deliberately excludes the playhead (so a 60fps
      // clock does not re-render 77 tiles), which means the header's "nearest
      // cut" can be a moment stale. The label being stale is cosmetic; applying
      // to the wrong cut is not.
      const target = resolveTarget();
      if (!target.ok) return;
      // The hard cut is "take it off", not "put something on" — one entry, and the
      // only one whose click removes rather than adds.
      if (entry.isCut) {
        const removal = removeTransitionPatch(timeline, target.toClipId);
        if (removal) editor.applyPatch(removal);
        return;
      }
      const duration = library.durationFor(entry);
      const eligibility = transitionEligibility(timeline, {
        fromClipId: target.fromClipId,
        toClipId: target.toClipId,
        durationSeconds: duration,
        kind: entry.id,
      });
      if (!eligibility.ok) return;
      const patch = addTransitionPatch(
        timeline,
        target.fromClipId,
        entry.id,
        eligibility.durationSeconds,
      );
      if (patch === null) return;
      editor.applyPatch(patch);
      library.noteUsed(entry.id);
      library.noteDuration(eligibility.durationSeconds);
    },
    [editor, library, resolveTarget, timeline],
  );

  /**
   * Suggestions for the resolved cut, with the reason each one was made.
   *
   * Only shown on the unfiltered, unsearched view: someone who has typed a query
   * or picked a shelf has already said what they are looking for, and a strip of
   * guesses above their results is noise at exactly the wrong moment.
   */
  const suggestions = useMemo(
    () =>
      target.ok && library.query.trim() === '' && library.filter === 'all'
        ? recommendTransitions(timeline, target.toClipId)
        : [],
    [library.filter, library.query, target, timeline],
  );

  const activeShelf = library.rail.find((entry) => entry.id === library.filter);

  return (
    <section className="transitions" aria-label="transitions panel" data-density={density}>
      <div className="fx-search tr-search">
        <Input
          uiSize="sm"
          type="search"
          aria-label="search transitions"
          placeholder="Search transitions…"
          icon={<Search size={ICON_SIZE.sm} />}
          value={library.query}
          onChange={(event) => library.setQuery(event.target.value)}
        />
        <button
          type="button"
          className="tr-density"
          aria-pressed={density === 'compact'}
          aria-label={density === 'compact' ? 'Show larger previews' : 'Show more at once'}
          title={density === 'compact' ? 'Larger previews' : 'More at once'}
          onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
        >
          {density === 'compact' ? '▦' : '▤'}
        </button>
      </div>

      {/* Plain toggle buttons, NOT a tablist: a tablist promises tabpanels wired
          with aria-controls, and these filter a list in place. `aria-pressed` is
          the accurate role for a filter chip. */}
      <div
        className="fx-filters"
        role="group"
        aria-label="transition categories"
        onWheel={(event) => {
          // A vertical wheel scrolls this strip HORIZONTALLY; without it the
          // categories past the fold are only reachable by dragging.
          const strip = event.currentTarget;
          if (strip.scrollWidth <= strip.clientWidth) return;
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          strip.scrollLeft += event.deltaY;
        }}
      >
        {library.rail.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`fx-filter${library.filter === entry.id ? ' is-active' : ''}`}
            aria-pressed={library.filter === entry.id}
            // Zero-count shelves stay clickable: their empty state is what tells a
            // user how to fill them.
            onClick={() => library.setFilter(entry.id as TransitionFilter)}
            title={entry.blurb}
          >
            {entry.label}
            <span className="fx-filter-count">{entry.count}</span>
          </button>
        ))}
      </div>

      <p className={`tr-target${target.ok ? '' : ' is-blocked'}`} role="status">
        {target.note}
      </p>

      <div className="fx-body">
        <div className="fx-main">
          {activeShelf !== undefined && library.query.trim() === '' && (
            <p className="fx-blurb">{activeShelf.blurb}</p>
          )}

          {suggestions.length > 0 && (
            <section className="tr-suggested" aria-label="suggested for this cut">
              <h3 className="tr-suggested-title">Suggested for this cut</h3>
              <div className="fx-grid tr-grid" role="list">
                {suggestions.map(({ transition: entry, reason }) => (
                  <div className="fx-card tr-card" role="listitem" key={`suggested-${entry.id}`}>
                    <button
                      type="button"
                      className="fx-card-apply tr-card-apply"
                      // The reason rides the accessible name: a suggestion nobody
                      // can interrogate is indistinguishable from a random pick.
                      aria-label={`${entry.label}. ${reason}`}
                      title={reason}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(TRANSITION_DND_TYPE, entry.id);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      onMouseEnter={() => setActiveId(`suggested-${entry.id}`)}
                      onMouseLeave={() =>
                        setActiveId((c) => (c === `suggested-${entry.id}` ? null : c))
                      }
                      onFocus={() => setActiveId(`suggested-${entry.id}`)}
                      onBlur={() => setActiveId((c) => (c === `suggested-${entry.id}` ? null : c))}
                      onClick={() => apply(entry)}
                    >
                      <TransitionThumbnail
                        transition={entry}
                        active={activeId === `suggested-${entry.id}`}
                        reducedMotion={reducedMotion}
                      />
                      <span className="fx-card-label">{entry.label}</span>
                      <span className="tr-card-why">{reason}</span>
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {library.emptyReason !== null ? (
            <EmptyState reason={library.emptyReason} query={library.query} />
          ) : (
            <div className="fx-grid tr-grid" role="list" aria-label="transitions">
              {library.results.map((entry) => {
                const applied = appliedIds.has(entry.id);
                const favourite = library.isFavourite(entry.id);
                const seconds = library.durationFor(entry);
                return (
                  <div className="fx-card tr-card" role="listitem" key={entry.id}>
                    <button
                      type="button"
                      className="fx-card-apply tr-card-apply"
                      data-applied={applied || undefined}
                      // The accessible name carries the description and the target,
                      // so a screen-reader user gets what the hover animation and
                      // the header convey visually.
                      aria-label={`${entry.label}. ${entry.description}${
                        target.ok ? ` ${target.note}` : ''
                      }`}
                      title={`${entry.description}${target.ok ? '' : `\n\n${target.note}`}`}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(TRANSITION_DND_TYPE, entry.id);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      onMouseEnter={() => setActiveId(entry.id)}
                      onMouseLeave={() => setActiveId((c) => (c === entry.id ? null : c))}
                      // Focus drives the animation too: keyboard users get the same
                      // preview as pointer users.
                      onFocus={() => setActiveId(entry.id)}
                      onBlur={() => setActiveId((c) => (c === entry.id ? null : c))}
                      onClick={() => apply(entry)}
                    >
                      <TransitionThumbnail
                        transition={entry}
                        active={activeId === entry.id}
                        reducedMotion={reducedMotion}
                      />
                      {applied && <span className="fx-card-applied">In use</span>}
                      <span className="fx-card-label">{entry.label}</span>
                      <span className="tr-card-meta">
                        {entry.direction !== undefined && (
                          <span
                            className="tr-card-dir"
                            data-direction={entry.direction}
                            aria-hidden="true"
                          >
                            {DIRECTION_GLYPH[entry.direction] ?? ''}
                          </span>
                        )}
                        {seconds > 0 && <span className="tr-card-secs">{seconds.toFixed(2)}s</span>}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`fx-card-fav${favourite ? ' is-on' : ''}`}
                      aria-label={
                        favourite
                          ? `Remove ${entry.label} from favourites`
                          : `Add ${entry.label} to favourites`
                      }
                      aria-pressed={favourite}
                      onClick={() => library.toggleFavourite(entry.id)}
                    >
                      <Star size={ICON_SIZE.sm} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** A one-character hint at which way a directional transition moves. */
const DIRECTION_GLYPH: Readonly<Record<string, string>> = {
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  in: '⤢',
  out: '⤡',
};

/**
 * Empty states, differentiated by cause.
 *
 * A single "nothing here" would be a dead end on the Favourites, Recents and
 * Presets shelves, where the useful message is how to fill them.
 */
function EmptyState({
  reason,
  query,
}: {
  readonly reason: 'no-matches' | 'no-favourites' | 'no-recents' | 'no-presets';
  readonly query: string;
}): JSX.Element {
  if (reason === 'no-favourites') {
    return (
      <p className="panel-empty">
        <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> No favourites yet — tap the star on any
        transition to keep it here.
      </p>
    );
  }
  if (reason === 'no-recents') {
    return (
      <p className="panel-empty">
        <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> Nothing here yet — the transitions you
        apply collect on this shelf.
      </p>
    );
  }
  if (reason === 'no-presets') {
    return (
      <p className="panel-empty">
        <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> No presets yet — tune a transition in
        the inspector and choose “Save as preset”.
      </p>
    );
  }
  return (
    <p className="panel-empty">
      <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> Nothing matches “{query.trim()}”. Try a
      direction (“left”), a feel (“fast”, “cinematic”) or browse a category.
    </p>
  );
}
