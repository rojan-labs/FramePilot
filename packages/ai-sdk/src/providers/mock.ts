/**
 * @framepilot/ai-sdk/providers/mock — deterministic offline provider.
 *
 * Implemented for real (no network): it returns a fixed, tool-call-shaped
 * response so tests and offline development are deterministic. It is the default
 * provider. Like every provider it returns tool calls, never a patch — the
 * orchestrator turns the calls into a validated patch (see providers/types.ts).
 *
 * Phase 11 M1 (ADR 0033): `stream()` yields the SAME deterministic content as
 * `complete()`, but as scripted `text-delta` chunks (word by word) followed by the
 * scripted tool call and a terminal `done`. This is the streaming sidebar's test
 * backbone — the whole UI works offline against it, reproducibly, and honors an
 * `AbortSignal` between chunks.
 */
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ToolCall,
} from './types.js';

/** A stable tool call the mock proposes when editing tools are offered. */
const CANNED_TOOL_CALL: ToolCall = {
  id: 'call_mock_001',
  name: 'delete_range',
  arguments: { trackId: 'video_1', start: 0, end: 3.2 },
};

const CHAT_TEXT = 'Mock response: this is a deterministic offline answer.';
const EDIT_TEXT = 'Mock edit: trim 3.2s of dead air from the intro.';

/** Split text into chunks that re-join to exactly the original (spaces kept). */
const wordDeltas = (text: string): string[] => text.split(/(?<=\s)/);

export class MockProvider implements AiProvider {
  public readonly name = 'mock' as const;
  /** Fixed: the mock has no configuration, so its capacity is the mock provider floor. */
  public readonly modelId = 'mock';

  /** True when mutating tools are on offer (so the mock "edits" vs "chats"). */
  private offersEditing(request: AiCompletionRequest): boolean {
    return (request.tools ?? []).some((t) => t.name === CANNED_TOOL_CALL.name);
  }

  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    if (!this.offersEditing(request)) {
      return { text: CHAT_TEXT };
    }
    return { text: EDIT_TEXT, toolCalls: [CANNED_TOOL_CALL] };
  }

  public async *stream(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    const editing = this.offersEditing(request);
    const text = editing ? EDIT_TEXT : CHAT_TEXT;
    const chunks: ProviderChunk[] = wordDeltas(text).map((t) => ({ type: 'text-delta', text: t }));
    if (editing) chunks.push({ type: 'tool-call', call: CANNED_TOOL_CALL });
    chunks.push({ type: 'done', text });
    for (const chunk of chunks) {
      if (signal?.aborted) return;
      yield chunk;
    }
  }
}
