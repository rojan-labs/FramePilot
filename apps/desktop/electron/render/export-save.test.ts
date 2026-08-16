import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { saveExportAs } from './export-save.js';

describe('saveExportAs', () => {
  const projectsDir = (): string => mkdtempSync(join(tmpdir(), 'fp-export-save-'));

  it('copies the sandboxed render to the user-chosen destination', async () => {
    const dir = projectsDir();
    mkdirSync(join(dir, 'exports'));
    const source = join(dir, 'exports', 'proj.mp4');
    writeFileSync(source, 'fake-video-bytes');
    const dest = join(dir, 'chosen', 'saved.mp4');

    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: dest }));
    const copyFile = vi.fn(async (_src: string, _d: string) => undefined);

    const result = await saveExportAs(
      dir,
      source,
      'proj.mp4',
      showSaveDialog,
      copyFile as unknown as (s: string, d: string) => Promise<void>,
    );

    expect(result).toEqual({ ok: true, path: dest });
    expect(showSaveDialog).toHaveBeenCalledWith({
      title: 'Save exported video',
      defaultPath: 'proj.mp4',
    });
    expect(copyFile).toHaveBeenCalledWith(source, dest);
  });

  it('reports cancellation without touching the file system', async () => {
    const dir = projectsDir();
    mkdirSync(join(dir, 'exports'));
    const source = join(dir, 'exports', 'proj.mp4');
    writeFileSync(source, 'fake-video-bytes');

    const showSaveDialog = vi.fn(async () => ({ canceled: true }));
    const copyFile = vi.fn(async () => undefined);

    const result = await saveExportAs(dir, source, undefined, showSaveDialog, copyFile);

    expect(result).toEqual({ ok: false, error: 'cancelled' });
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('rejects a source path outside the projects sandbox before showing any dialog', async () => {
    const dir = projectsDir();
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: '/anywhere.mp4' }));
    const copyFile = vi.fn(async () => undefined);

    const result = await saveExportAs(dir, '/etc/passwd', undefined, showSaveDialog, copyFile);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('outside the FramePilot projects folder');
    }
    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('surfaces a copy failure as an error', async () => {
    const dir = projectsDir();
    mkdirSync(join(dir, 'exports'));
    const source = join(dir, 'exports', 'proj.mp4');
    writeFileSync(source, 'fake-video-bytes');

    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: '/no/such/dir/x.mp4' }));
    const copyFile = vi.fn(async () => {
      throw new Error('ENOENT: no such directory');
    });

    const result = await saveExportAs(dir, source, undefined, showSaveDialog, copyFile);

    expect(result).toEqual({ ok: false, error: 'ENOENT: no such directory' });
  });
});
