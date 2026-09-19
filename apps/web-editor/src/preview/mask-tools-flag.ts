/**
 * RD2.1: whether the mask stack UI is on (MK4: monitor mask tools + Inspector mask panel).
 *
 * The same mechanism as the compositor flag (`compositor-flag.ts`): one build-time variable,
 * no flag framework. `VITE_FRAMEPILOT_MASK_TOOLS` set to `on` or `off` wins. Unset, development
 * and test builds (the dev server the e2e suite runs against) get `on`, and a production build
 * gets `off`, so a packaged release only switches when RD3 flips this default.
 *
 * Off hides the monitor tools and the Inspector's Mask tab. Masks already in a project still
 * preview and export: the flag gates editing chrome, never a frame of output.
 */

export type MaskToolsSetting = 'on' | 'off';

/** The subset of `import.meta.env` this decision reads; injectable for tests. */
export interface MaskToolsEnv {
  readonly DEV?: boolean;
  readonly MODE?: string;
  readonly VITE_FRAMEPILOT_MASK_TOOLS?: string;
}

/**
 * Resolve the mask tools setting for this build.
 *
 * @param env - Build environment; defaults to Vite's `import.meta.env`.
 * @returns `on` or `off`. An unrecognised explicit value falls back to the build default rather
 *   than guessing, so a typo cannot silently enable the tools in a release.
 */
export function maskToolsSetting(env: MaskToolsEnv = import.meta.env): MaskToolsSetting {
  const explicit = env.VITE_FRAMEPILOT_MASK_TOOLS?.trim().toLowerCase();
  if (explicit === 'on' || explicit === 'off') return explicit;
  return env.DEV === true || env.MODE === 'test' ? 'on' : 'off';
}

/** True when the monitor mask tools and the Inspector mask panel are shown. */
export function maskToolsEnabled(env?: MaskToolsEnv): boolean {
  return maskToolsSetting(env) === 'on';
}
