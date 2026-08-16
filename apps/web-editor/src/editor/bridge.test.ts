import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type RendererBridge,
  exportVideo,
  getBridge,
  importAsset,
  importMedia,
  isDesktop,
  onProjectChanged,
  openProject,
  projectsDir,
  revealProject,
  saveProject,
} from './bridge.js';
import { newProject } from './project.js';

/**
 * A bridge whose methods are spies; only open/save are exercised here.
 *
 * FROZEN on purpose. Electron's `contextBridge.exposeInMainWorld` hands the renderer
 * a frozen object, and that difference is not cosmetic: a `Proxy`-based wrapper over
 * a frozen target throws a `TypeError` on first property read, which once blanked the
 * app window while every test here passed against a mutable fake. Keep this frozen so
 * the renderer-side wrapper is always exercised under the real constraint.
 */
function fakeBridge(overrides: Partial<RendererBridge> = {}): RendererBridge {
  return Object.freeze({
    ping: vi.fn(async () => 'pong' as const),
    licenseStatus: vi.fn(async () => ({
      status: 'valid' as const,
      licensed: true,
      expiresAt: null,
    })),
    licenseActivate: vi.fn(async () => ({
      status: 'valid' as const,
      licensed: true,
      expiresAt: null,
    })),
    licenseDeactivate: vi.fn(async () => ({
      status: 'needs_activation' as const,
      licensed: false,
      expiresAt: null,
    })),
    sidecarStatus: vi.fn(async () => ({ phase: 'stopped' as const, baseUrl: null, detail: null })),
    openProject: vi.fn(async () => ({ ok: false as const, error: 'not configured' })),
    openProjectDialog: vi.fn(async () => ({ ok: false as const, error: 'not configured' })),
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
    onExportProgress: vi.fn(() => () => {}),
    exportSaveAs: vi.fn(async () => ({ ok: false as const, error: 'cancelled' })),
    importMedia: vi.fn(async () => ({ ok: true as const, path: 'media/p/clip.mp4' })),
    importAsset: vi.fn(async () => ({
      ok: true as const,
      durationSeconds: 12,
      kind: 'video' as const,
      media: { peaks: [0.1], peaksPerSecond: 10, thumbnailPaths: ['media/p/t0.jpg'] },
    })),
    transcribe: vi.fn(async () => ({ ok: false as const, error: 'not configured' })),
    aiChat: vi.fn(async () => ({ ok: true as const, text: '' })),
    aiPlan: vi.fn(async () => ({ ok: true as const, text: '' })),
    aiEdit: vi.fn(async () => ({ ok: false as const, error: 'not configured' })),
    aiProviders: vi.fn(async () => [
      { name: 'mock' as const, label: 'Offline mock', model: 'mock', ready: true },
    ]),
    aiConfigGet: vi.fn(async () => ({
      activeProvider: 'mock' as const,
      providers: [{ name: 'mock' as const, label: 'Offline mock', model: 'mock', ready: true }],
    })),
    aiConfigSet: vi.fn(async () => ({
      activeProvider: 'mock' as const,
      providers: [{ name: 'mock' as const, label: 'Offline mock', model: 'mock', ready: true }],
    })),
    onProjectChanged: vi.fn(() => () => {}),
    conversationsList: vi.fn(async () => []),
    conversationsLoad: vi.fn(async () => null),
    conversationsSave: vi.fn(async () => ({ ok: true as const })),
    conversationsDelete: vi.fn(async () => ({ ok: true as const })),
    aiStreamStart: vi.fn(async () => 'req_1'),
    aiStreamAbort: vi.fn(() => {}),
    aiStreamAnswer: vi.fn(() => {}),
    onAiStreamEvent: vi.fn(() => () => {}),
    ...overrides,
  });
}

afterEach(() => {
  delete window.framepilot;
});

