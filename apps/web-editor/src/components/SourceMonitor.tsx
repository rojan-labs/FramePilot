/**
 * Read-only Source monitor (H1.7, J3 — source-vs-program split).
 *
 * Previews exactly ONE media-bin asset, independent of the project timeline. In/out state is
 * ephemeral UI state, never a patch. The AI receives a live snapshot object whose playhead is
 * updated in place, so playback does not push 30/60Hz state updates through the top-level Editor.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { rationalFrameRate } from '@framepilot/ai-sdk';
import type { Asset } from '@framepilot/timeline-schema';
import { previewMediaSrc } from '../editor/media.js';
import { assetDisplayName, assetKind, formatTime } from '../editor/selectors.js';
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  ICON_SIZE,
} from './icons.js';
import { MonitorHeaderPortal } from './MonitorHeaderPortal.js';

export interface SourceMonitorProps {
  readonly asset: Asset | undefined;
  readonly fps: number;
  readonly headerControlsHost?: HTMLElement | null;
  readonly onInteractionChange?: (interaction: SourceMonitorSnapshot | undefined) => void;
}

export interface SourceMonitorSnapshot {
  readonly assetId: string;
  readonly rate: { readonly numerator: number; readonly denominator: number };
  readonly playhead: { readonly seconds: number; readonly frame: number };
  readonly markedRange?: { readonly startFrame: number; readonly endFrame: number };
}

interface MutableSourceMonitorSnapshot {
  assetId: string;
  rate: { numerator: number; denominator: number };
  playhead: { seconds: number; frame: number };
  markedRange?: { startFrame: number; endFrame: number };
}

const FALLBACK_FPS = 30;
const frameSeconds = (fps: number): number => (fps > 0 ? 1 / fps : 1 / FALLBACK_FPS);

interface MarkRange {
  readonly in: number | null;
  readonly out: number | null;
}

const EMPTY_RANGE: MarkRange = { in: null, out: null };

export function SourceMonitor({
  asset,
  fps,
  headerControlsHost,
  onInteractionChange,
}: SourceMonitorProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<MarkRange>(EMPTY_RANGE);
  const currentTimeRef = useRef(0);
  const interactionRef = useRef<MutableSourceMonitorSnapshot>();
  currentTimeRef.current = currentTime;

  const updateLivePlayhead = useCallback(
    (seconds: number): void => {
      currentTimeRef.current = seconds;
      const interaction = interactionRef.current;
      if (interaction === undefined) return;
      const rate = fps > 0 ? fps : FALLBACK_FPS;
      interaction.playhead.seconds = seconds;
      interaction.playhead.frame = Math.round(seconds * rate);
    },
    [fps],
  );

  // Publish only when the structural source context changes. The same object is retained by
  // the parent and its playhead is mutated by updateLivePlayhead, so an AI turn reads the exact
  // current source position without forcing the entire Editor tree to render on every tick.
  useEffect(() => {
    if (!onInteractionChange) return;
    if (!asset) {
      interactionRef.current = undefined;
      onInteractionChange(undefined);
      return;
    }
    const rate = fps > 0 ? fps : FALLBACK_FPS;
    const startFrame = range.in === null ? undefined : Math.round(range.in * rate);
    const endFrame = range.out === null ? undefined : Math.round(range.out * rate);
    const interaction: MutableSourceMonitorSnapshot = {
      assetId: asset.id,
      rate: rationalFrameRate(rate),
      playhead: {
        seconds: currentTimeRef.current,
        frame: Math.round(currentTimeRef.current * rate),
      },
      ...(startFrame !== undefined && endFrame !== undefined && endFrame > startFrame
        ? { markedRange: { startFrame, endFrame } }
        : {}),
    };
    interactionRef.current = interaction;
    onInteractionChange(interaction);
  }, [asset, fps, onInteractionChange, range]);

  // Unmount is the only cleanup that clears the parent's snapshot. Effect re-runs above replace
  // it directly, avoiding the old undefined→snapshot double update on every playhead tick.
  useEffect(
    () => () => {
      interactionRef.current = undefined;
      onInteractionChange?.(undefined);
    },
    [onInteractionChange],
  );

  const kind = asset ? assetKind(asset) : 'video';
  const src = asset ? previewMediaSrc(asset) : undefined;

  useEffect(() => {
    setPlaying(false);
    updateLivePlayhead(0);
    setCurrentTime(0);
    setDuration(asset?.durationSeconds ?? 0);
    setRange(EMPTY_RANGE);
  }, [asset?.id, asset?.durationSeconds, updateLivePlayhead]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || kind !== 'video') return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [playing, asset?.id, kind]);

  const seekTo = useCallback(
    (time: number): void => {
      const clamped = Math.min(Math.max(time, 0), duration || 0);
      updateLivePlayhead(clamped);
      setCurrentTime(clamped);
      const video = videoRef.current;
      if (video && kind === 'video') video.currentTime = clamped;
    },
    [duration, kind, updateLivePlayhead],
  );

  const stepFrame = useCallback(
    (direction: 1 | -1): void => {
      setPlaying(false);
      seekTo(currentTimeRef.current + direction * frameSeconds(fps));
    },
    [fps, seekTo],
  );

  const markIn = useCallback((): void => {
    setRange((r) => ({ ...r, in: currentTimeRef.current }));
  }, []);
  const markOut = useCallback((): void => {
    setRange((r) => ({ ...r, out: currentTimeRef.current }));
  }, []);

  useEffect(() => {
    if (!asset) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea)$/i.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'i' || event.key === 'I') markIn();
      else if (event.key === 'o' || event.key === 'O') markOut();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [asset, markIn, markOut]);

  const onLoadedMetadata = (): void => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) setDuration(video.duration);
  };
  const onTimeUpdate = (): void => {
    const video = videoRef.current;
    if (!video) return;
    updateLivePlayhead(video.currentTime);
    setCurrentTime(video.currentTime);
  };

  const rangePercent = (t: number): number => (duration > 0 ? (t / duration) * 100 : 0);

  return (
    <section className="preview source-monitor" aria-label="source monitor">
      <div className="preview-stage">
        <div className="preview-frame" style={{ ['--aspect' as string]: 16 / 9 }}>
          {asset && src ? (
            kind === 'image' ? (
              <img
                className="preview-video"
                src={src}
                alt={assetDisplayName(asset, asset.id)}
                aria-label={`source preview ${asset.id}`}
              />
            ) : (
              <video
                ref={videoRef}
                className="preview-video"
                src={src}
                aria-label={`source preview ${asset.id}`}
                muted={kind === 'audio'}
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onEnded={() => setPlaying(false)}
              />
            )
          ) : (
            <p className="source-monitor-empty">
              Select an asset in the Media panel to load it here.
            </p>
          )}
        </div>
      </div>

      <div className="source-scrubber">
        <input
          type="range"
          aria-label="scrub source"
          min={0}
          max={duration || 0}
          step={frameSeconds(fps)}
          value={currentTime}
          disabled={!asset}
          onChange={(event) => seekTo(Number(event.target.value))}
        />
        {range.in !== null && range.out !== null && range.out > range.in && (
          <div
            className="source-scrubber-range"
            aria-hidden="true"
            style={{
              left: `${rangePercent(range.in)}%`,
              width: `${rangePercent(range.out) - rangePercent(range.in)}%`,
            }}
          />
        )}
      </div>

      <div className="transport" role="group" aria-label="source transport">
        <div className="transport-nav">
          <button
            type="button"
            className="transport-btn"
            aria-label="source go to start"
            disabled={!asset}
            onClick={() => {
              setPlaying(false);
              seekTo(0);
            }}
          >
            <SkipBack size={ICON_SIZE.md} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="transport-btn"
            aria-label="source step back one frame"
            disabled={!asset}
            onClick={() => stepFrame(-1)}
          >
            <ChevronLeft size={ICON_SIZE.md} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="transport-play"
            aria-label={playing ? 'source pause' : 'source play'}
            aria-pressed={playing}
            disabled={!asset}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? (
              <Pause size={ICON_SIZE.lg} aria-hidden="true" />
            ) : (
              <Play size={ICON_SIZE.lg} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="transport-btn"
            aria-label="source step forward one frame"
            disabled={!asset}
            onClick={() => stepFrame(1)}
          >
            <ChevronRight size={ICON_SIZE.md} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="transport-btn"
            aria-label="source go to end"
            disabled={!asset}
            onClick={() => {
              setPlaying(false);
              seekTo(duration);
            }}
          >
            <SkipForward size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </div>
        <span className="transport-time tabular">
          <span aria-label="source current time">{formatTime(currentTime, fps)}</span>
          <span className="transport-sep" aria-hidden="true">/</span>
          <span className="transport-total" aria-label="source total time">
            {formatTime(duration, fps)}
          </span>
        </span>
        <MonitorHeaderPortal host={headerControlsHost}>
          <div className="transport-right">
            <button
              type="button"
              className="transport-btn"
              aria-label="mark in"
              title="Mark in (I)"
              disabled={!asset}
              onClick={markIn}
            >
              In
            </button>
            <button
              type="button"
              className="transport-btn"
              aria-label="mark out"
              title="Mark out (O)"
              disabled={!asset}
              onClick={markOut}
            >
              Out
            </button>
          </div>
        </MonitorHeaderPortal>
      </div>
    </section>
  );
}
