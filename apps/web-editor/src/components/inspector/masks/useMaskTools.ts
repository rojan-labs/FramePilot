/**
 * Shared view state for mask editing (MK4): which tool is active, which mask and points are
 * selected, the live geometry of a drag in progress, zoom, and the mask clipboard.
 *
 * The Inspector's mask panel and the monitor's `MaskCanvasTools` are siblings far apart in the
 * tree, and both must agree on "the selected mask" the moment either changes it. A tiny external
 * store read through `useSyncExternalStore` does that without threading props through `Editor`.
 *
 * **View state only.** Nothing here is project state: every edit still leaves as a typed mask
 * command through the editor's validated patch path (`runMaskCommand`). The live geometry of a
 * drag is exactly that, a preview that is discarded or committed as ONE patch on release, so
 * history never sees the intermediate positions.
 */
import { useSyncExternalStore } from 'react';
import type { MaskClipboard, MaskGeometry } from '@framepilot/editor-core';

/** The hand tools on the monitor. */
export type MaskTool = 'select' | 'rectangle' | 'ellipse' | 'pen' | 'freehand';

/** Monitor zoom while masking: fit, or screen pixels per source pixel in percent. */
export type MaskZoom = 'fit' | '100' | '200' | '400' | '800';

export const MASK_ZOOM_LEVELS: readonly MaskZoom[] = ['fit', '100', '200', '400', '800'];

/** Zoom at or above which the monitor draws the source pixel grid. */
export const PIXEL_GRID_MIN_ZOOM = 400;

/** A drag in progress: the geometry the monitor draws and the preview composites. */
export interface LiveMaskEdit {
  readonly clipId: string;
  readonly maskId: string;
  readonly geometry: MaskGeometry;
}

/** Mask scalar edits in progress from the panel (a slider being dragged). */
export interface LiveMaskScalars {
  readonly clipId: string;
  readonly maskId: string;
  readonly values: Readonly<Record<string, number>>;
}

export interface MaskToolState {
  /** The clip whose mask panel is open, or `null`. The monitor tools show only for it. */
  readonly panelClipId: string | null;
  readonly selectedMaskId: string | null;
  readonly tool: MaskTool;
  /** Selected path points of the selected mask. */
  readonly selectedVertices: readonly number[];
  /** "Apply to all keyframes" edit mode. */
  readonly allKeyframes: boolean;
  readonly snapping: boolean;
  readonly zoom: MaskZoom;
  /** Pan of the zoomed monitor, CSS pixels. */
  readonly pan: { readonly x: number; readonly y: number };
  /** CSS scale the monitor frame needs for {@link zoom} (1 at fit). */
  readonly frameScale: number;
  readonly live: LiveMaskEdit | null;
  readonly liveScalars: LiveMaskScalars | null;
  readonly clipboard: MaskClipboard | null;
  /** The last refusal to show, in plain words. */
  readonly message: string | null;
}

const INITIAL: MaskToolState = {
  panelClipId: null,
  selectedMaskId: null,
  tool: 'select',
  selectedVertices: [],
  allKeyframes: false,
  snapping: true,
  zoom: 'fit',
  pan: { x: 0, y: 0 },
  frameScale: 1,
  live: null,
  liveScalars: null,
  clipboard: null,
  message: null,
};

type Listener = () => void;

/** A minimal external store: replace-on-write state, synchronous notification. */
export class MaskToolStore {
  private state: MaskToolState = INITIAL;
  private readonly listeners = new Set<Listener>();

  public readonly getState = (): MaskToolState => this.state;

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Merge a change; listeners fire only when something actually changed. */
  public update(change: Partial<MaskToolState>): void {
    const next = { ...this.state, ...change };
    const changed = (Object.keys(change) as (keyof MaskToolState)[]).some(
      (key) => next[key] !== this.state[key],
    );
    if (!changed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Back to the initial state (tests, project switch). */
  public reset(): void {
    this.state = INITIAL;
    for (const listener of this.listeners) listener();
  }

  public selectMask(maskId: string | null): void {
    if (maskId === this.state.selectedMaskId) return;
    this.update({ selectedMaskId: maskId, selectedVertices: [], message: null });
  }

  public setTool(tool: MaskTool): void {
    this.update({ tool, message: null });
  }
}

/** The editor's one mask tool store. */
export const maskToolStore = new MaskToolStore();

/**
 * Subscribe a component to the mask tool state.
 *
 * @param store - Injectable for tests; the app uses {@link maskToolStore}.
 */
export function useMaskTools(store: MaskToolStore = maskToolStore): MaskToolState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
