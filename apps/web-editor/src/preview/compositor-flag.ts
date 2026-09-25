/**
 * RD2.1: which compositor the WebCodecs program monitor runs.
 *
 * `layers` is the N-layer compositor driven by `framePlanAt` (PX2,
 * `plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md`); `legacy` is the flat-EDL engine
 * and the DOM `PreviewPlayer` fallback it came with. The legacy path stays reachable as a kill
 * switch until the release gate (RD3) retires it.
 *
 * One build-time variable, no flag framework: `VITE_FRAMEPILOT_PREVIEW_COMPOSITOR` set to
 * `layers` or `legacy` wins. Unset, every build gets `layers`. Production builds used to get
 * `legacy` until the parity work was complete; it is (every PX4 oracle row passes, styled
 * captions included, ADR 0180 amendment 2026-09-25), and a release that kept the old monitor
 * showed users a picture the export does not make. `legacy` stays an explicit kill switch
 * until RD3 deletes it.
 */

export type PreviewCompositor = 'layers' | 'legacy';

/** The subset of `import.meta.env` this decision reads; injectable for tests. */
export interface CompositorEnv {
  readonly DEV?: boolean;
  readonly MODE?: string;
  readonly VITE_FRAMEPILOT_PREVIEW_COMPOSITOR?: string;
}

/**
 * Resolve the compositor for this build.
 *
 * @param env - Build environment; defaults to Vite's `import.meta.env`.
 * @returns `layers` or `legacy`. An unrecognised explicit value falls back to the default
 *   (`layers`) rather than guessing, so a typo cannot silently switch a release to the old monitor.
 */
export function previewCompositor(env: CompositorEnv = import.meta.env): PreviewCompositor {
  const explicit = env.VITE_FRAMEPILOT_PREVIEW_COMPOSITOR?.trim().toLowerCase();
  if (explicit === 'layers' || explicit === 'legacy') return explicit;
  return 'layers';
}

/** True when the program monitor should run the N-layer compositor. */
export function layerCompositorEnabled(env?: CompositorEnv): boolean {
  return previewCompositor(env) === 'layers';
}
