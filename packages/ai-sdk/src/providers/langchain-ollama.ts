import { ChatOllama } from '@langchain/ollama';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { OLLAMA_BASE_URL, OLLAMA_DEFAULT_MODEL } from './provider-defaults.js';
import type { AiCompletionRequest } from './types.js';
import { OpenAiStyleProvider, baseOptions } from './langchain-provider-shared.js';

export class ConcreteLangChainOllamaProvider extends OpenAiStyleProvider {
  public readonly name = 'ollama' as const;
  public get modelId(): string {
    return this.config.model ?? OLLAMA_DEFAULT_MODEL;
  }
  protected buildModel(request: AiCompletionRequest, streaming: boolean): BaseChatModel {
    const configured = this.config.baseUrl ?? OLLAMA_BASE_URL;
    return new ChatOllama({
      // `ChatOllama` has no `apiKey` option — Ollama itself is unauthenticated — so a
      // configured key travels as an explicit header instead of being dropped. Hosts do
      // put Ollama behind an authenticating reverse proxy, and the native adapter this
      // replaced (ADR 0105) sent `Authorization: Bearer` whenever a key was set; passing
      // `undefined` here silently removed that, leaving no way to reach such a server.
      ...baseOptions(this.modelId, undefined, streaming),
      ...(this.config.apiKey !== undefined
        ? { headers: { Authorization: `Bearer ${this.config.apiKey}` } }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      baseUrl: configured.replace(/\/v1\/?$/, ''),
    }) as unknown as BaseChatModel;
  }
}
