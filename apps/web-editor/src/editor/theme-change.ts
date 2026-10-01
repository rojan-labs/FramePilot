/**
 * One shared signal for "the colour theme just changed".
 *
 * Canvas painters (the clip waveforms) resolve their colours from CSS custom
 * properties at paint time (ADR 0198), but a theme switch repaints nothing on a
 * canvas: the bitmap keeps the old theme's colours until something else (a resize)
 * triggers a repaint. The theme changes two ways — the OS preference (when the
 * setting is "system") and the `data-theme` attribute `useSettings` writes on
 * `<html>` — so both are watched here.
 *
 * ONE media-query listener and ONE MutationObserver serve every subscriber, however
 * many clips are on the timeline; they are created for the first subscriber and torn
 * down after the last one leaves.
 */

/** Called after the effective theme may have changed. */
export type ThemeChangeListener = () => void;

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const THEME_ATTRIBUTE = 'data-theme';

const listeners = new Set<ThemeChangeListener>();
let stopWatching: (() => void) | null = null;

function notifyAll(): void {
  // Copy first: a listener may unsubscribe while being notified.
  for (const listener of [...listeners]) listener();
}

function startWatching(): () => void {
  const query =
    typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;
  query?.addEventListener('change', notifyAll);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(notifyAll) : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });
  return () => {
    query?.removeEventListener('change', notifyAll);
    observer?.disconnect();
  };
}

/**
 * Subscribe to theme changes (OS preference or the `data-theme` attribute).
 *
 * @param listener - Called once per change; it should schedule its own repaint.
 * @returns An unsubscribe function.
 */
export function subscribeThemeChange(listener: ThemeChangeListener): () => void {
  listeners.add(listener);
  if (stopWatching === null) stopWatching = startWatching();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatching !== null) {
      stopWatching();
      stopWatching = null;
    }
  };
}