describe('getBridge / isDesktop', () => {
  it('returns null and reports non-desktop when no bridge is present', () => {
    expect(getBridge()).toBeNull();
    expect(isDesktop()).toBe(false);
  });

  it('wraps the injected window bridge in one stable project-aware view', () => {
    const bridge = fakeBridge();
    window.framepilot = bridge;

    const wrapped = getBridge();
    expect(wrapped).not.toBeNull();
    expect(isDesktop()).toBe(true);
    // The wrapper only intercepts the patch-delta transport methods; it must be
    // memoized per raw bridge so listeners/effects keyed on it stay stable.
    expect(getBridge()).toBe(wrapped);
    // Everything else reflects straight through to the injected bridge.
    expect(wrapped!.ping).toBe(bridge.ping);
    expect(wrapped!.importMedia).toBe(bridge.importMedia);
  });

  it('reads and calls every wrapped method over a frozen preload bridge', () => {
    // The regression this pins: a Proxy-based wrapper satisfies the assertions
    // above but throws `TypeError: 'get' on proxy: property ... is a read-only and
    // non-configurable data property` the instant anything reads an overridden
    // method off the real (frozen) contextBridge object — blanking the window at
    // mount. Reading and invoking each override here fails loudly if that returns.
    const bridge = fakeBridge();
    expect(Object.isFrozen(bridge)).toBe(true);
    window.framepilot = bridge;

    const wrapped = getBridge()!;
    expect(() => {
      for (const key of ['openProject', 'openProjectDialog', 'saveProject', 'saveProjectDefault', 'aiStreamStart', 'onProjectChanged'] as const) {
        expect(typeof wrapped[key]).toBe('function');
      }
    }).not.toThrow();

    // Overridden methods must still reach the host.
    void wrapped.saveProject('/projects/p.fp.json', newProject('Frozen'), 1);
    expect(bridge.saveProject).toHaveBeenCalled();
    const unsubscribe = wrapped.onProjectChanged(() => {});
    expect(bridge.onProjectChanged).toHaveBeenCalled();
    expect(typeof unsubscribe).toBe('function');
  });
});

