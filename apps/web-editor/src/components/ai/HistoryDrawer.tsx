/**
 * Conversation history + search drawer (Phase 11 M7, ADR 0033).
 *
 * Lists conversations grouped Today/Yesterday/Previous 7/30/Older with per-row
 * actions (rename · duplicate · delete · pin · favorite · export). A single input
 * does **global search** across titles, messages, tool output, edit summaries, and
 * file names (`searchConversations`); when it's non-empty the grouped view collapses
 * to flat hits with a snippet. Reuses the conversation store actions (M2) — nothing
 * here mutates conversations directly.
 */
import { useEffect, useMemo, useState } from 'react';
import { type Conversation, groupByDate } from '../../ai/conversation.js';
import { searchConversations } from '../../ai/conversationSearch.js';
import { toJson, toMarkdown } from '../../ai/conversationExport.js';
import type { UseConversations } from '../../ai/useConversations.js';
import { Menu, MenuItem } from '../Menu.js';
import {
  Copy,
  Download,
  Flag,
  ICON_SIZE,
  MoreHorizontal,
  Pencil,
  Search,
  Star,
  Trash2,
  X,
} from '../icons.js';

/** First-letter badge for a conversation's mode (e.g. "Agent" -> "A"). */
function ModeBadge({ mode }: { mode: Conversation['mode'] }): JSX.Element {
  return (
    <span className="ai-mode-badge" title={mode} aria-label={mode}>
      {mode.charAt(0).toUpperCase()}
    </span>
  );
}

/** Copy `content` to the clipboard (no-op where the clipboard API is unavailable). */
async function copyText(content: string): Promise<void> {
  /* v8 ignore start -- browser-only clipboard glue, verified manually */
  await navigator.clipboard?.writeText(content);
  /* v8 ignore stop */
}

/** Trigger a client-side download of `content` as `filename` (no-op without a DOM). */
function downloadText(filename: string, content: string, type: string): void {
  /* v8 ignore start -- browser-only download glue, verified manually */
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  /* v8 ignore stop */
}

function Row({
  conversation,
  snippet,
  conversations,
  onSelect,
}: {
  conversation: Conversation;
  snippet?: string;
  conversations: UseConversations;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const commitRename = (): void => {
    const title = draft.trim();
    if (title.length > 0) conversations.rename(conversation.id, title);
    setRenaming(false);
  };
  return (
    <li className="ai-hist-row" data-pinned={conversation.pinned}>
      <button type="button" className="ai-hist-open" onClick={() => onSelect(conversation.id)}>
        {conversation.unread && <span className="ai-unread-dot" aria-label="Unread" />}
        {renaming ? (
          <input
            className="ai-hist-rename"
            aria-label="Rename conversation"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="ai-hist-title">{conversation.title}</span>
        )}
        <span className="ai-hist-meta">
          <ModeBadge mode={conversation.mode} />
          <span>{conversation.model}</span>
        </span>
        {snippet && <span className="ai-hist-snippet">{snippet}</span>}
      </button>
      <div className="ai-hist-actions">
        <Menu
          label="Row actions"
          className="ai-hist-menu"
          trigger={<MoreHorizontal size={ICON_SIZE.sm} aria-hidden="true" />}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Pencil size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  setDraft(conversation.title);
                  setRenaming(true);
                  close();
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={<Copy size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  conversations.duplicate(conversation.id);
                  close();
                }}
              >
                Duplicate
              </MenuItem>
              <MenuItem
                icon={<Flag size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  conversations.togglePinned(conversation.id);
                  close();
                }}
              >
                {conversation.pinned ? 'Unpin' : 'Pin'}
              </MenuItem>
              <MenuItem
                icon={<Star size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  conversations.toggleFavorite(conversation.id);
                  close();
                }}
              >
                {conversation.favorite ? 'Unfavorite' : 'Favorite'}
              </MenuItem>
              <MenuItem
                icon={<Download size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  downloadText(`${conversation.id}.md`, toMarkdown(conversation), 'text/markdown');
                  close();
                }}
              >
                Export Markdown
              </MenuItem>
              <MenuItem
                icon={<Copy size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  void copyText(toMarkdown(conversation));
                  close();
                }}
              >
                Copy Markdown
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  conversations.remove(conversation.id);
                  close();
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </li>
  );
}

export function HistoryDrawer({
  conversations,
  onSelect,
  onClose,
}: {
  conversations: UseConversations;
  /**
   * Open a conversation by id. Defaults to `conversations.open`, but the sidebar
   * passes a guarded handler that STOPS any in-flight run before switching, so a
   * live run is never orphaned in a conversation the user just navigated away from.
   */
  onSelect?: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const all = conversations.conversations;
  const hits = useMemo(() => searchConversations(all, query), [all, query]);
  const groups = useMemo(() => groupByDate(all), [all]);
  const searching = query.trim().length > 0;

  // Search reads message and tool text, which only conversations whose log is resident
  // can match — and the sidebar deliberately keeps only the working set in memory
  // (`MAX_LOADED_CONVERSATIONS`). Pull the rest in the moment the reviewer actually
  // searches, so browsing the list stays free and searching stays complete.
  const { loadAll } = conversations;
  useEffect(() => {
    if (searching) void loadAll();
  }, [searching, loadAll]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const select = (id: string): void => {
    (onSelect ?? conversations.open)(id);
    onClose();
  };

  return (
    <div className="ai-history" role="dialog" aria-label="Conversation history">
      <div className="ai-history-head">
        <div className="ai-history-search">
          <Search size={ICON_SIZE.sm} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search conversations"
            placeholder="Search conversations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="ai-icon-button"
          aria-label="Close history"
          onClick={onClose}
        >
          <X size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      </div>

      {all.length === 0 ? (
        <p className="ai-empty">No conversations yet.</p>
      ) : searching ? (
        <div className="ai-history-list">
          {hits.length === 0 ? (
            <p className="ai-empty">No matches for “{query}”.</p>
          ) : (
            <ul>
              {hits.map((hit) => (
                <Row
                  key={hit.conversation.id}
                  conversation={hit.conversation}
                  snippet={hit.snippet}
                  conversations={conversations}
                  onSelect={select}
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="ai-history-list">
          {groups.map((group) => (
            <section key={group.label}>
              <h3 className="ai-history-group">{group.label}</h3>
              <ul>
                {group.conversations.map((conversation) => (
                  <Row
                    key={conversation.id}
                    conversation={conversation}
                    conversations={conversations}
                    onSelect={select}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export { copyText, downloadText, toJson };
