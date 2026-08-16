/**
 * @framepilot/ai-sdk/visual-index-client — drive the engine sidecar's visual
 * indexing routes (plan MEDIA-INTELLIGENCE MI4.1–MI4.3) from the host/renderer.
 *
 * WHY: visual indexing (adaptive frame sampling → NVIDIA embeddings → optional
 * VLM captions → brain vectors) runs entirely in the Python sidecar (decision
 * D6). The host owns the plaintext NVIDIA key(s) (decision D5) and passes them
 * in the request body — the engine never reads keys from disk. This module is
 * the TS side of that contract: Zod schemas mirroring the engine's Pydantic
 * response models (`VisualStatusResponse` / `VisualIndexResponse` /
 * `VisualIndexCancelResponse` in `service.py`), an injectable-fetch client, and
 * a paced-loop driver that re-POSTs `/brain/visual/index` until the job is done.
 *
 * Honest degradation (AGENTS.md invariant 6): a transport failure (no sidecar,
 * timeout, HTTP error, malformed payload) resolves to `undefined` — the caller
 * proceeds exactly as if visual indexing did not exist, never with a fabricated
 * result. An `available: false` (no sandbox root) or `available: true` with a
 * `reason` (no key, cancelled, all keys failing) is a real, typed engine
 * response the caller renders as-is. Keys are NEVER logged.
 */
import { createLogger, type VisualIndexResult } from '@framepilot/shared-types';
import { z } from 'zod/v4';
import { type FootageMap, footageMapSchema } from './footage-map.js';

const log = createLogger('ai-sdk:visual-index-client');

/**
 * Request body for {@link VisualIndexClient.footageMap} (plan FI3.1). The live
 * WORKING `project` rides along so the engine projects asset spans onto timeline
 * time; `twelveLabsKey` is forwarded (like search) so the Pegasus arm is reached
 * when configured. `assetId` narrows the map to one asset; `refresh` recomputes.
 */
export interface FootageMapRequestInput {
  readonly projectId: string;
  readonly project?: unknown;
  readonly assetId?: string;
  readonly refresh?: boolean;
  /**
   * Serve only an already-cached map; on a miss return an empty one rather than calling
   * the understanding provider. For a caller enriching something else (a run's context)
   * that must never turn a cheap read into a slow, billed Pegasus fetch.
   */
  readonly cachedOnly?: boolean;
  /**
   * Return chapter/highlight times in each asset's OWN source seconds (the footage's
   * structure), not projected onto the timeline. The understanding panel sets this so
   * the map reflects the footage — complete even when the asset is unplaced or trimmed;
   * the AI leaves it off so `map_footage` acts on timeline time.
   */
  readonly assetTime?: boolean;
  readonly twelveLabsKey?: string;
}

/**
 * Default per-request timeout. An index *slice* does real work (frame decode +
 * a network round-trip to NVIDIA per batch), so it is far longer than a brain
 * read; status/cancel are quick but share the bound for simplicity.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Per-request timeout for an index *slice* (`POST /brain/visual/index`). A slice
 * can stream a whole local video to a hosted backend (TwelveLabs) or decode +
 * embed many frames — minutes of real work, not a quick brain read. The
 * short {@link DEFAULT_TIMEOUT_MS} bound would abort a large upload mid-stream,
 * stranding the job at 0% (the classic "stuck indexing" report). This matches
 * the engine's upload timeout so both sides fail together, never one early.
 */
const DEFAULT_INDEX_TIMEOUT_MS = 900_000;

/**
 * Safety bound on paced-loop iterations so a job that never reports `done`
 * (e.g. a cursor that fails to advance) can never spin forever. At
 * `maxAssets` ≥ 1 per slice this covers far more assets than any real project.
 */
const DEFAULT_MAX_SLICES = 100_000;

/**
 * One visual-index job's journaled state, as `GET /brain/visual/status`'
 * `lastJob` returns it. Mirrors the engine's Pydantic `VisualJobStatus`.
 * `state` is the brain `JobState` string (`queued|running|done|failed|
 * interrupted`) — kept as a plain string so a new engine state never fails
 * parsing here (honest-degrade over strict enum coupling).
 */
export const visualJobStatusSchema = z.object({
  jobId: z.string(),
  state: z.string(),
  /** Fraction complete, 0..1. */
  progress: z.number(),
  error: z.string().nullish(),
  cursor: z.number().default(0),
  total: z.number().default(0),
  updatedAt: z.string(),
});

