/**
 * RD2.1: which compositor the WebCodecs program monitor runs.
 *
 * `layers` is the N-layer compositor driven by `framePlanAt` (PX2,
 * `plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md`); `legacy` is the flat-EDL engine
 * and the DOM `PreviewPlayer` fallback it came with. The legacy path stays reachable as a kill
 * switch until the release gate (RD3) retires it.
 *
 * One build-time variable, no flag framework: `VITE_FRAMEPILOT_PREVIEW_COMPOSITOR` set to
 * `layers` or `legacy` wins. Unset, development and test builds (the dev server the e2e and
 * parity suites run against) get `layers`, and a production build gets `legacy`, so a packaged
 * desktop release only switches when RD3 flips this default.
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
 * @returns `layers` or `legacy`. An unrecognised explicit value falls back to the build default
 *   rather than guessing, so a typo cannot silently enable the other path in a release.
 */
export function previewCompositor(env: CompositorEnv = import.meta.env): PreviewCompositor {
  const explicit = env.VITE_FRAMEPILOT_PREVIEW_COMPOSITOR?.trim().toLowerCase();
  if (explicit === 'layers' || explicit === 'legacy') return explicit;
  return env.DEV === true || env.MODE === 'test' ? 'layers' : 'legacy';
}

/** True when the program monitor should run the N-layer compositor. */
export function layerCompositorEnabled(env?: CompositorEnv): boolean {
  return previewCompositor(env) === 'layers';
}
