import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportDialog } from './ExportDialog.js';
import type { ExportProgressMessage, RendererBridge } from '../editor/bridge.js';

afterEach(() => {
  delete window.framepilot;
});

/** A save-as bridge stub that reports the user cancelling the dialog. */
const cancelledSaveAs: RendererBridge['exportSaveAs'] = vi.fn(async () => ({
  ok: false as const,
  error: 'cancelled',
}));

const DEFAULT_REQUEST_ID = 'req-1';

/**
 * Install a desktop bridge stubbing the async export triad
 * (`exportVideoStart`/`exportVideoCancel`/`onExportProgress`, H1.3b). Returns
 * `emit` to push a progress message to whatever listener the dialog
 * subscribed, and the `exportVideoStart`/`exportVideoCancel` spies.
 */
function installBridge(
  options: {
    requestId?: string | null;
    exportSaveAs?: RendererBridge['exportSaveAs'];
  } = {},
): {
  emit: (message: ExportProgressMessage) => void;
  exportVideoStart: RendererBridge['exportVideoStart'];
  exportVideoCancel: RendererBridge['exportVideoCancel'];
} {
  const requestId = options.requestId === undefined ? DEFAULT_REQUEST_ID : options.requestId;
  let listener: ((message: ExportProgressMessage) => void) | null = null;
  const exportVideoStart = vi.fn(async () => requestId as unknown as string);
  const exportVideoCancel = vi.fn();
  window.framepilot = {
    ping: vi.fn(),
    sidecarStatus: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(),
    saveProjectDefault: vi.fn(),
    projectsDir: vi.fn(),
    revealProject: vi.fn(),
    recentProjects: vi.fn(),
    exportVideo: vi.fn(),
    exportVideoStart,
    exportVideoCancel,
    onExportProgress: vi.fn((cb: (message: ExportProgressMessage) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    exportSaveAs: options.exportSaveAs ?? cancelledSaveAs,
    aiChat: vi.fn(),
    aiPlan: vi.fn(),
    aiEdit: vi.fn(),
  } as unknown as RendererBridge;
  return {
    emit: (message) => listener?.(message),
    exportVideoStart,
    exportVideoCancel,
  };
}

/** Open the export dropdown — the trigger button's accessible name is "Export
 *  video" (`aria-label`), distinct from the popover's inner "Export" submit
 *  button, so this never collides with `getByRole('button', { name: 'Export' })`. */
function openExportMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Export video' }));
}

describe('ExportDialog', () => {
  it('shows the trigger but keeps the popover closed until clicked', () => {
    render(<ExportDialog assets={[]} ensureSaved={vi.fn()} onReveal={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Export video' })).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'Export video' })).toBeNull();
    openExportMenu();
    expect(screen.getByRole('dialog', { name: 'Export video' })).toBeDefined();
  });

  it('closes the popover on Escape', () => {
    render(<ExportDialog assets={[]} ensureSaved={vi.fn()} onReveal={vi.fn()} />);
    openExportMenu();
    expect(screen.getByRole('dialog', { name: 'Export video' })).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Export video' })).toBeNull();
  });

  it('shows a desktop-only note and disables Export in the browser', () => {
    render(<ExportDialog assets={[]} ensureSaved={vi.fn()} onReveal={vi.fn()} />);
    openExportMenu();
    expect(screen.getByRole('note').textContent).toContain('desktop app');
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('saves then starts the export with the chosen preset + burn-in, shows queued→running, prompts Save As, and reveals the output', async () => {
    const { emit, exportVideoStart } = installBridge();
    const ensureSaved = vi.fn(async () => '/p/project.fp.json');
    const onReveal = vi.fn();

    render(<ExportDialog assets={[]} ensureSaved={ensureSaved} onReveal={onReveal} />);
    openExportMenu();

    fireEvent.click(screen.getByRole('combobox', { name: 'Export preset' }));
    fireEvent.click(screen.getByRole('option', { name: 'Square (1:1)' }));
    fireEvent.click(screen.getByLabelText('Burn captions into the video'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(ensureSaved).toHaveBeenCalled());
    await waitFor(() => expect(exportVideoStart).toHaveBeenCalled());
    expect(exportVideoStart).toHaveBeenCalledWith({
      projectPath: '/p/project.fp.json',
      preset: 'square',
      burnCaptions: true,
      denoise: false,
      limiter: false,
    });

    emit({ requestId: DEFAULT_REQUEST_ID, status: 'queued' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Queued'));

    emit({ requestId: DEFAULT_REQUEST_ID, status: 'running' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Rendering'));

    emit({
      requestId: DEFAULT_REQUEST_ID,
      status: 'completed',
      result: { ok: true, outputPath: '/out/final.mp4', state: 'completed' },
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reveal in folder' })).toBeDefined(),
    );
    // The default (cancelled) Save As stub means the original sandboxed render
    // is still what "Reveal in folder" points at.
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in folder' }));
    expect(onReveal).toHaveBeenCalledWith('/out/final.mp4');
  });

  it('prompts Save As after export and reports the chosen destination', async () => {
    const exportSaveAs = vi.fn(async () => ({
      ok: true as const,
      path: '/Users/me/Downloads/proj123.mp4',
    }));
    const { emit } = installBridge({ exportSaveAs });
    const onReveal = vi.fn();

    render(
      <ExportDialog
        assets={[]}
        ensureSaved={async () => '/p/project.fp.json'}
        onReveal={onReveal}
      />,
    );
    openExportMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    emit({
      requestId: DEFAULT_REQUEST_ID,
      status: 'completed',
      result: { ok: true, outputPath: '/sandbox/exports/proj123.mp4', state: 'completed' },
    });

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('/Users/me/Downloads/proj123.mp4'),
    );
    expect(exportSaveAs).toHaveBeenCalledWith({
      sourcePath: '/sandbox/exports/proj123.mp4',
      suggestedName: 'proj123.mp4',
    });
    // Once saved, "Save As…" (retry) is gone and reveal points at the saved copy.
    expect(screen.queryByRole('button', { name: 'Save As…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in folder' }));
    expect(onReveal).toHaveBeenCalledWith('/Users/me/Downloads/proj123.mp4');
  });

  it('offers a Save As retry when the user dismisses the initial dialog', async () => {
    const exportSaveAs = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'cancelled' })
      .mockResolvedValueOnce({ ok: true, path: '/Users/me/Movies/proj123.mp4' });
    const { emit } = installBridge({ exportSaveAs });

    render(
      <ExportDialog
        assets={[]}
        ensureSaved={async () => '/p/project.fp.json'}
        onReveal={vi.fn()}
      />,
    );
    openExportMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    emit({
      requestId: DEFAULT_REQUEST_ID,
      status: 'completed',
      result: { ok: true, outputPath: '/sandbox/exports/proj123.mp4', state: 'completed' },
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save As…' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('/Users/me/Movies/proj123.mp4'),
    );
    expect(exportSaveAs).toHaveBeenCalledTimes(2);
  });

  it('forwards the chosen master-audio options', async () => {
    const { exportVideoStart } = installBridge();
    render(
      <ExportDialog
        assets={[]}
        ensureSaved={async () => '/p/project.fp.json'}
        onReveal={vi.fn()}
      />,
    );
    openExportMenu();

    fireEvent.click(screen.getByRole('combobox', { name: 'Loudness preset' }));
    fireEvent.click(screen.getByRole('option', { name: 'Social (-14 LUFS)' }));
    fireEvent.click(screen.getByLabelText('Reduce background noise'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exportVideoStart).toHaveBeenCalled());
    expect(exportVideoStart).toHaveBeenCalledWith(
      expect.objectContaining({ loudness: 'social', denoise: true, limiter: false }),
    );
  });

  it('forwards the chosen EQ preset and compression toggle (plan H1.4)', async () => {
    const { exportVideoStart } = installBridge();
    render(
      <ExportDialog
        assets={[]}
        ensureSaved={async () => '/p/project.fp.json'}
        onReveal={vi.fn()}
      />,
    );
    openExportMenu();

    fireEvent.click(screen.getByRole('combobox', { name: 'EQ preset' }));
    fireEvent.click(screen.getByRole('option', { name: 'Voice clarity' }));
    fireEvent.click(screen.getByLabelText('Even out volume (voice compression)'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exportVideoStart).toHaveBeenCalled());
    expect(exportVideoStart).toHaveBeenCalledWith(
      expect.objectContaining({ eq: 'voice-clarity', compression: 'voice' }),
    );
  });

  it('reports when the project could not be saved before export', async () => {
    installBridge();
    const ensureSaved = vi.fn(async () => null);
    render(<ExportDialog assets={[]} ensureSaved={ensureSaved} onReveal={vi.fn()} />);
    openExportMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not save'));
  });

  it('surfaces a render failure from the engine', async () => {
    const { emit } = installBridge();
    const ensureSaved = vi.fn(async () => '/p/project.fp.json');
    render(<ExportDialog assets={[]} ensureSaved={ensureSaved} onReveal={vi.fn()} />);
    openExportMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    emit({
      requestId: DEFAULT_REQUEST_ID,
      status: 'failed',
      result: { ok: false, error: 'black frames detected' },
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('black frames detected'),
    );
  });

  it('shows a Cancel export button while queued/running and wires it to exportVideoCancel', async () => {
    const { emit, exportVideoCancel } = installBridge();
    render(
      <ExportDialog
        assets={[]}
        ensureSaved={async () => '/p/project.fp.json'}
        onReveal={vi.fn()}
      />,
    );
    openExportMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    emit({ requestId: DEFAULT_REQUEST_ID, status: 'queued' });
    const cancelButton = await screen.findByRole('button', { name: 'Cancel export' });
    fireEvent.click(cancelButton);

    expect(exportVideoCancel).toHaveBeenCalledWith(DEFAULT_REQUEST_ID);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Cancelling'));

    emit({
      requestId: DEFAULT_REQUEST_ID,
      status: 'cancelled',
      result: { ok: false, error: 'Export cancelled.' },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Export cancelled.'),
    );
  });

  it('stays open across a close/reopen and keeps in-progress state (never loses an export in flight)', async () => {
    const { emit } = installBridge();
    render(
      <ExportDialog
        assets={[]}
        ensureSaved={async () => '/p/project.fp.json'}
        onReveal={vi.fn()}
      />,
    );
    openExportMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    emit({ requestId: DEFAULT_REQUEST_ID, status: 'running' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Rendering'));

    // Close via the popover's header X (disambiguated from the footer's "Close"
    // button by its title — both share the accessible name "Close").
    fireEvent.click(screen.getByTitle('Close (Esc)'));
    expect(screen.queryByRole('dialog', { name: 'Export video' })).toBeNull();
    openExportMenu();

    expect(screen.getByRole('status').textContent).toContain('Rendering');
  });
});