export type VisualJobStatus = z.infer<typeof visualJobStatusSchema>;

/**
 * `GET /brain/visual/status` response. Mirrors the engine's Pydantic
 * `VisualStatusResponse` field-for-field. `keyConfigured` reflects the engine's
 * ENV key only — the host's own plaintext key is not visible here, and the key
 * value is never returned by either side.
 */
export const visualStatusResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullish(),
  /** Live vector backend: `sqlite-vec` or the brute-force fallback. */
  backend: z.string().nullish(),
  /** Raw brain row counts, e.g. `{ assets, spans, vectors, captions }`. */
  counts: z.record(z.string(), z.number()).default({}),
  indexedAssets: z.number().default(0),
  totalAssets: z.number().default(0),
  keyConfigured: z.boolean().default(false),
  lastJob: visualJobStatusSchema.nullish(),
});

export type VisualStatusResponse = z.infer<typeof visualStatusResponseSchema>;

/** One asset's outcome within an index slice. Mirrors Pydantic `VisualIndexItem`. */
export const visualIndexItemSchema = z.object({
  assetId: z.string(),
  ok: z.boolean(),
  indexed: z.number().default(0),
  captioned: z.number().default(0),
  reason: z.string().nullish(),
});

export type VisualIndexItem = z.infer<typeof visualIndexItemSchema>;

/**
 * `POST /brain/visual/index` slice response. Mirrors Pydantic
 * `VisualIndexResponse`. The caller re-POSTs with `jobId` until `done`;
 * `reason` also carries the honest no-op signals (`all_keys_failing`,
 * `cancelled`, or the no-key reason on an `available: true` response with no
 * `jobId`).
 */
export const visualIndexResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullish(),
  jobId: z.string().nullish(),
  cursor: z.number().default(0),
  total: z.number().default(0),
  done: z.boolean().default(false),
  indexed: z.number().default(0),
  captioned: z.number().default(0),
  captionsReason: z.string().nullish(),
  items: z.array(visualIndexItemSchema).default([]),
});

export type VisualIndexResponse = z.infer<typeof visualIndexResponseSchema>;

/** `POST /brain/visual/index/cancel` response. Mirrors Pydantic `VisualIndexCancelResponse`. */
export const visualIndexCancelResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullish(),
  jobId: z.string().nullish(),
  state: z.string().nullish(),
});

export type VisualIndexCancelResponse = z.infer<typeof visualIndexCancelResponseSchema>;

/**
 * Host-resolved vision provider for per-scene captions (plan D7). The host reads
 * the plaintext provider key and passes it here — the same body channel as the
 * NVIDIA keys. Omit to index embeddings only (captions skipped). Never logged.
 */
export interface VisualCaptionProviderInput {
  readonly kind: 'anthropic' | 'openai';
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/** Request body for `POST /brain/visual/index` (camelCase — the engine's alias shape). */
export interface VisualIndexRequestInput {
  readonly projectId: string;
  /** Saved project to embed captions against (optional; mutually exclusive with `project`). */
  readonly projectPath?: string;
  /** Inline project document to embed captions against (optional). */
  readonly project?: Record<string, unknown>;
  /** Explicit worklist; omit to index every video/image asset the brain knows. */
  readonly assetIds?: readonly string[];
  /** Comma-separated NVIDIA embedding key(s); falls back to the engine's ENV setting. */
  readonly nvidiaKeys?: string;
  /**
   * TwelveLabs API key. When set, the engine delegates indexing to TwelveLabs'
   * hosted understanding backend instead of the built-in NVIDIA-embed pipeline;
   * falls back to the engine's `TWELVELABS_API_KEY` env. Host-owned, never logged.
   */
  readonly twelveLabsKey?: string;
  /** Vision provider for captions; omit to skip captioning. */
  readonly captionProvider?: VisualCaptionProviderInput;
  /** Omit to start a new job (id minted + returned); pass the returned id to continue. */
  readonly jobId?: string;
  /** Assets to index this slice (engine-bounded 1..10). */
  readonly maxAssets?: number;
}

/** Request body for `POST /brain/visual/index/cancel`. */
export interface VisualIndexCancelInput {
  readonly projectId: string;
  readonly jobId: string;
}

export interface VisualIndexClientOptions {
  /** Sidecar base URL (e.g. `http://127.0.0.1:8765`). */
  readonly baseUrl: string;
  /** Injectable `fetch` (defaults to the global) for testing / Electron net. */
  readonly fetchFn?: typeof fetch;
  /** Per-request timeout in ms; a hung sidecar must not stall the caller. */
  readonly timeoutMs?: number;
  /**
   * Per-slice timeout in ms for `POST /brain/visual/index` (defaults to
   * {@link DEFAULT_INDEX_TIMEOUT_MS}). Far longer than {@link timeoutMs}: a slice
   * may upload a whole video. Status/cancel keep the short {@link timeoutMs}.
   */
  readonly indexTimeoutMs?: number;
  /** Desktop-only index transport; it receives no provider credentials. */
  readonly indexFn?: (
    input: Omit<VisualIndexRequestInput, 'captionProvider'>,
  ) => Promise<VisualIndexResult | undefined>;
}

/**
 * Thin HTTP client for the sidecar's visual-index routes. Every method degrades
 * to `undefined` on a transport failure (never throws), so a caller — the
 * background auto-index loop or the Settings status panel — can always render an
 * honest state without a try/catch of its own.
 */
export class VisualIndexClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly indexTimeoutMs: number;
  private readonly indexFn: VisualIndexClientOptions['indexFn'];

