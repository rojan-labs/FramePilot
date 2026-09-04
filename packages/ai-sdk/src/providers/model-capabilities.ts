/**
 * @framepilot/ai-sdk/providers/model-capabilities — how much room a model actually has.
 *
 * ## Why this exists
 *
 * Context occupancy used to be reported against one hardcoded constant
 * (`DEFAULT_CONTEXT_BUDGET.contextWindow`, 190_000) no matter which provider or model
 * the host had selected. That number is wrong in both directions: a Claude Opus 4.8 run
 * has 1M tokens of room and was shown as 17K/190K, while a local `llama3.2` run has 128K
 * and was shown the same 190K — so the meter under-reported pressure on the small model
 * and over-reported it on the large one. Switching models changed nothing on screen,
 * which is exactly the "the number is meaningless" complaint.
 *
 * ## Where the numbers come from
 *
 * The bulk of the table is generated from the vendored models.dev catalog
 * (`model-capabilities/models.json` → {@link MODEL_CATALOG}), so a new frontier model is
 * a catalog refresh rather than a hand-edit, and ~275 models are covered instead of the
 * two dozen anyone remembered to type out. {@link LOCAL_MODEL_CAPABILITIES} adds only the
 * ids the catalog does not carry — Ollama's short local names and a couple of hosted
 * aliases — and never shadows a catalog entry.
 *
 * ## The four rules
 *
 * 1. **Never invent a number for a model we do not know.** An unrecognised id falls back
 *    to the provider's conservative floor and says so via {@link ModelCapabilities.source},
 *    so the UI can label the capacity "assumed" instead of presenting a guess as fact.
 * 2. **Match on the model, not on the deployment.** Ids arrive prefixed (`zhipuai/glm-5v-turbo`,
 *    `meta/llama-3.3-70b-instruct`) or bare (`glm-5v-turbo`) depending on whether the host
 *    is talking to OpenRouter, NVIDIA, Ollama, or a first-party API — but it is the same
 *    model with the same window either way. The vendor prefix is therefore dropped before
 *    matching, which is what makes both forms resolve. This is only sound because catalog
 *    basenames are unique; the generator fails the build if two vendors ever collide.
 * 3. **A reservation must leave room for a prompt.** Several catalog entries report an
 *    output ceiling equal to the whole window (`mistral-large-latest`, 262144/262144).
 *    Taken literally the prompt budget would collapse to zero, so the reservation is
 *    clamped — see {@link clampOutputReservation}.
 * 4. **Pure and dependency-free.** No network lookup (Anthropic's `/v1/models` reports
 *    `max_input_tokens` live, but a prompt-assembly path must not block on HTTP, and a
 *    desktop run must work offline). The table is the cache; drift costs an inaccurate
 *    meter, never a wrong edit.
 */
import { createLogger } from '@framepilot/shared-types';
import { MODEL_CATALOG } from './model-catalog.generated.js';
import type { ProviderName } from './types.js';

const log = createLogger('ai-sdk:model-capabilities');

/** Where a capacity figure came from — the UI labels an assumed capacity honestly. */
export type CapabilitySource = 'known_model' | 'provider_default';

export interface ModelCapabilities {
  /** Total tokens the model accepts as input for one request. */
  readonly contextWindow: number;
  /**
   * Tokens reserved for the model's reply. Subtracted from the window before the prompt
   * budget, and surfaced separately in the UI so "available capacity" is honest — the
   * room a prompt may occupy is never the whole window.
   */
  readonly maxOutputTokens: number;
  readonly source: CapabilitySource;
}

/** Raw limits before the reservation is clamped and the source is decided. */
interface Limits {
  readonly contextWindow: number;
  /** `null` when the source does not document an output ceiling. */
  readonly maxOutputTokens: number | null;
}

/**
 * The floor used when a provider is unknown. Deliberately small: under-promising room
 * makes the budgeter trim early (safe, a shorter prompt), while over-promising makes it
 * overflow the provider (unsafe, a rejected request).
 */
const CONSERVATIVE_FALLBACK: ModelCapabilities = {
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
  source: 'provider_default',
};

/**
 * Models the generated catalog does not list, keyed the same way (unqualified, lowercase).
 *
 * These are the ids a host actually configures for locally served or aliased deployments:
 * Ollama's short tags (`llama3.2`, `qwen2.5-coder`), Groq's `-versatile` suffix, and the
 * NVIDIA NIM Llama 3.1 build. Windows follow each server's documented default. The
 * catalog wins on any id both know, so this table can only add coverage, never contradict.
 */
const LOCAL_MODEL_CAPABILITIES: Readonly<Record<string, Limits>> = Object.freeze({
  'llama3.1': { contextWindow: 131_072, maxOutputTokens: 4_096 },
  'llama3.2': { contextWindow: 131_072, maxOutputTokens: 4_096 },
  'llama-3.1-70b-instruct': { contextWindow: 128_000, maxOutputTokens: 4_096 },
  'llama-3.3-70b-versatile': { contextWindow: 131_072, maxOutputTokens: 32_768 },
  'qwen2.5-coder': { contextWindow: 32_768, maxOutputTokens: 8_192 },
  'mistral-large': { contextWindow: 131_072, maxOutputTokens: 8_192 },
});

