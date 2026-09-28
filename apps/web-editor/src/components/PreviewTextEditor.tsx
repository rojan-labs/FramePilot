/**
 * On-canvas editor for the selected text overlay: the words, drawn as the export draws them, in
 * the bounding box ({@link TransformBox}).
 *
 * - **Move** it: drag inside the box (the params' centre).
 * - **Scale** it: a corner or the top or bottom edge scales the words and their wrap width
 *   together; Shift stretches the letters instead (the clip's scaleX/scaleY).
 * - **Reflow** it: the left or right edge is a new wrap width; the words keep their size.
 * - **Turn** it: the lollipop or a corner's outside (the clip's rotation).
 * - **Type**: double-click, then Enter (or a click away) commits, Escape cancels.
 *
 * The words keep their own measured layout (their wrap, and a typed overlay's box hugging its
 * longest line, as the engine's raster does); the box is built around them from that measure,
 * the stored centre and the clip's transform. One gesture is one {@link TextOverlayCommit}, which
 * the caller applies as ONE patch, even when it changed both the params and the transform.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Keyframe } from '@framepilot/timeline-schema';
import type { TextOverlayParams } from '../editor/patch-builders.js';
import { textOverlayStyle } from '../editor/textOverlay.js';
import { useHugLines } from '../editor/useHugLines.js';
import {
  textOverlayEditAfter,
  type PictureBaseTransform,
  type TextOverlayEdit,
} from '../preview/transform-box/adapters.js';
import type { Box, ResizeHandle, TransformGesture } from '../preview/transform-box/geometry.js';
import {
  pictureBaseOf,
  textOverlayClipTransform,
  transformAt,
} from '../preview/transform-box/monitor.js';
import { TransformBox } from './transform-box/TransformBox.js';

/** One committed edit: the params that changed, the new transform when it changed, or both. */
export interface TextOverlayCommit {
  readonly params?: Partial<TextOverlayParams>;
  readonly transform?: PictureBaseTransform;
}

export interface PreviewTextEditorProps {
  readonly params: TextOverlayParams;
  readonly timeInClip: number;
  readonly duration: number;
  /** The project frame, in pixels: the box's and the pointer's coordinate space. */
  readonly resolution: { readonly width: number; readonly height: number };
  /** The clip's keyframes, so the words are placed, turned and stretched as the export does. */
  readonly keyframes?: readonly Keyframe[];
  /** Apply one gesture's edit as one reversible patch. */
  readonly onCommit: (edit: TextOverlayCommit) => void;
}

/** The side handles reflow the words (a new wrap width) without Shift. */
const REFLOW_HANDLES: readonly ResizeHandle[] = ['e', 'w'];

/** The params a gesture on the box can change. */
const BOX_PARAM_KEYS = ['xPercent', 'yPercent', 'fontSizePercent', 'boxWidthPercent'] as const;

const transformChanged = (a: PictureBaseTransform, b: PictureBaseTransform): boolean =>
  a.scale !== b.scale ||
  a.scaleX !== b.scaleX ||
  a.scaleY !== b.scaleY ||
  a.x !== b.x ||
  a.y !== b.y ||
  a.rotation !== b.rotation;

