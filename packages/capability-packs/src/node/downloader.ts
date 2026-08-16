import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import { CapabilityPackArtifactSchema, type CapabilityPackArtifact } from '../contracts.js';
import {
  CapabilityPackInstallApprovalSchema,
  CapabilityPackInstallIdentitySchema,
  type CapabilityPackInstallApproval,
  type CapabilityPackInstallIdentity,
  type CapabilityPackInstallProgress,
} from '../install-contracts.js';
import { artifactIdentityKey, identityKey } from './storage.js';

const log = createLogger('capability-packs:downloader');
const DOWNLOAD_OVERHEAD_BYTES = 16 * 1024 * 1024;

interface PartialMetadata {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly artifactDigest: string;
  readonly expectedBytes: number;
  readonly etag: string;
}

export interface CapabilityPackDownloadRequest {
  readonly operationId: string;
  readonly identity: CapabilityPackInstallIdentity;
  readonly artifact: CapabilityPackArtifact;
  readonly approval: CapabilityPackInstallApproval;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CapabilityPackInstallProgress) => void;
}

export interface DownloadedCapabilityPackArtifact {
  readonly identity: CapabilityPackInstallIdentity;
  readonly filePath: string;
  readonly bytes: number;
  readonly resumedFromBytes: number;
}

interface PhysicalDownloadResult {
  readonly filePath: string;
  readonly bytes: number;
  readonly resumedFromBytes: number;
}

interface DownloadSubscriber {
  readonly request: CapabilityPackDownloadRequest;
  readonly resolve: (result: DownloadedCapabilityPackArtifact) => void;
  readonly reject: (error: unknown) => void;
  readonly abort?: () => void;
}

interface SharedDownloadTask {
  readonly key: string;
  readonly controller: AbortController;
  readonly subscribers: Set<DownloadSubscriber>;
  readonly promise: Promise<PhysicalDownloadResult>;
}

export class CapabilityPackDownloadError extends Error {
  constructor(
    public readonly code:
      | 'approval_required'
      | 'insufficient_space'
      | 'download_failed'
      | 'download_cancelled'
      | 'artifact_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackDownloadError';
  }
}

export interface CapabilityPackDownloaderOptions {
  readonly fetch?: typeof fetch;
  readonly availableBytes?: (directory: string) => Promise<number>;
}

/**
 * Resumable, content-addressed download authority.
 *
 * Physical bytes are shared by immutable artifact digest, but callers remain independent
 * subscribers: each keeps its own operation id, progress observer and cancellation. The
 * physical request is cancelled only when its final subscriber leaves.
 */
