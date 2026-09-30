import { useEffect, useState } from 'react';
import { Tooltip } from './Tooltip.js';
import { ICON_SIZE, Minimize2 } from './icons.js';

/** How long the "Press Esc" hint stays up after the monitor goes fullscreen. */
const ESC_HINT_MS = 2500;

interface ExitFullscreenButtonProps {
  readonly onExit: () => void;
}

/**
 * The transport's way out of fullscreen, in the slot a video player keeps its fullscreen
 * toggle: the right end of the controls, beside the volume.
 *
 * The monitor's own fullscreen button lives in the application bar (the view controls are
 * hoisted there), and the bar is not part of the fullscreen element. So while the monitor
 * fills the screen, this is the control that stands in for it.
 */
export function ExitFullscreenButton({ onExit }: ExitFullscreenButtonProps): JSX.Element {
  return (
    <Tooltip label="Exit fullscreen" shortcut="Esc">
      <button type="button" className="transport-btn" aria-label="exit fullscreen" onClick={onExit}>
        <Minimize2 size={ICON_SIZE.md} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * "Press Esc to exit full screen", shown briefly when the monitor goes fullscreen. A
 * browser shows its own version of this; the desktop app's window does not, so the monitor
 * says it. Mounted only while fullscreen, so each entry shows it once.
 */
export function FullscreenEscHint(): JSX.Element | null {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), ESC_HINT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div className="fullscreen-esc-hint" role="status">
      Press <kbd>Esc</kbd> to exit full screen
    </div>
  );
}