describe('onProjectChanged', () => {
  it('is a no-op (returning a no-op) without a bridge', () => {
    const unsubscribe = onProjectChanged(() => {}, null);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('delivers a validated external change and forwards the unsubscribe', () => {
    let captured: ((event: { path: string; project: unknown }) => void) | null = null;
    const unsub = vi.fn();
    const bridge = fakeBridge({
      onProjectChanged: vi.fn((listener) => {
        captured = listener;
        return unsub;
      }),
    });
    const seen: { path: string; name: string }[] = [];

    const returned = onProjectChanged((change) => {
      seen.push({ path: change.path, name: change.project.name });
    }, bridge);

    expect(captured).not.toBeNull();
    captured!({ path: '/projects/p.fp.json', project: newProject('Edited by agent') });
    expect(seen).toEqual([{ path: '/projects/p.fp.json', name: 'Edited by agent' }]);

    returned();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('drops an external write that fails schema validation', () => {
    let captured: ((event: { path: string; project: unknown }) => void) | null = null;
    const bridge = fakeBridge({
      onProjectChanged: vi.fn((listener) => {
        captured = listener;
        return () => {};
      }),
    });
    const callback = vi.fn();

    onProjectChanged(callback, bridge);
    captured!({ path: '/projects/p.fp.json', project: { not: 'a project' } });

    expect(callback).not.toHaveBeenCalled();
  });
});

describe('openProject', () => {
  it('fails gracefully when no bridge is available', async () => {
    const result = await openProject('/p.fp.json', null);
    expect(result).toEqual({
      ok: false,
      error: 'Desktop bridge unavailable (running outside Electron).',
    });
  });

  it('propagates a bridge-level open error', async () => {
    const bridge = fakeBridge({
      openProject: vi.fn(async () => ({ ok: false as const, error: 'ENOENT' })),
    });
    expect(await openProject('/missing.fp.json', bridge)).toEqual({ ok: false, error: 'ENOENT' });
  });

  it('rejects a file that does not pass schema validation', async () => {
    const bridge = fakeBridge({
      openProject: vi.fn(async () => ({ ok: true as const, path: '/p', project: { nope: true } })),
    });
    const result = await openProject('/p', bridge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('failed validation');
    }
  });

  it('returns a validated project on success', async () => {
    const project = JSON.parse(JSON.stringify(newProject('Demo')));
    const bridge = fakeBridge({
      openProject: vi.fn(async () => ({ ok: true as const, path: '/demo.fp.json', project })),
    });
    const result = await openProject('/demo.fp.json', bridge);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.name).toBe('Demo');
      expect(result.path).toBe('/demo.fp.json');
    }
  });

  it('defaults to the window bridge when none is injected', async () => {
    const project = JSON.parse(JSON.stringify(newProject('FromWindow')));
    window.framepilot = fakeBridge({
      openProject: vi.fn(async () => ({ ok: true as const, path: '/w', project })),
    });
    const result = await openProject('/w');
    expect(result.ok).toBe(true);
  });
});

describe('saveProject', () => {
  it('fails gracefully when no bridge is available', async () => {
    const result = await saveProject('/p.fp.json', newProject('X'), null);
    expect(result.ok).toBe(false);
  });

  it('delegates to the bridge and returns its result', async () => {
    const save = vi.fn(async (path: string) => ({ ok: true as const, path }));
    const bridge = fakeBridge({ saveProject: save });
    const project = newProject('Y');
    const result = await saveProject('/y.fp.json', project, bridge);
    expect(result).toEqual({ ok: true, path: '/y.fp.json' });
    expect(save).toHaveBeenCalledWith('/y.fp.json', project, undefined);
  });
});

describe('revealProject', () => {
  it('errors gracefully in the browser (no bridge)', async () => {
    expect(await revealProject('/p.fp.json', null)).toEqual({
      ok: false,
      error: 'Reveal is only available in the desktop app.',
    });
  });

  it('delegates the path to the bridge', async () => {
    const reveal = vi.fn(async () => ({ ok: true as const }));
    const bridge = fakeBridge({ revealProject: reveal });
    expect(await revealProject('/p.fp.json', bridge)).toEqual({ ok: true });
    expect(reveal).toHaveBeenCalledWith('/p.fp.json');
  });
});

describe('projectsDir', () => {
  it('returns null in the browser (no bridge)', async () => {
    expect(await projectsDir(null)).toBeNull();
  });

  it('returns the bridge folder when available', async () => {
    const bridge = fakeBridge({ projectsDir: vi.fn(async () => '/projects') });
    expect(await projectsDir(bridge)).toBe('/projects');
  });
});

describe('exportVideo', () => {
  it('returns an actionable error in the browser (no engine)', async () => {
    const result = await exportVideo({ projectPath: '/p.fp.json' }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('desktop app');
    }
  });

  it('delegates to the bridge and returns the rendered output', async () => {
    const exp = vi.fn(async () => ({
      ok: true as const,
      outputPath: '/out.mp4',
      state: 'completed',
    }));
    const bridge = fakeBridge({ exportVideo: exp });
    const req = { projectPath: '/p.fp.json', preset: 'reels_9_16', burnCaptions: true };
    expect(await exportVideo(req, bridge)).toEqual({
      ok: true,
      outputPath: '/out.mp4',
      state: 'completed',
    });
    expect(exp).toHaveBeenCalledWith(req);
  });
});

describe('importMedia', () => {
  it('returns an actionable error in the browser (no disk to write)', async () => {
    const result = await importMedia(
      { projectId: 'p', fileName: 'clip.mp4', data: new ArrayBuffer(4) },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('desktop app');
    }
  });

  it('delegates to the bridge and returns the relative disk path', async () => {
    const imp = vi.fn(async () => ({ ok: true as const, path: 'media/p/clip.mp4' }));
    const bridge = fakeBridge({ importMedia: imp });
    const req = { projectId: 'p', fileName: 'clip.mp4', data: new ArrayBuffer(4) };
    expect(await importMedia(req, bridge)).toEqual({ ok: true, path: 'media/p/clip.mp4' });
    expect(imp).toHaveBeenCalledWith(req);
  });
});

describe('importAsset', () => {
  it('returns an actionable error in the browser (no engine)', async () => {
    const result = await importAsset({ inputPath: 'media/p/clip.mp4' }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Thumbnail previews require the FramePilot desktop app.');
    }
  });

  it('delegates to the bridge and returns the derived media', async () => {
    const derive = vi.fn(async () => ({
      ok: true as const,
      durationSeconds: 8,
      kind: 'audio' as const,
      media: { peaks: [0.5], peaksPerSecond: 5 },
    }));
    const bridge = fakeBridge({ importAsset: derive });
    const req = { inputPath: 'media/p/voice.wav' };
    expect(await importAsset(req, bridge)).toEqual({
      ok: true,
      durationSeconds: 8,
      kind: 'audio',
      media: { peaks: [0.5], peaksPerSecond: 5 },
    });
    expect(derive).toHaveBeenCalledWith(req);
  });
});
