import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
