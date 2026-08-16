/**
 * Effects panel — the effect-layer library (schema v13, ADR 0088).
 *
 * Layout follows what editors already know from CapCut/Premiere: a filter rail
 * (shelves first, then the twenty families), a search field, and a thumbnail grid
 * whose tiles animate on hover. Applying is either a click (lands at the
 * playhead) or a drag onto the timeline's effect lane.
 *
 * WHAT CHANGED FROM THE OLD PANEL: it listed 8 colour grades, 7 transitions, and
 * ten tiles disabled with a "Soon" tag. Colour grades and transitions are per-CLIP
 * operations and still belong to the clip Inspector and the on-cut picker
 * respectively, so they are no longer duplicated here; this panel is now
 * exclusively the effect-LAYER library, and nothing in it is a placeholder — every
 * one of the 72 entries renders in both the preview and the export.
 *
 * Effects do NOT require a clip selection, which is the whole point of a layer:
 * `hasSelection` gating would be wrong, because an effect applies to whatever is
 * beneath it rather than to a chosen clip.
 */
import { useCallback, useMemo, useState } from 'react';
import { Input } from '@framepilot/ui';
import type { CatalogEffect } from '@framepilot/timeline-schema/effect-catalog';
import type { UseEditor } from '../editor/useEditor.js';
import { addEffectLayerPatch } from '../editor/patch-builders.js';
import { findClip } from '../editor/selectors.js';
import { EffectThumbnail } from './EffectThumbnail.js';
import { useEffectLibrary, type LibraryFilter } from './useEffectLibrary.js';
import { ICON_SIZE, Search, Sparkles, Star } from './icons.js';

export interface EffectsPanelProps {
  readonly editor: UseEditor;
}

/**
 * DnD payload type for dragging a catalog effect onto the timeline. The dragged
 * string is the catalog `effectId`; the timeline resolves it to a full layer, so
 * the drag carries an id rather than a serialized layer (one source of truth for
 * how an effect becomes a layer — `addEffectLayerPatch`).
 */
export const EFFECT_DND_TYPE = 'application/x-framepilot-effect';

/**
 * Re-exported because the timeline still imports the transition drag type from
 * here. Transitions are per-clip operations, NOT effect layers — they live at a
 * cut between two clips — and their own panel is `TransitionsPanel`.
 */
export { TRANSITION_DND_TYPE } from './transition-catalog.js';

