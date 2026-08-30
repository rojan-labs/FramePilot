/**
 * Desktop → Python-sidecar export client (plan/PLAN.md Phase 8 — "Renderer→engine
 * export IPC channel"; async contract H1.3b).
 *
 * WHY in the main process: the render engine is Python MoviePy + FFmpeg and MUST
 * stay out of the renderer (AGENTS.md render-vs-preview rule). The renderer asks
 * the main process to export; the main process talks to the FastAPI sidecar,
 * which loads the saved `project.fp.json`, renders deterministically, and
 * auto-validates the output (PRD §9.4). `fetch` is injected so this is unit-
 * tested offline without a live sidecar.
 *
 * Contract (H1.3a, ADR 0050):
 * - `POST /render/preview` is synchronous: `200` + a `RenderJob` body directly.
 *   Preview stays on this single round trip — it is deliberately fast/low-res.
 * - `POST /render` (a full export) is asynchronous: `202` + `{jobId, status}`
 *   immediately. The actual render is tracked via `GET /render/jobs/{jobId}`,
 *   polled here until the job reaches a terminal status (`completed`/`failed`/
 *   `cancelled`), at which point `RenderTask.result` carries the same `RenderJob`
 *   shape preview returns directly. `POST /render/jobs/{jobId}/cancel` stops an
 *   in-flight job when the caller aborts via `options.signal`.
 *
 * Either way, success is decided by the terminal `RenderJob.state`/`output_path`,
 * never by the HTTP status alone — a failed/invalid render is reported as
 * `{ ok: false }`, never returned as a usable output.
 *
 * **Every request on the async path is bounded** (see {@link fetchBounded}): the caller's
 * abort signal and a per-request deadline are both wired into the actual `fetch`, not
 * merely checked between poll iterations. Without that, an abort raised while awaiting a
 * hung submit or status request was never observed at all, and `ExportHub.cancel` aborted
 * a controller nobody was listening to.
 */
import { createLogger } from '@framepilot/shared-types';
import type { ExportRequest, ExportResult } from '../ipc/contract.js';

const log = createLogger('desktop:render:export-client');

/** Minimal shape of the sidecar's `RenderJob` (a full render's terminal result). */
interface RenderJobResponse {
  state?: string;
  output_path?: string | null;
  error?: string | null;
  /** The raw cause (ffmpeg stderr tail) behind the plain `error` line (P7.6). */
  error_detail?: string | null;
}

/** Minimal shape of the sidecar's `202` response from `POST /render`. */
interface RenderAcceptedResponse {
  jobId?: string;
  status?: string;
}

/** Minimal shape of the sidecar's `RenderTask` (`GET`/`cancel` `/render/jobs/{id}`). */
interface RenderTaskResponse {
  id?: string;
  status?: string;
  attempts?: number;
  error?: string | null;
  result?: RenderJobResponse | null;
  stage?: string | null;
  progress?: number | null;
}

/** The queue-level statuses a submitted (non-preview) render job moves through. */
export type RenderJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** One observed status transition of a submitted (non-preview) render job. */
export interface RenderJobProgress {
  readonly jobId: string;
  readonly status: RenderJobStatus;
  readonly stage?: string;
  readonly progress?: number;
}

