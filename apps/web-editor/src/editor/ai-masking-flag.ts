/**
 * RD2.1: the browser build's reading of the AI masking kill switch.
 *
 * The decision itself is `aiMaskingUnroutableTools` in `@framepilot/ai-sdk`
 * (`masking/feature-flag.ts`), shared with the desktop so the two hosts cannot disagree. This
 * module only reads Vite's baked environment, the way `preview/mask-tools-flag.ts` does:
 * `VITE_FRAMEPILOT_AI_MASKING` set to `on` or `off` wins; unset, a dev or test build is `on` and
 * a production build is `off` until RD3 flips the default.
 *
 * The result goes to the orchestrator as `disabledTools`, not to the sidecar executor, because
 * the browser often has no executor at all (no `VITE_FRAMEPILOT_PYTHON_API_URL`) and the switch
 * must hold there too.
 */
import { aiMaskingUnroutableTools } from '@framepilot/ai-sdk';

/** The subset of `import.meta.env` this decision reads; injectable for tests. */
export interface AiMaskingBuildEnv {
  readonly DEV?: boolean;
  readonly MODE?: string;
  readonly VITE_FRAMEPILOT_AI_MASKING?: string;
}

/**
 * The masking tools this build switches off: none when on, every tool the masking domain
 * registers when off.
 *
 * @param env - Build environment; defaults to Vite's `import.meta.env`.
 */
export function aiMaskingDisabledTools(
  // Read defensively, as `ai.ts` reads its other variables: outside Vite there is no env, and
  // an absent env is a release build (off), never a guess that it is on.
  env: AiMaskingBuildEnv = (import.meta as { env?: AiMaskingBuildEnv }).env ?? {},
): readonly string[] {
  return aiMaskingUnroutableTools({
    explicit: env.VITE_FRAMEPILOT_AI_MASKING,
    development: env.DEV === true || env.MODE === 'test',
  });
}