export class CapabilityPackDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly availableBytes: (directory: string) => Promise<number>;
  private readonly inFlight = new Map<string, SharedDownloadTask>();

  constructor(
    private readonly downloadRoot: string,
    options: CapabilityPackDownloaderOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.availableBytes = options.availableBytes ?? availableDiskBytes;
  }

  download(requestInput: CapabilityPackDownloadRequest): Promise<DownloadedCapabilityPackArtifact> {
    let request: CapabilityPackDownloadRequest;
    try {
      request = validateRequest(requestInput);
    } catch (error) {
      return Promise.reject(error);
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(
        new CapabilityPackDownloadError('download_cancelled', 'Capability Pack download cancelled.'),
      );
    }

    const key = artifactIdentityKey(request.identity);
    let task = this.inFlight.get(key);
    if (task === undefined) {
      task = this.createTask(key, request);
      this.inFlight.set(key, task);
    }
    return this.subscribe(task, request);
  }

  private createTask(
    key: string,
    seed: CapabilityPackDownloadRequest,
  ): SharedDownloadTask {
    const controller = new AbortController();
    const subscribers = new Set<DownloadSubscriber>();
    const physicalRequest: CapabilityPackDownloadRequest = {
      ...seed,
      signal: controller.signal,
      onProgress: (progress) => {
        for (const subscriber of [...subscribers]) {
          emitProgress(subscriber.request, progress.phase, progress.completedBytes, progress.detail);
        }
      },
    };
    const task = {} as SharedDownloadTask;
    const promise = this.downloadOnce(physicalRequest).finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    });
    Object.assign(task, { key, controller, subscribers, promise });
    return task;
  }

  private subscribe(
    task: SharedDownloadTask,
    request: CapabilityPackDownloadRequest,
  ): Promise<DownloadedCapabilityPackArtifact> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: PhysicalDownloadResult): void => {
        if (settled) return;
        settled = true;
        if (subscriber.abort !== undefined) request.signal?.removeEventListener('abort', subscriber.abort);
        task.subscribers.delete(subscriber);
        if (error !== undefined) reject(error);
        else if (result !== undefined) resolve({ ...result, identity: request.identity });
      };
      const abort = (): void => {
        finish(
          new CapabilityPackDownloadError('download_cancelled', 'Capability Pack download cancelled.'),
        );
        if (task.subscribers.size === 0) {
          // Detach synchronously before aborting the physical task. The physical promise settles
          // on a later microtask; without this handoff, a new caller can subscribe to the already
          // aborted task and inherit somebody else's cancellation.
          if (this.inFlight.get(task.key) === task) this.inFlight.delete(task.key);
          task.controller.abort();
        }
      };
      const subscriber: DownloadSubscriber = { request, resolve, reject, abort };
      task.subscribers.add(subscriber);
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted === true) {
        abort();
        return;
      }
      void task.promise.then(
        (result) => finish(undefined, result),
        (error) => finish(error),
      );
    });
  }

  private async downloadOnce(
    request: CapabilityPackDownloadRequest,
  ): Promise<PhysicalDownloadResult> {
    await mkdir(this.downloadRoot, { recursive: true });
    throwIfAborted(request.signal);
    const basename = request.identity.artifactDigest;
    const partialPath = path.join(this.downloadRoot, `${basename}.partial`);
    const metadataPath = `${partialPath}.json`;
    const completePath = path.join(this.downloadRoot, `${basename}.artifact`);
    const existingComplete = await fileSize(completePath);
    if (existingComplete === request.artifact.sizeBytes) {
      await verifyArtifact(completePath, request.artifact.sha256, request.signal);
      await requireDiskSpace(
        this.availableBytes,
        this.downloadRoot,
        request.artifact.unpackedSizeBytes + DOWNLOAD_OVERHEAD_BYTES,
      );
      return {
        filePath: completePath,
        bytes: existingComplete,
        resumedFromBytes: existingComplete,
      };
    }

    let partialBytes = await reusablePartialBytes(partialPath, metadataPath, request.artifact);
    emitProgress(request, 'reserving_space', partialBytes, 'Checking available disk space.');
    const requiredBytes =
      request.artifact.sizeBytes - partialBytes +
      request.artifact.unpackedSizeBytes +
      DOWNLOAD_OVERHEAD_BYTES;
    await requireDiskSpace(this.availableBytes, this.downloadRoot, requiredBytes);

    let resumedFromBytes = partialBytes;
    const metadata = partialBytes > 0 ? await readPartialMetadata(metadataPath) : undefined;
    let response = await this.fetchArtifact(request, partialBytes, metadata?.etag);
    if (partialBytes > 0 && !isValidResume(response, partialBytes, metadata?.etag)) {
      await discardPartial(partialPath, metadataPath);
      partialBytes = 0;
      resumedFromBytes = 0;
      response = await this.fetchArtifact(request, 0);
    }
    assertDownloadResponse(response, partialBytes);
    const etag = strongEtag(response.headers.get('etag'));
    if (partialBytes > 0 && etag === undefined) {
      await discardPartial(partialPath, metadataPath);
      throw new CapabilityPackDownloadError(
        'download_failed',
        'Capability Pack resume response did not provide the strong ETag required to continue safely.',
      );
    }
    if (etag !== undefined) await writePartialMetadata(metadataPath, request.artifact, etag);
    else await rm(metadataPath, { force: true });
    emitProgress(
      request,
      'downloading',
      partialBytes,
      partialBytes > 0 ? 'Resuming download.' : undefined,
    );

    try {
      partialBytes = await appendResponseBody(response, partialPath, partialBytes, request);
    } catch (error) {
      if (request.signal?.aborted === true || isAbortError(error)) {
        throw new CapabilityPackDownloadError(
          'download_cancelled',
          'Capability Pack download cancelled.',
        );
      }
      throw new CapabilityPackDownloadError(
        'download_failed',
        `Capability Pack download failed: ${errorMessage(error)}`,
      );
    }
    if (partialBytes !== request.artifact.sizeBytes) {
      throw new CapabilityPackDownloadError(
        'artifact_corrupt',
        `Downloaded ${partialBytes} bytes; expected ${request.artifact.sizeBytes}.`,
      );
    }

    emitProgress(request, 'verifying', partialBytes, 'Verifying SHA-256 digest.');
    await verifyArtifact(partialPath, request.artifact.sha256, request.signal);
    await rename(partialPath, completePath);
    await rm(metadataPath, { force: true });
    log.action('downloadComplete', { pack: identityKey(request.identity), bytes: partialBytes });
    return {
      filePath: completePath,
      bytes: partialBytes,
      resumedFromBytes,
    };
  }

  private async fetchArtifact(
    request: CapabilityPackDownloadRequest,
    offset: number,
    etag?: string,
  ): Promise<Response> {
    const headers = new Headers();
    if (offset > 0 && etag !== undefined) {
      headers.set('range', `bytes=${offset}-`);
      headers.set('if-range', etag);
    }
    try {
      return await this.fetchImpl(request.artifact.url, {
        headers,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted === true || isAbortError(error)) {
        throw new CapabilityPackDownloadError('download_cancelled', 'Capability Pack download cancelled.');
      }
      throw new CapabilityPackDownloadError(
        'download_failed',
        `Capability Pack request failed: ${errorMessage(error)}`,
      );
    }
  }
}