/** Catalog first, local additions only where the catalog is silent (rule 2 above). */
const KNOWN_MODELS: Readonly<Record<string, Limits>> = Object.freeze({
  ...LOCAL_MODEL_CAPABILITIES,
  ...MODEL_CATALOG,
});

/** Precomputed once: prefix resolution walks every key on a miss. */
const KNOWN_MODEL_IDS: readonly string[] = Object.freeze(Object.keys(KNOWN_MODELS));

/**
 * Per-provider floor for an id the table does not know. Chosen as the smallest window
 * that provider realistically serves, for the same under-promise reason as
 * {@link CONSERVATIVE_FALLBACK}.
 */
const PROVIDER_DEFAULTS: Readonly<Record<ProviderName, ModelCapabilities>> = Object.freeze({
  anthropic: { contextWindow: 200_000, maxOutputTokens: 64_000, source: 'provider_default' },
  // Serves the same Claude models as `anthropic`, so the same floor. In practice this is
  // rarely reached: the default model is a full catalog id, which resolves exactly.
  'claude-agent-sdk': {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    source: 'provider_default',
  },
  nvidia: { contextWindow: 128_000, maxOutputTokens: 4_096, source: 'provider_default' },
  openrouter: { contextWindow: 128_000, maxOutputTokens: 8_192, source: 'provider_default' },
  // An aggregator like OpenRouter: the id names the real vendor, so a known slug resolves
  // from the catalog and only an unknown one lands here. Same floor, same reasoning.
  'vercel-gateway': {
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    source: 'provider_default',
  },
  groq: { contextWindow: 131_072, maxOutputTokens: 32_768, source: 'provider_default' },
  google: { contextWindow: 1_048_576, maxOutputTokens: 65_536, source: 'provider_default' },
  ollama: { contextWindow: 32_768, maxOutputTokens: 4_096, source: 'provider_default' },
  deepseek: { contextWindow: 128_000, maxOutputTokens: 8_192, source: 'provider_default' },
  // An arbitrary server serving an id the catalog does not know. Nothing is knowable
  // about its window, so this is the conservative floor — the same value and the same
  // reasoning as CONSERVATIVE_FALLBACK. A recognised model id still wins over it.
  'openai-compatible': {
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    source: 'provider_default',
  },
  // The mock provider backs tests and the no-key browser build. A large, round window
  // keeps fixtures readable and never trips the budgeter by accident.
  mock: { contextWindow: 200_000, maxOutputTokens: 8_192, source: 'provider_default' },
});

/**
 * The share of the window a reply may occupy once the documented ceiling has to be
 * overridden. Some catalog entries report a max output equal to the whole context window
 * (`mistral-large-latest`, 262144/262144) because both are the model's theoretical maxima,
 * not a split of one budget. Reserving all of it would leave the prompt zero tokens, so
 * those entries fall back to half — arbitrary, but it keeps at least as much room for the
 * conversation as for the reply. A documented ceiling that already fits is honoured as-is.
 */
const OVERSIZED_OUTPUT_SHARE_OF_WINDOW = 0.5;

/**
 * Reduce a provider-specific id to the form the tables are keyed by: lowercased, trimmed,
 * with the Ollama `:tag` suffix (and any OpenRouter `:free`/`:nitro` variant) dropped and
 * the `vendor/` prefix removed. Dropping the prefix is deliberate — see rule 2.
 */
function normalizeModelId(model: string): string {
  // `split` always yields at least one element, so index 0 / `.at(-1)` are never
  // undefined; the assertions state that rather than adding branches no input can reach.
  const withoutTag = model.trim().toLowerCase().split(':')[0]!;
  return withoutTag.split('/').at(-1)!.trim();
}

/**
 * Clamp a reply reservation so a prompt always has room, and substitute the provider's
 * floor when the source documented no ceiling at all (rule 3).
 */
function clampOutputReservation(limits: Limits, fallback: ModelCapabilities): number {
  const { contextWindow } = limits;
  const claimed = limits.maxOutputTokens ?? fallback.maxOutputTokens;
  if (claimed > 0 && claimed < contextWindow) return claimed;
  return Math.max(1, Math.floor(contextWindow * OVERSIZED_OUTPUT_SHARE_OF_WINDOW));
}

function resolved(limits: Limits, fallback: ModelCapabilities): ModelCapabilities {
  return {
    contextWindow: limits.contextWindow,
    maxOutputTokens: clampOutputReservation(limits, fallback),
    source: 'known_model',
  };
}

/**
 * The longest known id that `id` extends, so a dated or suffixed variant inherits its base
 * model: `claude-opus-4-8-20260101` → `claude-opus-4-8`. Longest wins so a variant of
 * `claude-opus-4-5` (200K) cannot borrow `claude-opus-4-8`'s 1M window through the shared
 * `claude-opus-4-` stem.
 */
