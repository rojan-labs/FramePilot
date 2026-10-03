/**
 * The credentials a visual-index request carries, read from Settings → AI.
 *
 * One function for every caller that indexes footage: the app (`main.ts`), the headless
 * agent-run harness and the harness's project importer. It used to be a closure in
 * `main.ts` with a hand copy in the harness, and a third caller would have meant a third
 * copy of the provider-default table below, each free to drift from the others.
 */
import type { AiProviderName } from '@framepilot/shared-types';
import type { VisualIndexRequestInput } from '@framepilot/ai-sdk';
import type { VisualPackHandles } from '../capability-packs/visual-packs.js';
import type { AiConfigStore } from './ai-config.js';

export type VisualIndexCredentials = Pick<
  VisualIndexRequestInput,
  'nvidiaKeys' | 'twelveLabsKey' | 'captionProvider' | 'visualEmbedPack' | 'visualDescribePack'
>;

/** OpenAI-compatible base URLs for the providers that can caption scenes. */
const CAPTION_PROVIDER_BASE_URLS: Partial<Record<AiProviderName, string>> = {
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'vercel-gateway': 'https://ai-gateway.vercel.sh/v1',
  groq: 'https://api.groq.com/openai/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://127.0.0.1:11434/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

/**
 * Credentials for `/brain/visual/*`, from the stored AI configuration.
 *
 * @param aiConfig - Settings → AI.
 * @param packHandles - Installed local perception packs (ADR 0176); none in the harness.
 * @returns Only the credentials that are configured; an absent field means "not available".
 */
export function visualIndexCredentialsFor(
  aiConfig: AiConfigStore,
  packHandles: VisualPackHandles = {},
): VisualIndexCredentials {
  const providerName = aiConfig.visualCaptionProvider();
  const provider = aiConfig.resolveConfig(providerName);
  const baseUrl = provider.baseUrl ?? CAPTION_PROVIDER_BASE_URLS[providerName];
  // `claude-agent-sdk` lands in the no-key branch, and that is correct rather than a
  // gap: scene captioning runs in the Python sidecar, which authenticates with a key it
  // is handed. That provider has no key to hand over — its credential is an OS-keychain
  // login usable only by the `claude` binary in this process — so there is nothing to
  // forward and captioning stays off. Do NOT "fix" this by adding it to the `ollama`
  // exemption: that would send `apiKey: ''` and the sidecar would fail per media file.
  const captionProvider =
    providerName === 'mock' || (providerName !== 'ollama' && !provider.apiKey)
      ? undefined
      : {
          kind: providerName === 'anthropic' ? ('anthropic' as const) : ('openai' as const),
          model: provider.model ?? 'vision-model',
          apiKey: provider.apiKey ?? '',
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        };
  const nvidiaKeys = aiConfig.resolveEmbeddingsKeys();
  const twelveLabsKey = aiConfig.resolveTwelveLabsKey();
  return {
    ...(nvidiaKeys !== undefined ? { nvidiaKeys } : {}),
    ...(twelveLabsKey !== undefined ? { twelveLabsKey } : {}),
    ...(captionProvider !== undefined ? { captionProvider } : {}),
    ...packHandles,
  };
}
