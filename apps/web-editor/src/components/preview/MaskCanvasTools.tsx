/**
 * Monitor mask tools (MK4.1, plan 10 "Editing tools"): draw and edit a clip's masks directly on
 * the program monitor.
 *
 * Tools: Select, Rectangle, Ellipse, Pen (click for corners, drag for smooth tangents, Shift for
 * 45° segments) and Freehand (a stroke fitted with Schneider's algorithm). With Select: drag a
 * mask to move it, drag points and tangents (Alt breaks a smooth pair, Cmd/Ctrl-click converts
 * corner ↔ smooth), click an edge to add a point, marquee to select points, the transform box
 * scales and rotates about its centre (Alt from the centre, Shift keeps the aspect), and the
 * knobs above the shape set expansion, outer feather and inner feather. Arrow keys nudge 1 px
 * (Shift 10 px). Snapping pulls to the picture's edges and centre and to other masks' points.
 *
 * ## One gesture, one undo
 *
 * A drag previews through the shared tool store (`live`), which the monitor composites, and
 * commits ONE typed mask command on release. Nothing reaches history mid-drag.
 *
 * ## Coordinates
 *
 * The SVG's user space is the project frame (`viewBox` = resolution); a group transform maps
 * source pixels onto it (`monitorPictureSpace`), so geometry is drawn in the source pixels it is
 * stored in, sub-pixel exact. Handles are sized in screen pixels by dividing by the current
 * screen-pixels-per-source-pixel.
 *
 * ## Keyboard drawing (a11y)
 *
 * Focus the canvas. `V R E P F` pick a tool. Arrow keys move a crosshair (Shift ×10); Space adds
 * a pen point or sets a rectangle/ellipse corner; Enter closes the pen path; Escape cancels.
 * With Select, arrows nudge, `[` and `]` step through points, Delete removes points or the mask.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FREEHAND_FIT_TOLERANCE_PX,
  constrainToAngle,
  dragBox,
  dragTangent,
  fitClosedStroke,
  frameSnapLines,
  hitTangent,
  hitVertex,
  identityTransform,
  isEditableMask,
  maskGeometryAt,
  moveVertices,
  nearestPointOnPath,
  nextMaskId,
  rectFromCorners,
  snapPoint,
  toggleVertexSmooth,
  transformVertices,
  verticesBounds,
  verticesInRect,
  MASK_SHAPE_PRESETS,
  MASK_SHAPE_PRESET_NAMES,
  shapePresetPaths,
  type AnalyticMaskGeometry,
  type MaskGeometry,
  type MaskShapePreset,
  type MaskPathVertex,
  type PixelPoint,
  type SnapTargets,
} from '@framepilot/editor-core';
import { masksOf, type Asset, type Clip, type MaskLayer } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../editor/useEditor.js';
import {
  clipSourceTimeAt,
  copyMasks,
  runMaskCommand,
  type MaskCommandInput,
} from '../../editor/mask-editing.js';
import {
  MASK_ZOOM_LEVELS,
  PIXEL_GRID_MIN_ZOOM,
  maskToolStore,
  useMaskTools,
  type MaskTool,
  type MaskToolStore,
  type MaskZoom,
} from '../inspector/masks/useMaskTools.js';
import {
  Ban,
  Blend,
  Circle,
  Shapes,
  FlipVertical2,
  SquareSplitHorizontal,
  Diamond,
  ICON_SIZE,
  Magnet,
  MousePointer2,
  Sparkles,
  Wand2,
  Pencil,
  PenTool,
  Square,
} from '../icons.js';
import { Tooltip } from '../Tooltip.js';
import { packToolCopy, SMART_MASK_PACK } from '../inspector/masks/packToolCopy.js';
import { SUBJECT_MATTE_CAPABILITY, usePackStatus } from '../inspector/masks/usePackStatus.js';
import {
  BOX_HANDLES,
  boxHandlePoint,
  boxOf,
  flattenOutline,
  geometryCentre,
  offsetPolygon,
  outlinePathData,
  outlineVertices,
  pointInPolygon,
  polylinePathData,
  resizeBox,
  squaresPathData,
  translateGeometry,
  withBox,
  type OrientedBox,
} from './mask-canvas-geometry.js';
import { keySampleChanges, sampleCanvasColour } from '../../preview/masks/eyedropper.js';
import { affineAttribute, applyAffine, monitorPictureSpace } from './mask-monitor-space.js';
import { maskToolTelemetry } from './mask-tool-telemetry.js';
import {
  analyticDrawGeometry,
  analyticGuides,
  analyticHandlePoints,
  analyticValuesAt,
  dragAnalyticHandle,
  hitsAnalyticMask,
  isAnalyticLayer,
  type AnalyticHandle,
  type AnalyticMaskLayer,
  type AnalyticValues,
} from './analytic-mask-handles.js';

/** Handle sizes and hit radii, screen pixels. */
const VERTEX_HANDLE_PX = 7;
const TANGENT_HANDLE_PX = 6;
const BOX_HANDLE_PX = 8;
const HIT_RADIUS_PX = 7;
const SNAP_RADIUS_PX = 6;
/** A press that moves less than this is a click, not a drag. */
const CLICK_SLOP_PX = 3;
/** The rotation handle's distance above a transform box. */
const ROTATE_STALK_PX = 22;
/** Vertical gap between the edge knobs so they are separable at zero values. */
const KNOB_SPACING_PX = 16;
/** Distance from the shape's right edge to the knobs' zero position. */
const KNOB_GAP_PX = 28;
const NUDGE_PX = 1;
const NUDGE_LARGE_PX = 10;

const TOOL_KEYS: Readonly<Record<string, MaskTool>> = {
  v: 'select',
  r: 'rectangle',
  e: 'ellipse',
  p: 'pen',
  f: 'freehand',
  s: 'split',
  m: 'mirror',
  g: 'gradient',
  h: 'shape',
  o: 'ai-object',
  b: 'ai-brush',
};

/** How far apart the points sampled along an AI Brush stroke are, source pixels. */
const BRUSH_SAMPLE_SPACING_PX = 24;

const TOOLS: readonly { readonly tool: MaskTool; readonly label: string; readonly key: string }[] =
  [
    { tool: 'select', label: 'Selection tool', key: 'V' },
    { tool: 'rectangle', label: 'Rectangle tool', key: 'R' },
    { tool: 'ellipse', label: 'Ellipse tool', key: 'E' },
    { tool: 'pen', label: 'Pen tool', key: 'P' },
    { tool: 'freehand', label: 'Freehand tool', key: 'F' },
    // Analytic masks (MK8.1): one drag places the line (split, mirror) or the ramp (gradient).
    { tool: 'split', label: 'Split tool', key: 'S' },
    { tool: 'mirror', label: 'Mirror band tool', key: 'M' },
    { tool: 'gradient', label: 'Gradient tool (Alt-drag for radial)', key: 'G' },
    // Shape presets (MK8.3): drag a box; the path is ordinary and editable afterwards.
    { tool: 'shape', label: 'Shape preset tool', key: 'H' },
    // Subject hints (BR6.3): they say which subject the next background removal keeps.
    { tool: 'ai-object', label: 'AI Object tool', key: 'O' },
    { tool: 'ai-brush', label: 'AI Brush tool', key: 'B' },
    // Tracking hints (MK7.4): they steer the next measurement and never change the project.
    { tool: 'feature-point', label: 'Feature point tool', key: 'T' },
    { tool: 'exclude', label: 'Exclude region tool', key: 'X' },
  ];

const TOOL_ICONS = {
  select: MousePointer2,
  rectangle: Square,
  ellipse: Circle,
  pen: PenTool,
  freehand: Pencil,
  split: SquareSplitHorizontal,
  mirror: FlipVertical2,
  gradient: Blend,
  shape: Shapes,
  'feature-point': Diamond,
  exclude: Ban,
  'ai-object': Sparkles,
  'ai-brush': Wand2,
  // The correction brush is armed from the review panel, not the toolbar, so it has no button;
  // it still needs an icon because the toolbar maps every tool.
  'correction-brush': Pencil,
} as const;

type EdgeProperty = 'expansionPx' | 'featherOuterPx' | 'featherInnerPx';

type Gesture =
  | {
      readonly kind: 'geometry';
      readonly maskId: string;
      readonly pointerId: number;
      readonly start: PixelPoint;
      readonly startClient: PixelPoint;
      readonly base: MaskGeometry;
      readonly mode:
        | { readonly type: 'move' }
        | {
            readonly type: 'vertices';
            readonly indices: ReadonlySet<number>;
            readonly grabbed: number;
          }
        | { readonly type: 'tangent'; readonly vertex: number; readonly side: 'in' | 'out' }
        | { readonly type: 'box-resize'; readonly ux: number; readonly uy: number }
        | { readonly type: 'box-rotate'; readonly centre: PixelPoint }
        | {
            readonly type: 'selection-resize';
            readonly indices: ReadonlySet<number>;
            readonly box: OrientedBox;
            readonly ux: number;
            readonly uy: number;
          }
        | {
            readonly type: 'selection-rotate';
            readonly indices: ReadonlySet<number> | null;
            readonly centre: PixelPoint;
          }
        | { readonly type: 'segment'; readonly segment: number; readonly t: number };
      latest: MaskGeometry | null;
    }
  | {
      readonly kind: 'edge';
      readonly maskId: string;
      readonly pointerId: number;
      readonly property: EdgeProperty;
      /** Where a zero value sits on the knob axis, source x. */
      readonly originX: number;
      readonly expansion: number;
      latest: number | null;
    }
  | {
      readonly kind: 'marquee';
      readonly pointerId: number;
      readonly start: PixelPoint;
      current: PixelPoint;
      readonly additive: boolean;
    }
  | {
      readonly kind: 'draw-box';
      readonly pointerId: number;
      readonly shape: 'rectangle' | 'ellipse' | 'preset';
      readonly start: PixelPoint;
      current: PixelPoint;
    }
  | {
      /** Dragging out a region the tracker must ignore (MK7.4). Never touches the project. */
      readonly kind: 'draw-exclusion';
      readonly pointerId: number;
      readonly start: PixelPoint;
      current: PixelPoint;
    }
  | {
      /** Placing a split, mirror band or gradient with its tool (MK8.1). */
      readonly kind: 'draw-analytic';
      readonly pointerId: number;
      readonly tool: 'split' | 'mirror' | 'gradient';
      readonly start: PixelPoint;
      current: PixelPoint;
      readonly radial: boolean;
    }
  | {
      /** Dragging a handle of a split, mirror band or gradient (MK8.1). */
      readonly kind: 'analytic';
      readonly maskId: string;
      readonly maskKind: AnalyticMaskLayer['kind'];
      readonly pointerId: number;
      readonly handle: AnalyticHandle;
      readonly start: PixelPoint;
      readonly startClient: PixelPoint;
      readonly base: AnalyticValues;
      latest: Record<string, number> | null;
    }
  | { readonly kind: 'freehand'; readonly pointerId: number; readonly samples: PixelPoint[] }
  | {
      readonly kind: 'correction-brush';
      readonly pointerId: number;
      readonly brush: 'keep' | 'remove';
      readonly samples: PixelPoint[];
    }
  | {
      readonly kind: 'ai-brush';
      readonly pointerId: number;
      readonly label: 'include' | 'exclude';
      readonly samples: PixelPoint[];
    }
  | { readonly kind: 'pen-drag'; readonly pointerId: number; readonly index: number }
  | {
      readonly kind: 'pan';
      readonly pointerId: number;
      readonly startClient: PixelPoint;
      readonly basePan: PixelPoint;
    };

