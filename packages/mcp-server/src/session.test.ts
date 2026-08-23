import { describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { readProjectFile, writeProjectFile } from '@framepilot/timeline-schema/file';
import { activePointerPath } from '@framepilot/shared-types/projects-root';
import { EditorSession, SessionError, sessionFromEnv } from './session.js';
import { makeProject, makeSandboxProject } from './__fixtures__/project.js';

/** Write the desktop app's active-project pointer into a sandbox root. */
async function writeActivePointer(root: string, projectPath: string): Promise<void> {
  await writeFile(
    activePointerPath(root),
    JSON.stringify({ path: projectPath, projectId: 'proj_1', updatedAt: 1 }),
    'utf-8',
  );
}

async function openSession() {
  const { root, projectPath } = await makeSandboxProject();
  const session = new EditorSession(root);
  await session.openProject('project.fp.json');
  return { root, projectPath, session };
}

describe('EditorSession — open/save', () => {
  it('opens a sandboxed project and reports state', async () => {
    const { session } = await openSession();
    const state = session.state();
    expect(state?.canUndo).toBe(false);
    expect(state?.historyLength).toBe(0);
  });

  it('returns null state before any project is opened', () => {
    expect(new EditorSession('/tmp').state()).toBeNull();
  });

  it('saves to the open path and to an explicit path', async () => {
    const { root, session } = await openSession();
    await session.runTool('trim_clip', { clipId: 'clip_a', start: 0, end: 4 });

    await session.saveProject();
    const reopened = await readProjectFile(`${root}/project.fp.json`);
    const clipA = reopened.timeline.tracks[0]!.clips[0]!;
    expect(clipA.end).toBe(4);
    expect(reopened.history.length).toBe(1);

    const saved = await session.saveProject('copy.fp.json');
    expect(saved.path.endsWith('copy.fp.json')).toBe(true);
  });

  it('rejects saveProject with a conflict when the file changed on disk since open', async () => {
    const { projectPath, session } = await openSession();
    await session.runTool('trim_clip', { clipId: 'clip_a', start: 0, end: 4 });
    // Simulate the GUI (or another process) autosaving the open file underneath us.
    await writeProjectFile(projectPath, makeProject({ name: 'Edited elsewhere' }));

    await expect(session.saveProject()).rejects.toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    // The external edit is intact — the lost-update was prevented, not clobbered.
    expect((await readProjectFile(projectPath)).name).toBe('Edited elsewhere');
  });

  it('saveProject recreates the file when it was deleted on disk (no false conflict)', async () => {
    const { projectPath, session } = await openSession();
    await session.runTool('trim_clip', { clipId: 'clip_a', start: 0, end: 4 });
    await rm(projectPath);

    const state = await session.saveProject();
    expect(state.path.endsWith('project.fp.json')).toBe(true);
    expect((await readProjectFile(projectPath)).timeline.tracks[0]!.clips[0]!.end).toBe(4);
  });

  it('saveProject succeeds on a second save (baseline advances after each write)', async () => {
    const { session } = await openSession();
    await session.runTool('trim_clip', { clipId: 'clip_a', start: 0, end: 4 });
    await session.saveProject();
    // The first save advanced the baseline to what it just wrote, so a follow-up
    // save (no external change) is not a false conflict.
    await session.runTool('trim_clip', { clipId: 'clip_a', start: 0, end: 3 });
    const state = await session.saveProject();
    expect(state.historyLength).toBe(2);
  });
});

describe('EditorSession — runTool', () => {
  it('runs a read tool and returns data', async () => {
    const { session } = await openSession();
    const result = session.runTool('get_timeline', {});
    expect(result.kind).toBe('read');
    if (result.kind === 'read') {
      expect(result.data).toMatchObject({ tracks: expect.any(Array) });
    }
  });

  it('applies a valid mutating tool and records undo', async () => {
    const { session } = await openSession();
    const result = session.runTool('split_clip', { clipId: 'clip_a', at: 3 });
    expect(result.kind).toBe('mutate');
    if (result.kind === 'mutate') {
      expect(result.applied).toBe(true);
      expect(result.diff).toBeDefined();
    }
    expect(session.state()?.canUndo).toBe(true);
  });

  it('returns applied:false when a patch fails validation (untouched timeline)', async () => {
    const { session } = await openSession();
    const result = session.runTool('trim_clip', { clipId: 'does_not_exist', start: 0, end: 1 });
    expect(result.kind).toBe('mutate');
    if (result.kind === 'mutate') {
      expect(result.applied).toBe(false);
      expect(result.validation.valid).toBe(false);
    }
    expect(session.state()?.canUndo).toBe(false);
  });

  it('surfaces an action tool for the host to perform', async () => {
    const { session } = await openSession();
    expect(session.runTool('render_preview', {})).toEqual({
      kind: 'action',
      name: 'render_preview',
    });
  });

  it('rejects unknown, unavailable, and invalid-arg tool calls', async () => {
    const { session } = await openSession();
    expect(() => session.runTool('no_such_tool', {})).toThrow(
      expect.objectContaining({ code: 'unknown_tool' }),
    );
    // generate_mask remains unavailable (dependency-gated CV engine); detect_faces
    // was replaced by the pack-backed detect_subjects, so it is now unknown here.
    expect(() => session.runTool('detect_faces', {})).toThrow(
      expect.objectContaining({ code: 'unknown_tool' }),
    );
    expect(() => session.runTool('generate_mask', {})).toThrow(
      expect.objectContaining({ code: 'unavailable_tool' }),
    );
    expect(() => session.runTool('trim_clip', { clipId: 'clip_a' })).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });

  it('analysis tools validate args and return a delegable analysis result', async () => {
    const { session } = await openSession();
    const ok = session.runTool('analyze_silence', { assetId: 'a', minSilenceSeconds: 0.5 });
    expect(ok.kind).toBe('analysis');
    if (ok.kind === 'analysis') {
      expect(ok.name).toBe('analyze_silence');
      expect(ok.args).toEqual({ assetId: 'a', minSilenceSeconds: 0.5 });
    }
    expect(() => session.runTool('detect_scenes', { threshold: 5 })).toThrow(
      expect.objectContaining({ code: 'invalid_args' }),
    );
  });
});

describe('EditorSession — asset & folder (project-scoped) tools', () => {
  it('add_asset appends to the bin, persists, and is undoable', async () => {
    const { root, session } = await openSession();
    const result = session.runTool('add_asset', { path: 'media/b.mp4', kind: 'video' });
    expect(result.kind).toBe('mutate');
    if (result.kind === 'mutate') expect(result.applied).toBe(true);

    await session.saveProject();
    const reopened = await readProjectFile(`${root}/project.fp.json`);
    expect(reopened.assets.map((a) => a.id)).toContain('asset_media_b_mp4');

    const afterUndo = session.undo();
    expect(afterUndo.canUndo).toBe(false);
    expect(session.state()?.project.assets.some((a) => a.id === 'asset_media_b_mp4')).toBe(false);
  });

  it('manage_assets by-kind folds existing assets into folders', async () => {
    const { session } = await openSession();
    const result = session.runTool('manage_assets', { strategy: 'by-kind' });
    expect(result.kind).toBe('mutate');
    if (result.kind === 'mutate') {
      expect(result.applied).toBe(true);
      expect(result.diff?.summary.some((l) => l.includes('folder folder_video added'))).toBe(true);
    }
    const project = session.state()?.project;
    expect(project?.folders.some((f) => f.id === 'folder_video')).toBe(true);
    expect(project?.assets.find((a) => a.id === 'asset_1')?.folderId).toBe('folder_video');
  });

  it('rejects an add_asset path that escapes the projects sandbox', async () => {
    const { session } = await openSession();
    expect(() => session.runTool('add_asset', { path: '../../etc/passwd' })).toThrow(
      expect.objectContaining({ code: 'unsafe_path' }),
    );
  });
});

describe('EditorSession — undo/redo/history', () => {
  it('undoes and redoes an applied edit', async () => {
    const { session } = await openSession();
    session.runTool('trim_clip', { clipId: 'clip_a', start: 0, end: 4 });

    const afterUndo = session.undo();
    expect(afterUndo.canUndo).toBe(false);
    expect(afterUndo.canRedo).toBe(true);
    expect(session.history()).toHaveLength(0);

    const afterRedo = session.redo();
    expect(afterRedo.canUndo).toBe(true);
    expect(session.history()).toHaveLength(1);
  });
});

describe('EditorSession — guards', () => {
  it('requires an open project for every operation', () => {
    const session = new EditorSession('/tmp');
    expect(() => session.runTool('get_timeline', {})).toThrow(
      expect.objectContaining({ code: 'no_project' }),
    );
    expect(() => session.undo()).toThrow(SessionError);
    expect(() => session.redo()).toThrow(SessionError);
    expect(() => session.history()).toThrow(SessionError);
    return expect(session.saveProject()).rejects.toThrow(
      expect.objectContaining({ code: 'no_project' }),
    );
  });
});

describe('EditorSession — active project (GUI integration)', () => {
  it('openActiveProject opens the project named by the app pointer', async () => {
    const { root, projectPath } = await makeSandboxProject();
    await writeActivePointer(root, projectPath);
    const session = new EditorSession(root);

    // The opened path is realpath-normalized (symlink-resolved), so match the tail.
    const state = await session.openActiveProject();
    expect(state.path.endsWith('project.fp.json')).toBe(true);
    expect(session.state()?.path).toBe(state.path);
  });

  it('openActiveProject resolves a RELATIVE pointer path against the projects root', async () => {
    // The desktop app normally writes an absolute pointer, but a relative path is
    // resolved against the projects root by resolveWithin rather than trusted as-is.
    const { root } = await makeSandboxProject();
    await writeActivePointer(root, 'project.fp.json');
    const state = await new EditorSession(root).openActiveProject();
    expect(state.path.endsWith('project.fp.json')).toBe(true);
  });

  it('openActiveProject throws no_project when there is no pointer', async () => {
    const { root } = await makeSandboxProject();
    await expect(new EditorSession(root).openActiveProject()).rejects.toThrow(
      expect.objectContaining({ code: 'no_project' }),
    );
  });

  it('openActiveProject ignores a corrupt pointer (no_project)', async () => {
    const { root } = await makeSandboxProject();
    await writeFile(activePointerPath(root), '{ not valid json', 'utf-8');
    await expect(new EditorSession(root).openActiveProject()).rejects.toThrow(
      expect.objectContaining({ code: 'no_project' }),
    );
  });

  it('openActiveProject ignores a structurally invalid pointer (no_project)', async () => {
    const { root } = await makeSandboxProject();
    // Valid JSON, wrong shape — exercises the isActivePointer guard's false branch.
    await writeFile(activePointerPath(root), JSON.stringify({ path: '/x' }), 'utf-8');
    await expect(new EditorSession(root).openActiveProject()).rejects.toThrow(
      expect.objectContaining({ code: 'no_project' }),
    );
  });

  it('openActiveProject rejects a pointer whose target escapes the projects root', async () => {
    // The pointer file is locally writable, so a poisoned pointer must not be able to
    // coerce the session into opening/saving an arbitrary absolute path. Its target is
    // sandbox-checked exactly like an agent-supplied path.
    const { root } = await makeSandboxProject();
    const external = await makeSandboxProject(); // a project in a DIFFERENT root
    await writeActivePointer(root, external.projectPath);
    await expect(new EditorSession(root).openActiveProject()).rejects.toThrow(
      expect.objectContaining({ code: 'unsafe_path' }),
    );
  });

  it('ensureOpenProject is a no-op once a project is open', async () => {
    const { session } = await openSession();
    const before = session.state()?.path;
    await session.ensureOpenProject();
    expect(session.state()?.path).toBe(before);
  });

  it('ensureOpenProject falls back to the active project when none is open', async () => {
    const { root, projectPath } = await makeSandboxProject();
    await writeActivePointer(root, projectPath);
    const session = new EditorSession(root);

    await session.ensureOpenProject();
    expect(session.state()?.path.endsWith('project.fp.json')).toBe(true);
  });
});

describe('sessionFromEnv', () => {
  it('builds a session from FRAMEPILOT_PROJECTS_ROOT', () => {
    expect(sessionFromEnv({ FRAMEPILOT_PROJECTS_ROOT: '/tmp' })).toBeInstanceOf(EditorSession);
  });

  it('defaults to the Documents projects folder when the env var is unset', () => {
    // No longer throws (previously required the env var) — it mirrors the app's
    // default ~/Documents/FramePilot Projects so it works with no config.
    expect(sessionFromEnv({})).toBeInstanceOf(EditorSession);
  });
});
