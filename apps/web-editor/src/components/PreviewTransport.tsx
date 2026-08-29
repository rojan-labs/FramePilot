/**
 * Program-monitor transport (revamp Phase 2, F3 — "transport is missing half the
 * professional control set").
 *
 * What it adds over the five buttons it replaces:
 *
 *  - **Prev/next edit point.** The navigation an editor reaches for constantly and
 *    the monitor simply did not have. See `editor/edit-points.ts` for why this is
 *    NOT `listEditBoundaries` (that answers a transition question, and skipping
 *    gap edges would make the button look broken).
 *  - **Loop, in the transport.** Loop lived in the *view* controls, next to grid
 *    and safe-area guides — a different mental category. Looping is playback.
 *  - **Volume/mute.** Genuinely wired: footage audio through the preview engine's
 *    master gain bus, audio-only clips through the mixer's monitor scale. One
 *    control, everything you hear, and never any part of the edit.
 *  - **The scrub bar**, spanning the monitor width, with the project's cut ticks.
 *
 * Shared by every monitor that has an editor timeline behind it, so the control
 * set cannot drift between them.
 *
 * **Playback speed is deliberately absent.** A speed control here would need the
 * preview engine to support a playback rate, and the engine is audio-master
 * clocked — a rate means resampling scheduled audio buffers (which shifts pitch)
 * plus rate-aware frame selection and decode-ahead. The pitch question is exactly
 * what ADR 0089 is being written to decide for speed ramps (revamp Phase 10), and
 * shipping a dropdown that silently did nothing would break the render-honesty
 * rule (AGENTS.md). It lands with 10c, behind that decision.
 */
import { useMemo } from 'react';
import { usePlayhead, useFramePlayhead, type UseEditor } from '../editor/useEditor.js';
import { formatTime } from '../editor/selectors.js';
import { listEditPoints, nextEditPoint, prevEditPoint } from '../editor/edit-points.js';
import { useSettings } from '../editor/useSettings.js';
import { PreviewScrubBar } from './PreviewScrubBar.js';
import { Tooltip } from './Tooltip.js';
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ICON_SIZE,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from './icons.js';
import { hintFor } from '../editor/shortcuts.js';

export interface PreviewTransportProps {
  readonly editor: UseEditor;
  /** Sequence length (seconds) as the MONITOR understands it — project time, so
   * an unloadable source still contributes its duration as a gap. */
  readonly durationSec: number;
  readonly fps: number;
}

/** Volume slider granularity — 20 steps over the range is plenty for monitoring. */
const VOLUME_STEP = 0.05;

