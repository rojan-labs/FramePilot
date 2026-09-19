/**
 * RD2.1: the AI masking kill switch.
 *
 * The same mechanism as the compositor and mask-tools flags — one variable, `on` or `off`, no
 * flag framework — with the same default: on in development and test, OFF in a packaged
 * release until RD3 flips it. Off removes the masking domain's new tools from what the model is
 * offered (`HostToolExecutor.unroutableTools`), so no run can reach them; masks already in a
 * project still preview, export and edit by hand. The flag gates an agent capability, never a
 * frame of output.
 *
 * Two hosts read it, because there are two orchestrators: the desktop's main process
 * (`FRAMEPILOT_AI_MASKING`, a runtime variable, so support can switch a shipped build off
 * without a rebuild) and the browser build (`VITE_FRAMEPILOT_AI_MASKING`, baked by Vite). The
 * decision is this one function either way.
 *
 * The two tools folded INTO the domain from `tracking` (`professional_tracking_mask`,
 * `track_subject_automatically`) are not switched: they shipped before this work and a kill
 * switch for a new feature must not take an old one with it.
 */
import { MASKING_TOOLS } from '../domain-tools/masking.js';

export type AiMaskingSetting = 'on' | 'off';

export interface AiMaskingEnv {
  /** The variable's raw value, if set. */
  readonly explicit?: string | undefined;
  /** A development or test build (the dev server, vitest, an unpackaged desktop app). */
  readonly development: boolean;
}

/**
 * Resolve the setting. An unrecognised explicit value falls back to the build default rather
 * than guessing, so a typo cannot silently enable the tools in a release.
 */
export function aiMaskingSetting(env: AiMaskingEnv): AiMaskingSetting {
  const explicit = env.explicit?.trim().toLowerCase();
  if (explicit === 'on' || explicit === 'off') return explicit;
  return env.development ? 'on' : 'off';
}

export function aiMaskingEnabled(env: AiMaskingEnv): boolean {
  return aiMaskingSetting(env) === 'on';
}

/** Every tool the switch removes: the ones `domain-tools/masking.ts` registers. */
export const AI_MASKING_TOOL_NAMES: readonly string[] = MASKING_TOOLS.map((tool) => tool.name);

/** What a host adds to its unroutable set for a given setting. Empty when on. */
export function aiMaskingUnroutableTools(env: AiMaskingEnv): readonly string[] {
  return aiMaskingEnabled(env) ? [] : AI_MASKING_TOOL_NAMES;
}