function longestPrefixMatch(id: string): string | undefined {
  let best: string | undefined;
  for (const key of KNOWN_MODEL_IDS) {
    if (id.startsWith(key) && key.length > (best?.length ?? 0)) best = key;
  }
  return best;
}

/**
 * The capacity of one provider+model pair.
 *
 * Resolution order: exact model id → longest known prefix → the provider's floor →
 * {@link CONSERVATIVE_FALLBACK}. The id is matched without its `vendor/` prefix and
 * without any `:tag` suffix, so `zhipuai/glm-5v-turbo`, `glm-5v-turbo`, and
 * `glm-5v-turbo:free` all resolve to the same entry. Never throws, and never returns zero.
 *
 * @param provider - The configured provider, or `undefined` when the host has not
 *   resolved one yet (early startup, or a run assembled before dispatch).
 * @param model - The model id the provider will send, or `undefined` when unknown.
 * @returns The window, the output reservation, and whether the figure is model-specific.
 */
export function capabilitiesFor(
  provider: ProviderName | undefined,
  model: string | undefined,
): ModelCapabilities {
  const fallback = (provider ? PROVIDER_DEFAULTS[provider] : undefined) ?? CONSERVATIVE_FALLBACK;
  if (!model) return fallback;

  const id = normalizeModelId(model);
  if (!id) return fallback;

  // `hasOwn`, not a plain lookup: the table is an object literal, so an id like
  // `toString` or `constructor` would otherwise "match" an inherited prototype member.
  if (Object.hasOwn(KNOWN_MODELS, id)) return resolved(KNOWN_MODELS[id]!, fallback);

  const prefix = longestPrefixMatch(id);
  if (prefix) return resolved(KNOWN_MODELS[prefix]!, fallback);

  log.debug('unknown model id — using the provider floor', { provider, model: id });
  return fallback;
}

/**
 * Model families this SDK will send images to.
 *
 * ## WHY a list, and why it is conservative
 *
 * There is no reliable cross-provider way to ask "can this model see?". The generated
 * catalog tracks context windows, not modalities, and an OpenAI-compatible gateway
 * happily accepts an `image_url` part for a text-only model and then either errors or —
 * worse — silently answers about nothing. Sending a frame to a model that cannot read it
 * is the expensive failure: the image is billed as input tokens and the answer is a
 * confident hallucination about a picture the model never saw.
 *
 * So this is an allowlist matched as a prefix on the normalized id, and the default is
 * NO. A vision model missing from it loses a capability the user can still get by other
 * means; a text model wrongly included produces made-up descriptions of their footage.
 *
 * Matched against {@link normalizeModelId}'s output — vendor prefix and `:tag` suffix
 * already stripped — so `openai/gpt-4o-mini`, `gpt-4o-mini` and `gpt-4o-mini:free` all hit
 * the same entry.
 */
const VISION_MODEL_PREFIXES: readonly string[] = Object.freeze([
  // Anthropic — every Claude 3 and later reads images.
  'claude-3',
  'claude-4',
  'claude-5',
  'claude-haiku',
  'claude-sonnet',
  'claude-opus',
  'claude-fable',
  // Google Gemini — vision across the line.
  'gemini-',
  // OpenAI (direct, Azure, OpenRouter).
  'gpt-4o',
  'gpt-4.1',
  'gpt-4-turbo',
  'gpt-4-vision',
  'gpt-5',
  'o3',
  'o4-mini',
  // Open-weight multimodal families served by NVIDIA NIM / Groq / Ollama / OpenRouter.
  'llama-3.2-11b-vision',
  'llama-3.2-90b-vision',
  'llama-4',
  'llava',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'pixtral',
  'internvl',
  'phi-3.5-vision',
  'phi-4-multimodal',
]);

/**
 * Can this provider+model pair actually READ an image we attach to a message?
 *
 * Used to gate the frame-grab tool: a run driven by a text-only model must not be offered
 * a tool whose entire output is a picture. See {@link VISION_MODEL_PREFIXES} for why the
 * answer defaults to `false`.
 *
 * @param provider - The configured provider; `mock` is treated as sighted so tests and
 *   the no-key browser build can exercise the vision path deterministically.
 * @param model - The model id the provider will send.
 * @returns `true` only when the id matches a known multimodal family.
 */
export function supportsVision(
  provider: ProviderName | undefined,
  model: string | undefined,
): boolean {
  if (provider === 'mock') return true;
  // The model can see; the transport cannot carry a picture. The Claude Agent SDK takes a
  // string prompt, which has nowhere to put an image block, so every frame this SDK
  // attached would be dropped on the floor — and the model would then describe footage it
  // never saw, which is exactly the hallucination VISION_MODEL_PREFIXES exists to prevent.
  // Gating on the transport rather than the id is the whole point: `claude-opus-5` is a
  // sighted model reached through a blind pipe.
  if (provider === 'claude-agent-sdk') return false;
  const id = normalizeModelId(model ?? '');
  if (!id) return false;
  return VISION_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
}
