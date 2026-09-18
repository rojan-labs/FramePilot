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
import type { MaskClipboard, MaskGeometry, MaskShapePreset } from '@framepilot/editor-core';
import type { MaskTarget } from '@framepilot/timeline-schema';

/** The hand tools on the monitor. */
/**
 * `feature-point` and `exclude` are TRACKING tools (MK7.4): they place hints for the next
 * measurement — texture the tracker should follow, and regions it must ignore — rather than
 * editing the mask, so they never change the project.
 */
/**
 * `ai-object` and `ai-brush` are SUBJECT tools (BR6.3): they say which subject the next background
 * removal should keep — a click, or a stroke across it — and, like the tracking hints, they change
 * nothing in the project until a run produces an artifact.
 */
export type MaskTool =
  | 'select'
  | 'rectangle'
  | 'ellipse'
  | 'pen'
  | 'freehand'
  // Analytic kinds (MK8.1): a split line, a mirror band and a gradient, placed by one drag.
  | 'split'
  | 'mirror'
  | 'gradient'
  // Shape presets (MK8.3): drag a box, get an ordinary path shaped like the chosen preset.
  | 'shape'
  | 'feature-point'
  | 'exclude'
  | 'ai-object'
  | 'ai-brush'
  | 'correction-brush';

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
  /** The preset the Shapes tool draws, and a star's points or a polygon's sides (MK8.3). */
  readonly shapePreset: MaskShapePreset;
  readonly shapePoints: number;
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
   * Whether the monitor is armed to sample a colour for the selected `key` mask (MK6.1).
   *
   * View state, like the active tool: the sample itself becomes a typed mask edit the moment it
   * is taken. Disarmed after a pick, so the eyedropper never eats the next ordinary click.
   */
  readonly eyedropper: boolean;
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
  /**
   * Where the editor clicked to say "this is the subject" for the next matte (BR6.3).
   *
   * Fractions of the picture, with the source instant the click was made at, because the pack
   * is prompted at a frame. Editor-owned hints like {@link featurePoints}: they steer the NEXT
   * run and are recorded on the mask only once that run produces an artifact.
   */
  readonly subjectPoints: readonly SubjectPoint[];
  /**
   * Brush fixes drawn on the monitor but not yet applied (BR6.5).
   *
   * Source pixels, so they rasterise straight into a correction mask at the artifact's size. They
   * are a draft until [Apply fix] saves them, which is why they live here and not on the mask:
   * an unapplied stroke must not change a frame of output.
   */
  readonly correctionStrokes: readonly CorrectionStrokeDraft[];
  /** Which fix the brush paints, and how wide it is, in source pixels. */
  readonly brushKind: CorrectionBrushKind;
  readonly brushRadiusPx: number;
  /** The mask debug view the review list asked the monitor to show, or `null`. */
  readonly requestedMaskView: string | null;
  /**
   * "Take me to this clip's background removal" (BR6.6), from the export dialog.
   *
   * A counter rather than a flag, because asking twice for the same clip must move the editor
   * twice — by the second ask they have usually scrolled away.
   */
  readonly reviewRequest: { readonly clipId: string; readonly seq: number } | null;
  /** The last refusal to show, in plain words. */
  readonly message: string | null;
}

/**
 * What a correction brush marks: the subject (keep), background (remove), or a soft edge to
 * re-matte (edge, BR6.10: hair and blur; it widens the matting band, it never sets alpha).
 */
export type CorrectionBrushKind = 'keep' | 'remove' | 'edge';

/** One unapplied brush stroke, in display-corrected source pixels at a source instant. */
export interface CorrectionStrokeDraft {
  readonly kind: CorrectionBrushKind;
  readonly radiusPx: number;
  readonly sourceTime: number;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/** One AI Object click: include or exclude, at a source instant, in picture fractions. */
export interface SubjectPoint {
  readonly x: number;
  readonly y: number;
  readonly label: 'include' | 'exclude';
  readonly sourceTime: number;
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
  shapePreset: 'heart',
  shapePoints: 5,
  clipboard: null,
  pendingTarget: null,
  eyedropper: false,
  subjectPoints: [],
  correctionStrokes: [],
  brushKind: 'keep',
  brushRadiusPx: 24,
  requestedMaskView: null,
  reviewRequest: null,
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

  /**
   * Add an AI Object pick, flip the one already there, or take it back (BR6.3).
   *
   * Three outcomes rather than two, because "keep this" and "not this" land in the same place and
   * an editor correcting themselves means the second one. Clicking the same spot with the SAME
   * meaning removes the pick; clicking it with the OTHER meaning flips it; anywhere else adds one.
   *
   * @param point - The pick, in fractions of the picture, at a source instant.
   * @param within - How close counts as the same spot, as a fraction of the picture.
   */
  public toggleSubjectPoint(point: SubjectPoint, within = 0.02): void {
    const nearest = this.state.subjectPoints.findIndex(
      (candidate) =>
        Math.abs(candidate.x - point.x) <= within &&
        Math.abs(candidate.y - point.y) <= within &&
        Math.abs(candidate.sourceTime - point.sourceTime) <= 1e-3,
    );
    if (nearest < 0) {
      this.update({ subjectPoints: [...this.state.subjectPoints, point] });
      return;
    }
    const existing = this.state.subjectPoints[nearest]!;
    this.update({
      subjectPoints:
        existing.label === point.label
          ? this.state.subjectPoints.filter((_value, index) => index !== nearest)
          : this.state.subjectPoints.map((candidate, index) =>
              index === nearest ? point : candidate,
            ),
    });
  }

  /** Record one brush stroke drawn on the monitor; it changes nothing until [Apply fix]. */
  public addCorrectionStroke(stroke: CorrectionStrokeDraft): void {
    if (stroke.points.length === 0) return;
    this.update({ correctionStrokes: [...this.state.correctionStrokes, stroke] });
  }

  /** Throw away the unapplied strokes (applied, cancelled, or another clip). */
  public clearCorrectionStrokes(): void {
    if (this.state.correctionStrokes.length === 0) return;
    this.update({ correctionStrokes: [] });
  }

  /** Ask the editor to select a clip and show its background removal. */
  public requestReview(clipId: string): void {
    this.update({
      reviewRequest: { clipId, seq: (this.state.reviewRequest?.seq ?? 0) + 1 },
    });
  }

  /** Ask the monitor for a mask debug view (the review list switches to Overlay). */
  public requestMaskView(view: string | null): void {
    this.update({ requestedMaskView: view });
  }

  /** Forget the subject clicks (a finished run, another clip). */
  public clearSubjectPoints(): void {
    if (this.state.subjectPoints.length === 0) return;
    this.update({ subjectPoints: [] });
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
    this.update({ tool, eyedropper: false, message: null });
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

/**
 * Subscribe a component to ONE value of the mask tool state: it re-renders only when that value
 * changes (by `Object.is`), not on every update of the store.
 *
 * WHY: the store changes on every pointer move of a mask drag (the live geometry). A component
 * far from the monitor that needs one field - `Editor` and `Inspector` read `reviewRequest` -
 * re-rendered the whole editor on every move through {@link useMaskTools}, inside the MK4.6
 * pointer budget's `work` window.
 *
 * @param select - Must return a value that keeps its identity while it does not change (a field
 *   of the state, not a new object).
 */
export function useMaskToolValue<T>(
  select: (state: MaskToolState) => T,
  store: MaskToolStore = maskToolStore,
): T {
  const snapshot = (): T => select(store.getState());
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
