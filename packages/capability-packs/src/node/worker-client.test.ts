import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CapabilityPackWorkerRequest } from '../worker-protocol.js';
import {
  CapabilityPackWorkerRuntimeError,
  runCapabilityPackWorker,
  type CapabilityPackWorkerLauncher,
} from './worker-client.js';

const fixture = fileURLToPath(new URL('./__fixtures__/worker-runtime.mjs', import.meta.url));

function launcher(scenario: string): CapabilityPackWorkerLauncher {
  return (_entrypoint, _args, env) =>
    spawn(process.execPath, [fixture, scenario], {
      shell: false,
      windowsHide: true,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}

async function sandbox(): Promise<{ root: string; media: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-worker-client-'));
  const media = path.join(root, 'shot.mp4');
  await writeFile(media, 'fixture');
  return { root, media };
}

function request(media: string): CapabilityPackWorkerRequest {
  return {
    type: 'request',
    protocolVersion: 1,
    requestId: 'track:clip-1',
    projectRevision: 4,
    capability: 'tracking.region',
    media: {
      handleId: 'media:clip-1',
      assetId: 'asset-1',
      absolutePath: media,
      sourceStartSeconds: 0,
      sourceEndSeconds: 2,
      fps: 30,
      firstFrame: 0,
      lastFrameExclusive: 60,
    },
    parameters: { region: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } },
  };
}

describe('runCapabilityPackWorker environment contract', () => {
  it('merges FRAMEPILOT_-prefixed extras after the scrub and drops everything else', async () => {
    const { root, media } = await sandbox();
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const capturingLauncher: CapabilityPackWorkerLauncher = (entrypoint, args, env) => {
      seenEnv = env;
      return launcher('success')(entrypoint, args, env);
    };
    process.env.FRAMEPILOT_CAPABILITY_PACK_ROOT = '';
    delete process.env.SECRET_SHOULD_NOT_LEAK;
    await runCapabilityPackWorker({
      entrypoint: '/signed/worker',
      mediaRoot: root,
      request: request(media),
      launch: capturingLauncher,
      extraEnvironment: {
        FRAMEPILOT_CAPABILITY_PACK_ROOT: '/packs/framepilot.subject-intelligence/1.0.0',
        SECRET_TOKEN: 'nope',
        'lowercase_key': 'nope',
      },
    });
    expect(seenEnv?.FRAMEPILOT_CAPABILITY_PACK_NETWORK).toBe('disabled');
    expect(seenEnv?.FRAMEPILOT_CAPABILITY_PACK_ROOT).toBe(
      '/packs/framepilot.subject-intelligence/1.0.0',
    );
    expect(seenEnv?.SECRET_TOKEN).toBeUndefined();
    expect(seenEnv?.['lowercase_key']).toBeUndefined();
  });

  it('never lets extras override the host-owned sandbox or identity keys', async () => {
    const { root, media } = await sandbox();
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const capturingLauncher: CapabilityPackWorkerLauncher = (entrypoint, args, env) => {
      seenEnv = env;
      return launcher('success')(entrypoint, args, env);
    };
    await runCapabilityPackWorker({
      entrypoint: '/signed/worker',
      mediaRoot: root,
      request: request(media),
      launch: capturingLauncher,
      extraEnvironment: {
        FRAMEPILOT_CAPABILITY_PACK_ROOT: '/packs/root',
        FRAMEPILOT_CAPABILITY_PACK_NETWORK: 'enabled',
        FRAMEPILOT_CAPABILITY_PACK_RUNTIME: '0',
      },
    });
    expect(seenEnv?.FRAMEPILOT_CAPABILITY_PACK_NETWORK).toBe('disabled');
    expect(seenEnv?.FRAMEPILOT_CAPABILITY_PACK_RUNTIME).toBe('1');
  });
});

describe('runCapabilityPackWorker temp folder (BR4.12 follow-up F3)', () => {
  it('points TMPDIR, TEMP and TMP at the host temp directory, never the desktop temp folder', async () => {
    const { root, media } = await sandbox();
    const temp = path.join(root, 'scratch-tmp');
    await mkdir(temp);
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const capturingLauncher: CapabilityPackWorkerLauncher = (entrypoint, args, env) => {
      seenEnv = env;
      return launcher('success')(entrypoint, args, env);
    };
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = '/desktop/tmp';
    try {
      await runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: request(media),
        launch: capturingLauncher,
        temporaryDirectory: temp,
        extraEnvironment: { FRAMEPILOT_TMPDIR: '/elsewhere' },
      });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect(seenEnv?.TMPDIR).toBe(temp);
    expect(seenEnv?.TEMP).toBe(temp);
    expect(seenEnv?.TMP).toBe(temp);
  });

  it('refuses a temp directory that is a link, missing, or outside the staging root', async () => {
    const { root, media } = await sandbox();
    const real = path.join(root, 'real');
    await mkdir(real);
    const linked = path.join(root, 'linked');
    await symlink(real, linked);
    for (const temporaryDirectory of [linked, path.join(root, 'missing')]) {
      await expect(
        runCapabilityPackWorker({
          entrypoint: '/signed/worker',
          mediaRoot: root,
          request: request(media),
          launch: neverLaunchWorker,
          temporaryDirectory,
        }),
      ).rejects.toMatchObject({ code: 'media_escape' });
    }
    const stagingRoot = path.join(root, 'staging');
    await mkdir(stagingRoot);
    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        outputRoot: stagingRoot,
        request: request(media),
        launch: neverLaunchWorker,
        temporaryDirectory: real,
      }),
    ).rejects.toMatchObject({ code: 'media_escape' });
  });
});

