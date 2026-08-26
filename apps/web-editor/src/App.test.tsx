/**
 * Tests for the top-level shell: the slim topbar (project name + File menu IO,
 * Shortcuts/Settings overlays) and that the editor workspace mounts for the
 * active project. Project IO is wired to the desktop bridge.
 *
 * Since App now starts at the HomeScreen (project = null), tests that need
 * the editor UI must first navigate through the HomeScreen via `navigateToEditor`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ExternalProjectChange, ExportProgressMessage } from './editor/bridge.js';
import { App } from './App.js';
import type { RendererBridge } from './editor/bridge.js';
import { demoProject } from './editor/demo.js';
import { listBrowserProjectSummaries, loadBrowserProject } from './editor/persistence.js';

const STORAGE_PREFIX = 'framepilot:project:';
const LAST_ID_KEY = 'framepilot:last-project-id';

afterEach(() => {
  delete window.framepilot;
  localStorage.clear();
});

/** Install a desktop bridge with overridable spies for the IO/render methods.
 * Returns the bridge plus `emitExportProgress` to drive the async export
 * progress channel (H1.3b) from whatever listener `ExportDialog` subscribed. */
function installBridge(overrides: Partial<RendererBridge> = {}): RendererBridge & {
  emitExportProgress: (message: ExportProgressMessage) => void;
} {
  let exportProgressListener: ((message: ExportProgressMessage) => void) | null = null;
  const bridge = {
    ping: vi.fn(async () => 'pong' as const),
    sidecarStatus: vi.fn(async () => ({ phase: 'stopped' as const, baseUrl: null, detail: null })),
    openProject: vi.fn(async () => ({ ok: false as const, error: 'no' })),
    openProjectDialog: vi.fn(async () => ({ ok: false as const, error: 'no' })),
    saveProject: vi.fn(async (path: string) => ({ ok: true as const, path })),
    saveProjectDefault: vi.fn(async () => ({ ok: true as const, path: '/projects/p.fp.json' })),
    projectsDir: vi.fn(async () => '/projects'),
    revealProject: vi.fn(async () => ({ ok: true as const })),
    recentProjects: vi.fn(async () => []),
    exportVideo: vi.fn(async () => ({
      ok: true as const,
      outputPath: '/out.mp4',
      state: 'completed',
    })),
    exportVideoStart: vi.fn(async () => 'req-1'),
    exportVideoCancel: vi.fn(),
    onExportProgress: vi.fn((listener: (message: ExportProgressMessage) => void) => {
      exportProgressListener = listener;
      return () => {
        exportProgressListener = null;
      };
    }),
    exportSaveAs: vi.fn(async () => ({ ok: false as const, error: 'cancelled' })),
    aiChat: vi.fn(async () => ({ ok: true as const, text: '' })),
    aiPlan: vi.fn(async () => ({ ok: true as const, text: '' })),
    aiEdit: vi.fn(async () => ({ ok: false as const, error: 'no' })),
    onProjectChanged: vi.fn(() => () => {}),
    ...overrides,
  } as RendererBridge;
  window.framepilot = bridge;
  return {
    ...bridge,
    emitExportProgress: (message) => exportProgressListener?.(message),
  };
}

/**
 * Navigate from the HomeScreen to the editor by creating a new project.
 * Must be called after `render(<App />)` when in desktop mode or when no
 * browser-persisted project exists.
 */
function navigateToEditor(name = 'Test Project'): void {
  fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
  const dialog = screen.getByRole('dialog', { name: 'New project' });
  fireEvent.change(within(dialog).getByPlaceholderText('My project'), {
    target: { value: name },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
}

/** Open the topbar File menu so its items (New/Open/Save + path) are mounted. */
const openFileMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'File' }));
};

