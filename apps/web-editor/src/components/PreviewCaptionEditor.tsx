/** Direct-manipulation controls for an active caption cue in the program monitor. */
import { useRef, useState } from 'react';
import type { CaptionStyle } from '@framepilot/timeline-schema';
import { resolveCaptionStyle } from '../editor/captionPreview.js';

export interface PreviewCaptionEditorProps {
  readonly clipId: string;
  readonly style: CaptionStyle | undefined;
  readonly trackStyle: CaptionStyle | undefined;
  readonly text: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onStyleCommit: (patch: Partial<CaptionStyle>) => void;
  readonly onTextCommit: (text: string) => void;
}

type Gesture =
  | { kind: 'move'; startX: number; startY: number; x: number; y: number; rect: DOMRect }
  | { kind: 'resize'; startX: number; width: number; rect: DOMRect }
  | { kind: 'rotate'; centerX: number; centerY: number; startAngle: number; rotation: number };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const anchorY = (position: CaptionStyle['position']): number =>
  position === 'top' ? 12 : position === 'middle' ? 50 : 84;

export function PreviewCaptionEditor({
  clipId,
  style,
  trackStyle,
  text,
  selected,
  onSelect,
  onStyleCommit,
  onTextCommit,
}: PreviewCaptionEditorProps): JSX.Element {
  const resolved = resolveCaptionStyle(style, trackStyle);
  const safe = resolved.safeArea !== false;
  const minPosition = safe ? 10 : 0;
  const maxPosition = safe ? 90 : 100;
  const base = {
    x: resolved.xPercent ?? 50,
    y: resolved.yPercent ?? anchorY(resolved.position),
    width: resolved.maxWidthPercent ?? 90,
    rotation: resolved.rotation ?? 0,
  };
  const [live, setLive] = useState<Partial<typeof base> | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const gesture = useRef<Gesture | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const shown = { ...base, ...live };

  const begin = (event: React.PointerEvent, kind: Gesture['kind']): void => {
    if (!selected) return;
    event.preventDefault();
    event.stopPropagation();
    const frame = boxRef.current?.parentElement?.getBoundingClientRect();
    const box = boxRef.current?.getBoundingClientRect();
    if (!frame || !box) return;
    if (kind === 'move') {
      gesture.current = {
        kind,
        startX: event.clientX,
        startY: event.clientY,
        x: base.x,
        y: base.y,
        rect: frame,
      };
    } else if (kind === 'resize') {
      gesture.current = { kind, startX: event.clientX, width: base.width, rect: frame };
    } else {
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      gesture.current = {
        kind,
        centerX,
        centerY,
        startAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
        rotation: base.rotation,
      };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: React.PointerEvent): void => {
    const active = gesture.current;
    if (!active) return;
    if (active.kind === 'move') {
      setLive({
        x: clamp(active.x + ((event.clientX - active.startX) / active.rect.width) * 100, minPosition, maxPosition),
        y: clamp(active.y + ((event.clientY - active.startY) / active.rect.height) * 100, minPosition, maxPosition),
      });
    } else if (active.kind === 'resize') {
      setLive({
        width: clamp(active.width + ((event.clientX - active.startX) / active.rect.width) * 200, 15, 100),
      });
    } else {
      const angle = Math.atan2(event.clientY - active.centerY, event.clientX - active.centerX);
      setLive({ rotation: active.rotation + ((angle - active.startAngle) * 180) / Math.PI });
    }
  };

  const end = (): void => {
    const active = gesture.current;
    gesture.current = null;
    if (!active || !live) return;
    if (live.x !== undefined || live.y !== undefined) {
      onStyleCommit({ xPercent: live.x ?? base.x, yPercent: live.y ?? base.y });
    } else if (live.width !== undefined) {
      onStyleCommit({ maxWidthPercent: live.width });
    } else if (live.rotation !== undefined) {
      onStyleCommit({ rotation: live.rotation });
    }
    setLive(null);
  };

  const commitText = (): void => {
    setEditing(false);
    if (draft !== text) onTextCommit(draft);
  };

  return (
    <div
      ref={boxRef}
      className={`preview-caption-edit${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
      data-caption-id={clipId}
      style={{
        left: `${shown.x}%`,
        top: `${shown.y}%`,
        width: `${shown.width}%`,
        transform: `translate(-50%, -50%) rotate(${shown.rotation}deg)`,
      }}
      role="group"
      aria-label={`caption ${clipId}`}
      tabIndex={0}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onSelect();
        setDraft(text);
        setEditing(true);
      }}
      onPointerDown={(event) => {
        if (!selected) {
          event.stopPropagation();
          onSelect();
          return;
        }
        if (!editing) begin(event, 'move');
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => {
        gesture.current = null;
        setLive(null);
      }}
      onKeyDown={(event) => {
        if (!selected && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect();
          return;
        }
        if (event.key === 'Enter' && !editing) {
          event.preventDefault();
          setDraft(text);
          setEditing(true);
        }
        if (event.key === 'Escape' && editing) {
          event.preventDefault();
          setDraft(text);
          setEditing(false);
        }
      }}
    >
      {editing && (
        <textarea
          className="preview-caption-edit-input"
          aria-label="caption text"
          name="preview-caption-text"
          autoComplete="off"
          autoFocus
          value={draft}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commitText();
            }
          }}
        />
      )}
      {selected && !editing && (
        <>
          <button
            type="button"
            className="preview-caption-handle preview-caption-handle--resize"
            aria-label="Resize caption width"
            onPointerDown={(event) => begin(event, 'resize')}
          />
          <button
            type="button"
            className="preview-caption-handle preview-caption-handle--rotate"
            aria-label="Rotate caption"
            onPointerDown={(event) => begin(event, 'rotate')}
          />
        </>
      )}
    </div>
  );
}
