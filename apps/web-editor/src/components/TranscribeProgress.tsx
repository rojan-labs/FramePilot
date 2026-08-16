/**
 * The waiting experience for speech-to-text — the one place in the editor where
 * the user is asked to wait minutes.
 *
 * Transcribing an hour of audio with the local model takes minutes, and the
 * only feedback used to be the word "Transcribing…" on a disabled button. That
 * is the >20s bucket with nothing in it: no sense of progress, no idea whether
 * it had hung, no way to tell slow from broken.
 *
 * WHY there is no percentage. `whisper-cli` is an opaque subprocess and the
 * hosted providers return one response per request; neither reports how far
 * along it is. Rather than animate a lie, this shows an **indeterminate** bar
 * plus two things that are true: the elapsed time, and which phase the work is
 * in. A fake "87%" that stalls is worse than an honest sweep.
 *
 * Provider-specific copy states only what the editor can verify: where the job
 * is running and whether it is still active. It never invents a pipeline stage
 * from elapsed time.
 */
import { useEffect, useRef, useState } from 'react';
import { AudioLines, ICON_SIZE, RotateCcw } from './icons.js';
import { Button } from '@framepilot/ui';

/**
 * Elapsed whole seconds since the hook first ran with `active`, or 0 when idle.
 * Ticks once a second — enough for a "1:04" readout, cheap enough to ignore.
 */
export function useElapsedSeconds(active: boolean, startedAt = performance.now()): number {
  const [elapsed, setElapsed] = useState(() =>
    active ? Math.max(0, Math.floor((performance.now() - startedAt) / 1000)) : 0,
  );
  const startRef = useRef(startedAt);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return undefined;
    }
    startRef.current = startedAt;
    const update = (): void => {
      setElapsed(Math.max(0, Math.floor((performance.now() - startRef.current) / 1000)));
    };
    update();
    const id = window.setInterval(() => {
      update();
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  return elapsed;
}

/** Delay a potentially-fast loader so a sub-250ms cache hit never flashes. */
export function useDelayedLoading(active: boolean, delayMs = 250): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return visible;
}

/** `0:07` / `2:14` — the shape people read a stopwatch in. */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/**
 * The phase to report at `elapsed` seconds in.
 *
 * Honest about the provider and vague about timing. Past ten seconds, the only
 * additional fact available is that the request is still active.
 */
export function transcribePhase(elapsed: number, provider: string): string {
  if (elapsed >= 10) return 'Still working on this recording…';
  if (provider === 'whisper-cli') return 'Analyzing audio locally…';
  if (provider === 'twelvelabs') return 'Indexing and transcribing with TwelveLabs…';
  return `Sending audio to ${provider === 'groq' ? 'Groq' : 'NVIDIA'} for transcription…`;
}

export interface TranscribeProgressProps {
  /** Human name of the clip being transcribed. */
  readonly label: string;
  /** Which provider is running, so the copy can be truthful about where it runs. */
  readonly provider: string;
  /** Shared job start, so reopening the panel does not reset elapsed time. */
  readonly startedAt?: number | undefined;
  /** Cancel the wait, when the host supports it. Omitted ⇒ no cancel affordance. */
  readonly onCancel?: (() => void) | undefined;
}

/**
 * The in-flight state: an indeterminate bar, the current phase, and elapsed time.
 * `role="status"` so a screen reader hears the phase changes without the polite
 * announcements interrupting anything.
 */
export function TranscribeProgress({
  label,
  provider,
  startedAt,
  onCancel,
}: TranscribeProgressProps): JSX.Element {
  const fallbackStartedAt = useRef(performance.now());
  const elapsed = useElapsedSeconds(true, startedAt ?? fallbackStartedAt.current);
  const visible = useDelayedLoading(true);
  if (!visible) {
    return <span className="transcribe-progress-placeholder" aria-hidden="true" />;
  }
  return (
    <div className="transcribe-progress" role="status" aria-live="polite">
      <div className="transcribe-progress-head">
        <AudioLines size={ICON_SIZE.sm} aria-hidden="true" />
        <span className="transcribe-progress-phase">{transcribePhase(elapsed, provider)}</span>
        <span className="transcribe-progress-elapsed tabular" aria-label="elapsed time">
          {formatElapsed(elapsed)}
        </span>
      </div>
      {/* Indeterminate: a segment sweeping across, because no honest percentage
          exists. `aria-valuenow` is deliberately omitted — that is exactly what
          an indeterminate progressbar means. */}
      <div
        className="transcribe-progress-track"
        role="progressbar"
        aria-label={`Transcribing ${label}`}
      >
        <span className="transcribe-progress-fill" />
      </div>
      {onCancel && (
        <button type="button" className="transcribe-progress-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

export interface TranscribeErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
}

/**
 * The failure branch — a loading state is not finished until its error path is.
 * States what broke and offers the one action that helps, without apologising.
 */
export function TranscribeError({ message, onRetry }: TranscribeErrorProps): JSX.Element {
  return (
    <div className="transcribe-error" role="alert">
      <p className="transcribe-error-message">{message}</p>
      <Button variant="secondary" type="button" onClick={onRetry}>
        <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}
