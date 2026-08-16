/**
 * Tests for the speech-to-text waiting experience.
 *
 * The properties that matter are honesty ones: the bar must not claim a
 * percentage it cannot know, the phase copy must describe a real stage, and the
 * failure path must offer the action that helps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  TranscribeError,
  TranscribeProgress,
  formatElapsed,
  transcribePhase,
} from './TranscribeProgress.js';

describe('formatElapsed', () => {
  it('reads like a stopwatch', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7)).toBe('0:07');
    expect(formatElapsed(74)).toBe('1:14');
    expect(formatElapsed(600)).toBe('10:00');
  });
});

describe('transcribePhase', () => {
  it('names a real pipeline stage rather than repeating "Loading…"', () => {
    expect(transcribePhase(0, 'whisper-cli')).toMatch(/locally/);
    expect(transcribePhase(5, 'whisper-cli')).toMatch(/Analyzing/);
    expect(transcribePhase(30, 'whisper-cli')).toMatch(/Still working/);
  });

  it('is truthful about where the work runs', () => {
    // Hosted providers send audio away; the local model does not.
    expect(transcribePhase(5, 'groq')).toMatch(/Sending audio/);
    expect(transcribePhase(5, 'whisper-cli')).not.toMatch(/Sending/);
    expect(transcribePhase(5, 'twelvelabs')).toMatch(/TwelveLabs/);
  });

  it('reassures rather than alarms on a long wait', () => {
    expect(transcribePhase(120, 'whisper-cli')).toMatch(/still working/i);
  });
});

describe('TranscribeProgress', () => {
  beforeEach(() => {
    // `performance` must be faked explicitly: the hook measures with
    // `performance.now()` (monotonic, so a system clock change mid-transcription
    // cannot make the elapsed readout jump), and Vitest fakes `Date` but not
    // `performance` by default.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function revealLoader(): void {
    act(() => {
      vi.advanceTimersByTime(250);
    });
  }

  it('delays the loader to avoid flashing on cache hits', () => {
    render(<TranscribeProgress label="take-1.mp4" provider="whisper-cli" />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    revealLoader();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('exposes an INDETERMINATE progressbar — no invented percentage', () => {
    render(<TranscribeProgress label="take-1.mp4" provider="whisper-cli" />);
    revealLoader();
    const bar = screen.getByRole('progressbar', { name: 'Transcribing take-1.mp4' });
    // Omitting aria-valuenow is what "indeterminate" means to assistive tech.
    // Neither whisper-cli nor the hosted providers report progress, so any
    // number here would be a lie.
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
  });

  it('announces politely so phase changes do not interrupt', () => {
    render(<TranscribeProgress label="take-1.mp4" provider="whisper-cli" />);
    revealLoader();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('ticks the elapsed clock so a long wait never looks frozen', () => {
    render(<TranscribeProgress label="take-1.mp4" provider="whisper-cli" />);
    revealLoader();
    expect(screen.getByLabelText('elapsed time').textContent).toBe('0:00');
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByLabelText('elapsed time').textContent).toBe('0:04');
  });

  it('advances the phase as the wait grows', () => {
    render(<TranscribeProgress label="take-1.mp4" provider="whisper-cli" />);
    revealLoader();
    expect(screen.getByText(/Analyzing/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(screen.getByText(/Still working/)).toBeTruthy();
  });

  it('offers no cancel affordance when the host cannot cancel', () => {
    render(<TranscribeProgress label="take-1.mp4" provider="whisper-cli" />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('offers cancel when the host can', () => {
    const onCancel = vi.fn();
    render(<TranscribeProgress label="a.mp4" provider="groq" onCancel={onCancel} />);
    revealLoader();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('TranscribeError', () => {
  it('states what broke and offers a retry', () => {
    const onRetry = vi.fn();
    render(<TranscribeError message="No API key for Groq." onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('No API key for Groq.');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
