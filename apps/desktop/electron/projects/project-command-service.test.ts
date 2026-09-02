import { describe, expect, it, vi } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { Patch } from '@framepilot/editor-core';
import {
  isProjectFileConflictError,
  ProjectFileConflictError,
} from '@framepilot/timeline-schema/file';
import { ProjectCommandService, type ProjectRevisionIO } from './project-command-service.js';

const project = (assets: Project['assets']): Project =>
  parseProject({
    id: 'project_1',
    name: 'Test project',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets,
    timeline: { tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
  });

const asset = {
  id: 'asset_1',
  path: 'media/just-imported.mp4',
  kind: 'video' as const,
  durationSeconds: 12,
};

function revisionIO(): ProjectRevisionIO & { write: ReturnType<typeof vi.fn> } {
  return {
    read: async () => null,
    write: vi.fn(async () => {}),
  };
}

describe('ProjectCommandService.refresh', () => {
  it('updates the live document without serializing or advancing the persisted revision', () => {
    const serialize = vi.fn(JSON.stringify);
    const service = new ProjectCommandService(serialize);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    const callsAfterObserve = serialize.mock.calls.length;
    const imported = project([asset]);

    expect(service.refresh(imported, revision)).toBe(true);
    expect(serialize).toHaveBeenCalledTimes(callsAfterObserve);
    expect(service.revision(imported.id)).toBe(revision);
    expect(service.project(imported.id)?.assets).toEqual(imported.assets);
  });

  it('refuses a stale renderer snapshot', () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    expect(service.refresh(project([]), revision + 1)).toBe(false);
    expect(service.project(initial.id)).toBe(initial);
  });
});

