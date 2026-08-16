/**
 * Overlays panel (master-prompt §3.4 — substantially enhanced).
 *
 * Build an overlay: pick a **type** (Text / Title — Shape & Image/Sticker are
 * scaffolded but disabled until the engine supports them), a **style template**
 * (visual previews), a **9-point position**, and **timing** (start at the
 * playhead + duration). A live mini-preview reflects the choices. The list below
 * shows existing overlays with click-to-seek, inline text edit, and delete.
 *
 * What persists vs. previews: the engine currently models an overlay as a text
 * clip (`add_text_overlay` → a `text` effect). Text + timing are real, reversible
 * patches. **Template + position are preview-time presentation** (no schema field
 * yet — same pattern as caption templates in `captions.ts`); they drive the
 * preview here, not the render, and are documented as such rather than silently
 * implying persistence. Inline text edit is a combined delete+add patch (one undo)
 * since there is no in-place text-update op.
 */
import { useMemo, useRef, useState } from 'react';
import { Button } from '@framepilot/ui';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { addTextOverlayPatch, deleteClipPatch } from '../editor/patch-builders.js';
import { useSettings } from '../editor/useSettings.js';
import { Tooltip } from './Tooltip.js';
import { Captions, ICON_SIZE, ImagePlus, type LucideIcon, Square, Trash2, Type } from './icons.js';

export interface OverlaysPanelProps {
  readonly editor: UseEditor;
}

type OverlayType = 'text' | 'title' | 'shape' | 'image';

/**
 * DnD payload type for dragging a text overlay from this panel onto a timeline
 * lane (the dragged string is the {@link OverlayType}). Mirrors `ASSET_DND_TYPE`
 * / `TRANSITION_DND_TYPE`; dropping creates a text overlay at the cursor (#5).
 */
export const TEXT_OVERLAY_DND_TYPE = 'application/x-framepilot-text-overlay';

interface OverlayTypeDef {
  readonly id: OverlayType;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Disabled types are scaffolded but not yet supported by the engine. */
  readonly enabled: boolean;
}

const OVERLAY_TYPES: readonly OverlayTypeDef[] = [
  { id: 'text', label: 'Text', icon: Type, enabled: true },
  { id: 'title', label: 'Title', icon: Captions, enabled: true },
  { id: 'shape', label: 'Shape', icon: Square, enabled: false },
  { id: 'image', label: 'Image', icon: ImagePlus, enabled: false },
];

interface OverlayTemplate {
  readonly id: string;
  readonly label: string;
  readonly style: React.CSSProperties;
}

/** Visual style presets (preview-time) for the template gallery. */
const OVERLAY_TEMPLATES: readonly OverlayTemplate[] = [
  { id: 'clean', label: 'Clean', style: { color: '#fff', fontWeight: 600 } },
  {
    id: 'boxed',
    label: 'Boxed',
    style: { color: '#fff', fontWeight: 600, background: 'rgba(0,0,0,.55)', padding: '2px 6px' },
  },
  {
    id: 'pop',
    label: 'Pop',
    style: { color: '#ffd84d', fontWeight: 800, textTransform: 'uppercase' },
  },
  {
    id: 'accent',
    label: 'Accent',
    style: { color: '#fff', fontWeight: 700, background: 'var(--accent)', padding: '2px 6px' },
  },
];

/** 9-point anchor grid (master-prompt §3.4 position control). */
const POSITIONS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;
type Position = (typeof POSITIONS)[number];

/** Map a 9-point position to flexbox alignment for the live preview. */
function positionStyle(position: Position): React.CSSProperties {
  const [v, h] = (
    {
      'top-left': ['flex-start', 'flex-start'],
      top: ['flex-start', 'center'],
      'top-right': ['flex-start', 'flex-end'],
      left: ['center', 'flex-start'],
      center: ['center', 'center'],
      right: ['center', 'flex-end'],
      'bottom-left': ['flex-end', 'flex-start'],
      bottom: ['flex-end', 'center'],
      'bottom-right': ['flex-end', 'flex-end'],
    } satisfies Record<Position, [string, string]>
  )[position];
  return { alignItems: v, justifyContent: h };
}

