/**
 * @framepilot/ai-sdk/providers/provider-defaults — the default model and endpoint for
 * each provider.
 *
 * These are values, not behaviour, and every layer needs them: the provider factory, the
 * LangChain adapters, `model-capabilities.ts` sizing context occupancy before the first
 * call, and the desktop/browser settings UI showing a placeholder.
 *
 * They lived inside the native adapters (`groq.ts` exported `GROQ_DEFAULT_MODEL`, and so
 * on) until 2026-08-07, when the native adapters were deleted (ADR 0105). The LangChain
 * adapters had been importing their defaults *from the implementations they replaced* —
 * which is why deleting those files could not be a deletion alone. Constants that outlive
 * every implementation belong in a module of their own.
 *
 * **Changing a default here changes which model a user talks to.** It is not a cosmetic
 * edit: `model-capabilities.ts` derives the context window from the model id, so a default
 * that names a model with a different window silently changes how much history fits.
 */

/** Anthropic — the default agent model. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-8';

/** Groq — OpenAI-compatible endpoint and default model. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/** Google Gemini — REST root and default model. */
export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GOOGLE_DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Ollama — local server. The `/v1` suffix is the OpenAI-compatible surface; LangChain's
 * `ChatOllama` speaks Ollama's own API at the root and 404s on `/v1`, which is why
 * `langchain-providers.ts` strips it. Kept with the suffix because that is what a host
 * configures and what the settings UI shows.
 */
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

/** DeepSeek — OpenAI-compatible endpoint and default model. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

/** OpenRouter — OpenAI-compatible aggregator endpoint and default model. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** NVIDIA NIM — OpenAI-compatible endpoint and default model. */
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const NVIDIA_DEFAULT_MODEL = 'meta/llama-3.1-70b-instruct';

/**
 * Generic OpenAI-compatible server — **deliberately no base URL constant**.
 *
 * Every other entry here names a service whose endpoint we know. This provider is the
 * host's own server (vLLM, LM Studio, llama.cpp, LiteLLM, a local subscription proxy),
 * so there is no address to default to and inventing one would be worse than useless: a
 * silent fallback to somebody else's API is exactly the failure this provider exists to
 * prevent. `langchain-openai-compatible.ts` fails with an actionable error instead.
 *
 * The model default is a placeholder for the same reason — an arbitrary server serves
 * arbitrary ids. `gpt-4o-mini` is chosen only because it is the id most widely mirrored
 * by OpenAI-compatible gateways, and because `model-capabilities.ts` needs *some* id to
 * size context with before the first call. A host that serves anything else sets it.
 */
export const OPENAI_COMPATIBLE_DEFAULT_MODEL = 'gpt-4o-mini';
