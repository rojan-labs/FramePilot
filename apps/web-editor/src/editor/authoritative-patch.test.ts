import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type {
  AiStreamRequest,
  FramePilotBridge,
  ProjectChangedEvent,
  ProjectPatchCommitRequest,
} from '@framepilot/shared-types';
import { PROJECT_PATCH_TRANSPORT_KIND } from '@framepilot/shared-types';
import type { Patch } from '@framepilot/editor-core';
import { applyAuthoritativePatchTransport } from './authoritative-patch.js';
import { createProjectAwareBridge, resetProjectBridgeCacheForTests } from './bridge.js';

const project = (): Project =>
  parseProject({
    id: 'project_1',
    name: 'Project',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: 'media/clip.mp4',
        kind: 'video',
        durationSeconds: 10,
        media: { peaks: Array.from({ length: 10_000 }, () => 0.25), proxyPath: 'proxy.mp4' },
      },
    ],
    timeline: { tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
  });

const patch: Patch = {
  patchId: 'patch_1' as Patch['patchId'],
  createdBy: 'agent',
  reason: 'add marker',
  operations: [{ type: 'add_marker', id: 'marker', time: 1 }],
};

const transport = (revision = 2) => ({
  kind: PROJECT_PATCH_TRANSPORT_KIND,
  id: 'project_1',
  baseRevision: 1,
  revision,
  patch,
  history: [{ patch, inverse: { ...patch, patchId: 'inverse', operations: [{ type: 'remove_marker', id: 'marker' }] } }],
});

beforeEach(() => resetProjectBridgeCacheForTests());

describe('applyAuthoritativePatchTransport', () => {
  it('applies the patch while preserving unchanged heavy media and installing host history', () => {
    const base = project();
    const next = applyAuthoritativePatchTransport(base, transport());
    expect(next?.markers.map((marker) => marker.id)).toEqual(['marker']);
    expect(next?.assets[0]?.media?.peaks).toHaveLength(10_000);
    expect(next?.assets[0]?.media?.proxyPath).toBe('proxy.mp4');
    expect(next?.history).toHaveLength(1);
  });

  it('rejects a wrong project or malformed patch instead of coercing it', () => {
    expect(applyAuthoritativePatchTransport(project(), { ...transport(), id: 'other' })).toBeNull();
    expect(applyAuthoritativePatchTransport(project(), { ...transport(), patch: { nope: true } })).toBeNull();
  });
});

describe('project-aware renderer bridge', () => {
  it('reconstructs a compact manual commit into the existing full Project contract', async () => {
    const base = project();
    const raw = {
      saveProject: vi.fn(async () => ({ ok: true as const, path: '/p/project.fp.json', revision: 1 })),
      commitProjectPatch: vi.fn(async () => ({ ok: true as const, project: transport(), revision: 2, rebased: false })),
    } as unknown as FramePilotBridge;
    const bridge = createProjectAwareBridge(raw);
    await bridge.saveProject('/p/project.fp.json', base, 0);
    const request: ProjectPatchCommitRequest = { projectId: base.id, expectedRevision: 1, patch };
    const result = await bridge.commitProjectPatch!(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const full = result.project as Project;
    expect(full.markers).toHaveLength(1);
    expect(full.assets[0]?.media?.peaks).toHaveLength(10_000);
  });

  it('refreshes the reconstruction base from unsaved live AI state without losing host history', async () => {
    const base = { ...project(), history: [{ patch, inverse: { ...patch, patchId: 'old_inverse', operations: [] } }] } as Project;
    const live = parseProject({
      ...base,
      markers: [{ id: 'local', time: 0.5 }],
      history: [],
    });
    const raw = {
      saveProject: vi.fn(async () => ({ ok: true as const, path: '/p/project.fp.json', revision: 1 })),
      aiStreamStart: vi.fn(async () => 'request_1'),
      commitProjectPatch: vi.fn(async () => ({ ok: true as const, project: transport(), revision: 2, rebased: false })),
    } as unknown as FramePilotBridge;
    const bridge = createProjectAwareBridge(raw);
    await bridge.saveProject('/p/project.fp.json', base, 0);
    const stream: AiStreamRequest = {
      mode: 'agent',
      project: live,
      projectId: live.id,
      projectRevision: 1,
      userPrompt: 'edit',
      conversationId: 'conversation',
      turnId: 'turn',
    };
    await bridge.aiStreamStart(stream);
    const result = await bridge.commitProjectPatch!({ projectId: live.id, expectedRevision: 1, patch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const full = result.project as Project;
    expect(full.markers.map((marker) => marker.id)).toEqual(['local', 'marker']);
    expect(full.assets[0]?.media?.peaks).toHaveLength(10_000);
  });

  it('reconstructs auto-commit projectChanged pushes before existing listeners see them', async () => {
    const base = project();
    let hostListener: ((event: ProjectChangedEvent) => void) | undefined;
    const raw = {
      saveProject: vi.fn(async () => ({ ok: true as const, path: '/p/project.fp.json', revision: 1 })),
      onProjectChanged: vi.fn((listener: (event: ProjectChangedEvent) => void) => {
        hostListener = listener;
        return () => {};
      }),
    } as unknown as FramePilotBridge;
    const bridge = createProjectAwareBridge(raw);
    await bridge.saveProject('/p/project.fp.json', base, 0);
    const seen: ProjectChangedEvent[] = [];
    bridge.onProjectChanged((event) => seen.push(event));
    hostListener?.({ path: '/p/project.fp.json', project: transport(), revision: 2 });
    expect(seen).toHaveLength(1);
    const full = seen[0]!.project as Project;
    expect(full.markers).toHaveLength(1);
    expect(full.assets[0]?.media?.peaks).toHaveLength(10_000);
  });

  it('falls back to a full host open if the local revision cache cannot prove the delta base', async () => {
    const base = project();
    let hostListener: ((event: ProjectChangedEvent) => void) | undefined;
    const raw = {
      onProjectChanged: vi.fn((listener: (event: ProjectChangedEvent) => void) => {
        hostListener = listener;
        return () => {};
      }),
      openProject: vi.fn(async () => ({ ok: true as const, path: '/p/project.fp.json', project: base, revision: 2 })),
    } as unknown as FramePilotBridge;
    const bridge = createProjectAwareBridge(raw);
    const seen: ProjectChangedEvent[] = [];
    bridge.onProjectChanged((event) => seen.push(event));
    hostListener?.({ path: '/p/project.fp.json', project: transport(), revision: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(raw.openProject).toHaveBeenCalledTimes(1);
    expect(seen[0]?.project).toEqual(base);
  });
});
