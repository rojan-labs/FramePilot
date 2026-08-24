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