/** Options tuning the async submit+poll flow for full (non-preview) exports. */
export interface ExportViaSidecarOptions {
  /** Called on every observed status transition, including the first (`queued`). */
  readonly onProgress?: (progress: RenderJobProgress) => void;
  /**
   * Poll interval between `GET /render/jobs/{id}` calls. Renders run for anywhere
   * from a few seconds to several minutes, so 750ms is frequent enough to feel
   * live in the UI without hammering the sidecar with status requests.
   */
  readonly pollIntervalMs?: number;
  /** Injectable delay so tests drive the poll loop without real timers. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /** When aborted, stop polling and best-effort cancel the job via the sidecar. */
  readonly signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 750;

/**
 * Per-request deadline for `GET /render/jobs/{id}`. A status read is a dictionary lookup
 * in the sidecar; if it has not answered in 15s the socket is wedged, not busy. It is
 * deliberately much larger than the 750ms poll interval so a merely loaded engine is
 * never counted as a failure.
 */
const STATUS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Per-request deadline for `POST /render`. The sidecar answers `202` as soon as the job is
 * queued, so this bounds enqueueing, not rendering — but the request body carries the whole
 * project, and a cold engine may still be importing MoviePy, so the budget is generous.
 */
const SUBMIT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * How many consecutive failed status reads end the export.
 *
 * Deliberately the same number as the sidecar manager's own `DEFAULT_LIVENESS_FAILURES`:
 * the engine supervises itself and restarts a dead sidecar, and while it does, `GET
 * /render/jobs/{id}` returns 503 (or nothing). This used to give up after ONE null — an
 * export that was less patient than the recovery it was racing, so a transient blip was
 * reported to the user as a failed export while ffmpeg happily finished and wrote the file.
 */
const MAX_CONSECUTIVE_STATUS_FAILURES = 3;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a terminal `RenderJob` (or its absence) to the renderer-facing `ExportResult`. */
function toExportResult(
  job: RenderJobResponse | null | undefined,
  fallbackError: string,
): ExportResult {
  if (job?.state === 'completed' && job.output_path) {
    return { ok: true, outputPath: job.output_path, state: job.state };
  }
  const detail = job?.error_detail;
  return {
    ok: false,
    error: job?.error ?? fallbackError,
    ...(typeof detail === 'string' && detail.trim() !== '' && detail !== job?.error
      ? { detail }
      : {}),
  };
}

/** A caller abort plus a per-request deadline, both wired into the real request. */
interface RequestBounds {
  /** The caller's cancellation signal (`ExportHub.cancel`), or undefined. */
  readonly signal: AbortSignal | undefined;
  /** Deadline for this single request, in ms. */
  readonly timeoutMs: number;
}

/**
 * `fetch` with the caller's abort AND a per-request deadline forwarded into the request
 * itself.
 *
 * WHY not a `Promise.race`: racing only stops the *await*, leaving the socket open and the
 * abort unobserved. Passing a real `AbortSignal` into `fetch` is what actually tears the
 * request down, which is the whole point — an abort raised while awaiting an unbounded
 * request was previously invisible until the request returned on its own, which for a hung
 * sidecar is never.
 *
 * @param fetchFn - Injectable `fetch`.
 * @param url - Absolute request URL.
 * @param init - Request init; its `signal` is replaced by the combined one.
 * @param bounds - Caller signal + this request's deadline.
 * @returns The response, or a rejection when aborted or timed out.
 */
async function fetchBounded(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  bounds: RequestBounds,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromCaller = (): void => {
    controller.abort();
  };
  if (bounds.signal?.aborted) abortFromCaller();
  bounds.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    log.warn('request exceeded its deadline; aborting', { url, timeoutMs: bounds.timeoutMs });
    controller.abort();
  }, bounds.timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    bounds.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * POST the shared render request body to `route` (`/render` or `/render/preview`).
 *
 * @param bounds - When omitted the request is UNBOUNDED. That is correct — and required —
 *   for `/render/preview`, which is a synchronous full render performed on that one
 *   request: a submit-sized deadline there would abort real encoding work mid-flight.
 */
function postRenderRequest(
  baseUrl: string,
  route: string,
  req: ExportRequest,
  fetchFn: typeof fetch,
  bounds?: RequestBounds,
): Promise<Response> {
  const url = `${baseUrl}${route}`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_path: req.projectPath,
      settings: req.settings
        ? {
            ...(req.settings.resolution ? { resolution: req.settings.resolution } : {}),
            ...(req.settings.fps !== undefined ? { fps: req.settings.fps } : {}),
            ...(req.settings.quality ? { quality: req.settings.quality } : {}),
            ...(req.settings.bitrateKbps ? { bitrate_kbps: req.settings.bitrateKbps } : {}),
            ...(req.settings.videoCodec ? { video_codec: req.settings.videoCodec } : {}),
            ...(req.settings.container ? { container: req.settings.container } : {}),
          }
        : null,
      burn_captions: req.burnCaptions ?? false,
      denoise: req.denoise ?? false,
      eq: req.eq ?? null,
      compression: req.compression ?? null,
      loudness: req.loudness ?? null,
      limiter: req.limiter ?? false,
    }),
  };
  return bounds ? fetchBounded(fetchFn, url, init, bounds) : fetchFn(url, init);
}

