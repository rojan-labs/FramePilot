import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useMonitorFullscreen } from './useMonitorFullscreen.js';
import { ExitFullscreenButton, FullscreenEscHint } from './MonitorFullscreenControls.js';

/** A player inside the editor's monitor, wired the way both preview engines wire it. */
function Player(): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const { isFullscreen, toggleFullscreen, exitFullscreen } = useMonitorFullscreen(ref);
  return (
    <div className="stage-monitor" data-testid="monitor">
      <section ref={ref}>
        {isFullscreen && <FullscreenEscHint />}
        {isFullscreen && <ExitFullscreenButton onExit={exitFullscreen} />}
        <button type="button" onClick={toggleFullscreen}>
          fullscreen preview
        </button>
      </section>
    </div>
  );
}

// jsdom has no Fullscreen API: a stand-in that behaves like the browser's (the element
// becomes `document.fullscreenElement`, and `fullscreenchange` fires on the document).
let fullscreenElement: Element | null = null;
const setFullscreen = (element: Element | null): void => {
  fullscreenElement = element;
  document.dispatchEvent(new Event('fullscreenchange'));
};
const requestFullscreen = vi.fn(function (this: Element) {
  setFullscreen(this);
  return Promise.resolve();
});
const exitFullscreen = vi.fn(() => {
  setFullscreen(null);
  return Promise.resolve();
});

beforeEach(() => {
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMonitorFullscreen', () => {
  it('fullscreens the whole monitor and shows a way back out inside it', () => {
    render(<Player />);
    expect(screen.queryByRole('button', { name: 'exit fullscreen' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'fullscreen preview' }));

    expect(requestFullscreen.mock.contexts[0]).toBe(screen.getByTestId('monitor'));
    const exit = screen.getByRole('button', { name: 'exit fullscreen' });
    expect(screen.getByTestId('monitor').contains(exit)).toBe(true);
  });

  it('says how to leave on entry, then gets out of the way', () => {
    vi.useFakeTimers();
    try {
      render(<Player />);
      fireEvent.click(screen.getByRole('button', { name: 'fullscreen preview' }));

      expect(screen.getByRole('status').textContent).toBe('Press Esc to exit full screen');
      act(() => vi.advanceTimersByTime(3000));

      expect(screen.queryByRole('status')).toBeNull();
      // The permanent way out stays.
      expect(screen.getByRole('button', { name: 'exit fullscreen' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves fullscreen from the in-monitor button', () => {
    render(<Player />);
    fireEvent.click(screen.getByRole('button', { name: 'fullscreen preview' }));

    fireEvent.click(screen.getByRole('button', { name: 'exit fullscreen' }));

    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'exit fullscreen' })).toBeNull();
  });

  it('drops the exit button when fullscreen ends some other way (the OS, the browser)', () => {
    render(<Player />);
    fireEvent.click(screen.getByRole('button', { name: 'fullscreen preview' }));

    act(() => setFullscreen(null));

    expect(screen.queryByRole('button', { name: 'exit fullscreen' })).toBeNull();
  });

  it('makes Esc leave fullscreen and reach no other handler (deselect stays out of it)', () => {
    render(<Player />);
    fireEvent.click(screen.getByRole('button', { name: 'fullscreen preview' }));
    // The editor's global shortcuts listen on the window, as `select.clear` does.
    const deselect = vi.fn();
    window.addEventListener('keydown', deselect);

    const unhandled = fireEvent.keyDown(document.body, { key: 'Escape' });

    window.removeEventListener('keydown', deselect);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(deselect).not.toHaveBeenCalled();
    expect(unhandled).toBe(false);
  });

  it('leaves Esc to the editor when the monitor is not fullscreen', () => {
    render(<Player />);
    const deselect = vi.fn();
    window.addEventListener('keydown', deselect);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    window.removeEventListener('keydown', deselect);
    expect(deselect).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();
  });
});