export function PreviewTextEditor({
  params,
  timeInClip,
  duration,
  resolution,
  keyframes = [],
  onCommit,
}: PreviewTextEditorProps): JSX.Element {
  const textRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // A gesture in flight: the words follow it, as the release will store them.
  const [live, setLive] = useState<TextOverlayEdit | null>(null);
  // The words' own layout size (before any clip transform), in project pixels.
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);

  const base = pictureBaseOf(keyframes);
  const now = transformAt(keyframes, timeInClip);
  const shown: TextOverlayParams = live === null ? params : { ...params, ...live.params };
  const clip = textOverlayClipTransform(live?.transform ?? now, resolution);
  // The resting layout: while it is being edited, the words are shown whole, not mid-entrance.
  const style = textOverlayStyle(shown, duration / 2, duration, clip);

  // A typed overlay's box hugs its longest line, as the engine's raster does. Not while typing:
  // the lines move under the caret, and the box settles when the edit commits.
  useHugLines(
    textRef,
    editRef,
    shown.typography !== undefined && !editing,
    JSON.stringify([
      shown.text,
      shown.fontFamily,
      shown.fontWeight,
      shown.fontSizePercent,
      shown.boxWidthPercent,
      shown.typography,
    ]),
  );

  // Measure the words' layout box against the frame they sit in (their offset parent fills the
  // frame), after the hug above has set its width. Layout sizes, so the transform's turn and
  // scale (and a zoomed monitor) never distort the measure.
  useLayoutEffect(() => {
    const element = textRef.current;
    const frame = element?.offsetParent as HTMLElement | null | undefined;
    if (!element || !frame) return undefined;
    const measure = (): void => {
      if (frame.clientWidth === 0 || frame.clientHeight === 0) return;
      setMeasured({
        width: (element.offsetWidth / frame.clientWidth) * resolution.width,
        height: (element.offsetHeight / frame.clientHeight) * resolution.height,
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [resolution.width, resolution.height]);

  // Focus the words, caret at the end, when typing starts.
  useEffect(() => {
    if (!editing || !editRef.current) return;
    editRef.current.focus();
    const range = document.createRange();
    range.selectNodeContents(editRef.current);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  const commitText = (): void => {
    const next = editRef.current?.textContent ?? params.text;
    setEditing(false);
    if (next !== params.text) onCommit({ params: { text: next } });
  };

  // The committed box: the stored centre plus the clip's offset, the measured words at the
  // clip's scale, its turn. (Before the first measure, the wrap box stands in.)
  const size = measured ?? {
    width: (params.boxWidthPercent / 100) * resolution.width,
    height: (params.fontSizePercent / 100) * resolution.height,
  };
  const box: Box = {
    cx: (params.xPercent / 100) * resolution.width + now.x,
    cy: (params.yPercent / 100) * resolution.height + now.y,
    width: size.width * now.scale * now.scaleX,
    height: size.height * now.scale * now.scaleY,
    rotation: now.rotation,
  };
  const editFor = (next: Box, gesture: TransformGesture): TextOverlayEdit =>
    textOverlayEditAfter(
      {
        xPercent: params.xPercent,
        yPercent: params.yPercent,
        fontSizePercent: params.fontSizePercent,
        boxWidthPercent: params.boxWidthPercent,
      },
      base,
      box,
      next,
      gesture,
      resolution,
    );

  const commitGesture = (next: Box, gesture: TransformGesture): void => {
    const edit = editFor(next, gesture);
    const changed: Partial<Record<(typeof BOX_PARAM_KEYS)[number], number>> = {};
    for (const key of BOX_PARAM_KEYS) {
      if (edit.params[key] !== params[key]) changed[key] = edit.params[key];
    }
    const hasParams = Object.keys(changed).length > 0;
    const transform = transformChanged(edit.transform, base) ? edit.transform : undefined;
    if (!hasParams && transform === undefined) return;
    onCommit({
      ...(hasParams ? { params: changed } : {}),
      ...(transform === undefined ? {} : { transform }),
    });
  };

  return (
    <>
      <div
        ref={textRef}
        className={`preview-text-edit${editing ? ' is-editing' : ''}`}
        // Always visible and whole while selected; the box on top takes the pointer until the
        // words are being typed into.
        style={{ ...style, opacity: 1, pointerEvents: editing ? 'auto' : 'none' }}
      >
        <div
          ref={editRef}
          className="preview-text-edit-content"
          contentEditable={editing}
          suppressContentEditableWarning
          aria-label="text overlay content"
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              commitText();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              if (editRef.current) editRef.current.textContent = params.text;
              setEditing(false);
            }
          }}
        >
          {params.text}
        </div>
      </div>
      <TransformBox
        box={box}
        resolution={resolution}
        label="edit text overlay"
        rotateLabel="Rotate text overlay"
        sizeValue={{
          now: Math.round(params.fontSizePercent * 10) / 10,
          text: `${Math.round(params.fontSizePercent * 10) / 10}% of the frame height`,
        }}
        freeHandles={REFLOW_HANDLES}
        interactive={!editing}
        onDoubleClick={() => setEditing(true)}
        onPreview={(next, gesture) => setLive(next === null ? null : editFor(next, gesture))}
        onCommit={commitGesture}
      />
    </>
  );
}