/** What the overlay draws for a gesture that is not a live mask geometry. */
interface Draft {
  readonly box?: { readonly shape: 'rectangle' | 'ellipse'; readonly geometry: MaskGeometry };
  /** A shape preset being dragged out: its path(s), drawn as outlines (MK8.3). */
  readonly preset?: readonly (readonly MaskPathVertex[])[];
  readonly marquee?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly stroke?: readonly PixelPoint[];
  /** A split, mirror band or gradient being placed. */
  readonly analytic?: AnalyticMaskGeometry | null;
  readonly guideX?: number | null;
  readonly guideY?: number | null;
}

export interface MaskCanvasToolsProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly assets: readonly Asset[];
  readonly resolution: { readonly width: number; readonly height: number };
  /** The frame element's unzoomed CSS width, for zoom-to-source-pixels. */
  readonly frameWidth?: number;
  /**
   * Where the toolbar and messages mount: outside the zoomed frame, so they keep their size.
   * Absent, they render beside the canvas.
   */
  readonly chromeHost?: HTMLElement | null;
  readonly store?: MaskToolStore;
}

const describePoint = (point: PixelPoint): string =>
  `${point.x.toFixed(2)}, ${point.y.toFixed(2)} px`;

function editableMasks(clip: Clip): (MaskLayer & { kind: 'rectangle' | 'ellipse' | 'path' })[] {
  return masksOf(clip).filter(
    (mask): mask is MaskLayer & { kind: 'rectangle' | 'ellipse' | 'path' } =>
      isEditableMask(mask) && mask.units !== 'normalized',
  );
}

