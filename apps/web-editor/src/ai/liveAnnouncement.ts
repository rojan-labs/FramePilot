/**
 * The AI sidebar's screen-reader live region (D3a, plan/ORCHESTRATOR-GAP-CLOSURE.md).
 *
 * `AiSidebar`'s virtualized (and plain) message list used to carry `aria-live` on
 * the same element `@tanstack/react-virtual` mounts/unmounts rows on as the user
 * scrolls — a screen reader heard that scroll-driven row churn as if it were new
 * content. The fix moves live-region duty to a separate, visually-hidden element
 * outside the list, scoped to just the latest streamed assistant text. This module
 * is that derivation, pulled out as a pure function so it is unit-testable without
 * driving the sidebar's real frame-batched streaming pipeline.
 */
import type { ViewNode } from '@framepilot/ai-sdk';

/**
 * The text a screen reader should be told about right now.
 *
 * Mirrors the newest node's text only while it is still `streaming` — each delta
 * re-announces the growing line, which is the "streamed content" a live region is
 * for. Once the node settles (the final `assistant_message`), this returns `''`:
 * the reader has already heard the content incrementally, and continuing to hold
 * it would leave a second, permanent copy of text that is now visibly rendered in
 * the message bubble too. Any other latest node kind (tool/diff/notice/…) also
 * returns `''` — only assistant prose is announced here.
 */
export function latestStreamingAssistantText(nodes: readonly ViewNode[]): string {
  const latest = nodes[nodes.length - 1];
  return latest?.kind === 'assistant' && latest.streaming ? latest.text : '';
}
