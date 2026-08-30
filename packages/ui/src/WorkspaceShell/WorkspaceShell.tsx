/**
 * The editor workspace's outer shell: a full-height right rail alongside a
 * MAIN column (a top region — left rail + center stage — over a full-width
 * timeline dock), with draggable/collapsible rails on both sides (J1
 * extraction of apps/web-editor's `Editor.tsx` — plan
 * FRAMEPILOT-AI-PRODUCT-PLAN.md §6, "never remove a working affordance").
 *
 * This component owns only the **layout geometry** — grid columns, splitter
 * drag math, the collapsed/expanded chrome around each rail, and the dock's
 * height — never persistence (that's {@link useRailLayout} / {@link useDockHeight},
 * injected via a {@link WorkspacePersistenceAdapter}) and never *what* a rail
 * shows (that's each slot's `children`, owned by the host). Slot names mirror
 * what `Editor.tsx` actually renders in those positions: `left`/`right` rails,
 * `center` (the program monitor), and `dock` (toolbar + timeline).
 *
 * Behavior-preserving by construction: every className, aria-label, and DOM
 * nesting below is unchanged from the pre-extraction `Editor.tsx` JSX, so the
 * existing e2e/unit suite (which queries by those selectors) keeps passing.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { RailSplitter } from './RailSplitter.js';
import { StageSplitter } from './StageSplitter.js';
import { clampRailWidthsToContainer } from './useRailLayout.js';

export interface WorkspaceRailSlot {
  readonly collapsed: boolean;
  /** Effective width in px (already resolved to the collapsed strip width when collapsed — see `useRailLayout`'s `leftWidth`/`rightWidth`). */
  readonly width: number;
  readonly onResize: (width: number) => void;
  readonly onToggleCollapsed: () => void;
  readonly ariaLabel: string;
  /** Label + icon for the collapsed strip's expand button (the shell owns that button; the host owns everything else, including its own collapse affordance inside `children`). */
  readonly expandLabel: string;
  readonly expandIcon: ReactNode;
  /** Rendered only while expanded — tab strip + panel body, including the rail's own collapse control. */
  readonly children: ReactNode;
}

export interface WorkspaceDockSlot {
  readonly height: number;
  readonly onResize: (height: number) => void;
  readonly children: ReactNode;
}

export interface WorkspaceShellProps {
  readonly left: WorkspaceRailSlot;
  readonly right: WorkspaceRailSlot;
  /** The center stage (program monitor). */
  readonly center: ReactNode;
  readonly dock: WorkspaceDockSlot;
  /** Arms the CSS collapse/expand transition for one toggle — never during a live splitter drag (a transition on the live drag would make the rail chase the pointer). */
  readonly railAnimating?: boolean;
  /** Rendered as the shell's last child (e.g. toast notifications) — an app-level overlay unrelated to layout geometry, kept at the same DOM depth it occupied before extraction. */
  readonly overlay?: ReactNode;
}

export function WorkspaceShell({
  left,
  right,
  center,
  dock,
  railAnimating = false,
  overlay,
}: WorkspaceShellProps): JSX.Element {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Measures the shell's own width so both rails can give way before the center
  // stage (program monitor/timeline) is squeezed toward zero on a narrow window.
  // Degrades to "no constraint" where ResizeObserver is unavailable (jsdom).
  const [containerWidth, setContainerWidth] = useState<number>(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = workspaceRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const effectiveRailWidths = clampRailWidthsToContainer(containerWidth, {
    left: left.width,
    leftCollapsed: left.collapsed,
    right: right.width,
    rightCollapsed: right.collapsed,
  });

  const topGridColumns = `${effectiveRailWidths.left}px ${left.collapsed ? '0px' : 'var(--splitter-w)'} minmax(0, 1fr)`;

  return (
    <div className="editor-workspace" ref={workspaceRef}>
      <div className="editor-main" ref={mainRef}>
        <div
          className="framepilot-body"
          data-rail-anim={railAnimating}
          ref={bodyRef}
          style={{ gridTemplateColumns: topGridColumns }}
        >
          {left.collapsed ? (
            <aside className="rail rail-left is-collapsed" aria-label={left.ariaLabel}>
              <button
                type="button"
                className="rail-expand"
                aria-label={left.expandLabel}
                title={left.expandLabel}
                onClick={left.onToggleCollapsed}
              >
                {left.expandIcon}
              </button>
            </aside>
          ) : (
            <aside className="rail rail-left has-activitybar" aria-label={left.ariaLabel}>
              {left.children}
            </aside>
          )}

          <RailSplitter
            side="left"
            boundsRef={bodyRef}
            onResize={left.onResize}
            hidden={left.collapsed}
            width={effectiveRailWidths.left}
          />

          {/* The program monitor is the editor screen's main content, and until now
              the screen had no landmark at all — a screen-reader user had no way to
              skip the rails and the dock to reach it. `HomeScreen` owns the only
              other <main> in the app and is a different screen, so there is no
              collision. */}
          <main className="stage-col" aria-label="Program monitor">
            {center}
          </main>
        </div>

        <StageSplitter boundsRef={mainRef} onResize={dock.onResize} height={dock.height} />

        <div className="timeline-dock" style={{ height: `${dock.height}px` }}>
          {dock.children}
        </div>
      </div>

      {/* Full-height right rail — sibling of the whole main column, so it spans the
          timeline dock as well as the top region (not confined above the timeline). */}
      <RailSplitter
        side="right"
        boundsRef={workspaceRef}
        onResize={right.onResize}
        hidden={right.collapsed}
        width={effectiveRailWidths.right}
      />

      {right.collapsed ? (
        <aside
          className="rail rail-right is-collapsed"
          aria-label={right.ariaLabel}
          style={{ width: `${effectiveRailWidths.right}px` }}
        >
          <button
            type="button"
            className="rail-expand"
            aria-label={right.expandLabel}
            title={right.expandLabel}
            onClick={right.onToggleCollapsed}
          >
            {right.expandIcon}
          </button>
        </aside>
      ) : (
        <aside
          className="rail rail-right"
          aria-label={right.ariaLabel}
          style={{ width: `${effectiveRailWidths.right}px` }}
        >
          {right.children}
        </aside>
      )}

      {overlay}
    </div>
  );
}
