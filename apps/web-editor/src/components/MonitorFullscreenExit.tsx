import { ICON_SIZE, Minimize2 } from './icons.js';

interface MonitorFullscreenExitProps {
  readonly onExit: () => void;
}

/**
 * The way back out of a fullscreen monitor, drawn inside it.
 *
 * The monitor's own fullscreen button lives in the application bar (the view controls
 * are hoisted there), and the bar is not part of the fullscreen element — so once the
 * monitor filled the screen, nothing on it said how to leave. This sits over the
 * picture's corner for as long as the monitor is fullscreen, and names Esc too.
 */
export function MonitorFullscreenExit({ onExit }: MonitorFullscreenExitProps): JSX.Element {
  return (
    <button
      type="button"
      className="monitor-fullscreen-exit"
      aria-label="exit fullscreen"
      title="Exit fullscreen (Esc)"
      onClick={onExit}
    >
      <Minimize2 size={ICON_SIZE.md} aria-hidden="true" />
      <span className="monitor-fullscreen-exit-label">Exit fullscreen</span>
      <kbd className="monitor-fullscreen-exit-key">Esc</kbd>
    </button>
  );
}
