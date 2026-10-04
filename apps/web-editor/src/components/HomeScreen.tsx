/**
 * HomeScreen — the full-viewport launch screen shown when no project is open.
 *
 * The launch surface stays deliberately quiet: brand + appearance control in the
 * header, two obvious project actions, then a bounded scrolling list of projects. On
 * desktop that list pages through every project in the projects folder (recently opened
 * first) with a "Load more" control; see {@link useHomeProjects}. Drawing it never parses
 * full project files.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@framepilot/ui';
import { isDesktop } from '../editor/bridge.js';
import { useSettings } from '../editor/useSettings.js';
import { useHomeProjects } from './useHomeProjects.js';
import { Tooltip } from './Tooltip.js';
import { Contrast, FileText, FolderOpen, Plus, X } from './icons.js';
import './HomeScreen.css';

export interface HomeScreenProps {
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onOpenRecent: (path: string) => void;
  /**
   * Why the last open attempt failed, if it did.
   *
   * A project can fail to open for reasons the user can act on — the file was written by
   * a newer FramePilot, it is corrupt, its media has moved — and the main process returns
   * a good typed error for each. The renderer used to log it and return, so clicking a
   * recent project did nothing at all, with no way to tell "nothing happened" from
   * "something is wrong with that file".
   */
  readonly openError?: string | null;
  /** Dismiss the failure notice — it must not outlive the attempt it describes. */
  readonly onDismissOpenError?: () => void;
}

function formatDate(ms: number): string {
  const date = new Date(ms);
  const now = Date.now();
  const diffDays = Math.floor((now - ms) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function HomeScreen({
  onNew,
  onOpen,
  onOpenRecent,
  openError,
  onDismissOpenError,
}: HomeScreenProps): JSX.Element {
  const desktop = isDesktop();
  const projects = useHomeProjects(desktop);
  const listsAllProjects = projects.source === 'all';
  const { settings, update: updateSettings } = useSettings();
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

  return (
    <div className="launch-screen">
      <header className="launch-header">
        <div className="launch-brand" aria-label="FramePilot">
          <img className="launch-logo" src="/logo.png" alt="" width={28} height={28} />
          <span className="launch-brand-name">FramePilot</span>
          <span className="launch-brand-description">Professional AI-powered video editor</span>
        </div>

        <Tooltip
          label={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          placement="bottom"
        >
          <Button
            variant="ghost"
            className="launch-theme-toggle"
            type="button"
            aria-label="Toggle theme"
            onClick={toggleTheme}
          >
            <Contrast size={18} aria-hidden="true" />
          </Button>
        </Tooltip>
      </header>

      <main className="launch-main">
        {openError != null && openError !== '' && (
          // `alert`, not a toast: this is the answer to a click the user just made, and a
          // notice that disappears on its own is how "the button does nothing" happened
          // in the first place.
          <div className="launch-open-error" role="alert">
            <span className="launch-open-error-text">{openError}</span>
            {onDismissOpenError !== undefined && (
              <Button
                variant="ghost"
                type="button"
                aria-label="Dismiss"
                onClick={onDismissOpenError}
              >
                <X size={16} aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
        <section className="launch-actions" aria-label="Project actions">
          <button
            type="button"
            className="launch-action-card launch-action-card--primary"
            aria-label="New Project"
            onClick={onNew}
          >
            <span className="launch-action-icon" aria-hidden="true">
              <Plus size={22} />
            </span>
            <span className="launch-action-title">New Project</span>
            <span className="launch-action-description">Create a new project</span>
          </button>

          <button
            type="button"
            className="launch-action-card"
            aria-label="Open Project"
            onClick={desktop ? onOpen : undefined}
            disabled={!desktop}
            title={desktop ? undefined : 'Only available in the desktop app'}
          >
            <span className="launch-action-icon" aria-hidden="true">
              <FolderOpen size={22} />
            </span>
            <span className="launch-action-title">Open Project</span>
            <span className="launch-action-description">Open an existing project</span>
          </button>
        </section>

        <section className="launch-recents" aria-labelledby="launch-recents-heading">
          <h2 id="launch-recents-heading">{listsAllProjects ? 'Projects' : 'Recent projects'}</h2>

          <div className="launch-recent-scroll">
            {projects.entries.length > 0 ? (
              <ul className="launch-recent-list">
                {projects.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="launch-recent-item"
                      onClick={() => onOpenRecent(entry.path)}
                      title={entry.path}
                    >
                      <FileText className="launch-recent-icon" size={16} aria-hidden="true" />
                      <span className="launch-recent-copy">
                        <span className="launch-recent-name">{entry.name}</span>
                        <span className="launch-recent-path">{entry.path}</span>
                      </span>
                      {entry.date > 0 && (
                        <span
                          className="launch-recent-date"
                          title={entry.recent ? 'Last opened' : 'Last changed'}
                        >
                          {formatDate(entry.date)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="launch-empty">
                {listsAllProjects ? 'No projects yet.' : 'No recent projects yet.'}
              </p>
            )}
          </div>

          {projects.hasMore && projects.total !== null && (
            <div className="launch-recent-footer">
              <span className="launch-recent-count">
                Showing {projects.entries.length} of {projects.total}
              </span>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                loading={projects.loadingMore}
                onClick={projects.loadMore}
              >
                Load more
              </Button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
