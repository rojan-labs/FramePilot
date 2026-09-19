/**
 * The clip's mask stack in the Inspector (MK4.2): top first, as the stack combines.
 *
 * Each row: drag grip, colour chip, name (selects), blend mode, invert, visibility and lock.
 * Reorder by dragging a row or, from the keyboard, Alt+Arrow on a focused row. Every change
 * is one mask command through `runMaskCommand`, so each is one undo.
 */
import { useState } from 'react';
import type { MaskLayer, MaskMode } from '@framepilot/timeline-schema';
import { Eye, EyeOff, GripVertical, ICON_SIZE, Lock, LockOpen, Trash2 } from '../../icons.js';
import { Tooltip } from '../../Tooltip.js';

export const MASK_MODES: readonly { readonly value: MaskMode; readonly label: string }[] = [
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'intersect', label: 'Intersect' },
  { value: 'difference', label: 'Difference' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'darken', label: 'Darken' },
];

const KIND_LABELS: Readonly<Record<MaskLayer['kind'], string>> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  path: 'Path',
  matte: 'Subject',
  key: 'Key',
  linear: 'Split',
  band: 'Band',
  gradient: 'Gradient',
  layer: 'Track matte',
};

/** The name a mask shows: its own, else its kind and position. */
export const maskDisplayName = (mask: MaskLayer, index: number): string =>
  mask.name.trim() !== '' ? mask.name : `${KIND_LABELS[mask.kind]} ${String(index + 1)}`;

export interface MaskListProps {
  readonly masks: readonly MaskLayer[];
  readonly selectedMaskId: string | null;
  readonly onSelect: (maskId: string) => void;
  readonly onChange: (maskId: string, changes: Readonly<Record<string, string | boolean>>) => void;
  readonly onReorder: (maskIds: readonly string[]) => void;
  readonly onRemove: (maskId: string) => void;
}

/** The ids with `moved` placed at `toIndex`. */
export function reorderedIds(
  masks: readonly MaskLayer[],
  moved: string,
  toIndex: number,
): string[] {
  const ids = masks.map((mask) => mask.id).filter((id) => id !== moved);
  ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, moved);
  return ids;
}

export function MaskList({
  masks,
  selectedMaskId,
  onSelect,
  onChange,
  onReorder,
  onRemove,
}: MaskListProps): JSX.Element {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (masks.length === 0) {
    return (
      <p className="inspector-empty inspector-empty-inline">
        No masks yet. Draw one on the monitor.
      </p>
    );
  }

  return (
    <ul className="mask-list" role="listbox" aria-label="Masks">
      {masks.map((mask, index) => {
        const name = maskDisplayName(mask, index);
        const selected = mask.id === selectedMaskId;
        return (
          <li
            key={mask.id}
            className="mask-list-row"
            role="option"
            aria-selected={selected}
            aria-label={name}
            tabIndex={selected || (selectedMaskId === null && index === 0) ? 0 : -1}
            data-selected={selected || undefined}
            data-disabled={!mask.enabled || undefined}
            data-drop={
              dropIndex === index && dragging !== null && dragging !== mask.id ? 'true' : undefined
            }
            draggable
            onClick={() => onSelect(mask.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault();
                const toIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
                if (toIndex < 0 || toIndex >= masks.length) return;
                onReorder(reorderedIds(masks, mask.id, toIndex));
                return;
              }
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                const next = masks[index + (event.key === 'ArrowUp' ? -1 : 1)];
                if (next !== undefined) onSelect(next.id);
              }
            }}
            onDragStart={(event) => {
              setDragging(mask.id);
              event.dataTransfer?.setData('text/plain', mask.id);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDropIndex(index);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropIndex(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const moved = dragging ?? event.dataTransfer?.getData('text/plain') ?? null;
              setDragging(null);
              setDropIndex(null);
              if (moved === null || moved === mask.id) return;
              onReorder(reorderedIds(masks, moved, index));
            }}
          >
            <span className="mask-list-grip" aria-hidden="true">
              <GripVertical size={ICON_SIZE.sm} />
            </span>
            <label className="mask-list-color" style={{ background: mask.color }}>
              <span className="sr-only">{`Colour of ${name}`}</span>
              <input
                type="color"
                value={mask.color}
                aria-label={`Colour of ${name}`}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onChange(mask.id, { color: event.target.value })}
              />
            </label>
            <span className="mask-list-name" title={name}>
              {name}
            </span>
            <select
              className="mask-list-mode"
              aria-label={`Mode of ${name}`}
              value={mask.mode}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onChange(mask.id, { mode: event.target.value })}
            >
              {MASK_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
            <Tooltip label={mask.invert ? 'Inverted' : 'Invert'}>
              <button
                type="button"
                className="mask-list-toggle mask-list-invert"
                aria-label={`Invert ${name}`}
                aria-pressed={mask.invert}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(mask.id, { invert: !mask.invert });
                }}
              >
                Inv
              </button>
            </Tooltip>
            <Tooltip label={mask.enabled ? 'Hide mask' : 'Show mask'}>
              <button
                type="button"
                className="mask-list-toggle"
                aria-label={`${mask.enabled ? 'Hide' : 'Show'} ${name}`}
                aria-pressed={!mask.enabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(mask.id, { enabled: !mask.enabled });
                }}
              >
                {mask.enabled ? (
                  <Eye size={ICON_SIZE.sm} aria-hidden="true" />
                ) : (
                  <EyeOff size={ICON_SIZE.sm} aria-hidden="true" />
                )}
              </button>
            </Tooltip>
            <Tooltip label={mask.locked ? 'Unlock mask' : 'Lock mask'}>
              <button
                type="button"
                className="mask-list-toggle"
                aria-label={`${mask.locked ? 'Unlock' : 'Lock'} ${name}`}
                aria-pressed={mask.locked}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(mask.id, { locked: !mask.locked });
                }}
              >
                {mask.locked ? (
                  <Lock size={ICON_SIZE.sm} aria-hidden="true" />
                ) : (
                  <LockOpen size={ICON_SIZE.sm} aria-hidden="true" />
                )}
              </button>
            </Tooltip>
            <Tooltip label="Delete mask">
              <button
                type="button"
                className="mask-list-toggle"
                aria-label={`Delete ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(mask.id);
                }}
              >
                <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