export function PreviewTransport({ editor, durationSec, fps }: PreviewTransportProps): JSX.Element {
  // Frame-quantized for the READOUT (a timecode that changes per display refresh
  // is unreadable), raw for the scrub handle (which should track smoothly).
  const displayTimeSec = useFramePlayhead(editor, fps);
  const livePlayhead = usePlayhead(editor);
  const { settings, update } = useSettings();
  const playing = editor.state.playing;

  const editPoints = useMemo(() => listEditPoints(editor.state.timeline), [editor.state.timeline]);

  const seek = (time: number): void => {
    editor.setPlaying(false);
    editor.seek(Math.max(0, Math.min(durationSec, time)));
  };
  /** Scrubbing must not pause: dragging the bar during playback is a legitimate
   * gesture, and stopping playback under the user's finger is not what they asked. */
  const scrubTo = (time: number): void => {
    editor.seek(Math.max(0, Math.min(durationSec, time)));
  };
  const stepFrames = (frames: number): void => seek(displayTimeSec + frames / Math.max(1, fps));

  const toEditPoint = (direction: -1 | 1): void => {
    const from = livePlayhead;
    const target =
      direction === -1 ? prevEditPoint(from, editPoints) : nextEditPoint(from, editPoints);
    // No edit point that way: fall back to the end of the sequence in that
    // direction rather than doing nothing, so the button always means something.
    seek(target ?? (direction === -1 ? 0 : durationSec));
  };

  const muted = settings.previewMuted;
  const volume = settings.previewVolume;

  return (
    <div className="transport preview-transport" role="group" aria-label="transport">
      <PreviewScrubBar
        durationSec={durationSec}
        currentTimeSec={livePlayhead}
        fps={fps}
        editPoints={editPoints}
        onSeek={scrubTo}
        formatTimeLabel={(time) => formatTime(time, fps, settings.timeDisplay)}
      />

      <div className="transport-nav">
        <Tooltip label="Go to start" shortcut={hintFor('transport.start')}>
          <button
            type="button"
            className="transport-btn"
            aria-label="go to start"
            onClick={() => seek(0)}
          >
            <SkipBack size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Previous edit point" shortcut={hintFor('transport.prevEdit')}>
          <button
            type="button"
            className="transport-btn"
            aria-label="previous edit point"
            onClick={() => toEditPoint(-1)}
          >
            <ChevronFirst size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Step back one frame" shortcut={hintFor('transport.frameBack')}>
          <button
            type="button"
            className="transport-btn"
            aria-label="step back one frame"
            onClick={() => stepFrames(-1)}
          >
            <ChevronLeft size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Play / Pause" shortcut={hintFor('transport.playpause')}>
          <button
            type="button"
            className="transport-play"
            aria-label={playing ? 'pause' : 'play'}
            aria-pressed={playing}
            onClick={() => editor.setPlaying(!playing)}
          >
            {playing ? (
              <Pause size={ICON_SIZE.lg} aria-hidden="true" />
            ) : (
              <Play size={ICON_SIZE.lg} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
        <Tooltip label="Step forward one frame" shortcut={hintFor('transport.frameFwd')}>
          <button
            type="button"
            className="transport-btn"
            aria-label="step forward one frame"
            onClick={() => stepFrames(1)}
          >
            <ChevronRight size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Next edit point" shortcut={hintFor('transport.nextEdit')}>
          <button
            type="button"
            className="transport-btn"
            aria-label="next edit point"
            onClick={() => toEditPoint(1)}
          >
            <ChevronLast size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Go to end" shortcut={hintFor('transport.end')}>
          <button
            type="button"
            className="transport-btn"
            aria-label="go to end"
            onClick={() => seek(durationSec)}
          >
            <SkipForward size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      <span className="transport-time tabular">
        <span aria-label="current time">
          {formatTime(displayTimeSec, fps, settings.timeDisplay)}
        </span>
        <span className="transport-sep" aria-hidden="true">
          {' / '}
        </span>
        <span className="transport-total" aria-label="total time">
          {formatTime(durationSec, fps, settings.timeDisplay)}
        </span>
      </span>

      {/* Playback-adjacent controls: loop belongs with play, not with the grid. */}
      <div className="transport-playback-opts">
        {/* No `shortcut` hint: loop has no chord. `L` is already "play forward"
            (the J/K/L shuttle), and a tooltip must never claim a key that does
            something else. */}
        <Tooltip label="Loop playback">
          <button
            type="button"
            className={`transport-btn ${settings.loopByDefault ? 'is-active' : ''}`}
            aria-label="loop"
            aria-pressed={settings.loopByDefault}
            onClick={() => update({ loopByDefault: !settings.loopByDefault })}
          >
            <Repeat size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </Tooltip>
        {/* Likewise: `M` is "toggle marker at playhead". */}
        <Tooltip label={muted ? 'Unmute monitor' : 'Mute monitor'}>
          <button
            type="button"
            className={`transport-btn ${muted ? 'is-active' : ''}`}
            aria-label={muted ? 'unmute monitor' : 'mute monitor'}
            aria-pressed={muted}
            onClick={() => update({ previewMuted: !muted })}
          >
            {muted ? (
              <VolumeX size={ICON_SIZE.md} aria-hidden="true" />
            ) : (
              <Volume2 size={ICON_SIZE.md} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
        {/* Moving the slider off zero also un-mutes: reaching for volume while
            muted and hearing nothing would read as a broken control. */}
        <input
          className="transport-volume"
          type="range"
          aria-label="monitor volume"
          min={0}
          max={1}
          step={VOLUME_STEP}
          value={muted ? 0 : volume}
          onChange={(event) => {
            const next = Number(event.target.value);
            update({ previewVolume: next, previewMuted: next <= 0 });
          }}
        />
      </div>
    </div>
  );
}
