/**
 * Transition section body (revamp Phase 4 shell, Phase 9 contents — F7).
 *
 * ## What Phase 9 added, and the rule it follows
 *
 * Kind / duration / remove became kind, duration, **direction, intensity, softness,
 * easing**, reset, apply-to-selected-cuts and a preview — with **only the controls
 * the selected kind actually reads** on screen. Which those are is decided by
 * `inspector/transition-params.ts`, not by conditions written here, because the same
 * table has to agree with `render/transitions.py` or the panel offers a knob the
 * export ignores.
 *
 * Every look param rides the free-form `Effect.params`: no schema change, no
 * migration (§4.3). Reset **clears** the params rather than writing their default
 * values, so a reset transition is indistinguishable from one never touched.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@framepilot/ui';
import type { Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { clipTransition, transitionMaxDuration } from '../../../editor/selectors.js';
import {
  applyTransitionToClipsPatch,
  removeTransitionPatch,
  resetTransitionParamsPatch,
  setTransitionDurationPatch,
  setTransitionAlignmentPatch,
  setTransitionAudioPatch,
  setTransitionParamsPatch,
  swapTransitionKindPatch,
} from '../../../editor/patch-builders.js';
import { readAlignment, type TransitionAlignment } from '@framepilot/editor-core';
import {
  isTransitionDisabled,
  setTransitionDisabledPatch,
  transitionAudioMode,
  type TransitionAudioMode,
} from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';
import { useTransitionLibrary } from '../../useTransitionLibrary.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { InspectorRow } from '../InspectorRow.js';
import {
  TRANSITION_EASINGS,
  type TransitionParamName,
  acceptsParam,
  allLookParamNames,
  directionsFor,
  isKindParamOverridden,
  isParamOverridden,
  kindParamsFor,
  readKindParam,
  readParam,
} from '../transition-params.js';
import {
  TRANSITION_CATALOG,
  TRANSITION_CATEGORIES,
  getTransition,
} from '@framepilot/timeline-schema/transition-catalog';
import { ALIGNMENT_CHOICES } from '../../timeline/TransitionMenu.js';

/**
 * How long before and after the transition a preview plays.
 *
 * A transition previewed from its own first frame is a transition you cannot judge:
 * the whole point is how it joins two shots, and you need to see the outgoing one to
 * see the join. Three-quarters of a second is enough to read the cut without making
 * the user wait through a shot.
 */
const PREVIEW_LEAD_SECONDS = 0.75;

/**
 * Audio treatments, in the order they escalate.
 *
 * `equal-power` is last because it is the specialist answer: it is the right one
 * for music and overkill for dialogue, and putting it first would have people
 * reach for it by default.
 */
const AUDIO_MODES: readonly TransitionAudioMode[] = [
  'none',
  'crossfade',
  'fade-out-in',
  'equal-power',
];
const AUDIO_MODE_LABELS: readonly string[] = [
  'Hard cut',
  'Crossfade',
  'Fade out, fade in',
  'Equal power',
];
const PREVIEW_TAIL_SECONDS = 0.75;

/**
 * Transition inspector (M3b + revamp Phase 9) — shown only when the selected
 * (incoming) clip carries a transition. Every control commits one reversible patch.
 */
