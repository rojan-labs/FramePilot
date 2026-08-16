/**
 * The Cmd+K command palette (plan/AGENT-NATIVE-COMPLETION-PLAN.md P12.2, P13.3).
 *
 * One shared component serves two entry points: the global `⌘K` shortcut, and a
 * clip's "Ask AI about this clip" context-menu action (the point-react-refine
 * loop) which pre-selects the clip before opening this same palette. Both paths
 * funnel into the same `onSubmitScopedEdit`/`onOpenAiSidebar` callbacks the
 * caller wires to the AI sidebar's one real request-building path (`runTurn`) —
 * there is no parallel request path here, only UI.
 *
 * Style/interaction matches {@link ShortcutHelp}: the shared `.overlay-backdrop`,
 * Escape-to-close, outside-click-to-close. There is no existing arrow-key list
 * precedent in this codebase, so the small `activeIndex` state here is
 * self-contained rather than extracted into a generic hook (one consumer today).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SLASH_COMMANDS, type SlashCommand } from '../ai/composerActions.js';
import { ICON_SIZE, MessageSquare, Search, Send } from './icons.js';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Whether the editor currently has a live clip selection. */
  readonly hasSelection: boolean;
  /** e.g. "2 clips, 12.0–18.0s" — shown as a scoped-context hint above the input. */
  readonly selectionLabel?: string;
  /** Send a scoped edit prompt for the current selection. Only called when `hasSelection`. */
  readonly onSubmitScopedEdit: (text: string) => void;
  /** Open the AI sidebar (no selection to scope to, or the user asked for it explicitly). */
  readonly onOpenAiSidebar: () => void;
}

/** Case-insensitive substring match over a slash command's name + description. */
function matchesQuery(command: SlashCommand, query: string): boolean {
  if (query === '') return true;
  const haystack = `${command.name} ${command.description}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export function CommandPalette({
  open,
  onClose,
  hasSelection,
  selectionLabel,
  onSubmitScopedEdit,
  onOpenAiSidebar,
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on each open so a stale query/highlight never lingers across sessions.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const filteredCommands = useMemo(
    () => SLASH_COMMANDS.filter((command) => matchesQuery(command, query)),
    [query],
  );

  // The primary action (row 0) plus one row per filtered slash command.
  const rowCount = 1 + filteredCommands.length;

  const runPrimary = (): void => {
    if (hasSelection) onSubmitScopedEdit(query.trim());
    else onOpenAiSidebar();
    onClose();
  };

  const runCommand = (command: SlashCommand): void => {
    if (hasSelection) onSubmitScopedEdit(`/${command.name}`);
    else onOpenAiSidebar();
    onClose();
  };

  const runIndex = (index: number): void => {
    if (index === 0) runPrimary();
    else runCommand(filteredCommands[index - 1]!);
  };

  if (!open) return null;

  return (
    <div
      className="overlay-backdrop"
      role="presentation"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="command-palette-hint">
          {hasSelection ? (
            <span className="command-palette-scope">Selected: {selectionLabel}</span>
          ) : (
            <span className="command-palette-scope command-palette-scope--empty">
              Select a clip to scope your edit, or open the AI sidebar for a general request.
            </span>
          )}
        </div>

        <div className="command-palette-search">
          <Search size={ICON_SIZE.sm} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={
              hasSelection ? 'Describe the edit for the selected clip(s)…' : 'Search actions…'
            }
            aria-label="Command palette input"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((i) => (i + 1) % rowCount);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((i) => (i - 1 + rowCount) % rowCount);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runIndex(activeIndex);
              }
            }}
          />
        </div>

        <ul className="command-palette-list" role="listbox" aria-label="Command palette actions">
          <li role="presentation">
            <button
              type="button"
              role="option"
              aria-selected={activeIndex === 0}
              className={`command-palette-item${activeIndex === 0 ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={runPrimary}
            >
              {hasSelection ? (
                <>
                  <Send size={ICON_SIZE.sm} aria-hidden="true" />
                  <span>Send{query.trim() ? `: "${query.trim()}"` : ''}</span>
                </>
              ) : (
                <>
                  <MessageSquare size={ICON_SIZE.sm} aria-hidden="true" />
                  <span>Open AI sidebar</span>
                </>
              )}
            </button>
          </li>
          {filteredCommands.map((command, i) => {
            const index = i + 1;
            return (
              <li key={command.name} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={activeIndex === index}
                  className={`command-palette-item${activeIndex === index ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runCommand(command)}
                >
                  <span className="command-palette-item-name">/{command.name}</span>
                  <span className="command-palette-item-desc">{command.description}</span>
                </button>
              </li>
            );
          })}
          {filteredCommands.length === 0 && query.startsWith('/') && (
            <li className="command-palette-empty" role="presentation">
              No matching commands.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