/**
 * `GET /render/jobs/{jobId}`, or `null` on any transport/parse failure — including this
 * request's own deadline and the caller's abort landing mid-flight. Callers must therefore
 * re-check `signal.aborted` after a `null` rather than assuming the engine is gone.
 */
async function fetchJobStatus(
  baseUrl: string,
  jobId: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<RenderTaskResponse | null> {
  try {
    const response = await fetchBounded(
      fetchFn,
      `${baseUrl}/render/jobs/${jobId}`,
      { method: 'GET' },
      { signal, timeoutMs: STATUS_REQUEST_TIMEOUT_MS },
    );
    if (!response.ok) return null;
    return (await response.json()) as RenderTaskResponse;
  } catch {
    return null;
  }
}

/**
 * `POST /render/jobs/{jobId}/cancel` — best-effort; a failure just stops polling anyway.
 *
 * Deliberately NOT given the caller's abort signal: this request exists precisely because
 * the caller aborted, so wiring the abort in would cancel the cancellation and leave
 * ffmpeg running. Only the deadline bounds it.
 */
async function cancelRenderJob(
  baseUrl: string,
  jobId: string,
  fetchFn: typeof fetch,
): Promise<void> {
  try {
    await fetchBounded(
      fetchFn,
      `${baseUrl}/render/jobs/${jobId}/cancel`,
      { method: 'POST' },
      { signal: undefined, timeoutMs: STATUS_REQUEST_TIMEOUT_MS },
    );
  } catch {
    // Best-effort: if the cancel request itself can't reach the sidecar, the
    // caller has already stopped waiting on this job either way.
  }
}

/**
 * `POST /render/preview` — unchanged synchronous contract (`200` + `RenderJob`).
 */
async function renderPreviewSync(
  baseUrl: string,
  req: ExportRequest,
  fetchFn: typeof fetch,
): Promise<ExportResult> {
  let response: Response;
  try {
    response = await postRenderRequest(baseUrl, '/render/preview', req, fetchFn);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { ok: false, error: `Render request failed (${response.status}): ${detail}`.trim() };
  }
  const job = (await response.json()) as RenderJobResponse;
  return toExportResult(job, `Render did not complete (state: ${job.state ?? 'unknown'}).`);
}

/**
 * `POST /render` + poll `GET /render/jobs/{id}` — the async full-export contract
 * (H1.3a). Reports every observed status via `options.onProgress` and honours
 * `options.signal` for cancellation.
 */
async function renderFullAsync(
  baseUrl: string,
  req: ExportRequest,
  fetchFn: typeof fetch,
  options: ExportViaSidecarOptions,
): Promise<ExportResult> {
  const sleep = options.sleepFn ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let response: Response;
  try {
    response = await postRenderRequest(baseUrl, '/render', req, fetchFn, {
      signal: options.signal,
      timeoutMs: SUBMIT_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    // The submit is now abortable, so a throw here can be the user's own Stop landing
    // before the job even had an id — report that as a cancellation, not a render failure.
    if (options.signal?.aborted) return { ok: false, error: 'Export cancelled.' };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (response.status !== 202) {
    const detail = await response.text().catch(() => '');
    return { ok: false, error: `Render request failed (${response.status}): ${detail}`.trim() };
  }

  const accepted = (await response.json()) as RenderAcceptedResponse;
  const jobId = accepted.jobId;
  if (!jobId) {
    return { ok: false, error: 'Render request accepted but no job id was returned.' };
  }

  // Reports `progress` and, if `status` is terminal, returns the final `ExportResult` —
  // otherwise `null` so the poll loop keeps going.
  const reportAndCheckTerminal = (task: {
    status?: string | undefined;
    result?: RenderJobResponse | null;
    stage?: string | null;
    progress?: number | null;
  }): ExportResult | null => {
    const status = (task.status ?? 'queued') as RenderJobStatus;
    options.onProgress?.({
      jobId,
      status,
      ...(typeof task.stage === 'string' ? { stage: task.stage } : {}),
      ...(typeof task.progress === 'number' ? { progress: task.progress } : {}),
    });
    if (!isTerminalStatus(status)) return null;
    const fallback =
      status === 'cancelled' ? 'Export cancelled.' : `Render did not complete (status: ${status}).`;
    return toExportResult(task.result, fallback);
  };

  const initial = reportAndCheckTerminal({ status: accepted.status });
  if (initial) return initial;

  let consecutiveStatusFailures = 0;

  for (;;) {
    if (options.signal?.aborted) {
      await cancelRenderJob(baseUrl, jobId, fetchFn);
      // Read the terminal state WITHOUT the caller's signal: it is already aborted, and
      // passing it would abort this confirming read too, losing the cancelled status.
      const cancelled = await fetchJobStatus(baseUrl, jobId, fetchFn, undefined);
      return (
        reportAndCheckTerminal(cancelled ?? { status: 'cancelled' }) ?? {
          ok: false,
          error: 'Export cancelled.',
        }
      );
    }

    await sleep(pollIntervalMs);

    const task = await fetchJobStatus(baseUrl, jobId, fetchFn, options.signal);
    if (!task) {
      // A null is now often the caller's OWN abort landing mid-request, not a sick engine.
      // Go round: the top of the loop owns the cancel path, and this must not count as a
      // strike against the sidecar.
      if (options.signal?.aborted) continue;
      consecutiveStatusFailures += 1;
      log.warn('render job status check failed', {
        jobId,
        consecutiveStatusFailures,
        limit: MAX_CONSECUTIVE_STATUS_FAILURES,
      });
      if (consecutiveStatusFailures < MAX_CONSECUTIVE_STATUS_FAILURES) continue;
      // Giving up on WATCHING the job is not the same as the job stopping. Without this
      // cancel, ffmpeg ran to completion and wrote the output while the user was told the
      // export had failed — a finished file nobody knew about, and cores held for minutes.
      log.error('lost track of render job; cancelling it rather than leaving it running', {
        jobId,
        consecutiveStatusFailures,
      });
      await cancelRenderJob(baseUrl, jobId, fetchFn);
      return {
        ok: false,
        error:
          `Lost track of render job ${jobId} ` +
          `(${String(MAX_CONSECUTIVE_STATUS_FAILURES)} status checks in a row failed). ` +
          `The job was cancelled.`,
      };
    }
    consecutiveStatusFailures = 0;
    const result = reportAndCheckTerminal(task);
    if (result) return result;
  }
}

/**
 * Render/export a saved project through the sidecar.
 *
 * @param baseUrl - Sidecar base URL (e.g. `http://127.0.0.1:8765`).
 * @param req - Export request; `projectPath` must already be saved to disk.
 * @param fetchFn - Injectable `fetch` (defaults to the global) for testing.
 * @param options - Poll interval/progress/cancel tuning for full (non-preview)
 *   exports; ignored for `req.preview` (unchanged synchronous path).
 */
export async function exportViaSidecar(
  baseUrl: string,
  req: ExportRequest,
  fetchFn: typeof fetch = fetch,
  options: ExportViaSidecarOptions = {},
): Promise<ExportResult> {
  if (req.preview) {
    return renderPreviewSync(baseUrl, req, fetchFn);
  }
  return renderFullAsync(baseUrl, req, fetchFn, options);
}
