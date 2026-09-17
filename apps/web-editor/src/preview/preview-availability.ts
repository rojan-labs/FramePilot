/**
 * What the program monitor says when it cannot composite a timeline (PX3.2).
 *
 * The desktop is the product: there a failure keeps its specific message, because the user can
 * act on it (a missing file, a codec the machine lacks). The browser build decodes only what the
 * browser can; parity there is deferred, so a missing capability says so plainly instead of
 * showing a wrong picture or an engine-internal error.
 */

/** Shown in the browser build whenever the monitor cannot composite the timeline. */
export const BROWSER_PREVIEW_UNAVAILABLE = 'Preview unavailable for this timeline in the browser';

/**
 * @param detail - The engine's own error message (logged by the caller either way).
 * @param desktop - Whether the desktop bridge is present.
 * @returns The message the monitor shows.
 */
export function previewFailureMessage(detail: string, desktop: boolean): string {
  return desktop ? detail : BROWSER_PREVIEW_UNAVAILABLE;
}
