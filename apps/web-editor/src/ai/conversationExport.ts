/**
 * Conversation export (Phase 11 M7, ADR 0033).
 *
 * Serializes a conversation to Markdown (human-readable transcript) or JSON (the
 * exact persisted record). Pure; the drawer hands the string to the existing
 * download path. JSON export round-trips the stored shape so an exported
 * conversation can be re-imported byte-for-byte.
 */
import type { AiEvent } from '@framepilot/ai-sdk';
import type { Conversation } from './conversation.js';

/** Render one event as a Markdown line (or '' for non-transcript events). */
function eventMarkdown(event: AiEvent): string {
  switch (event.type) {
    case 'user_message':
      return `**You:** ${event.text}`;
    case 'assistant_message':
      return `**FramePilot:** ${event.text}`;
    case 'tool_call':
      return `- 🛠 ${event.title ?? event.toolName} (${event.status})`;
    case 'timeline_action':
      return `- ✏️ ${event.action}${event.detail ? ` — ${event.detail}` : ''}`;
    case 'diff':
      return `- 📝 Proposed edit: ${event.edit.text}`;
    case 'error':
      return `> ⚠️ ${event.message}`;
    default:
      return '';
  }
}

/** Export a conversation as a Markdown transcript. */
export function toMarkdown(conversation: Conversation): string {
  const lines = conversation.events.map(eventMarkdown).filter((line) => line.length > 0);
  return [`# ${conversation.title}`, '', ...lines, ''].join('\n');
}

/** Export a conversation as its exact JSON record (re-importable). */
export function toJson(conversation: Conversation): string {
  return JSON.stringify(conversation, null, 2);
}
