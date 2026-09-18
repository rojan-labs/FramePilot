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
import type { MaskTarget } from '@framepilot/timeline-schema';

/** The hand tools on the monitor. */
/**
 * `feature-point` and `exclude` are TRACKING tools (MK7.4): they place hints for the next
 * measurement — texture the tracker should follow, and regions it must ignore — rather than
 * editing the mask, so they never change the project.
 */
export type MaskTool =
  'select' | 'rectangle' | 'ellipse' | 'pen' | 'freehand' | 'feature-point' | 'exclude';

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
  /**
   * What the NEXT mask drawn on the monitor limits (MK5.1). `null` = the clip's alpha.
   *
   * Set by "Add mask" on an effect row, so the shape the editor then draws is created as that
   * effect's mask in one operation. Cleared as soon as a mask is drawn, or when the panel
   * moves to another clip: a stale effect target would silently retarget the next cut-out.
   */
  readonly pendingTarget: MaskTarget | null;
  /**
   * Extra texture the tracker should follow, display-corrected source pixels (MK7.4).
   *
   * Editor-owned hints, not project state: they steer the NEXT measurement and are meaningless
   * once the track exists, so they live with the tools rather than on the mask.
   */
  readonly featurePoints: readonly { readonly x: number; readonly y: number }[];
  /** Regions the tracker must ignore — a hand passing in front — same units. */
  readonly exclusions: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
  /** The last refusal to show, in plain words. */
  readonly message: string | null;
}

const INITIAL: MaskToolState = {
  panelClipId: null,
  selectedMaskId: null,
  tool: 'select',
  featurePoints: [],
  exclusions: [],
  selectedVertices: [],
  allKeyframes: false,
  snapping: true,
  zoom: 'fit',
  pan: { x: 0, y: 0 },
  frameScale: 1,
  live: null,
  liveScalars: null,
  clipboard: null,
  pendingTarget: null,
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

  /**
   * Add a point the tracker should follow, or remove the one nearest a click (MK7.4).
   *
   * Points are toggled rather than only added, because placing a point on the wrong texture is
   * the common mistake and undoing it must not mean clearing all of them.
   */
  public toggleFeaturePoint(point: { x: number; y: number }, withinPx = 8): void {
    const nearest = this.state.featurePoints.findIndex(
      (candidate) =>
        Math.abs(candidate.x - point.x) <= withinPx && Math.abs(candidate.y - point.y) <= withinPx,
    );
    this.update({
      featurePoints:
        nearest >= 0
          ? this.state.featurePoints.filter((_value, index) => index !== nearest)
          : [...this.state.featurePoints, point],
    });
  }

  /** Add a region the tracker must ignore. */
  public addExclusion(region: { x: number; y: number; width: number; height: number }): void {
    if (!(region.width > 0) || !(region.height > 0)) return;
    this.update({ exclusions: [...this.state.exclusions, region] });
  }

  /** Forget the tracking hints (a new mask, a new shot). */
  public clearTrackingHints(): void {
    this.update({ featurePoints: [], exclusions: [] });
  }

  public selectMask(maskId: string | null): void {
    if (maskId === this.state.selectedMaskId) return;
    this.update({ selectedMaskId: maskId, selectedVertices: [], message: null });
  }

  public setTool(tool: MaskTool): void {
    this.update({ tool, message: null });
  }

  /**
   * Start drawing a mask that will limit `target` (MK5.1's "Add mask" on an effect row).
   *
   * @param target - What the next drawn mask limits, or `null` for the clip's alpha.
   * @param tool - The tool to arm; Rectangle is the fastest shape to place on an effect.
   */
  public startMaskFor(target: MaskTarget | null, tool: MaskTool = 'rectangle'): void {
    this.update({ pendingTarget: target, tool, selectedVertices: [], message: null });
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
