/**
 * The slim application topbar (plan 3.4 Part 6; header redesign per H12-followup).
 *
 * Replaces the old bulky menu bar with one compact, three-zone row:
 *  - left: brand mark + **File** menu (New / Open / Save — folding the raw path
 *    input out of the chrome and into the menu where it belongs);
 *  - center: the click/F2-to-rename project title + a labelled save-status
 *    indicator (dot + word, never just the ambiguous dot alone);
 *  - right: Export (the header's one accent-filled control) + Shortcuts/Settings.
 * All project IO is owned by {@link App}; this is the presentation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset } from '@framepilot/timeline-schema';
import { Button } from '@framepilot/ui';
import { Menu, MenuItem } from './Menu.js';
import { Tooltip } from './Tooltip.js';
import { ExportDialog } from './ExportDialog.js';
import { useSettings } from '../editor/useSettings.js';
import {
  Captions,
  Contrast,
  FolderOpen,
  History,
  Map,
  Home,
  ICON_SIZE,
  Keyboard,
  Pencil,
  Plus,
  Save,
  Settings,
} from './icons.js';

const FEEDBACK_URL = 'https://github.com/rjach/FramePilot/issues/new';

/** Persistence state surfaced next to the project name. */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** Human-readable label shown beside the save-status dot. */
const SAVE_STATE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Unsaved',
  saving: 'Saving…',
  error: "Couldn't save",
};

export interface TopbarProps {
  readonly projectName: string;
  /** Current project location (empty = unsaved draft). */
  readonly path: string;
  /** Current persistence state, surfaced as a labelled dot. */
  readonly saveState: SaveState;
  /** The underlying error, shown in the status tooltip when saveState is 'error'. */
  readonly saveErrorDetail?: string | undefined;
  /** Navigate back to the Recent Projects (home) screen (H20). */
  readonly onHome?: () => void;
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onSave: () => void;
  /** Reveal the project (or projects folder) in the OS file manager. */
  readonly onReveal: () => void;
  /** Commit a new project name (click or F2 on the title to rename). */
  readonly onRename: (name: string) => void;
  /** Ensure the project is saved to disk before export; see {@link ExportDialog}. */
  readonly ensureSavedForExport: () => Promise<string | null>;
  /** Reveal an exported file in the OS file manager. */
  readonly onRevealExport: (path: string) => void;
  /** The project's media bin, for the export dialog's Credits list (schema v20). */
  readonly assets: readonly Asset[];
  /** The project's frame and length, for the export dialog's summary and size estimate. */
  readonly exportFrame: { readonly width: number; readonly height: number; readonly fps: number };
  readonly exportDurationSeconds: number;
  readonly projectId: string;
  /** Toggle the project history panel. */
  readonly onOpenHistory: () => void;
  /** Whether the history panel is currently open (drives the active state). */
  readonly historyOpen?: boolean;
  /** Toggle the footage-understanding panel (FI5.1). */
  readonly onOpenUnderstanding: () => void;
  /** Whether the understanding panel is currently open (drives the active state). */
  readonly understandingOpen?: boolean;
  /** Toggle the transcription panel — footage understanding's spoken counterpart. */
  readonly onOpenTranscription: () => void;
  /** Whether the transcription panel is currently open (drives the active state). */
  readonly transcriptionOpen?: boolean;
  readonly onOpenShortcuts: () => void;
  readonly onOpenSettings: () => void;
  /**
   * Receives the empty box in the middle of the bar, for the editor to portal
   * the monitor's Source/Program switch and view controls into.
   *
   * A callback ref rather than a rendered child because the owner of those
   * controls is `Editor`, a SIBLING of this component — the monitor tab state
   * they read lives there, and hoisting it into `App` just to render it here
   * would drag the whole monitor's state up two levels to win 29px of picture.
   * `null` on unmount so the portal tears down with the bar.
   */
  readonly onMonitorSlotRef?: (element: HTMLDivElement | null) => void;
}