  public constructor(options: VisualIndexClientOptions) {
    this.baseUrl = options.baseUrl;
    // Bind to globalThis: the native `fetch` throws "Illegal invocation" when
    // called as `this.fetchFn(...)` (i.e. with `this` rebound to the client
    // instance) because it requires `this` to be Window/WorkerGlobalScope.
    this.fetchFn = options.fetchFn ?? (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
    this.indexFn = options.indexFn;
  }

  /** Read visual-index coverage/health for a project, or `undefined` when unreachable. */
  public async status(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<VisualStatusResponse | undefined> {
    const query = new URLSearchParams({ projectId });
    return this.request(
      `/brain/visual/status?${query.toString()}`,
      { method: 'GET' },
      visualStatusResponseSchema,
      signal,
    );
  }

  /**
   * Fetch the time-ordered footage map for a project (plan FI3.1), or `undefined`
   * when the sidecar is unreachable. Uses the long index timeout — the TwelveLabs
   * arm may call Pegasus (a slow generative round-trip) on first (uncached) build.
   */
  public async footageMap(
    body: FootageMapRequestInput,
    signal?: AbortSignal,
  ): Promise<FootageMap | undefined> {
    return this.request(
      '/brain/visual/footage-map',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      footageMapSchema,
      signal,
      this.indexTimeoutMs,
    );
  }

  /** Run (or continue) one bounded index slice, or `undefined` when unreachable. */
  public async index(
    body: VisualIndexRequestInput,
    signal?: AbortSignal,
  ): Promise<VisualIndexResponse | undefined> {
    if (this.indexFn) {
      const { captionProvider: _captionProvider, ...request } = body;
      return this.indexFn(request);
    }
    return this.request(
      '/brain/visual/index',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      visualIndexResponseSchema,
      signal,
      this.indexTimeoutMs,
    );
  }

  /** Cooperatively cancel an in-flight job, or `undefined` when unreachable. */
  public async cancel(
    body: VisualIndexCancelInput,
    signal?: AbortSignal,
  ): Promise<VisualIndexCancelResponse | undefined> {
    return this.request(
      '/brain/visual/index/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      visualIndexCancelResponseSchema,
      signal,
    );
  }

  /**
   * One fetch + Zod-parse attempt with a timeout, shared by all three routes.
   * Never throws: an aborted/failed request, a non-2xx status, or a payload
   * that fails the schema all resolve to `undefined` with a debug log.
   */
  private async request<S extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: S,
    signal?: AbortSignal,
    timeoutMs: number = this.timeoutMs,
  ): Promise<z.output<S> | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Chain the caller's signal into ours so an external abort cancels the fetch.
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onExternalAbort);
    if (signal?.aborted) controller.abort();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        log.debug('visual route → HTTP error; degrading', { path, status: response.status });
        return undefined;
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) {
        log.warn('visual route → payload did not match schema; degrading', { path });
        return undefined;
      }
      return parsed.data;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.debug('visual route → request failed; degrading', { path, reason });
      return undefined;
      // v8's coverage provider reports a phantom uncovered branch on this try's `finally`
      // clause for an async function (both the normal-return and thrown-error paths are
      // exercised by tests; this is a known v8/vitest instrumentation quirk, not an
      // untested code path).
      /* v8 ignore next */
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/** How a {@link runVisualIndexLoop} run finished — a typed, honest outcome. */
export type VisualIndexLoopStatus =
  /** Every asset in the worklist was indexed. */
  | 'done'
  /** The sidecar could not be reached (or a slice returned a malformed payload). */
  | 'unreachable'
  /** The engine reported `available: false` (no sandbox root). */
  | 'unavailable'
  /** No embedding key resolved — nothing to index (honest no-op). */
  | 'no-key'
  /** The job was cancelled (by the user or an aborted signal). */
  | 'cancelled'
  /** All embedding keys failed mid-run; the job is resumable later. */
  | 'keys-failing'
  /** The iteration safety bound was hit without a terminal signal. */
  | 'exhausted-slices';

