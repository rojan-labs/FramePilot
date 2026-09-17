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
  type MaskGeometry,
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
import { Circle, ICON_SIZE, Magnet, MousePointer2, Pencil, PenTool, Square } from '../icons.js';
import { Tooltip } from '../Tooltip.js';
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
import { affineAttribute, applyAffine, monitorPictureSpace } from './mask-monitor-space.js';
import { maskToolTelemetry } from './mask-tool-telemetry.js';

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
};

const TOOLS: readonly { readonly tool: MaskTool; readonly label: string; readonly key: string }[] =
  [
    { tool: 'select', label: 'Selection tool', key: 'V' },
    { tool: 'rectangle', label: 'Rectangle tool', key: 'R' },
    { tool: 'ellipse', label: 'Ellipse tool', key: 'E' },
    { tool: 'pen', label: 'Pen tool', key: 'P' },
    { tool: 'freehand', label: 'Freehand tool', key: 'F' },
  ];

const TOOL_ICONS = {
  select: MousePointer2,
  rectangle: Square,
  ellipse: Circle,
  pen: PenTool,
  freehand: Pencil,
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
      readonly shape: 'rectangle' | 'ellipse';
      readonly start: PixelPoint;
      current: PixelPoint;
    }
  | { readonly kind: 'freehand'; readonly pointerId: number; readonly samples: PixelPoint[] }
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
  readonly marquee?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly stroke?: readonly PixelPoint[];
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
  const [boxAnchor, setBoxAnchor] = useState<PixelPoint | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [screenPerFrame, setScreenPerFrame] = useState(1);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const { playhead, timeline } = editor.state;
  const sourceTime = clipSourceTimeAt(clip, playhead);
  const space = useMemo(
    () => monitorPictureSpace(timeline, assets, playhead, resolution, clip.id),
    [timeline, assets, playhead, resolution, clip.id],
  );
  const masks = useMemo(() => editableMasks(clip), [clip]);
  const selectedMask = masks.find((mask) => mask.id === tools.selectedMaskId) ?? null;
  const selectedVertices = useMemo(() => new Set(tools.selectedVertices), [tools.selectedVertices]);

  // Keep a selection on this clip: the first editable mask when the selection is elsewhere.
  useEffect(() => {
    const onClip = masksOf(clip).some((mask) => mask.id === tools.selectedMaskId);
    if (!onClip) store.selectMask(masks[0]?.id ?? null);
  }, [clip, masks, store, tools.selectedMaskId]);

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
  const drawMask = (geometry: MaskGeometry): boolean => {
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
    switch (tools.tool) {
      case 'select':
        beginSelect(event, point);
        return;
      case 'rectangle':
      case 'ellipse': {
        const start = snapped(point, event, null).point;
        gesture.current = {
          kind: 'draw-box',
          pointerId: event.pointerId,
          shape: tools.tool,
          start,
          current: start,
        };
        return;
      }
      case 'freehand':
        gesture.current = { kind: 'freehand', pointerId: event.pointerId, samples: [point] };
        setDraft({ stroke: [point] });
        return;
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
      case 'marquee':
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

  const commitBox = (
    shape: 'rectangle' | 'ellipse',
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
      if (tools.tool === 'pen') {
        addPenPoint(at, { shiftKey: false, altKey: true });
      } else if (tools.tool === 'rectangle' || tools.tool === 'ellipse') {
        if (boxAnchor === null) {
          setBoxAnchor(at);
          setAnnouncement(
            `Corner set at ${describePoint(at)}. Move the crosshair and press Space again.`,
          );
        } else {
          commitBox(tools.tool, boxAnchor, at, { shiftKey: false, altKey: false });
          setBoxAnchor(null);
        }
      }
      return;
    }
    if (event.key === 'Enter' && tools.tool === 'pen') {
      handled();
      closePen(penPoints);
      return;
    }
    if (event.key === 'Escape') {
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
          return (
            <Tooltip key={tool} label={`${label} (${key})`}>
              <button
                type="button"
                className="mask-canvas-tool"
                aria-label={label}
                aria-pressed={tools.tool === tool}
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
        V, R, E, P and F choose a tool. Arrow keys move the crosshair or nudge the selection; hold
        Shift for 10 pixels. Space adds a point, Enter closes a path, Escape cancels. Delete removes
        the selected points or mask.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {chromeHost ? createPortal(chrome, chromeHost) : chrome}
    </>
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
