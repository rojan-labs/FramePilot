import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityPackArtifact } from '../contracts.js';
import type {
  CapabilityPackInstallApproval,
  CapabilityPackInstallIdentity,
} from '../install-contracts.js';
import {
  CapabilityPackDownloader,
  CapabilityPackDownloadError,
} from './downloader.js';
import { identityKey } from './storage.js';

const roots: string[] = [];
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fp-pack-download-boundary-'));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function request(bytes: Uint8Array, releaseDigit: string): {
  identity: CapabilityPackInstallIdentity;
  artifact: CapabilityPackArtifact;
  approval: CapabilityPackInstallApproval;
} {
  const sha = digest(bytes);
  const releaseDigest = releaseDigit.repeat(64);
  const identity: CapabilityPackInstallIdentity = {
    id: 'tracking-lite',
    version: '1.0.0',
    releaseDigest,
    os: 'darwin',
    arch: 'arm64',
    artifactDigest: sha,
  };
  const artifact: CapabilityPackArtifact = {
    os: 'darwin',
    arch: 'arm64',
    url: 'https://packs.example/tracking-lite.bin',
    sha256: sha,
    sizeBytes: bytes.byteLength,
    unpackedSizeBytes: bytes.byteLength * 4,
    format: 'raw',
    entrypoint: 'worker',
    files: ['worker'],
    maxFileCount: 1,
    executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDEFGHIJ' },
  };
  const approval: CapabilityPackInstallApproval = {
    identity,
    approvedSizeBytes: bytes.byteLength,
    approvedLicenseSpdx: ['MIT'],
    approvedMediaEgress: false,
    approvedAt: new Date().toISOString(),
  };
  return { identity, artifact, approval };
}

describe('CapabilityPackDownloader runtime boundaries', () => {
  it('keeps subscriber cancellation independent while sharing immutable bytes', async () => {
    const bytes = new TextEncoder().encode('shared immutable artifact');
    let fetches = 0;
    const downloader = new CapabilityPackDownloader(await root(), {
      availableBytes: async () => 1_000_000_000,
      fetch: async () => {
        fetches += 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 8));
            setTimeout(() => {
              controller.enqueue(bytes.subarray(8));
              controller.close();
            }, 0);
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { etag: '"shared-v1"' },
        });
      },
    });
    const first = request(bytes, '1');
    const second = request(bytes, '2');
    const abortFirst = new AbortController();

    const firstDownload = downloader.download({
      operationId: randomUUID(),
      ...first,
      signal: abortFirst.signal,
      onProgress: (progress) => {
        if (progress.phase === 'downloading' && progress.completedBytes > 0) abortFirst.abort();
      },
    });
    const secondDownload = downloader.download({ operationId: randomUUID(), ...second });

    await expect(firstDownload).rejects.toMatchObject({ code: 'download_cancelled' });
    const completed = await secondDownload;
    expect(completed.identity.releaseDigest).toBe(second.identity.releaseDigest);
    expect(fetches).toBe(1);
  });

  it('starts fresh work when the final subscriber cancels and a new caller arrives immediately', async () => {
    const bytes = new TextEncoder().encode('handoff-after-cancel');
    const selected = request(bytes, '5');
    let fetches = 0;
    const downloader = new CapabilityPackDownloader(await root(), {
      availableBytes: async () => 1_000_000_000,
      fetch: async () => {
        fetches += 1;
        return new Response(bytes, { status: 200, headers: { etag: '"handoff-v2"' } });
      },
    });
    const firstAbort = new AbortController();
    const first = downloader.download({
      operationId: randomUUID(),
      ...selected,
      signal: firstAbort.signal,
    });

    // Abort synchronously, before the first task's `downloadOnce` gets past its first await
    // (`mkdir`). Its own `throwIfAborted` check then rejects it without ever calling `fetch` —
    // so the physical task genuinely never starts network work, it does not just cancel an
    // in-flight one. The new subscriber arrives in this same handoff interval, which used to
    // find the already-aborted task still cached in `inFlight`.
    firstAbort.abort();
    const second = downloader.download({ operationId: randomUUID(), ...selected });

    await expect(first).rejects.toMatchObject({ code: 'download_cancelled' });
    await expect(second).resolves.toMatchObject({ bytes: bytes.byteLength });
    // Only the second (fresh) task ever reaches `fetch` — proof the handoff created a new
    // task rather than letting `second` inherit `first`'s stale, already-aborted one.
    expect(fetches).toBe(1);
  });

  it('accepts a fresh signed download without an ETag', async () => {
    const bytes = new TextEncoder().encode('fresh-no-etag');
    const selected = request(bytes, '3');
    const downloader = new CapabilityPackDownloader(await root(), {
      availableBytes: async () => 1_000_000_000,
      fetch: async () => new Response(bytes, { status: 200 }),
    });

    await expect(
      downloader.download({ operationId: randomUUID(), ...selected }),
    ).resolves.toMatchObject({ bytes: bytes.byteLength });
  });

  it('reserves signed unpacked staging bytes before downloading', async () => {
    const bytes = new Uint8Array(1024);
    const selected = request(bytes, '4');
    const downloader = new CapabilityPackDownloader(await root(), {
      availableBytes: async () => 16 * 1024 * 1024 + bytes.byteLength,
      fetch: async () => new Response(bytes, { status: 200 }),
    });

    const result = downloader.download({ operationId: randomUUID(), ...selected });
    await expect(result).rejects.toBeInstanceOf(CapabilityPackDownloadError);
    await expect(result).rejects.toMatchObject({ code: 'insufficient_space' });
  });

  it('treats two signed releases over the same artifact as different logical identities', () => {
    const bytes = new TextEncoder().encode('same bytes');
    const first = request(bytes, 'a').identity;
    const second = request(bytes, 'b').identity;
    expect(first.artifactDigest).toBe(second.artifactDigest);
    expect(identityKey(first)).not.toBe(identityKey(second));
  });
});