export interface VisualIndexLoopResult {
  readonly status: VisualIndexLoopStatus;
  /** The id of the job that ran, when one was created. */
  readonly jobId?: string;
  /** The last slice response observed, when any slice ran. */
  readonly last?: VisualIndexResponse;
}

export interface RunVisualIndexLoopOptions {
  readonly client: VisualIndexClient;
  /** The index request; `jobId` is managed by the loop and ignored if set here. */
  readonly request: VisualIndexRequestInput;
  /** Called after each slice with its response — for live progress UI. */
  readonly onSlice?: (response: VisualIndexResponse) => void;
  /** Abort the loop between slices (also cancels the in-flight slice fetch). */
  readonly signal?: AbortSignal;
  /** Iteration safety bound (defaults to {@link DEFAULT_MAX_SLICES}). */
  readonly maxSlices?: number;
}

/**
 * Drive the paced index job to completion: POST `/brain/visual/index`, then
 * re-POST with the returned `jobId` until the engine reports `done` — or a
 * terminal signal (no key, cancelled, keys failing, unreachable) stops it.
 *
 * The loop NEVER blocks on anything but the sequential slice requests, so a
 * caller `void`s it to index in the background without holding the UI thread.
 * It stops the moment a slice cannot yield a continuable job (no `jobId`), so a
 * no-key or `available: false` response is a clean one-iteration no-op rather
 * than a spin.
 */
export async function runVisualIndexLoop(
  options: RunVisualIndexLoopOptions,
): Promise<VisualIndexLoopResult> {
  const { client, request, onSlice, signal } = options;
  const maxSlices = options.maxSlices ?? DEFAULT_MAX_SLICES;
  const { jobId: _ignored, ...seed } = request;
  let jobId: string | undefined;
  let last: VisualIndexResponse | undefined;

  for (let slice = 0; slice < maxSlices; slice += 1) {
    if (signal?.aborted) {
      return await abortRun(client, request.projectId, jobId, last);
    }
    const response = await client.index(jobId ? { ...seed, jobId } : seed, signal);
    if (!response)
      return { status: 'unreachable', ...(jobId ? { jobId } : {}), ...(last ? { last } : {}) };
    last = response;
    onSlice?.(response);
    if (!response.available) return { status: 'unavailable', last: response };
    jobId = response.jobId ?? jobId;
    // No job handle on an available response ⇒ the engine had nothing to start
    // (no key). Honest no-op — there is nothing to continue.
    if (!jobId) return { status: 'no-key', last: response };
    if (response.done) return { status: 'done', jobId, last: response };
    // A `reason` on an available, not-done slice is a terminal signal.
    if (response.reason === 'cancelled') return { status: 'cancelled', jobId, last: response };
    if (response.reason) return { status: 'keys-failing', jobId, last: response };
  }
  log.warn('visual index loop hit the slice safety bound without completing', {
    projectId: request.projectId,
    jobId,
  });
  return { status: 'exhausted-slices', ...(jobId ? { jobId } : {}), ...(last ? { last } : {}) };
}

/** Cancel the in-flight job (best-effort) on an aborted loop, then report `cancelled`. */
async function abortRun(
  client: VisualIndexClient,
  projectId: string,
  jobId: string | undefined,
  last: VisualIndexResponse | undefined,
): Promise<VisualIndexLoopResult> {
  if (jobId) await client.cancel({ projectId, jobId });
  return { status: 'cancelled', ...(jobId ? { jobId } : {}), ...(last ? { last } : {}) };
}