export function EffectsPanel({ editor }: EffectsPanelProps): JSX.Element {
  const library = useEffectLibrary();
  const { selection, timeline } = editor.state;
  /** The tile under the pointer/focus — only one animates at a time. */
  const [activeId, setActiveId] = useState<string | null>(null);

  /** Which catalog effects already have a layer on the timeline, for the marker. */
  const appliedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const track of timeline.tracks) {
      for (const layer of track.effectLayers ?? []) ids.add(layer.effectId);
    }
    return ids;
  }, [timeline]);

  const apply = useCallback(
    (effect: CatalogEffect): void => {
      // With a clip selected, the effect spans exactly that clip: selecting a clip
      // and clicking an effect obviously means "put this on that shot", and a
      // default-length layer starting at the playhead would only partly cover it.
      //
      // With nothing selected there is no such intent to honour, so it lands at
      // the playhead for its catalog duration — the same convention the caption
      // and overlay tools use.
      const target = selection ? findClip(timeline, selection) : null;
      // `getPlayhead()`, NOT `editor.state.playhead`: this panel is memoised on a
      // key that deliberately excludes the playhead (so a 60fps clock does not
      // re-render it), which means the `state.playhead` captured in this closure
      // is stale — it applied every effect at 0s regardless of where the user was.
      // `getPlayhead` is the documented escape hatch: live value, stable identity.
      const patch = target
        ? addEffectLayerPatch(timeline, effect.id, target.clip.start, { end: target.clip.end })
        : addEffectLayerPatch(timeline, effect.id, editor.getPlayhead());
      if (patch === null) return;
      editor.applyPatch(patch);
      library.noteUsed(effect.id);
    },
    [editor, library, selection, timeline],
  );

  return (
    <section className="effects" aria-label="effects panel">
      {/* No heading: the left rail's own "Effects" tab already names this panel,
          and repeating it costs a row of vertical space the grid can use. The
          section keeps its aria-label, so assistive tech still gets the name. */}
      <div className="fx-search">
        <Input
          uiSize="sm"
          type="search"
          aria-label="search effects"
          placeholder="Search effects…"
          icon={<Search size={ICON_SIZE.sm} />}
          value={library.query}
          onChange={(event) => library.setQuery(event.target.value)}
        />
      </div>

      {/* A horizontal filter strip, not a left rail. This panel is ~207px wide;
          a rail took 105px of that and left one grid column. Running the filters
          across the top gives the grid the full width, which is what turns a
          single column of tiles into the three-up square grid the format wants. */}
      {/* Plain toggle buttons, NOT a tablist: a tablist promises tabpanels wired
          with aria-controls, and these filter a list in place. `aria-pressed` is
          the accurate role for a filter chip. */}
      <div
        className="fx-filters"
        role="group"
        aria-label="effect categories"
        // A vertical wheel scrolls this strip HORIZONTALLY. Without it the wheel
        // does nothing over the filters (the strip has no vertical overflow) and
        // the categories past the fold are only reachable by dragging, which is
        // not obvious. Trackpads that already send deltaX are passed through
        // untouched so a native horizontal swipe still behaves normally.
        onWheel={(event) => {
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
            // Zero-count shelves stay clickable: their empty state is what tells
            // a user HOW to fill them ("star an effect to keep it here").
            onClick={() => library.setFilter(entry.id as LibraryFilter)}
            title={entry.blurb}
          >
            {entry.label}
            <span className="fx-filter-count">{entry.count}</span>
          </button>
        ))}
      </div>

      <div className="fx-body">
        <div className="fx-main">
          {library.emptyReason !== null ? (
            <EmptyState reason={library.emptyReason} query={library.query} />
          ) : (
            <div className="fx-grid" role="list" aria-label="effects">
              {library.results.map((effect) => {
                const applied = appliedIds.has(effect.id);
                const favourite = library.isFavourite(effect.id);
                return (
                  <div className="fx-card" role="listitem" key={effect.id}>
                    <button
                      type="button"
                      className="fx-card-apply"
                      data-applied={applied || undefined}
                      // The accessible name carries the description too, so a
                      // screen-reader user gets what the hover animation conveys
                      // visually.
                      aria-label={`${effect.label}. ${effect.description}`}
                      title={effect.description}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(EFFECT_DND_TYPE, effect.id);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      onMouseEnter={() => setActiveId(effect.id)}
                      onMouseLeave={() => setActiveId((c) => (c === effect.id ? null : c))}
                      // Focus drives the animation too: keyboard users get the
                      // same preview as pointer users.
                      onFocus={() => setActiveId(effect.id)}
                      onBlur={() => setActiveId((c) => (c === effect.id ? null : c))}
                      onClick={() => apply(effect)}
                    >
                      <EffectThumbnail effect={effect} active={activeId === effect.id} />
                      {/* A dot, not a badge: a badge covers the preview, which is
                          the one thing the tile exists to show. The text stays for
                          assistive tech and is visually hidden by the class. */}
                      {applied && <span className="fx-card-applied">In use</span>}
                      <span className="fx-card-label">{effect.label}</span>
                    </button>
                    <button
                      type="button"
                      className={`fx-card-fav${favourite ? ' is-on' : ''}`}
                      aria-label={
                        favourite
                          ? `Remove ${effect.label} from favourites`
                          : `Add ${effect.label} to favourites`
                      }
                      aria-pressed={favourite}
                      onClick={() => library.toggleFavourite(effect.id)}
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

/**
 * Empty states, differentiated by cause.
 *
 * A single "nothing here" would be a dead end on the Favourites and Recents
 * shelves, where the useful message is how to fill them.
 */
function EmptyState({
  reason,
  query,
}: {
  readonly reason: 'no-matches' | 'no-favourites' | 'no-recents';
  readonly query: string;
}): JSX.Element {
  if (reason === 'no-favourites') {
    return (
      <p className="panel-empty">
        <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> No favourites yet — tap the star on any
        effect to keep it here.
      </p>
    );
  }
  if (reason === 'no-recents') {
    return (
      <p className="panel-empty">
        <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> Nothing used yet. Effects you apply show
        up here, newest first.
      </p>
    );
  }
  return (
    <p className="panel-empty">
      No effects match{query.trim() === '' ? ' this filter' : ` “${query.trim()}”`}. Try a look or a
      feeling — “vhs”, “dreamy”, “teal orange”, “censor”.
    </p>
  );
}