describe('ProjectCommandService persisted revision work', () => {
  it('serializes once on observe and reuses the cached fingerprint for checkpoints', async () => {
    const serialize = vi.fn(JSON.stringify);
    const io = revisionIO();
    const service = new ProjectCommandService(serialize, io);
    service.observe(project([]));
    expect(serialize).toHaveBeenCalledTimes(1);

    await service.checkpoint();
    await service.checkpoint();
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('per successful write serializes once and checkpoints once without an async duplicate', async () => {
    const serialize = vi.fn(JSON.stringify);
    const io = revisionIO();
    const service = new ProjectCommandService(serialize, io);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    await service.checkpoint();
    io.write.mockClear();
    serialize.mockClear();

    const changed = project([asset]);
    const result = await service.write(changed, revision, async () => {});
    expect(result).toEqual({ ok: true, revision: revision + 1 });
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(io.write).toHaveBeenCalledTimes(1);
  });

  it('does not advance the revision when identical persisted content is written again', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    await expect(service.write(initial, revision, async () => {})).resolves.toEqual({
      ok: true,
      revision,
    });
  });
});

describe('ProjectCommandService.commitPatch', () => {
  it('drops an oversized legacy undo payload before an agent commit', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const oversized: Project = {
      ...initial,
      history: [
        {
          patch: {
            patchId: 'legacy_large',
            createdBy: 'user',
            reason: 'x'.repeat(5 * 1024 * 1024),
            operations: [],
          },
          inverse: {
            patchId: 'legacy_large_inverse',
            createdBy: 'user',
            reason: 'legacy inverse',
            operations: [],
          },
        },
      ],
    };
    const revision = service.observe(oversized).revision;
    const patch: Patch = {
      patchId: 'agent_marker',
      createdBy: 'agent',
      reason: 'Add marker',
      operations: [{ type: 'add_marker', id: 'marker_1', time: 1 }],
    };

    const result = await service.commitPatch(initial.id, revision, patch, async () => {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.history).toHaveLength(1);
      expect(result.project.history[0]?.patch.patchId).toBe('agent_marker');
    }
  });

  it('serializes the committed project once for revision bookkeeping', async () => {
    const serialize = vi.fn(JSON.stringify);
    const service = new ProjectCommandService(serialize);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    serialize.mockClear();
    const patch: Patch = {
      patchId: 'agent_marker',
      createdBy: 'agent',
      reason: 'Add marker',
      operations: [{ type: 'add_marker', id: 'marker_1', time: 1 }],
    };
    await service.commitPatch(initial.id, revision, patch, async () => {});
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('replays an identical accepted patch without writing or advancing the revision', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    const write = vi.fn(async () => undefined);
    const patch: Patch = {
      patchId: 'agent_marker',
      createdBy: 'agent',
      reason: 'Add marker',
      operations: [{ type: 'add_marker', id: 'marker_1', time: 1 }],
    };

    const first = await service.commitPatch(initial.id, revision, patch, write, 'run_1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = await service.commitPatch(initial.id, revision, patch, write, 'run_1');

    expect(replay).toMatchObject({
      ok: true,
      revision: first.revision,
      replayed: true,
      rebased: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(service.project(initial.id)?.history).toHaveLength(1);
  });

  it('retains replay identity for every member of a collapsed run after reload', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    const first: Patch = {
      patchId: 'agent_marker_1',
      createdBy: 'agent',
      reason: 'Add first marker',
      operations: [{ type: 'add_marker', id: 'marker_1', time: 1 }],
    };
    const second: Patch = {
      patchId: 'agent_marker_2',
      createdBy: 'agent',
      reason: 'Add second marker',
      operations: [{ type: 'add_marker', id: 'marker_2', time: 2 }],
    };
    const firstResult = await service.commitPatch(
      initial.id,
      revision,
      first,
      async () => undefined,
      'run_1',
    );
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;
    const secondResult = await service.commitPatch(
      initial.id,
      firstResult.revision,
      second,
      async () => undefined,
      'run_1',
    );
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;

    const persisted = service.project(initial.id);
    expect(persisted).toBeDefined();
    if (persisted === undefined) return;
    const reloaded = new ProjectCommandService(JSON.stringify);
    reloaded.observe(persisted);
    const write = vi.fn(async () => undefined);
    const replay = await reloaded.commitPatch(initial.id, revision, second, write, 'run_1');
    expect(replay).toMatchObject({ ok: true, replayed: true, revision: 1 });
    expect(write).not.toHaveBeenCalled();
    expect(reloaded.project(initial.id)?.history).toHaveLength(1);
  });

  it('replays a repeat of the same operations even though the model reworded its reason', async () => {
    // The captured defect. `patchIdFor` hashes the OPERATIONS; `reason` is the model's
    // narration for the turn, which is different prose every time. Comparing the whole
    // patch object therefore compared the prose, so a repeat of an edit the project had
    // already committed — re-transcribing the same video to the same words — was refused
    // as `invalid_patch` rather than replayed, and refused again on every retry, because
    // the id is deterministic. Run `e8cb2636` spent its whole first turn on it and got
    // back "the proposed edit failed authoritative validation" for a no-op.
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    const operations = [{ type: 'add_marker' as const, id: 'marker_1', time: 1 }];
    const first = await service.commitPatch(
      initial.id,
      revision,
      {
        patchId: 'agent_marker',
        createdBy: 'agent',
        reason: "I'm setting up the edit foundation first.",
        operations,
      },
      async () => undefined,
      'run_1',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const write = vi.fn(async () => undefined);
    const reworded = await service.commitPatch(
      initial.id,
      revision,
      {
        patchId: 'agent_marker',
        createdBy: 'agent',
        reason: 'Building this edit from the ground up.',
        operations,
      },
      write,
      'run_2',
    );

    expect(reworded).toMatchObject({ ok: true, replayed: true, revision: first.revision });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects patch-id reuse with different content, and says which', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    const original: Patch = {
      patchId: 'agent_marker',
      createdBy: 'agent',
      reason: 'Add marker',
      operations: [{ type: 'add_marker', id: 'marker_1', time: 1 }],
    };
    await service.commitPatch(initial.id, revision, original, async () => undefined, 'run_1');

    const collision = await service.commitPatch(
      initial.id,
      revision,
      { ...original, operations: [{ type: 'add_marker', id: 'marker_2', time: 2 }] },
      async () => undefined,
      'run_1',
    );
    expect(collision).toMatchObject({ ok: false, code: 'invalid_patch' });
    // A reason the caller can show. Without it the desktop path had nothing to say but
    // "the proposed edit failed authoritative validation", which names no cause at all.
    if (collision.ok) return;
    expect(collision.issues?.[0]?.message).toContain('agent_marker');
  });
});

describe('ProjectCommandService — writer refused the publish', () => {
  const marker: Patch = {
    patchId: 'agent_marker',
    createdBy: 'agent',
    reason: 'Add marker',
    operations: [{ type: 'add_marker', id: 'marker_1', time: 1 }],
  };

  const conflict = (): ProjectFileConflictError =>
    new ProjectFileConflictError('/projects/demo.fp.json', 'changed on disk');

  it('reports a refused patch commit as a revision conflict, not an invalid patch', async () => {
    // The patch was valid against the project this process holds; the FILE moved. Calling
    // that `invalid_patch` would tell the agent to fix a patch that has nothing wrong with
    // it — `main.ts` maps `revision_conflict` to a `stale` event that says "replan".
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;

    const result = await service.commitPatch(initial.id, revision, marker, () => {
      throw conflict();
    });

    expect(result).toMatchObject({ ok: false, code: 'revision_conflict' });
    // No `currentRevision`: nothing persisted, so the in-memory revision did NOT advance,
    // and echoing it back would invite a retry at the same number against a moved file.
    expect(result).not.toHaveProperty('currentRevision');
  });

  it('does not advance the revision when the publish was refused', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;

    await service.commitPatch(initial.id, revision, marker, () => {
      throw conflict();
    });

    expect(service.revision(initial.id)).toBe(revision);
    expect(service.project(initial.id)?.markers).toEqual([]);
  });

  it('rethrows a refused write so the save path cannot report success', async () => {
    // `write()` has no conflict result variant, and inventing one would be a silent
    // downgrade of a save failure into "saved". The caller must see the refusal.
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;

    await expect(
      service.write(initial, revision, () => Promise.reject(conflict())),
    ).rejects.toSatisfy(isProjectFileConflictError);
    expect(service.revision(initial.id)).toBe(revision);
  });

  it('a refused write does not poison later writes to the same project', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project([]);
    const revision = service.observe(initial).revision;
    await expect(
      service.write(initial, revision, () => Promise.reject(conflict())),
    ).rejects.toSatisfy(isProjectFileConflictError);

    const after = await service.write(project([asset]), revision, async () => {});
    expect(after).toMatchObject({ ok: true });
  });
});
