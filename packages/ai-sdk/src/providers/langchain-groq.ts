import { ChatGroq } from '@langchain/groq';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { GROQ_BASE_URL, GROQ_DEFAULT_MODEL } from './provider-defaults.js';
import type { AiCompletionRequest } from './types.js';
import { OpenAiStyleProvider, baseOptions } from './langchain-provider-shared.js';

export class ConcreteLangChainGroqProvider extends OpenAiStyleProvider {
  public readonly name = 'groq' as const;
  public get modelId(): string {
    return this.config.model ?? GROQ_DEFAULT_MODEL;
  }
  protected buildModel(request: AiCompletionRequest, streaming: boolean): BaseChatModel {
    return new ChatGroq({
      ...baseOptions(this.modelId, this.config.apiKey, streaming),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      baseUrl: this.config.baseUrl ?? GROQ_BASE_URL,
    }) as unknown as BaseChatModel;
  }
}
