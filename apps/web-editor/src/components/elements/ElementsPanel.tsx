/**
 * Elements — everything you put on or into the picture that you did not film:
 * Photos, Videos, Stickers, Shapes (plan/elements, CapCut's Elements shelf).
 *
 * This is the host: a sub-tab strip and the sub-tab's own browser beneath it. Each
 * sub-tab is offered only when this build can serve it — Photos and Videos need the
 * desktop main process to reach Pexels, so a browser build shows neither, the same
 * "absent, never present-and-broken" rule the left rail follows.
 *
 * The chosen sub-tab is a view preference (`framepilot.view.elementsTab`), coerced
 * against what this build offers, so a tab remembered on the desktop never selects an
 * empty panel in the browser.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Asset, Project } from '@framepilot/timeline-schema';
import { isDesktop } from '../../editor/bridge.js';
import { useViewPreference } from '../../editor/useViewPreference.js';
import { PexelsBrowser } from './PexelsBrowser.js';
import { ShapesBrowser } from './ShapesBrowser.js';

/** Every sub-tab Elements can show, in the maintainer's order. */
export const ELEMENTS_TAB_IDS = ['photos', 'videos', 'stickers', 'shapes'] as const;
export type ElementsTab = (typeof ELEMENTS_TAB_IDS)[number];

const ELEMENTS_TAB_LABELS: Readonly<Record<ElementsTab, string>> = {
  photos: 'Photos',
  videos: 'Videos',
  stickers: 'Stickers',
  shapes: 'Shapes',
};

/**
 * The sub-tabs this build can serve, in display order.
 *
 * Photos and Videos are the Pexels library, reached through the desktop main
 * process; the renderer's CSP forbids reaching it directly, on purpose. Shapes are
 * drawn by the engine sidecar, which only the desktop app runs (the browser build's
 * labelled approximation is EL11).
 */
export function availableElementsTabs(desktop: boolean = isDesktop()): readonly ElementsTab[] {
  return desktop ? ['photos', 'videos', 'shapes'] : [];
}

/** Restore a remembered sub-tab only if this build renders it. */
export function coerceElementsTab(
  raw: unknown,
  available: readonly ElementsTab[],
): ElementsTab | undefined {
  return typeof raw === 'string' && (available as readonly string[]).includes(raw)
    ? (raw as ElementsTab)
    : undefined;
}

export interface ElementsPanelProps {
  readonly project: Project;
  /** Why placing a Pexels clip of this length at the playhead is impossible, or `null`. */
  readonly placementBlockedReasonFor: (durationSeconds: number) => string | null;
  /** Place a downloaded Pexels asset; returns the refusal sentence, or `null` on success. */
  readonly onAddStock: (asset: Asset) => string | null;
  /** Opens Settings → Photos & videos (Pexels). */
  readonly onOpenSettings?: () => void;
  /** Add a shape preset at the playhead; returns the refusal sentence, or `null`. */
  readonly onAddShape?: (presetId: string) => string | null;
}

export function ElementsPanel({
  project,
  placementBlockedReasonFor,
  onAddStock,
  onOpenSettings,
  onAddShape,
}: ElementsPanelProps): JSX.Element {
  const available = useMemo(() => availableElementsTabs(), []);
  const coerce = useCallback((raw: unknown) => coerceElementsTab(raw, available), [available]);
  const [storedTab, setTab] = useViewPreference<ElementsTab | null>(
    'elementsTab',
    available[0] ?? null,
    coerce,
  );
  const tab = storedTab !== null && available.includes(storedTab) ? storedTab : available[0];
  const tabRefs = useRef(new Map<ElementsTab, HTMLButtonElement>());
  // Photos and Videos share one query: switching between them re-searches the same
  // words in the other kind. Held here so a round trip through another sub-tab keeps it.
  const [pexelsQuery, setPexelsQuery] = useState('');

  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
      const move = (to: number): void => {
        const next = available[(to + available.length) % available.length];
        if (next === undefined) return;
        event.preventDefault();
        setTab(next);
        tabRefs.current.get(next)?.focus();
      };
      switch (event.key) {
        case 'ArrowRight':
          move(index + 1);
          break;
        case 'ArrowLeft':
          move(index - 1);
          break;
        case 'Home':
          move(0);
          break;
        case 'End':
          move(available.length - 1);
          break;
        default:
          break;
      }
    },
    [available, setTab],
  );

  if (tab === undefined) {
    // Nothing this build can serve. The rail hides the tab in that case (see Editor.tsx);
    // this is the backstop for a direct render.
    return (
      <div className="elements-panel">
        <p className="stock-note" role="note">
          Elements runs in the FramePilot desktop app. Open this project there to add photos and
          videos.
        </p>
      </div>
    );
  }

  return (
    <div className="elements-panel">
      <div className="elements-tabs" role="tablist" aria-label="Elements">
        {available.map((id, index) => (
          <button
            key={id}
            ref={(node) => {
              if (node) tabRefs.current.set(id, node);
              else tabRefs.current.delete(id);
            }}
            type="button"
            role="tab"
            id={`elements-tab-${id}`}
            className="elements-tab"
            aria-selected={tab === id}
            aria-controls={`elements-tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {ELEMENTS_TAB_LABELS[id]}
          </button>
        ))}
      </div>
      <div
        className="elements-tabpanel"
        role="tabpanel"
        id={`elements-tabpanel-${tab}`}
        aria-labelledby={`elements-tab-${tab}`}
      >
        {(tab === 'photos' || tab === 'videos') && (
          <PexelsBrowser
            kind={tab === 'photos' ? 'photo' : 'video'}
            initialQuery={pexelsQuery}
            onQueryChange={setPexelsQuery}
            project={project}
            placementBlockedReasonFor={placementBlockedReasonFor}
            onAddStock={onAddStock}
            {...(onOpenSettings ? { onOpenSettings } : {})}
          />
        )}
        {tab === 'shapes' && (
          <ShapesBrowser
            onAddShape={
              onAddShape ?? (() => 'Shapes are added from the editor. Open a project first.')
            }
          />
        )}
      </div>
    </div>
  );
}