/** Read the text stored on an overlay clip's `text` effect. */
function overlayText(clip: Clip): string {
  const effect = clip.effects.find((e) => e.type === 'text');
  return (effect?.params?.text as string | undefined) ?? '';
}

function overlayClips(timeline: Timeline): readonly Clip[] {
  return timeline.tracks.find((t) => t.type === 'overlay')?.clips ?? [];
}

export function OverlaysPanel({ editor }: OverlaysPanelProps): JSX.Element {
  const { settings } = useSettings();
  const { timeline, playhead } = editor.state;
  const overlayTrack = timeline.tracks.find((track) => track.type === 'overlay');

  const [type, setType] = useState<OverlayType>('text');
  const [templateId, setTemplateId] = useState(OVERLAY_TEMPLATES[0]!.id);
  const [position, setPosition] = useState<Position>('bottom');
  const [text, setText] = useState('');
  const [start, setStart] = useState(playhead);
  const [duration, setDuration] = useState(settings.defaultOverlaySeconds);
  const [editing, setEditing] = useState<string | null>(null);

  const template = OVERLAY_TEMPLATES.find((t) => t.id === templateId) ?? OVERLAY_TEMPLATES[0]!;
  const overlays = useMemo(() => overlayClips(timeline), [timeline]);
  const previewText = text.trim() || (type === 'title' ? 'Title text' : 'Your text here');

  const add = (): void => {
    /* v8 ignore next -- the button is disabled without a track or text */
    if (!overlayTrack) return;
    const patch = addTextOverlayPatch(timeline, overlayTrack.id, text, start, start + duration);
    if (patch) {
      editor.applyPatch(patch);
      setText('');
    }
  };

  const remove = (clip: Clip): void => {
    const patch = deleteClipPatch(timeline, clip.id);
    if (patch) editor.applyPatch(patch);
  };

  /** Inline text edit: delete + re-add at the same span as one undoable patch. */
  const commitEdit = (clip: Clip, nextText: string): void => {
    setEditing(null);
    if (!overlayTrack || nextText.trim() === '' || nextText === overlayText(clip)) return;
    const del = deleteClipPatch(timeline, clip.id);
    const addPatch = addTextOverlayPatch(timeline, overlayTrack.id, nextText, clip.start, clip.end);
    if (!del || !addPatch) return;
    editor.applyPatch({ ...addPatch, operations: [...del.operations, ...addPatch.operations] });
  };

  return (
    <section className="overlays" aria-label="overlays panel">
      <header className="panel-head">
        <h2>Overlays</h2>
      </header>

      {!overlayTrack && <p className="panel-empty">No overlay track in this project.</p>}

      {/* Type selector */}
      <div className="ov-types" role="group" aria-label="overlay type">
        {OVERLAY_TYPES.map((t) => {
          const Icon = t.icon;
          const button = (
            <button
              type="button"
              className={`ov-type${type === t.id ? ' is-active' : ''}`}
              aria-pressed={type === t.id}
              disabled={!t.enabled}
              onClick={() => t.enabled && setType(t.id)}
              // Enabled overlay types can be dragged straight onto a timeline lane
              // to create a text overlay at the drop point (#5).
              draggable={t.enabled}
              onDragStart={(event) => {
                if (!t.enabled) return;
                event.dataTransfer.setData(TEXT_OVERLAY_DND_TYPE, t.id);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              title={t.enabled ? 'Click to configure, or drag onto the timeline' : undefined}
            >
              <Icon size={ICON_SIZE.md} aria-hidden="true" />
              <span>{t.label}</span>
            </button>
          );
          return (
            <span key={t.id} className="ov-type-wrap">
              {t.enabled ? button : <Tooltip label="Coming soon">{button}</Tooltip>}
            </span>
          );
        })}
      </div>

      {/* Live preview */}
      <div className="ov-preview" aria-label="overlay preview" style={positionStyle(position)}>
        <span className="ov-preview-text" style={template.style}>
          {previewText}
        </span>
      </div>

      {/* Template gallery */}
      <div className="panel-field">
        <h3>Style</h3>
        <div className="ov-templates" role="group" aria-label="style templates">
          {OVERLAY_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`ov-template${templateId === t.id ? ' is-active' : ''}`}
              aria-pressed={templateId === t.id}
              onClick={() => setTemplateId(t.id)}
            >
              <span className="ov-template-swatch" aria-hidden="true">
                <span style={t.style}>Aa</span>
              </span>
              <span className="ov-template-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Position 9-point picker */}
      <div className="panel-field">
        <h3>Position</h3>
        <div className="ov-grid" role="group" aria-label="position">
          {POSITIONS.map((p) => (
            <button
              key={p}
              type="button"
              className={`ov-dot${position === p ? ' is-active' : ''}`}
              aria-label={p}
              aria-pressed={position === p}
              onClick={() => setPosition(p)}
            />
          ))}
        </div>
      </div>

      {/* Text + timing */}
      <div className="panel-field">
        <label htmlFor="overlay-text">{type === 'title' ? 'Title' : 'Text'}</label>
        <input
          id="overlay-text"
          type="text"
          placeholder="e.g. New feature →"
          value={text}
          aria-label="overlay text"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="ov-timing">
          <label>
            <span>Start</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={Number(start.toFixed(2))}
              aria-label="overlay start"
              onChange={(event) => setStart(Math.max(0, Number(event.target.value)))}
            />
          </label>
          <label>
            <span>Duration</span>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={Number(duration.toFixed(2))}
              aria-label="overlay duration"
              onChange={(event) => setDuration(Math.max(0.1, Number(event.target.value)))}
            />
          </label>
          <button
            type="button"
            className="ov-at-playhead"
            onClick={() => setStart(editor.getPlayhead())}
          >
            At playhead
          </button>
        </div>
        <Button
          variant="primary"
          type="button"
          onClick={add}
          disabled={!overlayTrack || text.trim() === ''}
        >
          {type === 'title' ? 'Add title' : 'Add text overlay'}
        </Button>
      </div>

      {/* Existing overlays */}
      <div className="panel-field">
        <h3>Overlays on the timeline</h3>
        {overlays.length === 0 ? (
          <p className="panel-empty">No overlays yet.</p>
        ) : (
          <ul className="ov-list" aria-label="overlay list">
            {overlays.map((clip) => (
              <OverlayRow
                key={clip.id}
                clip={clip}
                editing={editing === clip.id}
                onSeek={() => editor.seek(clip.start)}
                onEdit={() => setEditing(clip.id)}
                onCommit={(value) => commitEdit(clip, value)}
                onCancel={() => setEditing(null)}
                onDelete={() => remove(clip)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface OverlayRowProps {
  readonly clip: Clip;
  readonly editing: boolean;
  readonly onSeek: () => void;
  readonly onEdit: () => void;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}

function OverlayRow({
  clip,
  editing,
  onSeek,
  onEdit,
  onCommit,
  onCancel,
  onDelete,
}: OverlayRowProps): JSX.Element {
  const text = overlayText(clip);
  const settled = useRef(false);
  return (
    <li className="ov-row">
      <span className="ov-row-time tabular">
        {clip.start.toFixed(1)}–{clip.end.toFixed(1)}s
      </span>
      {editing ? (
        <input
          className="ov-row-input"
          type="text"
          defaultValue={text}
          autoFocus
          aria-label={`edit overlay ${clip.id}`}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              settled.current = true;
              onCommit((event.target as HTMLInputElement).value);
            } else if (event.key === 'Escape') {
              settled.current = true;
              onCancel();
            }
          }}
          onBlur={(event) => {
            if (!settled.current) onCommit(event.target.value);
          }}
        />
      ) : (
        <button
          type="button"
          className="ov-row-text"
          title="Click to seek · double-click to edit"
          onClick={onSeek}
          onDoubleClick={onEdit}
        >
          {text}
        </button>
      )}
      <button
        type="button"
        className="ov-row-del"
        aria-label={`delete overlay ${clip.id}`}
        title="Delete overlay"
        onClick={onDelete}
      >
        <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
      </button>
    </li>
  );
}
