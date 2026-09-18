import { spawn } from 'node:child_process';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityPackWorkerRequest } from '../worker-protocol.js';
import { CapabilityPackWarmWorker } from './warm-worker.js';
import type { CapabilityPackWorkerLauncher } from './worker-client.js';

const fixture = fileURLToPath(new URL('./__fixtures__/warm-worker.mjs', import.meta.url));
const sessions: CapabilityPackWarmWorker[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

function launcher(
  scenario: string,
  spawned: { count: number; env?: Readonly<Record<string, string>>; args?: readonly string[] },
): CapabilityPackWorkerLauncher {
  return (_entrypoint, args, env) => {
    spawned.count += 1;
    spawned.env = env;
    spawned.args = args;
    return spawn(process.execPath, [fixture, scenario], {
      shell: false,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

function session(
  scenario: string,
  spawned = { count: 0 },
  extra: Partial<ConstructorParameters<typeof CapabilityPackWarmWorker>[0]> = {},
): CapabilityPackWarmWorker {
  const created = new CapabilityPackWarmWorker({
    entrypoint: '/signed/worker',
    launch: launcher(scenario, spawned),
    ...extra,
  });
  sessions.push(created);
  return created;
}

async function sandbox(): Promise<{ root: string; media: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-warm-'));
  const media = path.join(root, 'shot.mp4');
  await writeFile(media, 'fixture');
  return { root, media };
}

function request(media: string, id: string, pts = 1024): CapabilityPackWorkerRequest {
  return {
    type: 'request',
    protocolVersion: 1,
    requestId: id,
    projectRevision: 3,
    capability: 'subject.segment_frame',
    media: {
      handleId: 'media:hover',
      assetId: 'asset-1',
      absolutePath: media,
      sourceStartSeconds: 1,
      sourceEndSeconds: 1.04,
      fps: 25,
      firstFrame: 25,
      lastFrameExclusive: 26,
    },
    parameters: { pts, hoverPoint: { x: 0.5, y: 0.5 }, previewHeight: 360 },
  };
}

describe('CapabilityPackWarmWorker (BR6.11)', () => {
  it('answers many requests from ONE warm process in the scrubbed environment', async () => {
    const { root, media } = await sandbox();
    const spawned: {
      count: number;
      env?: Readonly<Record<string, string>>;
      args?: readonly string[];
    } = { count: 0 };
    process.env.SECRET_SHOULD_NOT_LEAK = 'x';
    const warm = session('success', spawned, {
      extraEnvironment: { FRAMEPILOT_CAPABILITY_PACK_ROOT: '/packs/smart-mask' },
    });
    for (let index = 0; index < 5; index += 1) {
      const result = await warm.segmentFrame({
        request: request(media, `hover-${index}`, 1024 + index),
        mediaRoot: root,
      });
      expect(result).toMatchObject({
        capability: 'subject.segment_frame',
        pts: 1024 + index,
        score: 0.9,
      });
    }
    expect(spawned.count).toBe(1);
    expect(spawned.args).toEqual(['--framepilot-worker-warm']);
    expect(spawned.env?.FRAMEPILOT_CAPABILITY_PACK_NETWORK).toBe('disabled');
    expect(spawned.env?.FRAMEPILOT_CAPABILITY_PACK_ROOT).toBe('/packs/smart-mask');
    expect(spawned.env?.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    delete process.env.SECRET_SHOULD_NOT_LEAK;
    expect(warm.running).toBe(true);
  });

  it('refuses a capability with a write handle and media outside the root, before spawning', async () => {
    const { root, media } = await sandbox();
    const outside = await sandbox();
    const escape = path.join(root, 'escape.mp4');
    await symlink(outside.media, escape);
    const spawned = { count: 0 };
    const warm = session('success', spawned);
    const matte = {
      ...request(media, 'm'),
      capability: 'tracking.region',
      parameters: { region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    };
    await expect(
      warm.segmentFrame({
        request: matte as unknown as CapabilityPackWorkerRequest,
        mediaRoot: root,
      }),
    ).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(
      warm.segmentFrame({ request: request(escape, 'e'), mediaRoot: root }),
    ).rejects.toMatchObject({ code: 'media_escape' });
    expect(spawned.count).toBe(0);
  });

  it('cancels an in-flight request with the typed cancel and keeps the process for the next one', async () => {
    const { root, media } = await sandbox();
    const spawned = { count: 0 };
    const warm = session('hang', spawned, { requestTimeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = warm.segmentFrame({
      request: request(media, 'slow'),
      mediaRoot: root,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(warm.running).toBe(true);
    expect(spawned.count).toBe(1);
  });

  it('never sends a request that was aborted before its turn', async () => {
    const { root, media } = await sandbox();
    const warm = session('success');
    const controller = new AbortController();
    controller.abort();
    await expect(
      warm.segmentFrame({
        request: request(media, 'late'),
        mediaRoot: root,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it.each([
    ['wrong-pts', 'does not match'],
    ['handshake', 'invalid runtime message'],
    ['foreign', 'nobody asked'],
    ['malformed', 'malformed JSON'],
  ])(
    'kills the process on a %s answer and starts a fresh one next time',
    async (scenario, fragment) => {
      const { root, media } = await sandbox();
      const spawned = { count: 0 };
      const warm = session(scenario, spawned);
      await expect(
        warm.segmentFrame({ request: request(media, 'bad'), mediaRoot: root }),
      ).rejects.toThrow(fragment);
      expect(warm.running).toBe(false);
      await expect(
        warm.segmentFrame({ request: request(media, 'again'), mediaRoot: root }),
      ).rejects.toThrow(fragment);
      expect(spawned.count).toBe(2);
    },
  );

  it('fails the request whose worker died, then recovers', async () => {
    const { root, media } = await sandbox();
    const spawned = { count: 0 };
    const warm = session('crash-second', spawned);
    await warm.segmentFrame({ request: request(media, 'one'), mediaRoot: root });
    await expect(
      warm.segmentFrame({ request: request(media, 'two'), mediaRoot: root }),
    ).rejects.toMatchObject({ code: 'worker_failed' });
    await expect(
      warm.segmentFrame({ request: request(media, 'three'), mediaRoot: root }),
    ).resolves.toMatchObject({ pts: 1024 });
    expect(spawned.count).toBe(2);
  });

  it('times out a silent worker and ends an idle one', async () => {
    const { root, media } = await sandbox();
    const silent = session('hang', { count: 0 }, { requestTimeoutMs: 150 });
    await expect(
      silent.segmentFrame({ request: request(media, 'quiet'), mediaRoot: root }),
    ).rejects.toMatchObject({ code: 'timed_out' });
    expect(silent.running).toBe(false);
    const idle = session('success', { count: 0 }, { idleMs: 50 });
    await idle.segmentFrame({ request: request(media, 'once'), mediaRoot: root });
    expect(idle.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(idle.running).toBe(false);
  });
});
