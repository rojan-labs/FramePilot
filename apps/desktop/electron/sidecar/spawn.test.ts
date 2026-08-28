import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveSidecarCommand, type SidecarSpawnContext } from './spawn.js';

const HOST = '127.0.0.1';
const PORT = 8765;
const SERVE_ARGS = ['serve', '--host', HOST, '--port', String(PORT)];
const RESOURCES = '/opt/FramePilot/resources';
const BUNDLE_DIR = path.join(RESOURCES, 'engine');
const PROJECTS_ROOT = '/home/u/Documents/FramePilot Projects';
/** Every branch must carry the sandbox root; helper env is additive on top of it. */
const ROOT_ENV = { FRAMEPILOT_PROJECTS_ROOT: PROJECTS_ROOT };

const baseContext: SidecarSpawnContext = {
  env: {},
  isPackaged: false,
  resourcesPath: RESOURCES,
  platform: 'darwin',
  moduleDir: '/repo/apps/desktop/dist',
  fileExists: () => false,
  projectsRoot: PROJECTS_ROOT,
};

describe('resolveSidecarCommand', () => {
  it('dev (unpackaged): runs the engine from source via uv in the repo engine dir', () => {
    const command = resolveSidecarCommand(HOST, PORT, baseContext);
    expect(command).toEqual({
      command: 'uv',
      args: ['run', 'framepilot', ...SERVE_ARGS],
      cwd: path.resolve('/repo/apps/desktop/dist', '../../../engine/python'),
      env: ROOT_ENV,
      source: 'dev-uv',
    });
    expect(command.cwd).toBe(path.join('/repo', 'engine', 'python'));
  });

  it('packaged: launches the bundled binary under Resources/engine', () => {
    const command = resolveSidecarCommand(HOST, PORT, { ...baseContext, isPackaged: true });
    expect(command).toEqual({
      command: path.join(BUNDLE_DIR, 'framepilot-engine'),
      args: SERVE_ARGS,
      cwd: BUNDLE_DIR,
      env: ROOT_ENV,
      source: 'bundled',
    });
  });

  it('packaged on Windows: the bundled binary carries .exe', () => {
    const command = resolveSidecarCommand(HOST, PORT, {
      ...baseContext,
      isPackaged: true,
      platform: 'win32',
    });
    expect(command.command).toBe(path.join(BUNDLE_DIR, 'framepilot-engine.exe'));
    expect(command.source).toBe('bundled');
  });

  it('FRAMEPILOT_ENGINE_DIR overrides even a packaged app (debug a source engine)', () => {
    const command = resolveSidecarCommand(HOST, PORT, {
      ...baseContext,
      isPackaged: true,
      env: { FRAMEPILOT_ENGINE_DIR: '/work/engine/python' },
    });
    expect(command).toEqual({
      command: 'uv',
      args: ['run', 'framepilot', ...SERVE_ARGS],
      cwd: '/work/engine/python',
      env: ROOT_ENV,
      source: 'engine-dir-override',
    });
  });

  it('ignores a whitespace-only FRAMEPILOT_ENGINE_DIR', () => {
    const command = resolveSidecarCommand(HOST, PORT, {
      ...baseContext,
      env: { FRAMEPILOT_ENGINE_DIR: '   ' },
    });
    expect(command.source).toBe('dev-uv');
  });

  it('threads host/port through to the serve args', () => {
    const command = resolveSidecarCommand('0.0.0.0', 9001, baseContext);
    expect(command.args).toEqual([
      'run',
      'framepilot',
      'serve',
      '--host',
      '0.0.0.0',
      '--port',
      '9001',
    ]);
  });

  // The sidecar's sandbox root comes ONLY from this var and the engine has no
  // default: unset, every path-based route (analysis, render, temporal review)
  // answers 503 and the agent loses beat detection, transcription, and review.
  // The app resolved this folder for itself all along without passing it on.
  describe('sandbox root', () => {
    it.each([
      ['dev-uv', baseContext],
      ['bundled', { ...baseContext, isPackaged: true }],
      [
        'engine-dir-override',
        { ...baseContext, env: { FRAMEPILOT_ENGINE_DIR: '/work/engine/python' } },
      ],
    ] as const)('is handed to the engine in the %s branch', (source, context) => {
      const command = resolveSidecarCommand(HOST, PORT, context);
      expect(command.source).toBe(source);
      expect(command.env.FRAMEPILOT_PROJECTS_ROOT).toBe(PROJECTS_ROOT);
    });

    it('passes the app-resolved root, which already honours a user-set var', () => {
      const command = resolveSidecarCommand(HOST, PORT, {
        ...baseContext,
        env: { FRAMEPILOT_PROJECTS_ROOT: '/somewhere/else' },
        projectsRoot: '/somewhere/else',
      });
      expect(command.env.FRAMEPILOT_PROJECTS_ROOT).toBe('/somewhere/else');
    });
  });

  describe('bundled helper-tool env', () => {
    it('points the engine only at the small staged ffprobe helper', () => {
      const command = resolveSidecarCommand(HOST, PORT, {
        ...baseContext,
        isPackaged: true,
        fileExists: () => true,
      });
      expect(command.env).toEqual({
        ...ROOT_ENV,
        FRAMEPILOT_FFPROBE: path.join(BUNDLE_DIR, 'ffprobe'),
      });
    });

    it('sets only the helpers that were actually staged', () => {
      const command = resolveSidecarCommand(HOST, PORT, {
        ...baseContext,
        isPackaged: true,
        fileExists: (filePath) => filePath.endsWith('ffprobe'),
      });
      expect(command.env).toEqual({
        ...ROOT_ENV,
        FRAMEPILOT_FFPROBE: path.join(BUNDLE_DIR, 'ffprobe'),
      });
    });

    it('uses .exe helper names on Windows', () => {
      const seen: string[] = [];
      const command = resolveSidecarCommand(HOST, PORT, {
        ...baseContext,
        isPackaged: true,
        platform: 'win32',
        fileExists: (filePath) => {
          seen.push(filePath);
          return filePath.endsWith('ffprobe.exe');
        },
      });
      expect(command.env).toEqual({
        ...ROOT_ENV,
        FRAMEPILOT_FFPROBE: path.join(BUNDLE_DIR, 'ffprobe.exe'),
      });
      expect(seen).not.toContain(path.join(BUNDLE_DIR, 'whisper-cli.exe'));
    });

    it('never overrides a user-supplied helper env var', () => {
      const command = resolveSidecarCommand(HOST, PORT, {
        ...baseContext,
        isPackaged: true,
        env: { FRAMEPILOT_FFPROBE: '/usr/local/bin/ffprobe' },
        fileExists: () => true,
      });
      expect(command.env).toEqual(ROOT_ENV);
    });

    it('adds no helper env in dev — the source engine keeps PATH/imageio discovery', () => {
      const command = resolveSidecarCommand(HOST, PORT, {
        ...baseContext,
        fileExists: () => true,
      });
      expect(command.env).toEqual(ROOT_ENV);
    });
  });
});