export function Topbar({
  projectName,
  path,
  saveState,
  saveErrorDetail,
  onHome,
  onNew,
  onOpen,
  onSave,
  onReveal,
  onRename,
  ensureSavedForExport,
  onRevealExport,
  assets,
  exportFrame,
  exportDurationSeconds,
  projectId,
  onOpenHistory,
  historyOpen = false,
  onOpenUnderstanding,
  understandingOpen = false,
  onOpenTranscription,
  transcriptionOpen = false,
  onOpenShortcuts,
  onOpenSettings,
  onMonitorSlotRef,
}: TopbarProps): JSX.Element {
  const hasPath = path.trim() !== '';
  const { settings, update: updateSettings } = useSettings();
  // `settings.theme` can be 'system' — resolve it against the OS preference so
  // the toggle reflects (and flips) what is actually on screen, not just the
  // explicit 'light'/'dark' choice. A bare `!== 'light'` check here previously
  // treated 'system' as always-dark, so on a light-OS machine the toggle's
  // label/behavior silently disagreed with the real (light) rendered theme.
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
  );
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemPrefersDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const effectiveTheme: 'light' | 'dark' =
    settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme;
  const toggleTheme = useCallback(() => {
    updateSettings({ theme: effectiveTheme === 'dark' ? 'light' : 'dark' });
  }, [effectiveTheme, updateSettings]);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(projectName);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const startEditingTitle = useCallback(() => {
    setTitleDraft(projectName);
    setEditingTitle(true);
  }, [projectName]);

  useEffect(() => {
    if (!editingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editingTitle]);

  const commitTitle = useCallback(() => {
    const trimmed = titleDraft.trim();
    if (trimmed !== '' && trimmed !== projectName) onRename(trimmed);
    setEditingTitle(false);
  }, [titleDraft, projectName, onRename]);

  const saveStatusLabel = SAVE_STATE_LABEL[saveState];
  const saveStatusDetail =
    saveState === 'error' && saveErrorDetail ? saveErrorDetail : saveStatusLabel;

  return (
    <header className="topbar" aria-label="application bar">
      <span className="topbar-brand">
        <Menu
          label="File"
          trigger={
            <span className="topbar-logo" aria-hidden="true">
              <img className="topbar-logo-mark" src="/logo.png" alt="" />
            </span>
          }
          className="topbar-file"
        >
          {(close) => (
            <>
              {onHome && (
                <MenuItem
                  icon={<Home size={ICON_SIZE.sm} aria-hidden="true" />}
                  onSelect={() => {
                    onHome();
                    close();
                  }}
                >
                  Home
                </MenuItem>
              )}
              <MenuItem
                icon={<Plus size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  onNew();
                  close();
                }}
              >
                New project
              </MenuItem>

              <MenuItem
                icon={<FolderOpen size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  onOpen();
                  close();
                }}
              >
                Open…
              </MenuItem>
              <MenuItem
                icon={<Save size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  onSave();
                  close();
                }}
              >
                Save
              </MenuItem>
              <MenuItem
                icon={<FolderOpen size={ICON_SIZE.sm} aria-hidden="true" />}
                onSelect={() => {
                  onReveal();
                  close();
                }}
              >
                {hasPath ? 'Reveal in folder' : 'Open projects folder'}
              </MenuItem>
            </>
          )}
        </Menu>

        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="topbar-title topbar-title-input"
            aria-label="rename project"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitTitle();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="topbar-title"
            aria-label="project name"
            title="Rename project (F2)"
            onClick={startEditingTitle}
            onKeyDown={(event) => {
              if (event.key === 'F2' || event.key === 'Enter') {
                event.preventDefault();
                startEditingTitle();
              }
            }}
          >
            <span className="topbar-title-text">{projectName}</span>
            <Pencil className="topbar-title-edit-icon" size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        )}

        <Tooltip label={saveStatusDetail} placement="bottom">
          <span
            className={`topbar-status topbar-status--${saveState}`}
            aria-label="save state"
            title={saveStatusDetail}
            data-state={saveState}
            role="status"
          >
            <span className="topbar-status-dot" aria-hidden="true" />
          </span>
        </Tooltip>
      </span>

      {/* Filled by `Editor` through a portal; empty (and zero-height) in any
          render without a monitor, such as the Topbar's own tests. */}
      <div className="topbar-monitor" ref={onMonitorSlotRef ?? null} />

      {/* Every tooltip in the header opens DOWNWARD: the topbar sits flush against
          the window's top edge, so a default top-placed bubble is clipped (or
          overlaps the OS chrome) instead of pointing at its control. */}
      <div className="topbar-actions" role="group" aria-label="window">
        <Tooltip label="Footage understanding" placement="bottom">
          <Button
            variant="ghost"
            className={understandingOpen ? 'icon-btn is-active' : 'icon-btn'}
            type="button"
            aria-label="Footage understanding"
            aria-pressed={understandingOpen}
            onClick={onOpenUnderstanding}
          >
            <Map size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        </Tooltip>
        {/* Sits beside Footage understanding: the two answer the paired questions
            "what is in my footage" and "what is said in it". */}
        <Tooltip label="Transcription" placement="bottom">
          <Button
            variant="ghost"
            className={transcriptionOpen ? 'icon-btn is-active' : 'icon-btn'}
            type="button"
            aria-label="Transcription"
            aria-pressed={transcriptionOpen}
            onClick={onOpenTranscription}
          >
            <Captions size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip label="History" shortcut="⌘⇧H" placement="bottom">
          <Button
            variant="ghost"
            className={historyOpen ? 'icon-btn is-active' : 'icon-btn'}
            type="button"
            aria-label="History"
            aria-pressed={historyOpen}
            onClick={onOpenHistory}
          >
            <History size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip label="Keyboard shortcuts" shortcut="?" placement="bottom">
          <Button
            variant="ghost"
            className="icon-btn"
            type="button"
            aria-label="Keyboard shortcuts"
            onClick={onOpenShortcuts}
          >
            <Keyboard size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip label="Settings" shortcut="⌘," placement="bottom">
          <Button
            variant="ghost"
            className="icon-btn"
            type="button"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <Settings size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        </Tooltip>

        <span className="topbar-actions-divider" aria-hidden="true" />

        <Button
          variant="secondary"
          className="feedback-btn"
          type="button"
          onClick={() => window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer')}
        >
          Send feedback
        </Button>
        <ExportDialog
          ensureSaved={ensureSavedForExport}
          onReveal={onRevealExport}
          assets={assets}
          frame={exportFrame}
          durationSeconds={exportDurationSeconds}
          projectId={projectId}
        />
        <Tooltip
          label={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          placement="bottom"
        >
          <Button
            variant="ghost"
            className="icon-btn theme-toggle-btn"
            type="button"
            aria-label="Toggle theme"
            onClick={toggleTheme}
          >
            <Contrast size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
