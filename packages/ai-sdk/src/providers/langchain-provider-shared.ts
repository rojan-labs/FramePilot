import type { BaseMessage } from '@langchain/core/messages';
import {
  LangChainChatProvider,
  SHARED_CHAT_OPTIONS,
  assertSingleRetryAuthority,
  toChatMessages,
} from './langchain-chat.js';
import type { AiCompletionRequest } from './types.js';

export function baseOptions(
  model: string,
  apiKey: string | undefined,
  streaming: boolean,
): {
  model: string;
  apiKey?: string;
  streaming: boolean;
  streamUsage: boolean;
  maxRetries: number;
} {
  const options = {
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    streaming,
    ...SHARED_CHAT_OPTIONS,
  };
  assertSingleRetryAuthority(options);
  return options;
}

export abstract class OpenAiStyleProvider extends LangChainChatProvider {
  protected buildMessages(request: AiCompletionRequest): BaseMessage[] {
    return toChatMessages(request);
  }
}
