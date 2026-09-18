/**
 * RD2.1: the desktop's reading of the AI masking kill switch.
 *
 * The decision is `aiMaskingUnroutableTools` in `@framepilot/ai-sdk`, shared with the browser
 * build so the two hosts cannot disagree. The desktop's orchestrator runs in Electron main, so
 * it reads `FRAMEPILOT_AI_MASKING` at RUNTIME, on every call: support can switch a shipped
 * build off without a rebuild, and a switch flipped mid-session holds from the next request.
 * Unset, an unpackaged app is `on` and a packaged release is `off` until RD3 flips the default.
 */
import { aiMaskingUnroutableTools } from '@framepilot/ai-sdk';

/** The name of the variable, in one place for main and its test. */
export const AI_MASKING_ENV_VAR = 'FRAMEPILOT_AI_MASKING';

export interface DesktopAiMaskingSource {
  /** The live environment, read on every call — `process.env` in main. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `app.isPackaged`: a release build. */
  readonly packaged: boolean;
}

/**
 * The masking tools switched off right now. The desktop passes this to the orchestrator as
 * `disabledTools` (not offered, refused if named) and to its executor's routing, so a call
 * never reaches a pack worker while the switch is off.
 */
export function desktopAiMaskingDisabledTools(source: DesktopAiMaskingSource): readonly string[] {
  return aiMaskingUnroutableTools({
    explicit: source.env[AI_MASKING_ENV_VAR],
    development: !source.packaged,
  });
}
