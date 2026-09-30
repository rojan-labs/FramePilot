import { useCallback, useEffect, useState, type RefObject } from 'react';

/** What the monitor's fullscreen control reads and drives. */
export interface MonitorFullscreen {
  /** Whether the monitor holding this player is the fullscreen element right now. */
  readonly isFullscreen: boolean;
  /** Enter fullscreen, or leave it when the document is fullscreen already. */
  readonly toggleFullscreen: () => void;
  /** Leave fullscreen; a no-op when nothing is fullscreen. */
  readonly exitFullscreen: () => void;
}

/**
 * The element fullscreen puts on screen: the WHOLE monitor (picture plus transport),
 * not the player alone. Fullscreening just the stage left a bare picture with no play
 * button, no timecode and no scrub (the timeline dock is hidden too).
 */
function fullscreenTarget(player: HTMLElement | null): HTMLElement | null {
  return player?.closest<HTMLElement>('.stage-monitor') ?? player;
}

/**
 * Leaves fullscreen, swallowing the rejection a second exit gets: Esc in a browser
 * leaves fullscreen natively and may still reach the page's own handler.
 */
export function exitDocumentFullscreen(): void {
  if (!document.fullscreenElement) return;
  document.exitFullscreen().catch(() => undefined);
}

/**
 * Fullscreen state and controls for a preview player, shared by both preview engines.
 *
 * The state follows `fullscreenchange`, not the button: Esc, the OS and the in-monitor
 * exit button all leave fullscreen, and the monitor has to know whichever did it so it
 * can show (or drop) the control that gets the user back out.
 *
 * @param playerRef - The player's root element (inside `.stage-monitor` in the editor).
 * @returns Whether this monitor is fullscreen, and the controls to enter or leave it.
 */
export function useMonitorFullscreen(playerRef: RefObject<HTMLElement>): MonitorFullscreen {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = (): void => {
      // `undefined` where the API is missing (jsdom, older engines), not just `null`.
      const current = document.fullscreenElement ?? null;
      const player = playerRef.current;
      setIsFullscreen(current !== null && player !== null && current.contains(player));
    };
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [playerRef]);

  // Esc leaves fullscreen and does nothing else. Electron leaves HTML fullscreen on Esc
  // only when the page leaves the key unhandled, and the editor's global `select.clear`
  // shortcut always handled it: Esc deselected the clip under the bounding box and the
  // window stayed fullscreen. Capture phase, so no other Esc handler (deselect, close a
  // panel) runs behind a monitor that fills the screen; a browser that already left
  // natively makes the exit a no-op.
  useEffect(() => {
    if (!isFullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      exitDocumentFullscreen();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isFullscreen]);

  const toggleFullscreen = useCallback((): void => {
    if (document.fullscreenElement) {
      exitDocumentFullscreen();
      return;
    }
    fullscreenTarget(playerRef.current)
      ?.requestFullscreen()
      .catch(() => undefined);
  }, [playerRef]);

  return { isFullscreen, toggleFullscreen, exitFullscreen: exitDocumentFullscreen };
}