function validateRequest(request: CapabilityPackDownloadRequest): CapabilityPackDownloadRequest {
  const identity = CapabilityPackInstallIdentitySchema.parse(request.identity);
  const artifact = CapabilityPackArtifactSchema.parse(request.artifact);
  const approval = CapabilityPackInstallApprovalSchema.parse(request.approval);
  if (identityKey(approval.identity) !== identityKey(identity)) {
    throw new CapabilityPackDownloadError('approval_required', 'Approval does not match this signed release.');
  }
  if (approval.approvedSizeBytes !== artifact.sizeBytes) {
    throw new CapabilityPackDownloadError(
      'approval_required',
      'Approval does not match the signed artifact size.',
    );
  }
  if (
    identity.os !== artifact.os ||
    identity.arch !== artifact.arch ||
    identity.artifactDigest !== artifact.sha256
  ) {
    throw new CapabilityPackDownloadError(
      'approval_required',
      'Install identity does not match the signed platform artifact.',
    );
  }
  return { ...request, identity, artifact, approval };
}

async function requireDiskSpace(
  availableBytes: (directory: string) => Promise<number>,
  directory: string,
  requiredBytes: number,
): Promise<void> {
  if ((await availableBytes(directory)) >= requiredBytes) return;
  throw new CapabilityPackDownloadError(
    'insufficient_space',
    `Capability Pack needs ${requiredBytes} free bytes for download and extraction.`,
  );
}