describe('App shell', () => {
  it('renders the HomeScreen on first launch, then editor after creating a project', () => {
    installBridge();
    render(<App />);
    // HomeScreen is visible initially.
    expect(screen.getByRole('button', { name: 'New Project' })).toBeDefined();
    expect(screen.queryByLabelText('application bar')).toBeNull();

    navigateToEditor('Demo Project');

    // Now the full editor shell is shown.
    expect(screen.getByLabelText('application bar')).toBeDefined();
    expect(screen.getByLabelText('project name').textContent).toBe('Demo Project');
    expect(screen.getByLabelText('timeline')).toBeDefined();
    expect(screen.getByRole('region', { name: 'preview' })).toBeDefined();
  });

  it('creates a new project with a name from the File menu', () => {
    installBridge();
    render(<App />);
    navigateToEditor('Initial Project');

    openFileMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project' }));
    // Dialog appears — type a name and confirm.
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    fireEvent.change(within(dialog).getByPlaceholderText('My project'), {
      target: { value: 'My New Film' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(screen.getByLabelText('project name').textContent).toBe('My New Film');
  });

  it('renames the project inline from the header title', () => {
    installBridge();
    render(<App />);
    navigateToEditor('Original Name');

    fireEvent.click(screen.getByLabelText('project name'));
    const input = screen.getByLabelText('rename project');
    fireEvent.change(input, { target: { value: 'Renamed Project' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByLabelText('project name').textContent).toBe('Renamed Project');
  });

  it('does not crash when opening without the desktop bridge (browser mode)', async () => {
    // Browser mode — HomeScreen appears; navigate to editor first.
    render(<App />);
    // In browser mode with no localStorage, HomeScreen is shown too.
    navigateToEditor('Browser Project');

    openFileMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
    // No desktop bridge is installed, so the open fails gracefully — the editor
    // stays on the current project instead of crashing or losing state.
    await waitFor(() =>
      expect(screen.getByLabelText('project name').textContent).toBe('Browser Project'),
    );
  });

  it('opens a validated project through an injected desktop bridge', async () => {
    const openedProject = {
      id: 'project_opened',
      name: 'Opened Project',
      version: 1,
      fps: 30,
      resolution: { width: 1080, height: 1920 },
      assets: [],
      timeline: { tracks: [] },
      transcript: [],
      aiMemory: {},
      history: [],
    };
    installBridge({
      openProjectDialog: async () => ({
        ok: true as const,
        path: '/tmp/opened.fp.json',
        project: openedProject,
      }),
    });
    render(<App />);
    navigateToEditor();

    openFileMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
    await waitFor(() =>
      expect(screen.getByLabelText('project name').textContent).toBe('Opened Project'),
    );

    openFileMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByLabelText('save state').getAttribute('data-state')).toBe('saved'),
    );
  });

  it('reloads live when the project file is changed externally (e.g. an MCP agent)', async () => {
    let push: ((change: ExternalProjectChange) => void) | null = null;
    // Creation saves immediately, which is also how this test learns the id the
    // external change has to carry to count as the *same* project.
    let createdId: string | null = null;
    installBridge({
      saveProjectDefault: vi.fn(async (project: unknown) => {
        createdId = (project as { id: string }).id;
        return { ok: true as const, path: '/projects/p.fp.json' };
      }),
      onProjectChanged: vi.fn((listener) => {
        // The bridge already validates; the App receives a typed Project.
        push = listener as unknown as (change: ExternalProjectChange) => void;
        return () => {};
      }),
    });
    render(<App />);
    // Navigate to editor (push callback is already wired on mount).
    navigateToEditor('Current Project');
    await waitFor(() => expect(createdId).not.toBeNull());
    expect(screen.getByLabelText('project name').textContent).toBe('Current Project');
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }));
    expect(screen.getByRole('tab', { name: 'Captions' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    const external = {
      // Same open project: an agent step must reconcile it in place, not remount
      // the workspace and throw away the editor's active panel/stream state.
      id: createdId!,
      name: 'Reorganized by AI',
      version: 1,
      fps: 30,
      resolution: { width: 1080, height: 1920 },
      assets: [],
      timeline: { tracks: [] },
      transcript: [],
      aiMemory: {},
      history: [],
    } as unknown as ExternalProjectChange['project'];

    act(() => push!({ path: '/projects/demo.fp.json', project: external }));

    expect(screen.getByLabelText('project name').textContent).toBe('Reorganized by AI');
    expect(screen.getByRole('tab', { name: 'Captions' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('surfaces a save error from the bridge', async () => {
    installBridge({
      saveProject: async () => ({ ok: false as const, error: 'disk full' }),
      saveProjectDefault: async () => ({ ok: false as const, error: 'disk full' }),
    });
    render(<App />);
    navigateToEditor();

    openFileMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByLabelText('save state').getAttribute('data-state')).toBe('error'),
    );
    expect(screen.getByLabelText('save state').title).toContain('disk full');
  });

  it('shows the save-state chip (Saved once a freshly created project is written)', async () => {
    installBridge();
    render(<App />);
    navigateToEditor();
    await waitFor(() =>
      expect(screen.getByLabelText('save state').getAttribute('data-state')).toBe('saved'),
    );
  });

  it('persists a brand-new project immediately, so it appears in recents unedited', async () => {
    const bridge = installBridge();
    render(<App />);
    navigateToEditor('Untouched Project');

    // No import, no timeline edit: creating the project is enough to save it.
    await waitFor(() => expect(bridge.saveProjectDefault).toHaveBeenCalledTimes(1));
    const [saved] = (bridge.saveProjectDefault as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [{ name: string; id: string }];
    expect(saved.name).toBe('Untouched Project');
    expect(saved.id).toContain('project_untouched_project');
  });

  it('writes a brand-new project to localStorage in browser mode', async () => {
    render(<App />);
    navigateToEditor('Browser Project');

    await waitFor(() => expect(listBrowserProjectSummaries().length).toBe(1));
    const [summary] = listBrowserProjectSummaries();
    expect(summary!.name).toBe('Browser Project');
    expect(loadBrowserProject(summary!.id)?.name).toBe('Browser Project');
  });

  it('gives two projects created with the same name separate storage', async () => {
    render(<App />);
    navigateToEditor('Same Name');
    await waitFor(() => expect(listBrowserProjectSummaries().length).toBe(1));

    openFileMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    fireEvent.change(within(dialog).getByPlaceholderText('My project'), {
      target: { value: 'Same Name' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    // The second project must not overwrite the first one's file/blob.
    await waitFor(() => expect(listBrowserProjectSummaries().length).toBe(2));
  });

  it('File → Home returns to the Recent Projects screen (H20)', async () => {
    installBridge();
    render(<App />);
    navigateToEditor('Roundtrip');
    expect(screen.getByLabelText('application bar')).toBeDefined();
    openFileMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Home' }));
    await waitFor(() => expect(screen.queryByLabelText('application bar')).toBeNull());
    expect(screen.getByRole('button', { name: 'New Project' })).toBeDefined();
  });

  it('opens the keyboard help overlay with "?" and from the topbar, then closes it', () => {
    installBridge();
    render(<App />);
    navigateToEditor();

    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined();
  });

  it('reveals the projects folder from the File menu (no path yet)', async () => {
    const bridge = installBridge();
    render(<App />);
    navigateToEditor();

    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open projects folder' }));
    await waitFor(() => expect(bridge.revealProject).toHaveBeenCalledWith(''));
  });

  it('opens the export dialog from the topbar', () => {
    installBridge();
    render(<App />);
    navigateToEditor();

    expect(screen.queryByRole('dialog', { name: 'Export video' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export video' }));
    expect(screen.getByRole('dialog', { name: 'Export video' })).toBeDefined();
  });

  it('autosaves a path-less project a short while after an edit', async () => {
    vi.useFakeTimers();
    try {
      // Use browser mode (no bridge): pre-populate localStorage with the demo
      // project so App restores it directly into the editor (no HomeScreen step).
      // This avoids the desktop's HomeScreen firstRun complexity and lets us
      // make a single timeline edit to trigger the autosave path.
      localStorage.setItem(STORAGE_PREFIX + demoProject.id, JSON.stringify(demoProject));
      localStorage.setItem(LAST_ID_KEY, demoProject.id);

      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
      render(<App />);

      // Make a real, committed edit through the patch engine.
      fireEvent.click(screen.getByLabelText('clip clip_intro'));
      fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: 'Split' }));
      // The chip flips to "Unsaved", then autosave fires after the debounce.
      expect(screen.getByLabelText('save state').getAttribute('data-state')).toBe('dirty');
      await vi.advanceTimersByTimeAsync(2100);
      // In browser mode, autosave writes the project to localStorage.
      expect(setItemSpy).toHaveBeenCalledWith(
        expect.stringContaining('framepilot:project:'),
        expect.any(String),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports through the bridge after saving, and can reveal the output', async () => {
    const bridge = installBridge();
    render(<App />);
    navigateToEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Export video' }));
    const dialog = screen.getByRole('dialog', { name: 'Export video' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(bridge.exportVideoStart).toHaveBeenCalled());
    // Save-before-export wrote the project (path-less → default folder).
    expect(bridge.saveProjectDefault).toHaveBeenCalled();
    bridge.emitExportProgress({
      requestId: 'req-1',
      status: 'completed',
      result: { ok: true, outputPath: '/out.mp4', state: 'completed' },
    });
    await screen.findByRole('button', { name: 'Reveal in folder' });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in folder' }));
    await waitFor(() => expect(bridge.revealProject).toHaveBeenCalledWith('/out.mp4'));
  });

  it('opens the Settings dialog from the topbar and via ⌘,', () => {
    installBridge();
    render(<App />);
    navigateToEditor();

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeDefined();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();

    fireEvent.keyDown(document.body, { key: ',', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeDefined();
  });
});
