/**
 * Adjustment controls for the selected effect layer (schema v13, ADR 0088).
 *
 * WHY this panel has no per-effect code at all: every control is generated from
 * the catalog's param descriptors (`EFFECT_PARAMS[kind]`), which carry the label,
 * range, step, default, unit and — for discrete params — the choice list. That is
 * the whole reason descriptors live with the render kind rather than the catalog
 * entry: adding an effect kind never means writing a new panel, and a slider can
 * never offer a value the validator or the shader would reject.
 *
 * Committing: a drag reports continuously so the preview follows the pointer, but
 * only the RELEASE writes a patch. Dragging a slider from 0 to 100 must be one
 * undo step, not a hundred — the same rule `EffectLayerChip` follows for its
 * gestures.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EffectLayer } from '@framepilot/timeline-schema';
import { findEffect } from '@framepilot/timeline-schema/effect-catalog';
import {
  EFFECT_PARAMS,
  type EffectParamDescriptor,
} from '@framepilot/timeline-schema/effect-params';

export interface EffectInspectorProps {
  readonly layer: EffectLayer;
  /** Live value while dragging — drives the preview without touching history. */
  readonly onPreview: (params: Record<string, number>, intensity?: number) => void;
  /** Commit on release. `params` is partial; `intensity` null clears the override. */
  readonly onCommit: (params?: Record<string, number>, intensity?: number | null) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
}

export function EffectInspector({
  layer,
  onPreview,
  onCommit,
  onToggleEnabled,
  onRemove,
}: EffectInspectorProps): JSX.Element {
  const entry = findEffect(layer.effectId);
  const descriptors = EFFECT_PARAMS[layer.kind] ?? [];

  /** Uncommitted values during a drag, keyed by param name. */
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [intensityDraft, setIntensityDraft] = useState<number | null>(null);

  // Clear the draft when the selection changes, or the previous layer's in-flight
  // values would leak onto the newly selected one.
  useEffect(() => {
    setDraft({});
    setIntensityDraft(null);
  }, [layer.id]);

  const valueOf = useCallback(
    (descriptor: EffectParamDescriptor): number =>
      draft[descriptor.name] ?? layer.params[descriptor.name] ?? descriptor.default,
    [draft, layer.params],
  );

  const intensity = intensityDraft ?? layer.intensity ?? 1;

  const onSlide = useCallback(
    (descriptor: EffectParamDescriptor, next: number): void => {
      const merged = { ...draft, [descriptor.name]: next };
      setDraft(merged);
      onPreview(merged);
    },
    [draft, onPreview],
  );

  const onRelease = useCallback((): void => {
    if (Object.keys(draft).length === 0) return;
    onCommit(draft);
    setDraft({});
  }, [draft, onCommit]);

  return (
    <div className="fx-inspector">
      <header className="fx-inspector-head">
        <div>
          <h3>{entry?.label ?? layer.kind}</h3>
          {entry !== undefined && <p className="fx-inspector-blurb">{entry.description}</p>}
        </div>
        <span className="fx-inspector-range">
          {layer.start.toFixed(2)}s – {layer.end.toFixed(2)}s
        </span>
      </header>

      <label className="fx-control">
        <span className="fx-control-label">
          Strength
          <span className="fx-control-value">{Math.round(intensity * 100)}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={intensity}
          aria-label="Strength"
          onChange={(event) => {
            const next = Number(event.target.value);
            setIntensityDraft(next);
            onPreview(draft, next);
          }}
          // Both events, because a keyboard user never fires pointerup and would
          // otherwise never commit.
          onPointerUp={() => {
            if (intensityDraft === null) return;
            // 1 is the canonical "full strength" default, stored as ABSENT — so
            // committing exactly 1 clears the override rather than persisting it.
            onCommit(undefined, intensityDraft >= 1 ? null : intensityDraft);
            setIntensityDraft(null);
          }}
          onKeyUp={() => {
            if (intensityDraft === null) return;
            onCommit(undefined, intensityDraft >= 1 ? null : intensityDraft);
            setIntensityDraft(null);
          }}
        />
      </label>

      {descriptors.map((descriptor) =>
        descriptor.choices !== undefined ? (
          <div className="fx-control" key={descriptor.name}>
            <span className="fx-control-label">{descriptor.label}</span>
            <div className="fx-control-choices" role="group" aria-label={descriptor.label}>
              {descriptor.choices.map((choice, index) => (
                <button
                  key={choice}
                  type="button"
                  className={`fx-chip${Math.round(valueOf(descriptor)) === index ? ' is-active' : ''}`}
                  aria-pressed={Math.round(valueOf(descriptor)) === index}
                  // A discrete choice commits immediately: there is no drag to
                  // debounce, and waiting for a release would feel unresponsive.
                  onClick={() => onCommit({ [descriptor.name]: index })}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <label className="fx-control" key={descriptor.name}>
            <span className="fx-control-label">
              {descriptor.label}
              <span className="fx-control-value">
                {formatValue(valueOf(descriptor), descriptor)}
              </span>
            </span>
            <input
              type="range"
              min={descriptor.min}
              max={descriptor.max}
              step={descriptor.step}
              value={valueOf(descriptor)}
              aria-label={descriptor.label}
              {...(descriptor.hint !== undefined ? { title: descriptor.hint } : {})}
              onChange={(event) => onSlide(descriptor, Number(event.target.value))}
              onPointerUp={onRelease}
              onKeyUp={onRelease}
            />
          </label>
        ),
      )}

      <div className="fx-inspector-actions">
        <button
          type="button"
          className="fx-inspector-action"
          aria-pressed={layer.disabled === true}
          onClick={() => onToggleEnabled(layer.disabled === true)}
        >
          {/* Names the action, not the state. */}
          {layer.disabled === true ? 'Enable' : 'Bypass'}
        </button>
        <button type="button" className="fx-inspector-action is-destructive" onClick={onRemove}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** Human value for the read-out — integers stay integral, fractions show 2dp. */
function formatValue(value: number, descriptor: EffectParamDescriptor): string {
  const text = descriptor.step >= 1 ? String(Math.round(value)) : value.toFixed(2);
  return descriptor.unit !== undefined ? `${text}${descriptor.unit}` : text;
}
