import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityPackArtifact } from '../contracts.js';
import type {
  CapabilityPackInstallApproval,
  CapabilityPackInstallIdentity,
  CapabilityPackInstallProgress,
} from '../install-contracts.js';
import { CapabilityPackDownloadError, CapabilityPackDownloader } from './downloader.js';

const roots: string[] = [];
const bytes = new TextEncoder().encode('immutable capability pack bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const etag = '"artifact-v1"';
const identity: CapabilityPackInstallIdentity = {
  id: 'framepilot.tracking-lite',
  version: '1.0.0',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: digest,
  os: 'darwin',
  arch: 'arm64',
};
const artifact: CapabilityPackArtifact = {
  os: 'darwin',
  arch: 'arm64',
  url: 'https://packs.framepilot.ai/tracking-lite.zip',
  sha256: digest,
  sizeBytes: bytes.byteLength,
  unpackedSizeBytes: bytes.byteLength,
  format: 'raw',
  entrypoint: 'tracking-worker',
  maxFileCount: 1,
  files: ['tracking-worker'],
  executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
};
const approval: CapabilityPackInstallApproval = {
  identity,
  approvedSizeBytes: bytes.byteLength,
  approvedLicenseSpdx: ['MIT'],
  approvedMediaEgress: false,
  approvedAt: '2026-08-13T00:00:00.000Z',
};

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-downloader-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function response(body: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { etag, 'content-length': String(body.byteLength) },
    ...init,
  });
}

function request(
  overrides: Partial<{
    approval: CapabilityPackInstallApproval;
    signal: AbortSignal;
    onProgress: (progress: CapabilityPackInstallProgress) => void;
  }> = {},
) {
  return {
    operationId: '5d378174-65a8-4a6e-9262-39f130c58e79',
    identity,
    artifact,
    approval,
    ...overrides,
  };
}

describe('CapabilityPackDownloader', () => {
  it('downloads, verifies, and content-addresses an explicitly approved artifact', async () => {
    const root = await createRoot();
    const progress: CapabilityPackInstallProgress[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(bytes));
    const downloader = new CapabilityPackDownloader(root, {
      fetch: fetchMock,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    const result = await downloader.download(request({ onProgress: (event) => progress.push(event) }));

    expect(await readFile(result.filePath)).toEqual(Buffer.from(bytes));
    expect(path.basename(result.filePath)).toBe(`${digest}.artifact`);
    expect(progress.map((event) => event.phase)).toEqual(
      expect.arrayContaining(['reserving_space', 'downloading', 'verifying']),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('shares one in-flight immutable download between concurrent callers', async () => {
    const root = await createRoot();
    let resolveResponse: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const downloader = new CapabilityPackDownloader(root, {
      fetch: fetchMock,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    const first = downloader.download(request());
    const second = downloader.download(request());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveResponse?.(response(bytes));

    expect(await first).toEqual(await second);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('resumes only with the same strong ETag and matching Content-Range', async () => {
    const root = await createRoot();
    const offset = 10;
    await writeFile(path.join(root, `${digest}.partial`), bytes.slice(0, offset));
    await writeFile(
      path.join(root, `${digest}.partial.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        url: artifact.url,
        artifactDigest: digest,
        expectedBytes: bytes.byteLength,
        etag,
      })}\n`,
      'utf8',
    );
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get('range')).toBe(`bytes=${offset}-`);
      expect(new Headers(init?.headers).get('if-range')).toBe(etag);
      return response(bytes.slice(offset), {
        status: 206,
        headers: {
          etag,
          'content-range': `bytes ${offset}-${bytes.byteLength - 1}/${bytes.byteLength}`,
        },
      });
    });
    const downloader = new CapabilityPackDownloader(root, {
      fetch: fetchMock,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    const result = await downloader.download(request());

    expect(result.resumedFromBytes).toBe(offset);
    expect(await readFile(result.filePath)).toEqual(Buffer.from(bytes));
  });

  it('restarts instead of appending when a server cannot honor the partial', async () => {
    const root = await createRoot();
    const offset = 5;
    await writeFile(path.join(root, `${digest}.partial`), bytes.slice(0, offset));
    await writeFile(
      path.join(root, `${digest}.partial.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        url: artifact.url,
        artifactDigest: digest,
        expectedBytes: bytes.byteLength,
        etag,
      })}\n`,
      'utf8',
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(bytes))
      .mockResolvedValueOnce(response(bytes));
    const downloader = new CapabilityPackDownloader(root, {
      fetch: fetchMock,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    const result = await downloader.download(request());

    expect(result.resumedFromBytes).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFile(result.filePath)).toEqual(Buffer.from(bytes));
  });

  it('fails before network access when approval or free space does not match', async () => {
    const root = await createRoot();
    const fetchMock = vi.fn<typeof fetch>();
    const noSpace = new CapabilityPackDownloader(root, {
      fetch: fetchMock,
      availableBytes: async () => 0,
    });
    await expect(noSpace.download(request())).rejects.toMatchObject({ code: 'insufficient_space' });
    expect(fetchMock).not.toHaveBeenCalled();

    const wrongApproval = { ...approval, approvedSizeBytes: approval.approvedSizeBytes + 1 };
    await expect(noSpace.download(request({ approval: wrongApproval }))).rejects.toMatchObject({
      code: 'approval_required',
    });
  });

  it('deletes corrupt bytes and reports a typed digest failure', async () => {
    const root = await createRoot();
    const corrupt = new TextEncoder().encode('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(corrupt.byteLength).toBe(bytes.byteLength);
    const downloader = new CapabilityPackDownloader(root, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response(corrupt)),
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    await expect(downloader.download(request())).rejects.toBeInstanceOf(CapabilityPackDownloadError);
    await expect(stat(path.join(root, `${digest}.partial`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves safe partial bytes when cancellation interrupts streaming', async () => {
    const root = await createRoot();
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(bytes.slice(0, 8));
        streamController.enqueue(bytes.slice(8));
        streamController.close();
      },
    });
    const downloader = new CapabilityPackDownloader(root, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { etag, 'content-length': String(bytes.byteLength) },
        }),
      ),
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });

    await expect(
      downloader.download(
        request({
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === 'downloading' && progress.completedBytes === 8) controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'download_cancelled' });
    expect(await readFile(path.join(root, `${digest}.partial`))).toEqual(Buffer.from(bytes.slice(0, 8)));
  });
});
