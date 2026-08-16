/**
 * In-memory conversation search (Phase 11 M7, ADR 0033).
 *
 * Builds a lightweight searchable text per conversation spanning titles, message
 * text, tool output, timeline-edit summaries, and asset/file names, then does a
 * substring match (Approval A6: in-house index first; fuzzy ranking stays optional).
 * Pure and deterministic; the drawer renders the returned snippet with the match
 * highlighted.
 */
import type { AiEvent } from '@framepilot/ai-sdk';
import type { Conversation } from './conversation.js';

/** Pull every searchable string out of one event. */
function eventText(event: AiEvent): string[] {
  switch (event.type) {
    case 'user_message':
    case 'assistant_message':
    case 'notification':
    case 'warning':
      return [event.text];
    case 'error':
      return [event.message, event.detail ?? ''];
    case 'reasoning':
      return [...event.summaries];
    case 'plan':
      return event.steps.map((s) => s.label);
    case 'tool_call':
      return [event.toolName, event.title ?? ''];
    case 'tool_result':
      return [event.summary ?? '', ...(event.files ?? []), ...(event.logs ?? [])];
    case 'timeline_action':
      return [event.action, event.detail, ...(event.refs ?? []).map((r) => r.label)];
    case 'reference':
      return event.refs.map((r) => r.label);
    case 'diff':
      return [event.edit.text];
    default:
      return [];
  }
}

/** The full searchable text for a conversation (title + every event's text). */
export function conversationText(conversation: Conversation): string {
  const parts = [conversation.title, ...conversation.events.flatMap(eventText)];
  return parts.join('\n');
}

/** A search hit: the conversation plus a short snippet around the first match. */
export interface SearchHit {
  readonly conversation: Conversation;
  readonly snippet: string;
}

/** Extract a snippet of `text` around the first occurrence of `needle` (lowercased). */
function snippetAround(text: string, needle: string, radius = 30): string {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * Search conversations by substring across all their text, most-recent-first.
 *
 * @param conversations - The conversations to search.
 * @param query - The search string (trimmed; empty returns everything, recency-sorted).
 * @returns Matching conversations with a snippet around the first hit.
 */
export function searchConversations(
  conversations: readonly Conversation[],
  query: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  const byRecency = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  if (needle.length === 0) {
    return byRecency.map((conversation) => ({ conversation, snippet: '' }));
  }
  const hits: SearchHit[] = [];
  for (const conversation of byRecency) {
    const text = conversationText(conversation);
    if (text.toLowerCase().includes(needle)) {
      hits.push({ conversation, snippet: snippetAround(text, needle) });
    }
  }
  return hits;
}
