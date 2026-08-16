import { describe, expect, it, vi } from 'vitest';
import type { RendererBridge } from './bridge.js';
import { newProject } from './project.js';
import {
  BROWSER_PATH_PREFIX,
  loadBrowserProject,
  loadLastBrowserProject,
  persistProject,
} from './persistence.js';

const project = newProject('My Demo');

/** A minimal in-memory Storage implementation for tests. */
function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** A bridge whose save methods are spies; only what persistence calls is defined. */
function fakeBridge(overrides: Partial<RendererBridge> = {}): RendererBridge {
  return {
    ping: vi.fn(),
    sidecarStatus: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(async (path: string) => ({ ok: true as const, path })),
    saveProjectDefault: vi.fn(async () => ({ ok: true as const, path: '/projects/p.fp.json' })),
    projectsDir: vi.fn(),
    revealProject: vi.fn(),
    recentProjects: vi.fn(),
    exportVideo: vi.fn(),
    aiChat: vi.fn(),
    aiPlan: vi.fn(),
    aiEdit: vi.fn(),
    ...overrides,
  } as RendererBridge;
}

describe('persistProject — desktop', () => {
  it('writes in place when there is already a real file path', async () => {
    const bridge = fakeBridge();
    const out = await persistProject('/a/b.fp.json', project, { bridge });
    expect(out).toEqual({ ok: true, path: '/a/b.fp.json', desktop: true });
    expect(bridge.saveProject).toHaveBeenCalledWith('/a/b.fp.json', project, undefined);
    expect(bridge.saveProjectDefault).not.toHaveBeenCalled();
  });

  it('autosaves a path-less project to the default folder', async () => {
    const bridge = fakeBridge();
    const out = await persistProject('', project, { bridge });
    expect(out).toEqual({ ok: true, path: '/projects/p.fp.json', desktop: true });
    expect(bridge.saveProjectDefault).toHaveBeenCalledWith(project, undefined);
  });

  it('treats a browser pseudo-path as "no real file" and uses the default folder', async () => {
    const bridge = fakeBridge();
    await persistProject(`${BROWSER_PATH_PREFIX}${project.id}`, project, { bridge });
    expect(bridge.saveProjectDefault).toHaveBeenCalledWith(project, undefined);
  });

  it('surfaces a bridge save failure', async () => {
    const bridge = fakeBridge({
      saveProject: vi.fn(async () => ({ ok: false as const, error: 'disk full' })),
    });
    const out = await persistProject('/a/b.fp.json', project, { bridge });
    expect(out).toEqual({ ok: false, error: 'disk full' });
  });
});

describe('persistProject — browser', () => {
  it('persists to localStorage and returns a local:// pseudo-path', async () => {
    const storage = memStorage();
    const out = await persistProject('', project, { bridge: null, storage });
    expect(out).toEqual({
      ok: true,
      path: `${BROWSER_PATH_PREFIX}${project.id}`,
      desktop: false,
    });
    expect(loadBrowserProject(project.id, storage)?.name).toBe('My Demo');
    expect(loadLastBrowserProject(storage)?.id).toBe(project.id);
  });

  it('returns an error when no storage is available', async () => {
    const out = await persistProject('', project, { bridge: null, storage: null });
    expect(out.ok).toBe(false);
  });

  it('surfaces a thrown storage error (e.g. quota exceeded)', async () => {
    const storage = {
      ...memStorage(),
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    } as Storage;
    const out = await persistProject('', project, { bridge: null, storage });
    expect(out).toEqual({ ok: false, error: 'QuotaExceeded' });
  });
});

describe('loadBrowserProject / loadLastBrowserProject', () => {
  it('returns null with no storage', () => {
    expect(loadBrowserProject('x', null)).toBeNull();
    expect(loadLastBrowserProject(null)).toBeNull();
  });

  it('returns null for an absent entry', () => {
    expect(loadBrowserProject('missing', memStorage())).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    const storage = memStorage();
    storage.setItem(`framepilot:project:bad`, '{not json');
    expect(loadBrowserProject('bad', storage)).toBeNull();
  });

  it('returns null for a schema-invalid stored object', () => {
    const storage = memStorage();
    storage.setItem(`framepilot:project:weird`, JSON.stringify({ not: 'a project' }));
    expect(loadBrowserProject('weird', storage)).toBeNull();
  });

  it('returns null from loadLastBrowserProject when no last id is set', () => {
    expect(loadLastBrowserProject(memStorage())).toBeNull();
  });
});