const neverLaunchWorker: CapabilityPackWorkerLauncher = () => {
  throw new Error('must not launch');
};

describe('runCapabilityPackWorker', () => {
  it('runs one bounded request and verifies progress/result identity', async () => {
    const { root, media } = await sandbox();
    const progress: number[] = [];
    const result = await runCapabilityPackWorker({
      entrypoint: '/signed/worker',
      mediaRoot: root,
      request: request(media),
      launch: launcher('success'),
      onProgress: (event) => progress.push(event.completed),
    });
    expect(progress).toEqual([1]);
    expect(result).toMatchObject({
      projectRevision: 4,
      capability: 'tracking.region',
      backend: 'fixture-tracker',
      samples: [{ frame: 0, confidence: 0.95, occluded: false }],
    });
  });

  it('rejects path and symlink escapes before starting a worker', async () => {
    const { root } = await sandbox();
    const outside = await mkdtemp(path.join(tmpdir(), 'framepilot-worker-outside-'));
    const externalMedia = path.join(outside, 'secret.mp4');
    await writeFile(externalMedia, 'secret');
    let launched = false;
    const refusingLauncher: CapabilityPackWorkerLauncher = (...args) => {
      launched = true;
      return launcher('success')(...args);
    };
    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: request(externalMedia),
        launch: refusingLauncher,
      }),
    ).rejects.toMatchObject({ code: 'media_escape' });

    const links = path.join(root, 'links');
    await mkdir(links);
    const escapedLink = path.join(links, 'shot.mp4');
    await symlink(externalMedia, escapedLink);
    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: request(escapedLink),
        launch: refusingLauncher,
      }),
    ).rejects.toMatchObject({ code: 'media_escape' });
    expect(launched).toBe(false);
  });

  it('sandbox-checks EVERY capability that is not on the media-free list', async () => {
    // The guard used to read `if ('media' in request)`, which made the path sandbox
    // conditional on a property NAME: a request type carrying its path under any other key
    // would have skipped the check with no compile error and no failing test. The exemption
    // is a closed list of capabilities now, so this asserts the property that matters —
    // a capability nobody exempted is checked, whatever shape its payload has.
    const root = await mkdtemp(path.join(tmpdir(), 'framepilot-worker-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'framepilot-worker-outside-'));
    const externalMedia = path.join(outside, 'secret.mp4');
    await writeFile(externalMedia, 'secret');
    let launched = false;
    const refusingLauncher: CapabilityPackWorkerLauncher = (...args) => {
      launched = true;
      return launcher('success')(...args);
    };

    const base = request(externalMedia);
    const shapes: CapabilityPackWorkerRequest[] = [
      base,
      {
        ...base,
        capability: 'visual.embed',
        parameters: { promptBankVersion: 1, shots: [{ shotIndex: 0, keyframeT: 0.5 }] },
      } as CapabilityPackWorkerRequest,
      {
        ...base,
        capability: 'visual.describe',
        parameters: { tier2Version: 1, shots: [{ shotIndex: 0, t0: 0, t1: 1 }] },
      } as CapabilityPackWorkerRequest,
    ];
    for (const shape of shapes) {
      await expect(
        runCapabilityPackWorker({
          entrypoint: '/signed/worker',
          mediaRoot: root,
          request: shape,
          launch: refusingLauncher,
        }),
      ).rejects.toMatchObject({ code: 'media_escape' });
    }
    // Nothing was launched: the sandbox refuses before the process starts, on every one.
    expect(launched).toBe(false);
  });

  it('rejects malformed and stale worker output', async () => {
    const { root, media } = await sandbox();
    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: request(media),
        launch: launcher('malformed'),
      }),
    ).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: request(media),
        launch: launcher('mismatch'),
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it('sends typed cancellation and enforces a timeout', async () => {
    const { root, media } = await sandbox();
    const controller = new AbortController();
    const cancelled = runCapabilityPackWorker({
      entrypoint: '/signed/worker',
      mediaRoot: root,
      request: request(media),
      launch: launcher('hang'),
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });

    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: request(media),
        launch: launcher('hang'),
        timeoutMs: 5,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityPackWorkerRuntimeError>>({ code: 'timed_out' }),
    );
  });
});

