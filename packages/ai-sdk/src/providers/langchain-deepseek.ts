import { ChatDeepSeek } from '@langchain/deepseek';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from './provider-defaults.js';
import type { AiCompletionRequest } from './types.js';
import { OpenAiStyleProvider, baseOptions } from './langchain-provider-shared.js';

export class ConcreteLangChainDeepSeekProvider extends OpenAiStyleProvider {
  public readonly name = 'deepseek' as const;
  public get modelId(): string {
    return this.config.model ?? DEEPSEEK_DEFAULT_MODEL;
  }
  protected buildModel(request: AiCompletionRequest, streaming: boolean): BaseChatModel {
    return new ChatDeepSeek({
      ...baseOptions(this.modelId, this.config.apiKey, streaming),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      configuration: { baseURL: this.config.baseUrl ?? DEEPSEEK_BASE_URL },
    }) as unknown as BaseChatModel;
  }
}
