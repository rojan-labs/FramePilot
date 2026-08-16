/**
 * HomeScreen — the full-viewport launch screen shown when no project is open.
 *
 * The launch surface stays deliberately quiet: brand + appearance control in the
 * header, two obvious project actions, then a bounded scrolling list of recent
 * projects. Recents use metadata only, so drawing a long list never parses full
 * project files.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@framepilot/ui';
import type { RecentProject } from '../editor/bridge.js';
import { getBridge, isDesktop } from '../editor/bridge.js';
import { BROWSER_PATH_PREFIX, listBrowserProjectSummaries } from '../editor/persistence.js';
import { useSettings } from '../editor/useSettings.js';
import { Tooltip } from './Tooltip.js';
import { Contrast, FileText, FolderOpen, Plus } from './icons.js';
import './HomeScreen.css';

export interface HomeScreenProps {
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onOpenRecent: (path: string) => void;
}

interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

/**
 * Keep the launch list useful for people with many projects while bounding the
 * amount of DOM work. The list itself scrolls, so page layout never grows with it.
 */
const MAX_RECENTS = 100;

function formatDate(ms: number): string {
  const date = new Date(ms);
  const now = Date.now();
  const diffDays = Math.floor((now - ms) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function HomeScreen({ onNew, onOpen, onOpenRecent }: HomeScreenProps): JSX.Element {
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const desktop = isDesktop();
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

  useEffect(() => {
    if (desktop) {
      const bridge = getBridge();
      if (!bridge) return;
      bridge
        .recentProjects()
        .then((items: RecentProject[]) => {
          setRecents([...items].sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENTS));
        })
        .catch(() => {
          /* Recents are a convenience; project actions remain available on failure. */
        });
    } else {
      // Summaries only: no full project blob is parsed just to draw the launch list.
      setRecents(
        listBrowserProjectSummaries()
          .map(({ id, name, openedAt }) => ({
            path: `${BROWSER_PATH_PREFIX}${id}`,
            name,
            openedAt,
          }))
          .slice(0, MAX_RECENTS),
      );
    }
  }, [desktop]);

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
          <h2 id="launch-recents-heading">Recent projects</h2>

          <div className="launch-recent-scroll">
            {recents.length > 0 ? (
              <ul className="launch-recent-list">
                {recents.map((entry) => (
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
                      {entry.openedAt > 0 && (
                        <span className="launch-recent-date">{formatDate(entry.openedAt)}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="launch-empty">No recent projects yet.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