describe('runCapabilityPackWorker write handles (MD-3)', () => {
  async function matteSandbox() {
    const { root, media } = await sandbox();
    const stagingRoot = path.join(root, '.framepilot-derived', 'mattes', '.staging');
    const output = path.join(stagingRoot, 'req-1');
    await mkdir(path.join(output, 'inputs'), { recursive: true });
    return { root, media, stagingRoot, output };
  }
  function matteRequest(media: string, output: string, inputs?: string): CapabilityPackWorkerRequest {
    return {
      ...request(media),
      requestId: 'matte:req-1',
      capability: 'subject.matte',
      parameters: {
        output: {
          handleId: 'matte-out:req-1',
          absolutePath: output,
          allowedFiles: ['matte.mkv', 'frames.json'],
          maxBytes: 1_000_000,
        },
        ...(inputs === undefined
          ? {}
          : {
              inputs: {
                handleId: 'matte-in:req-1',
                absolutePath: inputs,
                files: ['locked/0.png'],
              },
            }),
        prompts: [
          { kind: 'box', pts: 0, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
          ...(inputs === undefined ? [] : [{ kind: 'lock' as const, pts: 0, file: 'locked/0.png' }]),
        ],
        previewHeight: 540,
      },
    } as CapabilityPackWorkerRequest;
  }
  const neverLaunch: CapabilityPackWorkerLauncher = () => {
    throw new Error('the worker must not start');
  };

  it('refuses a write handle without a staging root to check it against', async () => {
    const { root, media, output } = await matteSandbox();
    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: matteRequest(media, output),
        launch: neverLaunch,
      }),
    ).rejects.toMatchObject({ code: 'media_escape' });
  });

  it('refuses output or inputs outside the staging root, the root itself, and symlinks', async () => {
    const { root, media, stagingRoot, output } = await matteSandbox();
    const outside = path.join(root, 'elsewhere');
    await mkdir(outside);
    const linked = path.join(stagingRoot, 'linked');
    await symlink(outside, linked);
    for (const [out, inputs] of [
      [outside, undefined],
      [stagingRoot, undefined],
      [linked, undefined],
      [output, outside],
      [path.join(stagingRoot, 'missing'), undefined],
    ] as const) {
      await expect(
        runCapabilityPackWorker({
          entrypoint: '/signed/worker',
          mediaRoot: root,
          outputRoot: stagingRoot,
          request: matteRequest(media, out, inputs),
          launch: neverLaunch,
        }),
      ).rejects.toMatchObject({ code: 'media_escape' });
    }
  });

  it('starts the worker when both handles are host-created directories inside the root', async () => {
    const { root, media, stagingRoot, output } = await matteSandbox();
    let started = false;
    const launch: CapabilityPackWorkerLauncher = (entrypoint, args, env) => {
      started = true;
      return launcher('malformed')(entrypoint, args, env);
    };
    await expect(
      runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        outputRoot: stagingRoot,
        request: matteRequest(media, output, path.join(output, 'inputs')),
        launch,
      }),
    ).rejects.toMatchObject({ code: 'protocol_error' });
    expect(started).toBe(true);
  });
});

describe('runCapabilityPackWorker process group (BR4.12 H1)', () => {
  it.skipIf(process.platform === 'win32')(
    'settles when a descendant holds stdout, and kills that descendant before resolving',
    async () => {
      const { readFile } = await import('node:fs/promises');
      const { workerGroupSpawnOptions } = await import('./process-group.js');
      const { root, media } = await sandbox();
      const pidFile = path.join(root, 'linger.pid');
      const groupLauncher: CapabilityPackWorkerLauncher = (_entrypoint, _args, env) =>
        spawn(process.execPath, [fixture, 'lingering'], {
          shell: false,
          env: { ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          ...workerGroupSpawnOptions(),
        });
      const started = Date.now();
      const result = await runCapabilityPackWorker({
        entrypoint: '/signed/worker',
        mediaRoot: root,
        request: request(media),
        launch: groupLauncher,
        extraEnvironment: { FRAMEPILOT_FIXTURE_PID_FILE: pidFile },
        timeoutMs: 20_000,
      });
      expect(result.capability).toBe('tracking.region');
      expect(Date.now() - started).toBeLessThan(10_000);
      const lingering = Number(await readFile(pidFile, 'utf8'));
      expect(() => process.kill(lingering, 0)).toThrow();
    },
  );

  it('kills and waits for the whole group', async () => {
    const { ensureWorkerGroupGone, isWorkerGroupAlive, killWorkerGroup } = await import('./process-group.js');
    const alive = new Set([-42, 42]);
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      if (!alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') {
        alive.delete(-42);
        alive.delete(42);
      }
    };
    expect(isWorkerGroupAlive(42, { kill, platform: 'darwin' })).toBe(true);
    expect(await ensureWorkerGroupGone(42, 200, { kill, platform: 'darwin' })).toBe(true);
    expect(killWorkerGroup(undefined)).toBe('none');
    const trees: number[] = [];
    expect(killWorkerGroup(7, { platform: 'win32', killTree: (pid) => void trees.push(pid) })).toBe('group');
    expect(trees).toEqual([7]);
    const stubborn = (_pid: number, _signal: NodeJS.Signals | 0) => undefined;
    expect(await ensureWorkerGroupGone(9, 60, { kill: stubborn, platform: 'linux' })).toBe(false);
  });
});