export function MaskCanvasTools({
  editor,
  clip,
  assets,
  resolution,
  frameWidth,
  chromeHost,
  store = maskToolStore,
}: MaskCanvasToolsProps): JSX.Element | null {
  const tools = useMaskTools(store);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pendingPointerTs = useRef<number | null>(null);
  /** When the pointer handler was entered, so input delay and the monitor's work stay separable. */
  const pendingHandlerTs = useRef<number | null>(null);
  /**
   * The canvas' box in client pixels, held for the duration of a gesture (MK4.6).
   *
   * Every pointer move maps client pixels to source pixels, and `getBoundingClientRect` on a
   * document React has just written to forces a synchronous style + layout of the whole editor.
   * Doing that once per move is layout thrash and was the bulk of the Chrome pointer latency
   * (jsdom never showed it: it has no layout). The box cannot change while a pointer is down —
   * the ResizeObserver below clears the cache if the canvas is resized anyway.
   */
  const rectCache = useRef<DOMRect | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [penPoints, setPenPoints] = useState<MaskPathVertex[]>([]);
  const [cursor, setCursor] = useState<PixelPoint | null>(null);
  /** Where the pointer is while an AI subject tool is armed, source pixels (BR6.8). */
  const [hover, setHover] = useState<PixelPoint | null>(null);
  const [boxAnchor, setBoxAnchor] = useState<PixelPoint | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [screenPerFrame, setScreenPerFrame] = useState(1);
  const [spaceHeld, setSpaceHeld] = useState(false);
  // AI Object and AI Brush need the Smart Mask pack. They stay in the toolbar without it —
  // disabled, with the reason in the tooltip — so the editor can see the capability exists (BR6.2).
  const subjectPack = usePackStatus(SUBJECT_MATTE_CAPABILITY);
  const subjectCopy = packToolCopy(subjectPack.status, {
    pack: SMART_MASK_PACK,
    tool: 'Background removal',
  });

  const { playhead, timeline } = editor.state;
  const sourceTime = clipSourceTimeAt(clip, playhead);
  const space = useMemo(
    () => monitorPictureSpace(timeline, assets, playhead, resolution, clip.id),
    [timeline, assets, playhead, resolution, clip.id],
  );
  const masks = useMemo(() => editableMasks(clip), [clip]);
  // Splits, mirror bands and gradients (MK8.1): edited by their own handles, not a box.
  const analyticLayers = useMemo(
    () =>
      masksOf(clip).filter(
        (mask): mask is AnalyticMaskLayer => isAnalyticLayer(mask) && mask.units !== 'normalized',
      ),
    [clip],
  );
  const selectedMask = masks.find((mask) => mask.id === tools.selectedMaskId) ?? null;
  // The selected mask WHATEVER its kind: `masks` holds only the kinds the hand tools draw, and
  // the eyedropper edits a key, which they do not.
  const selectedLayer = masksOf(clip).find((mask) => mask.id === tools.selectedMaskId) ?? null;
  const selectedVertices = useMemo(() => new Set(tools.selectedVertices), [tools.selectedVertices]);

  // Keep a selection on this clip: the first editable mask when the selection is elsewhere.
  useEffect(() => {
    const onClip = masksOf(clip).some((mask) => mask.id === tools.selectedMaskId);
    if (!onClip) store.selectMask(masks[0]?.id ?? analyticLayers[0]?.id ?? null);
  }, [clip, masks, analyticLayers, store, tools.selectedMaskId]);

  // Screen pixels per project-frame pixel: handles are sized in screen pixels.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return undefined;
    const measure = (): void => {
      rectCache.current = null;
      const width = svg.getBoundingClientRect().width;
      setScreenPerFrame(width > 0 ? width / resolution.width : 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [resolution.width, tools.frameScale]);

  // Zoom in source pixels: 100% puts one source pixel on one CSS pixel.
  useEffect(() => {
    if (space === null) return;
    if (tools.zoom === 'fit') {
      store.update({ frameScale: 1, pan: { x: 0, y: 0 } });
      return;
    }
    const fitWidth = frameWidth ?? resolution.width;
    const screenPerSourceAtFit = (fitWidth / resolution.width) * space.scale;
    if (!(screenPerSourceAtFit > 0)) return;
    store.update({ frameScale: Number(tools.zoom) / 100 / screenPerSourceAtFit });
  }, [tools.zoom, space, frameWidth, resolution.width, store]);

  // MK4.6. `commit` is the monitor's own work: the pointer event's timestamp to the end of the
  // layout effect, by which point the overlay's DOM is written and the moved geometry is
  // paintable. That is what the 16 ms budget is about. `pointerToPaint` adds the wait for the
  // next vsync, which no amount of optimising the monitor can shorten.
  useLayoutEffect(() => {
    const started = pendingPointerTs.current;
    if (started === null) return;
    const handlerEntered = pendingHandlerTs.current ?? started;
    pendingPointerTs.current = null;
    pendingHandlerTs.current = null;
    const paintable = performance.now();
    maskToolTelemetry.record('work', paintable - handlerEntered);
    maskToolTelemetry.record('commit', paintable - started);
    requestAnimationFrame(() =>
      maskToolTelemetry.record('pointerToPaint', performance.now() - started),
    );
  });

  if (space === null) return null;

  const screenPerSource = screenPerFrame * space.scale;
  const px = (screen: number): number => screen / (screenPerSource > 0 ? screenPerSource : 1);

  const geometryOf = (mask: MaskLayer): MaskGeometry | null =>
    tools.live !== null && tools.live.clipId === clip.id && tools.live.maskId === mask.id
      ? tools.live.geometry
      : maskGeometryAt(mask, sourceTime);

  const scalarOf = (mask: MaskLayer, property: EdgeProperty): number => {
    const live = tools.liveScalars;
    if (live !== null && live.maskId === mask.id && live.values[property] !== undefined) {
      return live.values[property]!;
    }
    const keyframes = mask.keyframes.filter((keyframe) => keyframe.property === property);
    if (keyframes.length === 0) return mask[property];
    // Nearest-instant value is enough for placing a knob; the panel shows the exact one.
    let best = keyframes[0]!;
    for (const keyframe of keyframes) {
      if (Math.abs(keyframe.sourceTime - sourceTime) < Math.abs(best.sourceTime - sourceTime))
        best = keyframe;
    }
    return best.value;
  };

  const report = (message: string | null): void => {
    store.update({ message });
    if (message !== null) setAnnouncement(message);
  };

  const run = (command: MaskCommandInput): boolean => {
    const refusal = runMaskCommand(editor, command);
    report(refusal);
    return refusal === null;
  };

  /**
   * Draw a new mask, carrying whatever "Add mask" armed as its target (MK5.1).
   *
   * The pending target is consumed on success only: a refused draw leaves the effect row's
   * request armed, so the editor can simply draw a bigger shape and still get the effect mask.
   */
  const drawMask = (geometry: MaskGeometry | AnalyticMaskGeometry): boolean => {
    const target = tools.pendingTarget;
    const drawn = run({
      type: 'draw_mask',
      clipId: clip.id,
      sourceTime,
      geometry,
      ...(target === null ? {} : { target }),
    });
    if (drawn && target !== null) store.update({ pendingTarget: null });
    return drawn;
  };

  const canvasRect = (): DOMRect | undefined => {
    const cached = rectCache.current;
    if (cached !== null) return cached;
    const measured = svgRef.current?.getBoundingClientRect();
    if (measured !== undefined && gesture.current !== null) rectCache.current = measured;
    return measured;
  };

  const toSource = (event: { clientX: number; clientY: number }): PixelPoint => {
    const rect = canvasRect();
    const width = rect && rect.width > 0 ? rect.width : resolution.width;
    const height = rect && rect.height > 0 ? rect.height : resolution.height;
    const frame = {
      x: ((event.clientX - (rect?.left ?? 0)) * resolution.width) / width,
      y: ((event.clientY - (rect?.top ?? 0)) * resolution.height) / height,
    };
    return applyAffine(space.toSource, frame);
  };

  const snapOn = (event: { altKey: boolean }): boolean =>
    event.altKey ? !tools.snapping : tools.snapping;

  const snapTargets = (excludeMaskId: string | null): SnapTargets => {
    const lines = frameSnapLines({ width: space.sourceWidth, height: space.sourceHeight });
    const points: PixelPoint[] = [];
    for (const mask of masks) {
      if (mask.id === excludeMaskId) continue;
      const geometry = geometryOf(mask);
      if (geometry === null) continue;
      for (const vertex of outlineVertices(geometry)) points.push({ x: vertex.x, y: vertex.y });
    }
    return {
      xs: [...lines.xs, space.crop.x, space.crop.x + space.crop.width],
      ys: [...lines.ys, space.crop.y, space.crop.y + space.crop.height],
      points,
    };
  };

  const snapped = (
    point: PixelPoint,
    event: { altKey: boolean },
    excludeMaskId: string | null,
  ): { point: PixelPoint; guideX: number | null; guideY: number | null } => {
    if (!snapOn(event)) return { point, guideX: null, guideY: null };
    const result = snapPoint(point, snapTargets(excludeMaskId), px(SNAP_RADIUS_PX));
    return { point: result.point, guideX: result.guideX, guideY: result.guideY };
  };

  const setLive = (maskId: string, geometry: MaskGeometry): void => {
    store.update({ live: { clipId: clip.id, maskId, geometry } });
  };

  // --- Analytic masks (MK8.1) ------------------------------------------------------------------

  /** An analytic mask's values at the playhead, with an uncommitted drag laid over them. */
  const analyticValues = (mask: AnalyticMaskLayer): AnalyticValues => {
    const live = tools.liveScalars;
    return analyticValuesAt(
      mask,
      sourceTime,
      live !== null && live.clipId === clip.id && live.maskId === mask.id ? live.values : null,
    );
  };

  /** Half-length of a guide line: the picture's diagonal crosses the whole picture at any angle. */
  const guideReach = Math.hypot(space.sourceWidth, space.sourceHeight) * 2;

  /**
   * Start dragging a split, band or gradient handle (or its line) under the pointer: the selected
   * one's handles first, then any analytic mask's line, which selects it. `true` when one was hit.
   */
  const beginAnalytic = (event: React.PointerEvent<SVGSVGElement>, point: PixelPoint): boolean => {
    const tolerance = px(HIT_RADIUS_PX);
    const client = { x: event.clientX, y: event.clientY };
    const start = (mask: AnalyticMaskLayer, handle: AnalyticHandle): void => {
      gesture.current = {
        kind: 'analytic',
        maskId: mask.id,
        maskKind: mask.kind,
        pointerId: event.pointerId,
        handle,
        start: point,
        startClient: client,
        base: analyticValues(mask),
        latest: null,
      };
    };
    const selected =
      selectedLayer !== null && isAnalyticLayer(selectedLayer) ? selectedLayer : null;
    if (selected !== null) {
      if (selected.locked) {
        report('This mask is locked. Unlock it in the mask list to edit it.');
        return true;
      }
      const values = analyticValues(selected);
      for (const { handle, point: at } of analyticHandlePoints(
        selected.kind,
        values,
        px(ROTATE_STALK_PX * 3),
      )) {
        if (Math.hypot(at.x - point.x, at.y - point.y) <= tolerance) {
          start(selected, handle);
          return true;
        }
      }
      if (hitsAnalyticMask(selected.kind, values, point, tolerance, guideReach)) {
        start(selected, 'body');
        return true;
      }
    }
    for (const mask of analyticLayers) {
      if (mask.id === selected?.id) continue;
      if (!hitsAnalyticMask(mask.kind, analyticValues(mask), point, tolerance, guideReach))
        continue;
      store.selectMask(mask.id);
      if (mask.locked) {
        report('This mask is locked. Unlock it in the mask list to edit it.');
        return true;
      }
      start(mask, 'body');
      return true;
    }
    return false;
  };

  // --- Transform boxes -----------------------------------------------------------------------

  const selectionBox = (mask: MaskLayer, geometry: MaskGeometry): OrientedBox | null => {
    if (geometry.kind !== 'path') return boxOf(geometry);
    if (mask.kind !== 'path' || selectedVertices.size < 2) return null;
    const bounds = verticesBounds(geometry.vertices, selectedVertices);
    if (bounds === null) return null;
    return {
      cx: bounds.x + bounds.width / 2,
      cy: bounds.y + bounds.height / 2,
      halfWidth: bounds.width / 2,
      halfHeight: bounds.height / 2,
      rotation: 0,
    };
  };

  const edgeKnobs = (
    mask: MaskLayer,
    geometry: MaskGeometry,
  ): { property: EdgeProperty; point: PixelPoint; label: string }[] => {
    const right = knobAnchor(geometry);
    if (right === null) return [];
    const expansion = scalarOf(mask, 'expansionPx');
    const outer = scalarOf(mask, 'featherOuterPx');
    const inner = scalarOf(mask, 'featherInnerPx');
    // Beside the shape's right edge, clear of the transform box and the points, each knob
    // sitting as far out as the value it sets (outer feather beyond expansion, inner inside it).
    const x = right.x + px(KNOB_GAP_PX);
    return [
      { property: 'expansionPx', point: { x: x + expansion, y: right.y }, label: 'Expansion' },
      {
        property: 'featherOuterPx',
        point: { x: x + expansion + outer, y: right.y - px(KNOB_SPACING_PX) },
        label: 'Outer feather',
      },
      {
        property: 'featherInnerPx',
        point: { x: x + expansion - inner, y: right.y + px(KNOB_SPACING_PX) },
        label: 'Inner feather',
      },
    ];
  };

  /** The outline's rightmost point, which the edge knobs are measured from. */
  const knobAnchor = (geometry: MaskGeometry): PixelPoint | null => {
    const polygon = flattenOutline(outlineVertices(geometry));
    if (polygon.length === 0) return null;
    let right = polygon[0]!;
    for (const point of polygon) if (point.x > right.x) right = point;
    return right;
  };

  // --- Pointer --------------------------------------------------------------------------------

  const capture = (event: React.PointerEvent<SVGSVGElement>): void => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is an optimisation; the gesture still tracks without it. */
    }
  };

  const beginSelect = (event: React.PointerEvent<SVGSVGElement>, point: PixelPoint): void => {
    if (beginAnalytic(event, point)) return;
    const tolerance = px(HIT_RADIUS_PX);
    const client = { x: event.clientX, y: event.clientY };
    const base = (mask: MaskLayer): MaskGeometry | null => geometryOf(mask);
    if (selectedMask !== null && !selectedMask.locked) {
      const geometry = base(selectedMask);
      if (geometry !== null) {
        const start = {
          kind: 'geometry' as const,
          maskId: selectedMask.id,
          pointerId: event.pointerId,
          start: point,
          startClient: client,
          base: geometry,
          latest: null,
        };
        // Edge knobs.
        for (const knob of edgeKnobs(selectedMask, geometry)) {
          if (Math.hypot(knob.point.x - point.x, knob.point.y - point.y) <= tolerance) {
            gesture.current = {
              kind: 'edge',
              maskId: selectedMask.id,
              pointerId: event.pointerId,
              property: knob.property,
              originX: knobAnchor(geometry)!.x + px(KNOB_GAP_PX),
              expansion: scalarOf(selectedMask, 'expansionPx'),
              latest: null,
            };
            return;
          }
        }
        // Transform box handles.
        const box = selectionBox(selectedMask, geometry);
        if (box !== null) {
          const rotated = rotateHandlePoint(box, px(ROTATE_STALK_PX));
          if (Math.hypot(rotated.x - point.x, rotated.y - point.y) <= tolerance) {
            gesture.current = {
              ...start,
              mode:
                geometry.kind === 'path'
                  ? {
                      type: 'selection-rotate',
                      indices: selectedVertices,
                      centre: { x: box.cx, y: box.cy },
                    }
                  : { type: 'box-rotate', centre: { x: box.cx, y: box.cy } },
            };
            return;
          }
          for (const handle of BOX_HANDLES) {
            const at = boxHandlePoint(box, handle.ux, handle.uy);
            if (Math.hypot(at.x - point.x, at.y - point.y) > tolerance) continue;
            gesture.current = {
              ...start,
              mode:
                geometry.kind === 'path'
                  ? {
                      type: 'selection-resize',
                      indices: new Set(selectedVertices),
                      box,
                      ux: handle.ux,
                      uy: handle.uy,
                    }
                  : { type: 'box-resize', ux: handle.ux, uy: handle.uy },
            };
            return;
          }
        }
        if (geometry.kind === 'path') {
          const tangent = hitTangent(geometry.vertices, selectedVertices, point, tolerance);
          if (tangent !== null) {
            gesture.current = {
              ...start,
              mode: { type: 'tangent', vertex: tangent.vertex, side: tangent.side },
            };
            return;
          }
          const vertex = hitVertex(geometry.vertices, point, tolerance);
          if (vertex >= 0) {
            if (event.metaKey || event.ctrlKey) {
              run({
                type: 'set_mask_geometry',
                clipId: clip.id,
                maskId: selectedMask.id,
                sourceTime,
                geometry: { kind: 'path', vertices: toggleVertexSmooth(geometry.vertices, vertex) },
              });
              return;
            }
            let indices: Set<number>;
            if (event.shiftKey) {
              indices = new Set(selectedVertices);
              if (indices.has(vertex)) indices.delete(vertex);
              else indices.add(vertex);
            } else {
              indices = selectedVertices.has(vertex)
                ? new Set(selectedVertices)
                : new Set([vertex]);
            }
            store.update({ selectedVertices: [...indices].sort((a, b) => a - b) });
            gesture.current = { ...start, mode: { type: 'vertices', indices, grabbed: vertex } };
            return;
          }
          const hit = nearestPointOnPath(geometry.vertices, point);
          if (hit !== null && hit.distance <= tolerance && hit.t > 0 && hit.t < 1) {
            gesture.current = {
              ...start,
              mode: { type: 'segment', segment: hit.segment, t: hit.t },
            };
            return;
          }
        }
        if (pointInPolygon(flattenOutline(outlineVertices(geometry)), point)) {
          gesture.current = { ...start, mode: { type: 'move' } };
          return;
        }
      }
    }
    // Another mask under the pointer: select it and move it.
    for (const mask of masks) {
      if (mask.id === selectedMask?.id) continue;
      const geometry = base(mask);
      if (geometry === null || !pointInPolygon(flattenOutline(outlineVertices(geometry)), point))
        continue;
      store.selectMask(mask.id);
      if (mask.locked) {
        report('This mask is locked. Unlock it in the mask list to edit it.');
        return;
      }
      gesture.current = {
        kind: 'geometry',
        maskId: mask.id,
        pointerId: event.pointerId,
        start: point,
        startClient: client,
        base: geometry,
        latest: null,
        mode: { type: 'move' },
      };
      return;
    }
    if (selectedMask?.locked === true) {
      report('This mask is locked. Unlock it in the mask list to edit it.');
    }
    gesture.current = {
      kind: 'marquee',
      pointerId: event.pointerId,
      start: point,
      current: point,
      additive: event.shiftKey,
    };
  };

  /** Sample the monitor and fold the colour into the key (`keySampleChanges`). */
  const pickKeyColour = (
    mask: Extract<MaskLayer, { kind: 'key' }>,
    clientX: number,
    clientY: number,
    add: boolean,
  ): void => {
    const canvas = document.querySelector<HTMLCanvasElement>('.webcodecs-preview-canvas');
    const colour = canvas === null ? null : sampleCanvasColour(canvas, clientX, clientY);
    if (colour === null) {
      report('Move the playhead to a frame on the monitor, then pick again.');
      return;
    }
    if (
      run({
        type: 'set_mask_properties',
        clipId: clip.id,
        maskId: mask.id,
        sourceTime,
        changes: keySampleChanges(mask, colour, add),
      })
    ) {
      store.update({ eyedropper: false });
      setAnnouncement(add ? 'Colour added to the key' : 'Key set from the sampled colour');
    }
  };

  /**
   * Record one "keep this" / "not this" click for the next background removal (BR6.3).
   *
   * Stored as fractions of the picture, because that is what the pack's prompt takes, and at the
   * playhead's SOURCE instant, because the pack is prompted at a frame — the same clock the mask's
   * own keyframes use, so re-speeding or trimming the clip cannot move the frame the editor picked.
   */
  const addSubjectPoint = (point: PixelPoint, label: 'include' | 'exclude'): void => {
    if (!(space.sourceWidth > 0) || !(space.sourceHeight > 0)) return;
    const x = point.x / space.sourceWidth;
    const y = point.y / space.sourceHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      report('Click inside the picture to pick the subject.');
      return;
    }
    store.toggleSubjectPoint({ x, y, label, sourceTime });
    setAnnouncement(label === 'include' ? 'Subject point added' : 'Excluded point added');
  };

  /** Sample a brush stroke into evenly spaced subject points. Returns how many it added. */
  const addSubjectStroke = (
    samples: readonly PixelPoint[],
    label: 'include' | 'exclude',
  ): number => {
    const spacing = Math.max(1, BRUSH_SAMPLE_SPACING_PX);
    let added = 0;
    let last: PixelPoint | null = null;
    for (const sample of samples) {
      if (last !== null && Math.hypot(sample.x - last.x, sample.y - last.y) < spacing) continue;
      last = sample;
      const x = sample.x / space.sourceWidth;
      const y = sample.y / space.sourceHeight;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      store.toggleSubjectPoint({ x, y, label, sourceTime }, 0);
      added += 1;
    }
    return added;
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault();
      capture(event);
      gesture.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        basePan: tools.pan,
      };
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    svgRef.current?.focus({ preventScroll: true });
    capture(event);
    const point = toSource(event);
    setCursor(null);
    // MK6.1: the eyedropper takes the colour under the pointer straight off the monitor's
    // finished frame, so the key qualifies exactly what the editor pointed at.
    if (tools.eyedropper && selectedLayer?.kind === 'key') {
      pickKeyColour(selectedLayer, event.clientX, event.clientY, event.shiftKey);
      return;
    }
    switch (tools.tool) {
      case 'feature-point':
        // A click adds the point; a click on one removes it, because putting a point on the
        // wrong texture is the common mistake and undoing it must not clear the others.
        store.toggleFeaturePoint({ x: point.x, y: point.y });
        setAnnouncement('Feature point toggled');
        return;
      case 'ai-object':
        // Click = keep this, Alt-click = not this (BR6.3). Nothing runs on the click: the
        // points are what the NEXT background removal is prompted with.
        addSubjectPoint(point, event.altKey ? 'exclude' : 'include');
        return;
      case 'correction-brush':
        gesture.current = {
          kind: 'correction-brush',
          pointerId: event.pointerId,
          brush: tools.brushKind,
          samples: [point],
        };
        setDraft({ stroke: [point] });
        return;
      case 'ai-brush':
        gesture.current = {
          kind: 'ai-brush',
          pointerId: event.pointerId,
          label: event.altKey ? 'exclude' : 'include',
          samples: [point],
        };
        setDraft({ stroke: [point] });
        return;
      case 'exclude':
        gesture.current = {
          kind: 'draw-exclusion',
          pointerId: event.pointerId,
          start: point,
          current: point,
        };
        return;
      case 'select':
        beginSelect(event, point);
        return;
      case 'rectangle':
      case 'ellipse':
      case 'shape': {
        const start = snapped(point, event, null).point;
        gesture.current = {
          kind: 'draw-box',
          pointerId: event.pointerId,
          shape: tools.tool === 'shape' ? 'preset' : tools.tool,
          start,
          current: start,
        };
        return;
      }
      case 'freehand':
        gesture.current = { kind: 'freehand', pointerId: event.pointerId, samples: [point] };
        setDraft({ stroke: [point] });
        return;
      case 'split':
      case 'mirror':
      case 'gradient': {
        const start = snapped(point, { altKey: false }, null).point;
        gesture.current = {
          kind: 'draw-analytic',
          pointerId: event.pointerId,
          tool: tools.tool,
          start,
          current: start,
          radial: event.altKey,
        };
        return;
      }
      case 'pen':
        addPenPoint(point, event);
        gesture.current = { kind: 'pen-drag', pointerId: event.pointerId, index: penPoints.length };
        return;
    }
  };

  const addPenPoint = (
    raw: PixelPoint,
    modifiers: { shiftKey: boolean; altKey: boolean },
  ): void => {
    const first = penPoints[0];
    if (
      first !== undefined &&
      penPoints.length >= 3 &&
      Math.hypot(first.x - raw.x, first.y - raw.y) <= px(HIT_RADIUS_PX)
    ) {
      closePen(penPoints);
      return;
    }
    const previous = penPoints[penPoints.length - 1];
    let point = snapped(raw, modifiers, null).point;
    if (modifiers.shiftKey && previous !== undefined) point = constrainToAngle(previous, point);
    const next = [
      ...penPoints,
      { x: point.x, y: point.y, inX: 0, inY: 0, outX: 0, outY: 0, type: 'corner' as const },
    ];
    setPenPoints(next);
    setAnnouncement(`Point ${String(next.length)} at ${describePoint(point)}`);
  };

  const closePen = (points: readonly MaskPathVertex[]): void => {
    gesture.current = null;
    rectCache.current = null;
    if (points.length < 3) {
      report('A path needs at least three points.');
      return;
    }
    const id = nextMaskId(clip);
    if (drawMask({ kind: 'path', vertices: points })) {
      store.update({ selectedMaskId: id, selectedVertices: [], tool: 'select' });
      setAnnouncement('Path mask added');
    }
    setPenPoints([]);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const active = gesture.current;
    // The AI subject tools show what a click would pick BEFORE the click (BR6.8), so the
    // pointer is tracked even with no gesture in flight.
    if (tools.tool === 'ai-object' || tools.tool === 'ai-brush') setHover(toSource(event));
    if (active === null || active.pointerId !== event.pointerId) return;
    // Browsers stamp events on the performance clock; an environment that stamps on another
    // clock (a future value) falls back to handler entry, which under-reports only input delay.
    const now = performance.now();
    pendingPointerTs.current =
      event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
    pendingHandlerTs.current = now;
    // How long the browser took to deliver this event. Nothing the monitor can influence, but
    // without it a slow transport (Playwright's CDP-injected moves) is indistinguishable from
    // slow code — see plan/background-removal-ai/MK4-BUDGETS.md.
    maskToolTelemetry.record('inputDelay', now - pendingPointerTs.current);
    if (active.kind === 'pan') {
      store.update({
        pan: {
          x: active.basePan.x + event.clientX - active.startClient.x,
          y: active.basePan.y + event.clientY - active.startClient.y,
        },
      });
      return;
    }
    const point = toSource(event);
    switch (active.kind) {
      case 'geometry': {
        const moved = Math.hypot(
          event.clientX - active.startClient.x,
          event.clientY - active.startClient.y,
        );
        if (active.latest === null && moved < CLICK_SLOP_PX) return;
        const next = nextGeometry(active, point, event);
        if (next === null) return;
        active.latest = next.geometry;
        setLive(active.maskId, next.geometry);
        setDraft({ guideX: next.guideX, guideY: next.guideY });
        return;
      }
      case 'edge': {
        const raw = point.x - active.originX;
        const value =
          active.property === 'expansionPx'
            ? raw
            : active.property === 'featherOuterPx'
              ? Math.max(0, raw - active.expansion)
              : Math.max(0, active.expansion - raw);
        active.latest = value;
        store.update({
          liveScalars: {
            clipId: clip.id,
            maskId: active.maskId,
            values: { [active.property]: value },
          },
        });
        return;
      }
      case 'analytic': {
        const moved = Math.hypot(
          event.clientX - active.startClient.x,
          event.clientY - active.startClient.y,
        );
        if (active.latest === null && moved < CLICK_SLOP_PX) return;
        // Positions snap like any mask point; an angle, a width or a softness does not.
        const positional =
          active.handle === 'origin' ||
          active.handle === 'start' ||
          active.handle === 'end' ||
          active.handle === 'body';
        const target = positional ? snapped(point, event, active.maskId) : null;
        const values = dragAnalyticHandle(
          active.maskKind,
          active.handle,
          active.base,
          active.start,
          target?.point ?? point,
          event.shiftKey,
        );
        active.latest = values;
        store.update({ liveScalars: { clipId: clip.id, maskId: active.maskId, values } });
        setDraft({ guideX: target?.guideX ?? null, guideY: target?.guideY ?? null });
        return;
      }
      case 'draw-analytic': {
        active.current = point;
        setDraft({
          analytic: analyticDrawGeometry(
            active.tool,
            active.start,
            point,
            { width: space.sourceWidth, height: space.sourceHeight },
            { constrain: event.shiftKey, radial: active.radial },
          ),
        });
        return;
      }
      case 'marquee':
        active.current = point;
        setDraft({ marquee: rectFromCorners(active.start, point) });
        return;
      case 'draw-exclusion':
        active.current = point;
        setDraft({ marquee: rectFromCorners(active.start, point) });
        return;
      case 'draw-box': {
        const target = snapped(point, event, null);
        active.current = target.point;
        const box = dragBox(active.start, target.point, {
          square: event.shiftKey,
          fromCentre: event.altKey,
        });
        if (active.shape === 'preset') {
          setDraft({
            preset: presetDraft(box),
            guideX: target.guideX,
            guideY: target.guideY,
          });
          return;
        }
        const geometry: MaskGeometry =
          active.shape === 'rectangle'
            ? {
                kind: 'rectangle',
                cx: box.cx,
                cy: box.cy,
                width: box.width,
                height: box.height,
                rotation: 0,
                roundness: 0,
              }
            : {
                kind: 'ellipse',
                cx: box.cx,
                cy: box.cy,
                rx: box.width / 2,
                ry: box.height / 2,
                rotation: 0,
              };
        setDraft({
          box: { shape: active.shape, geometry },
          guideX: target.guideX,
          guideY: target.guideY,
        });
        return;
      }
      case 'freehand':
      case 'ai-brush':
      case 'correction-brush':
        active.samples.push(point);
        setDraft({ stroke: [...active.samples] });
        return;
      case 'pen-drag': {
        const vertex = penPoints[active.index];
        if (vertex === undefined) return;
        const outX = point.x - vertex.x;
        const outY = point.y - vertex.y;
        if (Math.hypot(outX, outY) < px(CLICK_SLOP_PX)) return;
        setPenPoints((points) =>
          points.map((candidate, index) =>
            index === active.index
              ? { ...candidate, outX, outY, inX: -outX, inY: -outY, type: 'smooth' as const }
              : candidate,
          ),
        );
        return;
      }
    }
  };

  const nextGeometry = (
    active: Extract<Gesture, { kind: 'geometry' }>,
    point: PixelPoint,
    event: { shiftKey: boolean; altKey: boolean },
  ): { geometry: MaskGeometry; guideX: number | null; guideY: number | null } | null => {
    const { base, mode } = active;
    const dx = point.x - active.start.x;
    const dy = point.y - active.start.y;
    switch (mode.type) {
      case 'move':
      case 'segment': {
        const centre = geometryCentre(base);
        const target = snapped({ x: centre.x + dx, y: centre.y + dy }, event, active.maskId);
        let moveX = target.point.x - centre.x;
        let moveY = target.point.y - centre.y;
        if (event.shiftKey) {
          if (Math.abs(moveX) >= Math.abs(moveY)) moveY = 0;
          else moveX = 0;
        }
        return {
          geometry: translateGeometry(base, moveX, moveY),
          guideX: target.guideX,
          guideY: target.guideY,
        };
      }
      case 'vertices': {
        if (base.kind !== 'path') return null;
        const grabbed = base.vertices[mode.grabbed]!;
        const target = snapped({ x: grabbed.x + dx, y: grabbed.y + dy }, event, active.maskId);
        return {
          geometry: {
            kind: 'path',
            vertices: moveVertices(
              base.vertices,
              mode.indices,
              target.point.x - grabbed.x,
              target.point.y - grabbed.y,
            ),
          },
          guideX: target.guideX,
          guideY: target.guideY,
        };
      }
      case 'tangent': {
        if (base.kind !== 'path') return null;
        const vertex = base.vertices[mode.vertex]!;
        return {
          geometry: {
            kind: 'path',
            vertices: dragTangent(
              base.vertices,
              mode.vertex,
              mode.side,
              { x: point.x - vertex.x, y: point.y - vertex.y },
              event.altKey,
            ),
          },
          guideX: null,
          guideY: null,
        };
      }
      case 'box-resize': {
        if (base.kind === 'path') return null;
        const box = resizeBox(boxOf(base), mode.ux, mode.uy, point, {
          fromCentre: event.altKey,
          keepAspect: event.shiftKey,
        });
        return { geometry: withBox(base, box), guideX: null, guideY: null };
      }
      case 'box-rotate': {
        if (base.kind === 'path') return null;
        const startAngle = Math.atan2(
          active.start.y - mode.centre.y,
          active.start.x - mode.centre.x,
        );
        const angle = Math.atan2(point.y - mode.centre.y, point.x - mode.centre.x);
        let degrees = base.rotation + ((angle - startAngle) * 180) / Math.PI;
        if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
        return { geometry: { ...base, rotation: degrees }, guideX: null, guideY: null };
      }
      case 'selection-resize': {
        if (base.kind !== 'path') return null;
        const next = resizeBox(mode.box, mode.ux, mode.uy, point, {
          fromCentre: event.altKey,
          keepAspect: event.shiftKey,
        });
        const scaleX = mode.box.halfWidth > 0 ? next.halfWidth / mode.box.halfWidth : 1;
        const scaleY = mode.box.halfHeight > 0 ? next.halfHeight / mode.box.halfHeight : 1;
        // Scale about the handle opposite the one dragged (or the centre with Alt).
        const anchor = event.altKey
          ? { x: mode.box.cx, y: mode.box.cy }
          : {
              x: mode.box.cx - mode.ux * mode.box.halfWidth,
              y: mode.box.cy - mode.uy * mode.box.halfHeight,
            };
        return {
          geometry: {
            kind: 'path',
            vertices: transformVertices(base.vertices, mode.indices, {
              ...identityTransform(anchor),
              scaleX: mode.ux === 0 ? 1 : scaleX,
              scaleY: mode.uy === 0 ? 1 : scaleY,
            }),
          },
          guideX: null,
          guideY: null,
        };
      }
      case 'selection-rotate': {
        if (base.kind !== 'path') return null;
        const startAngle = Math.atan2(
          active.start.y - mode.centre.y,
          active.start.x - mode.centre.x,
        );
        const angle = Math.atan2(point.y - mode.centre.y, point.x - mode.centre.x);
        let degrees = ((angle - startAngle) * 180) / Math.PI;
        if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
        return {
          geometry: {
            kind: 'path',
            vertices: transformVertices(base.vertices, mode.indices, {
              ...identityTransform(mode.centre),
              rotation: degrees,
            }),
          },
          guideX: null,
          guideY: null,
        };
      }
    }
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    rectCache.current = null;
    setDraft({});
    switch (active.kind) {
      case 'pan':
      case 'pen-drag':
        return;
      case 'geometry': {
        store.update({ live: null });
        if (active.latest === null) {
          if (active.mode.type === 'segment') {
            run({
              type: 'insert_mask_vertex',
              clipId: clip.id,
              maskId: active.maskId,
              segment: active.mode.segment,
              t: active.mode.t,
            });
            setAnnouncement('Point added');
          } else if (active.mode.type === 'move') {
            store.update({ selectedVertices: [] });
          }
          return;
        }
        run({
          type: 'set_mask_geometry',
          clipId: clip.id,
          maskId: active.maskId,
          sourceTime,
          geometry: active.latest,
        });
        return;
      }
      case 'edge': {
        store.update({ liveScalars: null });
        if (active.latest === null) return;
        run({
          type: 'set_mask_properties',
          clipId: clip.id,
          maskId: active.maskId,
          sourceTime,
          changes: { [active.property]: active.latest },
          allKeyframes: tools.allKeyframes,
        });
        return;
      }
      case 'analytic': {
        store.update({ liveScalars: null });
        if (active.latest === null) return;
        run({
          type: 'set_mask_properties',
          clipId: clip.id,
          maskId: active.maskId,
          sourceTime,
          changes: active.latest,
          allKeyframes: tools.allKeyframes,
        });
        return;
      }
      case 'draw-analytic': {
        const geometry = analyticDrawGeometry(
          active.tool,
          active.start,
          active.current,
          { width: space.sourceWidth, height: space.sourceHeight },
          { constrain: event.shiftKey, radial: active.radial },
        );
        if (geometry === null) {
          report('Drag from where the gradient is opaque to where it is clear.');
          return;
        }
        const id = nextMaskId(clip);
        if (drawMask(geometry)) {
          store.update({ selectedMaskId: id, selectedVertices: [], tool: 'select' });
          setAnnouncement(
            active.tool === 'split'
              ? 'Split mask added'
              : active.tool === 'mirror'
                ? 'Mirror band mask added'
                : 'Gradient mask added',
          );
        }
        return;
      }
      case 'marquee': {
        if (selectedMask === null || selectedMask.kind !== 'path') return;
        const geometry = geometryOf(selectedMask);
        if (geometry === null || geometry.kind !== 'path') return;
        const inside = verticesInRect(
          geometry.vertices,
          rectFromCorners(active.start, active.current),
        );
        const merged = active.additive ? new Set([...selectedVertices, ...inside]) : inside;
        store.update({ selectedVertices: [...merged].sort((a, b) => a - b) });
        return;
      }
      case 'draw-box': {
        commitBox(active.shape, active.start, active.current, event);
        return;
      }
      case 'correction-brush': {
        // The stroke is a DRAFT: it paints nothing until [Apply fix] saves it as a correction
        // input and re-runs the affected window, so an unapplied stroke never changes output.
        store.addCorrectionStroke({
          kind: active.brush,
          radiusPx: tools.brushRadiusPx,
          sourceTime,
          points: active.samples.map((sample) => ({ x: sample.x, y: sample.y })),
        });
        setAnnouncement(active.brush === 'keep' ? 'Keep stroke drawn' : 'Remove stroke drawn');
        return;
      }
      case 'ai-brush': {
        // A stroke is sampled into points at a fixed spacing, because the pack is prompted with
        // points at an instant; a denser stroke must not mean a heavier prompt.
        const added = addSubjectStroke(active.samples, active.label);
        setAnnouncement(
          added === 0
            ? 'Stroke too short — draw across the subject.'
            : `${String(added)} subject point(s) added`,
        );
        return;
      }
      case 'draw-exclusion': {
        const region = rectFromCorners(active.start, active.current);
        store.addExclusion(region);
        setAnnouncement('Excluded region added');
        return;
      }
      case 'freehand': {
        const vertices = fitClosedStroke(
          active.samples,
          Math.max(0.25, px(FREEHAND_FIT_TOLERANCE_PX)),
        );
        if (vertices === null) {
          report('Draw a larger shape.');
          return;
        }
        const id = nextMaskId(clip);
        if (drawMask({ kind: 'path', vertices })) {
          store.update({ selectedMaskId: id, selectedVertices: [], tool: 'select' });
          setAnnouncement(`Freehand mask added with ${String(vertices.length)} points`);
        }
        return;
      }
    }
  };

  /** The preset's outlines inside a dragged box, or none while the box is under a pixel. */
  const presetDraft = (box: {
    cx: number;
    cy: number;
    width: number;
    height: number;
  }): (readonly MaskPathVertex[])[] => {
    if (box.width < 1 || box.height < 1) return [];
    return shapePresetPaths(tools.shapePreset, box, { points: tools.shapePoints }).map(
      (path) => path.vertices,
    );
  };

  const commitBox = (
    shape: 'rectangle' | 'ellipse' | 'preset',
    start: PixelPoint,
    end: PixelPoint,
    modifiers: { shiftKey: boolean; altKey: boolean },
  ): void => {
    const box = dragBox(start, end, { square: modifiers.shiftKey, fromCentre: modifiers.altKey });
    if (box.width < 1 || box.height < 1) {
      report('Drag to draw the shape.');
      return;
    }
    const id = nextMaskId(clip);
    if (shape === 'preset') {
      const target = tools.pendingTarget;
      const drawn = run({
        type: 'draw_shape_preset',
        clipId: clip.id,
        preset: tools.shapePreset,
        box: { cx: box.cx, cy: box.cy, width: box.width, height: box.height },
        options: { points: tools.shapePoints },
        sourceTime,
        ...(target === null ? {} : { target }),
      });
      if (drawn) {
        store.update({
          selectedMaskId: id,
          selectedVertices: [],
          tool: 'select',
          ...(target === null ? {} : { pendingTarget: null }),
        });
        setAnnouncement(`${MASK_SHAPE_PRESET_NAMES[tools.shapePreset]} mask added`);
      }
      return;
    }
    const geometry: MaskGeometry =
      shape === 'rectangle'
        ? {
            kind: 'rectangle',
            cx: box.cx,
            cy: box.cy,
            width: box.width,
            height: box.height,
            rotation: 0,
            roundness: 0,
          }
        : {
            kind: 'ellipse',
            cx: box.cx,
            cy: box.cy,
            rx: box.width / 2,
            ry: box.height / 2,
            rotation: 0,
          };
    if (drawMask(geometry)) {
      store.update({ selectedMaskId: id, selectedVertices: [], tool: 'select' });
      setAnnouncement(`${shape === 'rectangle' ? 'Rectangle' : 'Ellipse'} mask added`);
    }
  };

  const onPointerCancel = (): void => {
    gesture.current = null;
    rectCache.current = null;
    setDraft({});
    store.update({ live: null, liveScalars: null });
  };

  const onWheel = (event: React.WheelEvent<SVGSVGElement>): void => {
    if (tools.zoom === 'fit') return;
    store.update({ pan: { x: tools.pan.x - event.deltaX, y: tools.pan.y - event.deltaY } });
  };

  // --- Keyboard -------------------------------------------------------------------------------

  const nudge = (dx: number, dy: number): void => {
    if (selectedMask === null && selectedLayer !== null && isAnalyticLayer(selectedLayer)) {
      if (selectedLayer.locked) {
        report('This mask is locked. Unlock it in the mask list to edit it.');
        return;
      }
      const values = analyticValues(selectedLayer);
      const changes =
        selectedLayer.kind === 'gradient'
          ? {
              startX: values.startX! + dx,
              startY: values.startY! + dy,
              endX: values.endX! + dx,
              endY: values.endY! + dy,
            }
          : { originX: values.originX! + dx, originY: values.originY! + dy };
      if (
        run({
          type: 'set_mask_properties',
          clipId: clip.id,
          maskId: selectedLayer.id,
          sourceTime,
          changes,
          allKeyframes: tools.allKeyframes,
        })
      ) {
        setAnnouncement(`Moved ${String(Math.abs(dx || dy))} px`);
      }
      return;
    }
    if (selectedMask === null) return;
    if (selectedMask.locked) {
      report('This mask is locked. Unlock it in the mask list to edit it.');
      return;
    }
    const geometry = geometryOf(selectedMask);
    if (geometry === null) return;
    const next =
      geometry.kind === 'path' && selectedVertices.size > 0
        ? {
            kind: 'path' as const,
            vertices: moveVertices(geometry.vertices, selectedVertices, dx, dy),
          }
        : translateGeometry(geometry, dx, dy);
    if (
      run({
        type: 'set_mask_geometry',
        clipId: clip.id,
        maskId: selectedMask.id,
        sourceTime,
        geometry: next,
      })
    ) {
      setAnnouncement(`Moved ${String(Math.abs(dx || dy))} px`);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const modifier = event.metaKey || event.ctrlKey;
    const lower = event.key.toLowerCase();
    if (!modifier && !event.altKey && TOOL_KEYS[lower] !== undefined) {
      handled();
      store.setTool(TOOL_KEYS[lower]!);
      setPenPoints([]);
      setBoxAnchor(null);
      setAnnouncement(TOOLS.find((entry) => entry.tool === TOOL_KEYS[lower])!.label);
      return;
    }
    const drawing = tools.tool !== 'select';
    const step = event.shiftKey ? NUDGE_LARGE_PX : NUDGE_PX;
    const arrows: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const arrow = arrows[event.key];
    if (arrow !== undefined && !modifier) {
      handled();
      if (drawing) {
        const from = cursor ?? {
          x: space.crop.x + space.crop.width / 2,
          y: space.crop.y + space.crop.height / 2,
        };
        const next = { x: from.x + arrow[0], y: from.y + arrow[1] };
        setCursor(next);
        setAnnouncement(`Crosshair ${describePoint(next)}`);
      } else {
        nudge(arrow[0], arrow[1]);
      }
      return;
    }
    if (event.key === ' ' && !modifier) {
      handled();
      if (!drawing) {
        setSpaceHeld(true);
        return;
      }
      const at = cursor ?? {
        x: space.crop.x + space.crop.width / 2,
        y: space.crop.y + space.crop.height / 2,
      };
      setCursor(at);
      if (tools.tool === 'ai-object' || tools.tool === 'ai-brush') {
        addSubjectPoint(at, event.shiftKey ? 'exclude' : 'include');
      } else if (tools.tool === 'pen') {
        addPenPoint(at, { shiftKey: false, altKey: true });
      } else if (tools.tool === 'split' || tools.tool === 'mirror' || tools.tool === 'gradient') {
        if (boxAnchor === null) {
          setBoxAnchor(at);
          setAnnouncement(
            `Start set at ${describePoint(at)}. Move the crosshair and press Space again.`,
          );
        } else {
          const geometry = analyticDrawGeometry(
            tools.tool,
            boxAnchor,
            at,
            { width: space.sourceWidth, height: space.sourceHeight },
            { constrain: false, radial: event.altKey },
          );
          setBoxAnchor(null);
          if (geometry === null)
            report('Move the crosshair away from the start, then press Space.');
          else if (drawMask(geometry)) {
            store.update({ selectedMaskId: nextMaskId(clip), tool: 'select' });
            setAnnouncement('Mask added');
          }
        }
      } else if (tools.tool === 'rectangle' || tools.tool === 'ellipse' || tools.tool === 'shape') {
        if (boxAnchor === null) {
          setBoxAnchor(at);
          setAnnouncement(
            `Corner set at ${describePoint(at)}. Move the crosshair and press Space again.`,
          );
        } else {
          commitBox(tools.tool === 'shape' ? 'preset' : tools.tool, boxAnchor, at, {
            shiftKey: false,
            altKey: false,
          });
          setBoxAnchor(null);
        }
      }
      return;
    }
    if (event.key === 'Enter' && (tools.tool === 'ai-object' || tools.tool === 'ai-brush')) {
      handled();
      const at = cursor ?? {
        x: space.crop.x + space.crop.width / 2,
        y: space.crop.y + space.crop.height / 2,
      };
      setCursor(at);
      addSubjectPoint(at, event.shiftKey ? 'exclude' : 'include');
      return;
    }
    if (event.key === 'Enter' && tools.tool === 'pen') {
      handled();
      closePen(penPoints);
      return;
    }
    if (event.key === 'Escape') {
      if (
        (tools.tool === 'ai-object' || tools.tool === 'ai-brush') &&
        tools.subjectPoints.length > 0
      ) {
        handled();
        store.clearSubjectPoints();
        setAnnouncement('Subject points cleared');
        return;
      }
      if (penPoints.length > 0 || boxAnchor !== null || gesture.current !== null) {
        handled();
        setPenPoints([]);
        setBoxAnchor(null);
        onPointerCancel();
        setAnnouncement('Drawing cancelled');
        return;
      }
      if (selectedVertices.size > 0) {
        handled();
        store.update({ selectedVertices: [] });
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      handled();
      if (tools.tool === 'pen' && penPoints.length > 0) {
        setPenPoints((points) => points.slice(0, -1));
        return;
      }
      if (selectedMask === null && selectedLayer !== null && isAnalyticLayer(selectedLayer)) {
        if (run({ type: 'remove_mask', clipId: clip.id, maskId: selectedLayer.id })) {
          store.selectMask(null);
          setAnnouncement('Mask deleted');
        }
        return;
      }
      if (selectedMask === null) return;
      if (selectedMask.kind === 'path' && selectedVertices.size > 0) {
        if (
          run({
            type: 'remove_mask_vertices',
            clipId: clip.id,
            maskId: selectedMask.id,
            vertices: [...selectedVertices],
          })
        ) {
          store.update({ selectedVertices: [] });
          setAnnouncement('Points deleted');
        }
        return;
      }
      if (run({ type: 'remove_mask', clipId: clip.id, maskId: selectedMask.id })) {
        store.selectMask(null);
        setAnnouncement('Mask deleted');
      }
      return;
    }
    if (!modifier && (lower === 't' || lower === 'x')) {
      handled();
      store.setTool(lower === 't' ? 'feature-point' : 'exclude');
      setAnnouncement(lower === 't' ? 'Feature point tool' : 'Exclude region tool');
      return;
    }
    if (modifier && (lower === 'c' || lower === 'v')) {
      handled();
      if (lower === 'c') {
        const copied = copyMasks(clip, assets, selectedMask === null ? [] : [selectedMask.id]);
        if (typeof copied === 'string') report(copied);
        else {
          store.update({ clipboard: copied, message: null });
          setAnnouncement('Mask copied');
        }
      } else if (tools.clipboard !== null) {
        if (run({ type: 'paste_masks', clipId: clip.id, clipboard: tools.clipboard })) {
          setAnnouncement('Masks pasted');
        }
      }
      return;
    }
    if ((event.key === '[' || event.key === ']') && selectedMask?.kind === 'path') {
      const geometry = geometryOf(selectedMask);
      if (geometry === null || geometry.kind !== 'path') return;
      handled();
      const count = geometry.vertices.length;
      const current =
        tools.selectedVertices.length > 0
          ? tools.selectedVertices[tools.selectedVertices.length - 1]!
          : -1;
      const next = event.key === ']' ? (current + 1) % count : (current - 1 + count) % count;
      store.update({ selectedVertices: [next] });
      setAnnouncement(
        `Point ${String(next + 1)} of ${String(count)} at ${describePoint(geometry.vertices[next]!)}`,
      );
    }
  };

  const onKeyUp = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    if (event.key === ' ') setSpaceHeld(false);
  };

  // --- Drawing --------------------------------------------------------------------------------

  const zoomPercent = tools.zoom === 'fit' ? 0 : Number(tools.zoom);
  const strokeWidth = 1.5;
  const selectedGeometry = selectedMask === null ? null : geometryOf(selectedMask);
  const box =
    selectedMask !== null && selectedGeometry !== null
      ? selectionBox(selectedMask, selectedGeometry)
      : null;

  const chrome = (
    <>
      <div className="mask-canvas-toolbar" role="toolbar" aria-label="Mask tools">
        {TOOLS.map(({ tool, label, key }) => {
          const Icon = TOOL_ICONS[tool];
          const needsPack = tool === 'ai-object' || tool === 'ai-brush';
          const blocked = needsPack && subjectCopy.blocked;
          return (
            <Tooltip key={tool} label={blocked ? subjectCopy.tooltip : `${label} (${key})`}>
              <button
                type="button"
                className="mask-canvas-tool"
                aria-label={label}
                aria-pressed={tools.tool === tool}
                disabled={blocked}
                aria-disabled={blocked}
                onClick={() => {
                  store.setTool(tool);
                  setPenPoints([]);
                  setBoxAnchor(null);
                }}
              >
                <Icon size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </Tooltip>
          );
        })}
        <span className="mask-canvas-toolbar-divider" aria-hidden="true" />
        <Tooltip label="Snap to edges, centre and other masks (hold Alt to invert)">
          <button
            type="button"
            className="mask-canvas-tool"
            aria-label="Snapping"
            aria-pressed={tools.snapping}
            onClick={() => store.update({ snapping: !tools.snapping })}
          >
            <Magnet size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
        {tools.tool === 'shape' && (
          <>
            <label className="mask-canvas-zoom">
              <span className="sr-only">Shape preset</span>
              <select
                aria-label="Shape preset"
                value={tools.shapePreset}
                onChange={(event) =>
                  store.update({ shapePreset: event.target.value as MaskShapePreset })
                }
              >
                {MASK_SHAPE_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {MASK_SHAPE_PRESET_NAMES[preset]}
                  </option>
                ))}
              </select>
            </label>
            {(tools.shapePreset === 'star' || tools.shapePreset === 'polygon') && (
              <label className="mask-canvas-zoom">
                <span className="sr-only">
                  {tools.shapePreset === 'star' ? 'Star points' : 'Polygon sides'}
                </span>
                <input
                  type="number"
                  aria-label={tools.shapePreset === 'star' ? 'Star points' : 'Polygon sides'}
                  min={3}
                  max={64}
                  step={1}
                  value={tools.shapePoints}
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value));
                    if (Number.isFinite(value)) {
                      store.update({ shapePoints: Math.min(64, Math.max(3, value)) });
                    }
                  }}
                />
              </label>
            )}
          </>
        )}
        <label className="mask-canvas-zoom">
          <span className="sr-only">Mask zoom</span>
          <select
            aria-label="Mask zoom"
            value={tools.zoom}
            onChange={(event) =>
              store.update({ zoom: event.target.value as MaskZoom, pan: { x: 0, y: 0 } })
            }
          >
            {MASK_ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level === 'fit' ? 'Fit' : `${level}%`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(tools.tool === 'ai-object' || tools.tool === 'ai-brush') && (
        <p className="mask-canvas-hint" role="status">
          {tools.tool === 'ai-object'
            ? 'Click the subject to keep it. Alt-click anything to leave out. Esc clears.'
            : 'Drag across the subject to keep it. Alt-drag over anything to leave out. Esc clears.'}{' '}
          {tools.subjectPoints.length > 0 &&
            `${String(tools.subjectPoints.length)} point(s) picked.`}
        </p>
      )}
      {tools.message !== null && (
        <p className="mask-canvas-message" role="status">
          {tools.message}
        </p>
      )}
    </>
  );

  return (
    <>
      <svg
        ref={svgRef}
        className="mask-canvas"
        data-tool={tools.tool}
        data-panning={spaceHeld || undefined}
        viewBox={`0 0 ${resolution.width} ${resolution.height}`}
        preserveAspectRatio="none"
        role="application"
        aria-label="Mask canvas"
        aria-roledescription="mask drawing canvas"
        aria-describedby="mask-canvas-help"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <g transform={affineAttribute(space.toFrame)}>
          {zoomPercent >= PIXEL_GRID_MIN_ZOOM && (
            <>
              <defs>
                <pattern id="mask-pixel-grid" width={1} height={1} patternUnits="userSpaceOnUse">
                  <path
                    d="M1 0H0V1"
                    className="mask-canvas-pixel-grid"
                    strokeWidth={px(1)}
                    fill="none"
                  />
                </pattern>
              </defs>
              <rect
                x={space.crop.x}
                y={space.crop.y}
                width={space.crop.width}
                height={space.crop.height}
                fill="url(#mask-pixel-grid)"
                data-testid="mask-pixel-grid"
              />
            </>
          )}
          {masks.map((mask) => {
            const geometry = geometryOf(mask);
            if (geometry === null) return null;
            const selected = mask.id === selectedMask?.id;
            return (
              <path
                key={mask.id}
                className="mask-canvas-outline"
                data-selected={selected || undefined}
                data-enabled={mask.enabled || undefined}
                d={outlinePathData(outlineVertices(geometry))}
                stroke={mask.color}
                strokeWidth={selected ? strokeWidth * 1.5 : strokeWidth}
                vectorEffect="non-scaling-stroke"
                fill="none"
                data-mask-id={mask.id}
              />
            );
          })}
          {analyticLayers.map((mask) => (
            <AnalyticMaskGuides
              key={mask.id}
              mask={mask}
              values={analyticValues(mask)}
              selected={mask.id === tools.selectedMaskId}
              reach={guideReach}
              strokeWidth={strokeWidth}
              px={px}
            />
          ))}
          {draft.analytic !== undefined && draft.analytic !== null && (
            <AnalyticDraft geometry={draft.analytic} reach={guideReach} />
          )}
          {selectedMask !== null && selectedGeometry !== null && (
            <SelectedMaskHandles
              mask={selectedMask}
              geometry={selectedGeometry}
              selectedVertices={selectedVertices}
              box={box}
              px={px}
              expansion={scalarOf(selectedMask, 'expansionPx')}
              featherOuter={scalarOf(selectedMask, 'featherOuterPx')}
              featherInner={scalarOf(selectedMask, 'featherInnerPx')}
              knobs={edgeKnobs(selectedMask, selectedGeometry)}
            />
          )}
          {draft.box !== undefined && (
            <path
              className="mask-canvas-draft"
              d={outlinePathData(outlineVertices(draft.box.geometry))}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          )}
          {draft.preset?.map((vertices, index) => (
            <path
              key={`preset-${String(index)}`}
              className="mask-canvas-draft"
              data-testid="mask-preset-draft"
              d={outlinePathData(outlineVertices({ kind: 'path', vertices }))}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          ))}
          {draft.stroke !== undefined && (
            <path
              className="mask-canvas-draft"
              d={polylinePathData(draft.stroke)}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          )}
          {draft.marquee !== undefined && (
            <rect
              className="mask-canvas-marquee"
              x={draft.marquee.x}
              y={draft.marquee.y}
              width={draft.marquee.width}
              height={draft.marquee.height}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {/*
            Tracking hints (MK7.4). They are drawn whatever tool is active, because what the
            tracker will follow and ignore has to be visible while the mask is being adjusted —
            not only while the hint tool happens to be selected.
          */}
          {tools.exclusions.map((region) => (
            <rect
              key={`exclude-${region.x}-${region.y}-${region.width}-${region.height}`}
              className="mask-canvas-exclusion"
              x={region.x}
              y={region.y}
              width={region.width}
              height={region.height}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* BR6.8: what a click would pick, shown before the click. The pack's per-frame
              segmentation (`subject.segment_frame`) is what would tint the OBJECT under the
              pointer; until that capability exists the monitor shows where the pick lands,
              rather than tinting a shape nothing has measured. */}
          {(tools.tool === 'ai-object' || tools.tool === 'ai-brush') && hover !== null && (
            <circle
              className="mask-canvas-subject-hover"
              cx={hover.x}
              cy={hover.y}
              r={tools.tool === 'ai-brush' ? tools.brushRadiusPx : px(10)}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {tools.correctionStrokes.map((stroke, index) => (
            <path
              key={`fix-${String(index)}`}
              className="mask-canvas-correction"
              data-kind={stroke.kind}
              d={polylinePathData([...stroke.points], false)}
              strokeWidth={stroke.radiusPx * 2}
              fill="none"
            />
          ))}
          {tools.subjectPoints.map((point) => (
            <g key={`subject-${String(point.x)}-${String(point.y)}-${point.label}`}>
              <circle
                className="mask-canvas-subject-point"
                data-label={point.label}
                cx={point.x * space.sourceWidth}
                cy={point.y * space.sourceHeight}
                r={px(5)}
                vectorEffect="non-scaling-stroke"
              />
              {/* A plus or a minus, so include and exclude are told apart without colour. */}
              <path
                className="mask-canvas-subject-sign"
                d={
                  point.label === 'include'
                    ? `M ${String(point.x * space.sourceWidth - px(3))} ${String(point.y * space.sourceHeight)} h ${String(px(6))} M ${String(point.x * space.sourceWidth)} ${String(point.y * space.sourceHeight - px(3))} v ${String(px(6))}`
                    : `M ${String(point.x * space.sourceWidth - px(3))} ${String(point.y * space.sourceHeight)} h ${String(px(6))}`
                }
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {tools.featurePoints.map((point) => (
            <circle
              key={`feature-${point.x}-${point.y}`}
              className="mask-canvas-feature-point"
              cx={point.x}
              cy={point.y}
              r={px(4)}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {penPoints.length > 0 && (
            <>
              <path
                className="mask-canvas-draft"
                d={outlinePathData(penPoints).replace(/Z$/, '')}
                vectorEffect="non-scaling-stroke"
                fill="none"
              />
              <path
                className="mask-canvas-vertex"
                d={squaresPathData(penPoints, px(VERTEX_HANDLE_PX))}
              />
            </>
          )}
          {draft.guideX !== undefined && draft.guideX !== null && (
            <line
              className="mask-canvas-guide"
              x1={draft.guideX}
              x2={draft.guideX}
              y1={0}
              y2={space.sourceHeight}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {draft.guideY !== undefined && draft.guideY !== null && (
            <line
              className="mask-canvas-guide"
              y1={draft.guideY}
              y2={draft.guideY}
              x1={0}
              x2={space.sourceWidth}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {(cursor !== null || boxAnchor !== null) && (
            <g className="mask-canvas-crosshair" data-testid="mask-crosshair">
              {cursor !== null && (
                <>
                  <line
                    x1={cursor.x - px(10)}
                    x2={cursor.x + px(10)}
                    y1={cursor.y}
                    y2={cursor.y}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    y1={cursor.y - px(10)}
                    y2={cursor.y + px(10)}
                    x1={cursor.x}
                    x2={cursor.x}
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
              {boxAnchor !== null && cursor !== null && (
                <path
                  className="mask-canvas-draft"
                  d={polylinePathData(
                    [
                      boxAnchor,
                      { x: cursor.x, y: boxAnchor.y },
                      cursor,
                      { x: boxAnchor.x, y: cursor.y },
                    ],
                    true,
                  )}
                  vectorEffect="non-scaling-stroke"
                  fill="none"
                />
              )}
            </g>
          )}
        </g>
      </svg>
      <p id="mask-canvas-help" className="sr-only">
        V, R, E, P and F choose a shape tool; O is AI Object and B is AI Brush. Arrow keys move the
        crosshair or nudge the selection; hold Shift for 10 pixels. Space adds a point, Enter picks
        the subject under the crosshair and Shift+Enter excludes it, Escape cancels. Delete removes
        the selected points or mask.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {chromeHost ? createPortal(chrome, chromeHost) : chrome}
    </>
  );
}

interface AnalyticMaskGuidesProps {
  readonly mask: AnalyticMaskLayer;
  readonly values: AnalyticValues;
  readonly selected: boolean;
  readonly reach: number;
  readonly strokeWidth: number;
  readonly px: (screen: number) => number;
}

/**
 * A split's line, a mirror band's two edges or a gradient's axis (MK8.1), with dashed softness
 * bounds; the selected mask adds its handles. Handles are round for positions, square for the
 * angle and the widths, so they read apart without colour.
 */
function AnalyticMaskGuides({
  mask,
  values,
  selected,
  reach,
  strokeWidth,
  px,
}: AnalyticMaskGuidesProps): JSX.Element {
  const radial = mask.kind === 'gradient' && mask.shape === 'radial';
  const { lines, circle } = analyticGuides(mask.kind, values, reach, radial);
  const handles = selected ? analyticHandlePoints(mask.kind, values, px(ROTATE_STALK_PX * 3)) : [];
  const size = px(BOX_HANDLE_PX);
  return (
    <g
      className="mask-canvas-analytic"
      data-mask-id={mask.id}
      data-kind={mask.kind}
      data-selected={selected || undefined}
      data-enabled={mask.enabled || undefined}
    >
      {lines.map((line, index) => (
        <line
          key={`${line.role}-${String(index)}`}
          className={
            line.role === 'soft' ? 'mask-canvas-analytic-soft' : 'mask-canvas-analytic-edge'
          }
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={mask.color}
          strokeWidth={selected ? strokeWidth * 1.5 : strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {circle !== null && (
        <circle
          className="mask-canvas-analytic-edge"
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
          stroke={mask.color}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
      )}
      {handles.map(({ handle, point, label }) =>
        handle === 'rotate' || handle === 'edge-near' || handle === 'edge-far' ? (
          <rect
            key={handle}
            className="mask-canvas-box-handle"
            data-handle={handle}
            x={point.x - size / 2}
            y={point.y - size / 2}
            width={size}
            height={size}
            aria-label={label}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <circle
            key={handle}
            className={handle === 'softness' ? 'mask-canvas-knob' : 'mask-canvas-vertex-dot'}
            data-handle={handle}
            cx={point.x}
            cy={point.y}
            r={size / 2}
            aria-label={label}
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
    </g>
  );
}

/** A split, band or gradient being placed: its guides, dashed. */
function AnalyticDraft({
  geometry,
  reach,
}: {
  readonly geometry: AnalyticMaskGeometry;
  readonly reach: number;
}): JSX.Element {
  const values: AnalyticValues =
    geometry.kind === 'gradient'
      ? {
          startX: geometry.startX,
          startY: geometry.startY,
          endX: geometry.endX,
          endY: geometry.endY,
        }
      : {
          originX: geometry.originX,
          originY: geometry.originY,
          angle: geometry.angle,
          softnessPx: geometry.softnessPx,
          widthPx: geometry.kind === 'band' ? geometry.widthPx : 0,
        };
  const { lines, circle } = analyticGuides(
    geometry.kind,
    values,
    reach,
    geometry.kind === 'gradient' && geometry.shape === 'radial',
  );
  return (
    <g className="mask-canvas-draft" data-testid="mask-analytic-draft">
      {lines.map((line, index) => (
        <line
          key={String(index)}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {circle !== null && (
        <circle
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
      )}
    </g>
  );
}

interface SelectedMaskHandlesProps {
  readonly mask: MaskLayer;
  readonly geometry: MaskGeometry;
  readonly selectedVertices: ReadonlySet<number>;
  readonly box: OrientedBox | null;
  readonly px: (screen: number) => number;
  readonly expansion: number;
  readonly featherOuter: number;
  readonly featherInner: number;
  readonly knobs: readonly { property: EdgeProperty; point: PixelPoint; label: string }[];
}

/** Handles of the selected mask: feather guides, knobs, transform box, points and tangents. */
function SelectedMaskHandles({
  mask,
  geometry,
  selectedVertices,
  box,
  px,
  expansion,
  featherOuter,
  featherInner,
  knobs,
}: SelectedMaskHandlesProps): JSX.Element {
  const polygon = useMemo(() => flattenOutline(outlineVertices(geometry)), [geometry]);
  const guides: { key: string; distance: number; className: string }[] = [];
  if (expansion !== 0)
    guides.push({ key: 'expansion', distance: expansion, className: 'mask-canvas-expansion' });
  if (featherOuter > 0)
    guides.push({
      key: 'outer',
      distance: expansion + featherOuter,
      className: 'mask-canvas-feather',
    });
  if (featherInner > 0)
    guides.push({
      key: 'inner',
      distance: expansion - featherInner,
      className: 'mask-canvas-feather',
    });

  const vertexPoints: PixelPoint[] = [];
  const selectedPoints: PixelPoint[] = [];
  const tangentLines: string[] = [];
  const tangentPoints: PixelPoint[] = [];
  if (geometry.kind === 'path') {
    geometry.vertices.forEach((vertex, index) => {
      if (selectedVertices.has(index)) {
        selectedPoints.push(vertex);
        for (const [ox, oy] of [
          [vertex.inX, vertex.inY],
          [vertex.outX, vertex.outY],
        ] as const) {
          if (ox === 0 && oy === 0) continue;
          tangentLines.push(`M${vertex.x} ${vertex.y}L${vertex.x + ox} ${vertex.y + oy}`);
          tangentPoints.push({ x: vertex.x + ox, y: vertex.y + oy });
        }
      } else {
        vertexPoints.push(vertex);
      }
    });
  }

  return (
    <g className="mask-canvas-selected" data-mask-id={mask.id}>
      {guides.map((guide) => (
        <path
          key={guide.key}
          className={guide.className}
          d={polylinePathData(offsetPolygon(polygon, guide.distance), true)}
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
      ))}
      {box !== null && (
        <>
          <path
            className="mask-canvas-box"
            d={polylinePathData(
              [
                boxHandlePoint(box, -1, -1),
                boxHandlePoint(box, 1, -1),
                boxHandlePoint(box, 1, 1),
                boxHandlePoint(box, -1, 1),
              ],
              true,
            )}
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
          <path
            className="mask-canvas-box-handle"
            d={squaresPathData(
              BOX_HANDLES.map((handle) => boxHandlePoint(box, handle.ux, handle.uy)),
              px(BOX_HANDLE_PX),
            )}
          />
          <RotateHandle box={box} px={px} />
        </>
      )}
      {tangentLines.length > 0 && (
        <path
          className="mask-canvas-tangent"
          d={tangentLines.join('')}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {tangentPoints.map((point, index) => (
        <circle
          key={index}
          className="mask-canvas-tangent-handle"
          cx={point.x}
          cy={point.y}
          r={px(TANGENT_HANDLE_PX) / 2}
        />
      ))}
      {vertexPoints.length > 0 && (
        <path
          className="mask-canvas-vertex"
          d={squaresPathData(vertexPoints, px(VERTEX_HANDLE_PX))}
        />
      )}
      {selectedPoints.length > 0 && (
        <path
          className="mask-canvas-vertex"
          data-selected="true"
          d={squaresPathData(selectedPoints, px(VERTEX_HANDLE_PX))}
        />
      )}
      {knobs.map((knob) => (
        <circle
          key={knob.property}
          className="mask-canvas-knob"
          data-knob={knob.property}
          cx={knob.point.x}
          cy={knob.point.y}
          r={px(BOX_HANDLE_PX) / 2}
        >
          <title>{knob.label}</title>
        </circle>
      ))}
    </g>
  );
}

/** The rotation handle: on a stalk `stalk` source pixels above the box's top edge, turned with it. */
function rotateHandlePoint(box: OrientedBox, stalk: number): PixelPoint {
  return boxHandlePoint({ ...box, halfHeight: box.halfHeight + stalk }, 0, -1);
}

function RotateHandle({
  box,
  px,
}: {
  readonly box: OrientedBox;
  readonly px: (screen: number) => number;
}): JSX.Element {
  const top = boxHandlePoint(box, 0, -1);
  const end = rotateHandlePoint(box, px(ROTATE_STALK_PX));
  return (
    <>
      <path
        className="mask-canvas-box"
        d={`M${top.x} ${top.y}L${end.x} ${end.y}`}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        className="mask-canvas-rotate"
        cx={end.x}
        cy={end.y}
        r={px(BOX_HANDLE_PX) / 2}
        data-testid="mask-rotate-handle"
      />
    </>
  );
}