export function TransitionPanel({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element | null {
  const { timeline, selectedIds } = editor.state;
  const effect = clipTransition(clip);
  const committed = Number(effect?.params?.durationSeconds ?? 0);
  // Local until committed, like the audio/color panels: the ScrubNumber emits on
  // every scrub tick, so "Apply" turns the whole drag into ONE patch (the on-cut
  // block is the live-drag path). Re-mounted per clip via `key`, so it reseeds.
  const [duration, setDuration] = useState(committed);
  /**
   * The user's own shelves, so a tuned transition can be kept.
   *
   * The same hook the panel uses, deliberately: a preset saved here has to appear
   * there, and two stores would drift the first time one of them was cleared.
   */
  const library = useTransitionLibrary();
  /** The preset name being typed, or `null` when the field is closed. */
  const [presetName, setPresetName] = useState<string | null>(null);
  const previewEnd = useRef<number | null>(null);

  // Stop a preview when the playhead passes the transition's tail. Driven off the
  // playhead subscription rather than a timer: a timer assumes playback started
  // instantly and never paused, and would stop somewhere else entirely if either
  // turned out false.
  useEffect(() => {
    return editor.subscribePlayhead(() => {
      const stopAt = previewEnd.current;
      if (stopAt === null) return;
      if (editor.getPlayhead() < stopAt) return;
      previewEnd.current = null;
      editor.setPlaying(false);
    });
  }, [editor]);

  if (!effect) return null;
  const params = effect.params ?? {};
  const kind = String(params.kind ?? 'cross-dissolve');
  const maxDuration = transitionMaxDuration(timeline, clip.id) ?? committed;

  const apply = (patch: ReturnType<typeof setTransitionParamsPatch>): void => {
    if (patch) editor.applyPatch(patch);
  };
  const setParam = (param: TransitionParamName, value: string | number | undefined): void =>
    apply(setTransitionParamsPatch(timeline, clip.id, { [param]: value }));
  const clearParam = (param: TransitionParamName): void =>
    apply(setTransitionParamsPatch(timeline, clip.id, { [param]: undefined }));

  const swapKind = (next: string): void => apply(swapTransitionKindPatch(timeline, clip.id, next));
  const applyDuration = (): void => apply(setTransitionDurationPatch(timeline, clip.id, duration));
  const remove = (): void => apply(removeTransitionPatch(timeline, clip.id));
  const resetParams = (): void => apply(resetTransitionParamsPatch(timeline, clip.id));
  const applyToSelection = (): void =>
    apply(applyTransitionToClipsPatch(timeline, clip.id, selectedIds));
  /**
   * Keep this transition, exactly as tuned, on the user's own shelf.
   *
   * Everything the effect carries is stored except `fromClipId`, which is about
   * THIS cut and would be meaningless — worse than meaningless — anywhere else.
   */
  const savePreset = (): void => {
    const { fromClipId: _ignored, kind: _kind, ...rest } = params;
    library.savePreset({
      name: (presetName ?? '').trim() || `${entry?.label ?? kind} (mine)`,
      kind,
      params: rest,
    });
    setPresetName(null);
  };

  /** Play the real cut: lead-in, the transition, tail-out. */
  const preview = (): void => {
    previewEnd.current = clip.start + committed + PREVIEW_TAIL_SECONDS;
    editor.seek(Math.max(0, clip.start - PREVIEW_LEAD_SECONDS));
    editor.setPlaying(true);
  };

  const overridden = (param: TransitionParamName): boolean =>
    isParamOverridden(params, kind, param);
  const entry = getTransition(kind);
  const kindParams = kindParamsFor(kind);
  const alignment = readAlignment(params);
  const setAlignment = (next: TransitionAlignment): void =>
    apply(setTransitionAlignmentPatch(timeline, clip.id, next));
  const disabled = isTransitionDisabled(timeline, clip.id);
  const audioMode = transitionAudioMode(timeline, clip.id);
  const setAudioMode = (next: TransitionAudioMode): void =>
    apply(setTransitionAudioPatch(timeline, clip.id, next));
  const otherSelected = selectedIds.filter((id) => id !== clip.id).length;

  return (
    <>
      <div className="inspector-subpanel" aria-label="transition settings">
        {/*
          A grouped native select rather than a flat list: 78 entries in one
          alphabetical run is unusable, and the category IS how people think about
          transitions ("something in the wipe family"). The panel is where you
          BROWSE; this is where you swap a known one for another known one.
        */}
        <label className="inspector-field">
          <span className="inspector-caption">Kind</span>
          <select
            aria-label="transition kind"
            value={kind}
            onChange={(event) => swapKind(event.target.value)}
          >
            {TRANSITION_CATEGORIES.map((category) => (
              <optgroup key={category.id} label={category.label}>
                {TRANSITION_CATALOG.filter((t) => t.category === category.id && !t.isCut).map(
                  (t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ),
                )}
              </optgroup>
            ))}
          </select>
        </label>
        {entry !== undefined && <p className="inspector-hint">{entry.description}</p>}
        <ScrubNumber
          label="Duration"
          ariaLabel="transition duration"
          unit="s"
          value={duration}
          min={0.05}
          max={Math.max(0.05, maxDuration)}
          step={0.05}
          onChange={setDuration}
        />
        <div className="inspector-actions">
          <Button
            variant="secondary"
            type="button"
            onClick={applyDuration}
            disabled={Math.abs(duration - committed) < 1e-4}
          >
            Apply duration
          </Button>
        </div>
        {/*
          The ceiling is stated rather than merely enforced. A slider that simply
          stops has the user wondering whether the app is broken; "this cut can
          carry 0.80s" is the same limit with the reason attached.
        */}
        <p className="inspector-hint">
          This cut can carry up to {maxDuration.toFixed(2)}s — half the shorter of the two shots.
        </p>

        <InspectorRow label="Alignment" name="transition alignment">
          <div className="transition-align" role="radiogroup" aria-label="transition alignment">
            {ALIGNMENT_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={alignment === choice.id}
                className={`transition-align-option${alignment === choice.id ? ' is-active' : ''}`}
                title={choice.label}
                aria-label={choice.label}
                onClick={() => setAlignment(choice.id)}
              >
                {/* The diagram carries the meaning; the label is for assistive
                    tech and the tooltip. */}
                <span className="transition-menu-glyph" aria-hidden="true">
                  {choice.glyph}
                </span>
              </button>
            ))}
          </div>
        </InspectorRow>

        {/* Only the controls this kind reads — see `transition-params.ts`. */}
        {acceptsParam(kind, 'direction') && (
          <InspectorRow
            label="Direction"
            name="transition direction"
            onReset={() => clearParam('direction')}
            canReset={overridden('direction')}
          >
            <LabeledSelect
              caption=""
              label="transition direction"
              value={String(readParam(params, kind, 'direction'))}
              options={directionsFor(kind)}
              onChange={(value) => setParam('direction', value)}
            />
          </InspectorRow>
        )}
        {acceptsParam(kind, 'intensity') && (
          <InspectorRow
            label="Intensity"
            name="transition intensity"
            onReset={() => clearParam('intensity')}
            canReset={overridden('intensity')}
          >
            <ScrubNumber
              label=""
              ariaLabel="transition intensity"
              value={Number(readParam(params, kind, 'intensity'))}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setParam('intensity', value)}
            />
          </InspectorRow>
        )}
        {acceptsParam(kind, 'softness') && (
          <InspectorRow
            label="Softness"
            name="transition softness"
            onReset={() => clearParam('softness')}
            canReset={overridden('softness')}
          >
            <ScrubNumber
              label=""
              ariaLabel="transition softness"
              value={Number(readParam(params, kind, 'softness'))}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setParam('softness', value)}
            />
          </InspectorRow>
        )}
        {acceptsParam(kind, 'easing') && (
          <InspectorRow
            label="Easing"
            name="transition easing"
            onReset={() => clearParam('easing')}
            canReset={overridden('easing')}
          >
            <LabeledSelect
              caption=""
              label="transition easing"
              value={String(readParam(params, kind, 'easing'))}
              options={TRANSITION_EASINGS}
              onChange={(value) => setParam('easing', value)}
            />
          </InspectorRow>
        )}

        {/*
          The kind's own numbers, built from the descriptors the renderers read.
          Nothing here is written per kind: "add transition #78" gets the controls
          its render kind declares, and no inspector change at all.
        */}
        {kindParams.map((descriptor) => (
          <InspectorRow
            key={descriptor.name}
            label={descriptor.label}
            name={`transition ${descriptor.name}`}
            onReset={() => setParam(descriptor.name as TransitionParamName, undefined)}
            canReset={isKindParamOverridden(params, kind, descriptor.name)}
          >
            {descriptor.choices ? (
              <LabeledSelect
                caption=""
                label={`transition ${descriptor.name}`}
                value={String(Math.round(readKindParam(params, kind, descriptor.name)))}
                options={descriptor.choices.map((_, index) => String(index))}
                labels={descriptor.choices}
                onChange={(value) =>
                  apply(
                    setTransitionParamsPatch(timeline, clip.id, {
                      [descriptor.name]: Number(value),
                    }),
                  )
                }
              />
            ) : (
              <ScrubNumber
                label=""
                ariaLabel={`transition ${descriptor.name}`}
                value={readKindParam(params, kind, descriptor.name)}
                min={descriptor.min}
                max={descriptor.max}
                step={descriptor.step}
                {...(descriptor.unit ? { unit: descriptor.unit } : {})}
                onChange={(value) =>
                  apply(setTransitionParamsPatch(timeline, clip.id, { [descriptor.name]: value }))
                }
              />
            )}
          </InspectorRow>
        ))}

        {/*
          The sound across the same cut. Off by default and stated as such: most
          cuts in an edit are hard-cut audio, and quietly crossfading every one of
          them would change how every existing project sounds.
        */}
        <InspectorRow
          label="Audio"
          name="transition audio"
          onReset={() => setAudioMode('none')}
          canReset={audioMode !== 'none'}
        >
          <LabeledSelect
            caption=""
            label="transition audio"
            value={audioMode}
            options={AUDIO_MODES}
            labels={AUDIO_MODE_LABELS}
            onChange={(value) => setAudioMode(value as TransitionAudioMode)}
          />
        </InspectorRow>
        {audioMode !== 'none' && (
          <p className="inspector-hint">
            Fades run for {committed.toFixed(2)}s on both sides, matching the video.
          </p>
        )}

        {/*
          Saving a preset takes a name, and an inline field rather than a dialog:
          `window.prompt` does not exist in the desktop shell, and a modal for one
          text input is more ceremony than the action deserves.
        */}
        {presetName !== null && (
          <div className="inspector-actions transition-preset-save">
            <input
              type="text"
              aria-label="preset name"
              placeholder={`${entry?.label ?? kind} (mine)`}
              value={presetName}
              autoFocus
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setPresetName(null);
                if (event.key === 'Enter') savePreset();
              }}
            />
            <Button variant="secondary" type="button" onClick={savePreset}>
              Save
            </Button>
          </div>
        )}

        <div className="inspector-actions">
          {/*
            Preview plays the REAL cut on the REAL footage rather than a synthetic
            swatch — a thumbnail can only teach a look the project may not have.
          */}
          <Button variant="secondary" type="button" onClick={preview}>
            Preview transition
          </Button>
          {/*
            Compare holds the transition OFF rather than removing it, so every
            tuned value survives and turning it back on is not a re-decision. One
            undo step either way, so comparing does not litter the history.
          */}
          <Button
            variant="ghost"
            type="button"
            aria-pressed={disabled}
            onClick={() => apply(setTransitionDisabledPatch(timeline, clip.id, !disabled))}
          >
            {disabled ? 'Show transition' : 'Compare without'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={applyToSelection}
            disabled={otherSelected === 0}
            title={
              otherSelected === 0
                ? 'Select more clips to copy this transition onto their cuts'
                : undefined
            }
          >
            {`Apply to ${otherSelected} selected`}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={resetParams}
            disabled={
              !allLookParamNames(kind).some((name) =>
                (['direction', 'intensity', 'softness', 'easing'] as const).includes(
                  name as TransitionParamName,
                )
                  ? overridden(name as TransitionParamName)
                  : isKindParamOverridden(params, kind, name),
              )
            }
          >
            Reset look
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setPresetName(presetName === null ? '' : null)}
            aria-expanded={presetName !== null}
          >
            Save as preset
          </Button>
          <Button variant="ghost" type="button" onClick={remove}>
            Remove
          </Button>
        </div>
      </div>
    </>
  );
}

/** Exported for tests — the preview's lead-in, so the assertion is not a magic number. */
export const TRANSITION_PREVIEW_LEAD_SECONDS = PREVIEW_LEAD_SECONDS;
