/**
 * Tests for the desktop↔renderer IPC data contract.
 *
 * These are compile-time guards: the assertions construct values of each contract
 * type, so if the shapes change incompatibly this test stops compiling. The point
 * of hoisting the contract into shared-types is exactly this — one definition both
 * apps build against (plan Phase 8 hardening, ADR 0023). A trivial runtime
 * assertion keeps vitest happy for a types-only module.
 */
import { describe, expect, it } from 'vitest';
import type {
  AiEditResult,
  AiRequest,
  AiTextResult,
  ExportRequest,
  ExportResult,
  FramePilotBridge,
  ImportAssetRequest,
  ImportAssetResult,
  ProjectOpenResult,
  ProjectSaveResult,
  RecentProject,
  RevealResult,
  SidecarStatus,
} from './ipc.js';

describe('ipc contract', () => {
  it('discriminated results carry an `ok` flag', () => {
    const open: ProjectOpenResult = { ok: true, path: '/p.fp.json', project: {} };
    const save: ProjectSaveResult = { ok: false, error: 'nope' };
    const reveal: RevealResult = { ok: true };
    const exp: ExportResult = { ok: true, outputPath: '/out.mp4', state: 'completed' };
    const text: AiTextResult = { ok: true, text: 'hi' };
    const edit: AiEditResult = { ok: false, error: 'bad' };
    expect([open.ok, save.ok, reveal.ok, exp.ok, text.ok, edit.ok]).toEqual([
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it('payload shapes are constructible', () => {
    const status: SidecarStatus = {
      phase: 'ready',
      baseUrl: 'http://127.0.0.1:8000',
      detail: null,
    };
    const recent: RecentProject = { path: '/a.fp.json', name: 'A', openedAt: 0 };
    const req: ExportRequest = { projectPath: '/a.fp.json', preset: 'reels', burnCaptions: true };
    const ai: AiRequest = { project: {}, userPrompt: 'tighten this' };
    expect(status.phase).toBe('ready');
    expect(recent.name).toBe('A');
    expect(req.burnCaptions).toBe(true);
    expect(ai.userPrompt).toContain('tighten');

    const importReq: ImportAssetRequest = { inputPath: 'media/p/a.mp4', thumbnails: 5 };
    const importOk: ImportAssetResult = {
      ok: true,
      durationSeconds: 8,
      kind: 'audio',
      media: { peaks: [0.2, 0.4], peaksPerSecond: 10 },
    };
    const importErr: ImportAssetResult = { ok: false, error: 'engine down' };
    expect(importReq.inputPath).toContain('media');
    expect(importOk.ok && importOk.kind).toBe('audio');
    expect(importErr.ok).toBe(false);
  });

  it('a stub bridge satisfies FramePilotBridge (surface is complete)', async () => {
    const bridge: FramePilotBridge = {
      ping: async () => 'pong',
      sidecarStatus: async () => ({ phase: 'stopped', baseUrl: null, detail: null }),
      openProject: async (path) => ({ ok: true, path, project: {} }),
      saveProject: async (path) => ({ ok: true, path }),
      saveProjectDefault: async () => ({ ok: true, path: '/default/a.fp.json' }),
      projectsDir: async () => '/projects',
      revealProject: async () => ({ ok: true }),
      recentProjects: async () => [],
      exportVideo: async () => ({ ok: true, outputPath: '/out.mp4', state: 'completed' }),
      importMedia: async () => ({ ok: true, path: 'media/p/a.mp4' }),
      openProjectDialog: async () => ({ ok: true, path: '/a.fp.json', project: {} }),
      importAsset: async () => ({
        ok: true,
        durationSeconds: 12,
        kind: 'video',
        media: { peaks: [0.1], peaksPerSecond: 10, thumbnailPaths: ['media/p/t0.jpg'] },
      }),
      aiChat: async () => ({ ok: true, text: '' }),
      aiPlan: async () => ({ ok: true, text: '' }),
      aiEdit: async () => ({ ok: true, patch: {}, validation: {}, text: '' }),
      aiProviders: async () => [
        { name: 'mock', label: 'Offline mock', model: 'mock', ready: true },
      ],
      onProjectChanged: () => () => {},
      conversationsList: async () => [],
      conversationsLoad: async () => null,
      conversationsSave: async () => ({ ok: true }),
      conversationsDelete: async () => ({ ok: true }),
      aiStreamStart: async () => 'req_1',
      aiStreamAbort: () => {},
      aiStreamAnswer: () => {},
      onAiStreamEvent: () => () => {},
    };
    expect(await bridge.ping()).toBe('pong');
  });
});
