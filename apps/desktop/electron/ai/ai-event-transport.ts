import type { AiEvent } from '@framepilot/ai-sdk';

/** Tool details remain useful in the UI, but must never become an unbounded IPC/WAL blob. */
export const MAX_TOOL_RESULT_TRANSPORT_CHARS = 256 * 1024;

/** Stop counting as soon as a JSON-like value crosses the transport budget. */
export function exceedsTransportBudget(value: unknown, maxChars: number): boolean {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  let chars = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      chars += current.length + 2;
    } else if (current === null || current === undefined) {
      chars += 4;
    } else if (typeof current !== 'object') {
      chars += String(current).length;
    } else if (!visited.has(current)) {
      visited.add(current);
      if (Array.isArray(current)) {
        chars += current.length;
        if (chars > maxChars) return true;
        for (const entry of current) pending.push(entry);
      } else {
        for (const [key, entry] of Object.entries(current)) {
          chars += key.length + 3;
          pending.push(entry);
        }
      }
    }
    if (chars > maxChars) return true;
  }
  return false;
}

/**
 * A tool result's pictures as they may cross the bridge: by file path only (EQ18).
 *
 * `runAiStream` moves the bytes to disk before an event gets here; this is the backstop
 * for any event that did not go through it (no image store configured, a store that
 * failed). A picture with no path is dropped rather than sent inline — a single frame is
 * tens of kilobytes, and it would otherwise ride the IPC channel, the durable run WAL and
 * the saved conversation, which is the growth this module exists to bound.
 */
function withoutImageBytes(event: AiEvent): AiEvent {
  if (event.type !== 'tool_result' || event.images === undefined) return event;
  if (event.images.every((image) => image.base64 === undefined)) return event;
  const byPath = event.images.flatMap((image) => {
    if (image.path === undefined) return [];
    const { base64: _bytes, ...rest } = image;
    return [rest];
  });
  const { images: _images, ...rest } = event;
  return byPath.length > 0 ? { ...rest, images: byPath } : rest;
}

/** Preserve lifecycle metadata while replacing only oversized expandable details. */
export function prepareAiEventForTransport(original: AiEvent): AiEvent {
  const event = withoutImageBytes(original);
  if (
    event.type !== 'tool_result' ||
    !exceedsTransportBudget(
      { input: event.input, result: event.result },
      MAX_TOOL_RESULT_TRANSPORT_CHARS,
    )
  ) {
    return event;
  }
  const { input: _input, result: _result, ...metadata } = event;
  return {
    ...metadata,
    result: {
      omitted: true,
      reason: 'Tool details exceeded the desktop transport limit; the summary is retained.',
    },
  };
}
