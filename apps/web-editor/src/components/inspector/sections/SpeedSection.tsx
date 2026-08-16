/**
 * Speed section body (revamp Phase 4 shell, Phase 10c contents — F8).
 *
 * ## What Phase 10c added
 *
 * Constant rate became rate **plus** reverse, freeze frame, and a duration-driven
 * mode — all of which schema v15 / ADR 0090 made expressible. The one rule that
 * shapes the whole panel: **the resulting clip duration is shown before you
 * commit**, not discovered afterwards. A speed control whose effect on the timeline
 * you only learn by pressing it is a control you have to undo to understand.
 *
 * Direction and magnitude are **separate controls**, not one signed number. `-2` in
 * a field is a fine way to *store* reverse and a poor way to ask for it: a user
 * thinking "play this backwards" is not thinking about a sign, and a stray minus in
 * a scrub field would silently flip the clip.
 *
 * The **ramp editor is Phase 10d**; this panel reports when a clip carries a curve
 * rather than pretending the constant controls describe it, because they do not.
 */
import { useState } from 'react';
import { Button } from '@framepilot/ui';
import { clipTimelineDuration, hasSpeedRamp } from '@framepilot/editor-core';
import type { Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { clipSpeed } from '../../../editor/selectors.js';
import { setClipSpeedPatch, setClipSpeedRampPatch } from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';
import { InspectorRow } from '../InspectorRow.js';

/** Speed presets offered alongside a custom numeric value. */
const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4] as const;
const SPEED_MIN = 0.1;
const SPEED_MAX = 8;

/** Seconds shown to two decimals — enough to read a frame at 30fps, not more. */
const formatSeconds = (seconds: number): string => `${seconds.toFixed(2)}s`;

/**
 * The timeline duration a clip would have at `speed`, or `null` for a freeze.
 *
 * Routed through the engine's own `clipTimelineDuration` on a hypothetical clip
 * rather than re-deriving `span / speed` here. A panel promising a duration the
 * validator then disagrees with is the exact failure that let ADR 0046's known
 * limitation stay invisible for so long.
 */
function durationAtSpeed(clip: Clip, speed: number): number | null {
  return clipTimelineDuration({ ...clip, speed, speedRamp: undefined });
}

export function SpeedPanel({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element {
  const committed = clipSpeed(clip);
  const ramped = hasSpeedRamp(clip);
  // Magnitude and direction are held apart; the stored value is their product.
  const [magnitude, setMagnitude] = useState(Math.abs(committed) || 1);
  const [reversed, setReversed] = useState(committed < 0);
  const frozen = committed === 0;
  const currentDuration = clip.end - clip.start;

  const apply = (speed: number | null): void => {
    const patch = setClipSpeedPatch(editor.state.timeline, clip.id, speed);
    if (patch) editor.applyPatch(patch);
  };

  const signed = reversed ? -magnitude : magnitude;
  const preview = durationAtSpeed(clip, signed);
  const pending = Math.abs(signed - committed) > 1e-6;

  /**
   * Set the speed that makes the clip last `seconds` — the duration-driven mode.
   *
   * The useful direction for "this shot needs to fill four seconds", and the one a
   * rate field cannot answer without arithmetic in the user's head. Reverse is
   * preserved: asking for a length is not asking to play forwards again.
   */
  const applyDuration = (seconds: number): void => {
    if (seconds <= 0) return;
    const sourceSpan = clip.sourceEnd - clip.sourceStart;
    const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, sourceSpan / seconds));
    setMagnitude(clamped);
    apply(reversed ? -clamped : clamped);
  };

  const clearRamp = (): void => {
    const patch = setClipSpeedRampPatch(editor.state.timeline, clip.id, null);
    if (patch) editor.applyPatch(patch);
  };

  if (ramped) {
    // A curve is not describable by a rate field, so the panel says what the clip
    // IS rather than showing controls that would misreport it. Offering the constant
    // controls here would let a stray click flatten a curve the user built.
    return (
      <div className="inspector-subpanel" aria-label="clip speed">
        <p className="inspector-note">
          {`This clip follows a speed ramp (${clip.speedRamp?.length ?? 0} points), lasting ${formatSeconds(currentDuration)}.`}
        </p>
        <div className="inspector-actions">
          <Button variant="ghost" type="button" onClick={clearRamp}>
            Remove ramp
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector-subpanel" aria-label="clip speed">
      <span className="inspector-select-caption">Presets</span>
      <div className="inspector-chip-row" role="group" aria-label="speed presets">
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`inspector-chip${!frozen && magnitude === preset ? ' is-active' : ''}`}
            aria-pressed={!frozen && magnitude === preset}
            onClick={() => {
              setMagnitude(preset);
              apply(reversed ? -preset : preset);
            }}
          >
            {preset}x
          </button>
        ))}
      </div>

      <InspectorRow label="Rate" name="clip speed">
        <ScrubNumber
          label=""
          ariaLabel="custom speed"
          unit="x"
          value={magnitude}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          onChange={setMagnitude}
        />
      </InspectorRow>

      <InspectorRow label="Duration" name="clip duration">
        {/*
          Duration-driven speed: editing this asks "make the clip last this long"
          and the rate follows.
        */}
        <ScrubNumber
          label=""
          ariaLabel="clip duration"
          unit="s"
          value={currentDuration}
          min={0.1}
          max={Math.max(0.1, (clip.sourceEnd - clip.sourceStart) / SPEED_MIN)}
          step={0.1}
          onChange={applyDuration}
        />
      </InspectorRow>

      <div className="inspector-chip-row" role="group" aria-label="speed direction">
        <button
          type="button"
          className={`inspector-chip${reversed ? ' is-active' : ''}`}
          aria-pressed={reversed}
          onClick={() => {
            const next = !reversed;
            setReversed(next);
            apply(next ? -magnitude : magnitude);
          }}
        >
          Reverse
        </button>
        <button
          type="button"
          className={`inspector-chip${frozen ? ' is-active' : ''}`}
          aria-pressed={frozen}
          onClick={() => {
            if (frozen) {
              apply(null);
              return;
            }
            setMagnitude(1);
            setReversed(false);
            apply(0);
          }}
        >
          Freeze frame
        </button>
      </div>

      {/*
        The resulting duration, BEFORE the commit — the rule the whole panel turns
        on. `aria-live` because the number changing IS the feedback; a screen-reader
        user scrubbing the rate would otherwise get nothing until they committed.
      */}
      <p className="inspector-note" aria-live="polite">
        {frozen
          ? `Holding one frame for ${formatSeconds(currentDuration)}. Frozen clips render silent.`
          : preview === null
            ? `Lasting ${formatSeconds(currentDuration)}.`
            : pending
              ? `${formatSeconds(currentDuration)} → ${formatSeconds(preview)} at ${magnitude}x${reversed ? ' reversed' : ''}`
              : `Lasting ${formatSeconds(currentDuration)} at ${magnitude}x${reversed ? ' reversed' : ''}`}
      </p>

      <div className="inspector-actions">
        <Button variant="secondary" type="button" onClick={() => apply(signed)} disabled={!pending}>
          Apply speed
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setMagnitude(1);
            setReversed(false);
            apply(null);
          }}
          disabled={committed === 1}
        >
          Reset speed
        </Button>
      </div>
    </div>
  );
}