async function appendResponseBody(
  response: Response,
  destination: string,
  offset: number,
  request: CapabilityPackDownloadRequest,
): Promise<number> {
  if (response.body === null) {
    throw new CapabilityPackDownloadError('download_failed', 'Capability Pack response had no body.');
  }
  const handle = await open(destination, offset > 0 ? 'a' : 'w');
  let completedBytes = offset;
  const reader = response.body.getReader();
  try {
    while (true) {
      throwIfAborted(request.signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      if (completedBytes + chunk.value.byteLength > request.artifact.sizeBytes) {
        throw new CapabilityPackDownloadError(
          'artifact_corrupt',
          'Capability Pack response exceeded its signed artifact length.',
        );
      }
      await handle.write(chunk.value);
      completedBytes += chunk.value.byteLength;
      emitProgress(request, 'downloading', completedBytes);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    await handle.close();
  }
  return completedBytes;
}

async function verifyArtifact(
  filePath: string,
  expectedDigest: string,
  signal?: AbortSignal,
): Promise<void> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  if (hash.digest('hex') !== expectedDigest) {
    await rm(filePath, { force: true });
    throw new CapabilityPackDownloadError('artifact_corrupt', 'Capability Pack SHA-256 did not match.');
  }
}

function emitProgress(
  request: CapabilityPackDownloadRequest,
  phase: CapabilityPackInstallProgress['phase'],
  completedBytes: number,
  detail?: string,
): void {
  try {
    request.onProgress?.({
      operationId: request.operationId,
      identity: request.identity,
      phase,
      completedBytes,
      totalBytes: request.artifact.sizeBytes,
      ...(detail === undefined ? {} : { detail }),
    });
  } catch (error) {
    log.warn('progressObserverFailed', { error: errorMessage(error) });
  }
}

async function reusablePartialBytes(
  partialPath: string,
  metadataPath: string,
  artifact: CapabilityPackArtifact,
): Promise<number> {
  const bytes = await fileSize(partialPath);
  if (bytes === 0) return 0;
  const metadata = await readPartialMetadata(metadataPath);
  if (
    metadata === undefined ||
    metadata.url !== artifact.url ||
    metadata.artifactDigest !== artifact.sha256 ||
    metadata.expectedBytes !== artifact.sizeBytes ||
    bytes >= artifact.sizeBytes
  ) {
    await discardPartial(partialPath, metadataPath);
    return 0;
  }
  return bytes;
}

async function readPartialMetadata(metadataPath: string): Promise<PartialMetadata | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('schemaVersion' in parsed) ||
      parsed.schemaVersion !== 1 ||
      !('url' in parsed) ||
      typeof parsed.url !== 'string' ||
      !('artifactDigest' in parsed) ||
      typeof parsed.artifactDigest !== 'string' ||
      !('expectedBytes' in parsed) ||
      typeof parsed.expectedBytes !== 'number' ||
      !('etag' in parsed) ||
      typeof parsed.etag !== 'string'
    ) {
      return undefined;
    }
    return parsed as PartialMetadata;
  } catch {
    return undefined;
  }
}

async function writePartialMetadata(
  metadataPath: string,
  artifact: CapabilityPackArtifact,
  etag: string,
): Promise<void> {
  const metadata: PartialMetadata = {
    schemaVersion: 1,
    url: artifact.url,
    artifactDigest: artifact.sha256,
    expectedBytes: artifact.sizeBytes,
    etag,
  };
  const temp = `${metadataPath}.tmp`;
  await writeFile(temp, `${JSON.stringify(metadata)}\n`, 'utf8');
  await rename(temp, metadataPath);
}

function isValidResume(response: Response, offset: number, expectedEtag?: string): boolean {
  if (response.status !== 206 || expectedEtag === undefined) return false;
  if (strongEtag(response.headers.get('etag')) !== expectedEtag) return false;
  const contentRange = response.headers.get('content-range');
  return contentRange?.startsWith(`bytes ${offset}-`) === true;
}

function assertDownloadResponse(response: Response, offset: number): void {
  const expectedStatus = offset > 0 ? 206 : 200;
  if (response.status !== expectedStatus) {
    throw new CapabilityPackDownloadError(
      'download_failed',
      `Capability Pack server returned HTTP ${response.status}; expected ${expectedStatus}.`,
    );
  }
}

function strongEtag(value: string | null): string | undefined {
  if (value === null || value.startsWith('W/')) return undefined;
  return /^"[^"\r\n]+"$/u.test(value) ? value : undefined;
}

async function availableDiskBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return stats.bavail * stats.bsize;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

async function discardPartial(partialPath: string, metadataPath: string): Promise<void> {
  await Promise.all([rm(partialPath, { force: true }), rm(metadataPath, { force: true })]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CapabilityPackDownloadError('download_cancelled', 'Capability Pack download cancelled.');
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
