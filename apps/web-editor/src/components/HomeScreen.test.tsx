import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectListEntry, ProjectListRequest } from '@framepilot/shared-types';
import type { RendererBridge } from '../editor/bridge.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { HomeScreen } from './HomeScreen.js';

const SETTINGS_KEY = 'framepilot.settings';

function installDesktopRecents(count: number): void {
  const now = Date.now();
  window.framepilot = {
    recentProjects: vi.fn(async () =>
      Array.from({ length: count }, (_, index) => ({
        path: `/projects/project-${index + 1}.fp.json`,
        name: `Project ${index + 1}`,
        openedAt: now - index * 60_000,
      })),
    ),
  } as unknown as RendererBridge;
}

/**
 * A desktop that pages through `count` projects in the folder, the first `recentCount` of
 * them recently opened, the way main's `projectList` channel does.
 */
function installDesktopProjects(count: number, recentCount = 0) {
  const now = Date.now();
  const all: ProjectListEntry[] = Array.from({ length: count }, (_, index) => ({
    path: `/projects/project-${index + 1}.fp.json`,
    name: `Project ${index + 1}`,
    lastActiveAt: now - index * 60_000,
    recent: index < recentCount,
  }));
  const listProjects = vi.fn(async ({ offset, limit }: ProjectListRequest) => ({
    ok: true as const,
    entries: all.slice(offset, offset + limit),
    total: all.length,
  }));
  const recentProjects = vi.fn(async () => []);
  window.framepilot = { recentProjects, listProjects } as unknown as RendererBridge;
  return { listProjects, recentProjects };
}

function renderHome(props: Partial<Parameters<typeof HomeScreen>[0]> = {}): void {
  render(
    <SettingsProvider>
      <HomeScreen onNew={() => {}} onOpen={() => {}} onOpenRecent={() => {}} {...props} />
    </SettingsProvider>,
  );
}

afterEach(() => {
  delete window.framepilot;
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('HomeScreen', () => {
  it('keeps a long recent-project list available instead of truncating it to five', async () => {
    installDesktopRecents(12);
    renderHome();

    await screen.findByText('Project 12');
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByRole('button', { name: 'New Project' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open Project' })).toBeDefined();
  });

  it('uses one appearance control and toggles the persisted theme', async () => {
    installDesktopRecents(0);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'dark' }));
    renderHome();

    const toggles = screen.getAllByRole('button', { name: 'Toggle theme' });
    expect(toggles).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(toggles[0]!);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')).toMatchObject({
      theme: 'light',
    });
  });

  it('says why a project would not open, instead of doing nothing', async () => {
    // Main returns a typed reason — a newer schema version, a corrupt file, a missing
    // migration — and the renderer used to log it and return, so clicking a recent
    // project produced no visible result at all and there was no way to tell "nothing
    // happened" from "something is wrong with that file".
    installDesktopRecents(1);
    const onDismiss = vi.fn();
    renderHome({
      openError: 'This project was written by a newer version of FramePilot.',
      onDismissOpenError: onDismiss,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('newer version of FramePilot');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('shows no failure notice when nothing failed', async () => {
    installDesktopRecents(1);
    renderHome();
    await screen.findByText('Project 1');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('HomeScreen project list (desktop)', () => {
  it('shows the first 10 projects in the folder, recent ones first', async () => {
    const { listProjects, recentProjects } = installDesktopProjects(23, 2);
    renderHome();

    await screen.findByText('Project 1');
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.queryByText('Project 11')).toBeNull();
    expect(screen.getByText('Showing 10 of 23')).toBeDefined();
    expect(listProjects).toHaveBeenCalledWith({ offset: 0, limit: 10 });
    expect(recentProjects).not.toHaveBeenCalled();
  });

  it('appends the next 10 on Load more and hides it once every project is shown', async () => {
    const { listProjects } = installDesktopProjects(23);
    renderHome();
    await screen.findByText('Project 10');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Project 20');
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getByText('Project 1')).toBeDefined();
    expect(screen.getByText('Showing 20 of 23')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Project 23');
    expect(screen.getAllByRole('listitem')).toHaveLength(23);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(listProjects.mock.calls.map(([request]) => request)).toEqual([
      { offset: 0, limit: 10 },
      { offset: 10, limit: 10 },
      { offset: 20, limit: 10 },
    ]);
  });

  it('offers no Load more when every project fits on the first page', async () => {
    installDesktopProjects(4);
    renderHome();
    await screen.findByText('Project 4');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('opens a listed project the same way as a recent one', async () => {
    installDesktopProjects(12);
    const onOpenRecent = vi.fn();
    renderHome({ onOpenRecent });

    fireEvent.click(await screen.findByRole('button', { name: /Project 3\b/ }));

    expect(onOpenRecent).toHaveBeenCalledWith('/projects/project-3.fp.json');
  });

  it('keeps the list and Load more when a later page fails', async () => {
    const { listProjects } = installDesktopProjects(23);
    renderHome();
    await screen.findByText('Project 10');
    listProjects.mockRejectedValueOnce(new Error('main went away'));

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Load more' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  it('falls back to recent projects when the desktop cannot list the folder yet', async () => {
    // A dev app still running an older preload has `recentProjects` but no `listProjects`.
    installDesktopRecents(3);
    renderHome();

    await screen.findByText('Project 3');
    expect(screen.getByRole('heading', { name: 'Recent projects' })).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('falls back to recent projects when listing the folder fails', async () => {
    installDesktopRecents(2);
    window.framepilot = {
      ...window.framepilot,
      listProjects: vi.fn(async () => {
        throw new Error('No handler registered for framepilot:project:list');
      }),
    } as unknown as RendererBridge;
    renderHome();

    await screen.findByText('Project 2');
    expect(screen.getByRole('heading', { name: 'Recent projects' })).toBeDefined();
  });

  it('keeps the browser list as it was', async () => {
    renderHome();
    expect(await screen.findByText('No recent projects yet.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Recent projects' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
