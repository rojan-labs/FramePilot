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
 */
import type { ExportRequest, ExportResult } from '../ipc/contract.js';

/** Minimal shape of the sidecar's `RenderJob` (a full render's terminal result). */
interface RenderJobResponse {
  state?: string;
  output_path?: string | null;
  error?: string | null;
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
}

/** The queue-level statuses a submitted (non-preview) render job moves through. */
export type RenderJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** One observed status transition of a submitted (non-preview) render job. */
export interface RenderJobProgress {
  readonly jobId: string;
  readonly status: RenderJobStatus;
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
  return { ok: false, error: job?.error ?? fallbackError };
}

/** POST the shared render request body to `route` (`/render` or `/render/preview`). */
function postRenderRequest(
  baseUrl: string,
  route: string,
  req: ExportRequest,
  fetchFn: typeof fetch,
): Promise<Response> {
  return fetchFn(`${baseUrl}${route}`, {
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
  });
}

/** `GET /render/jobs/{jobId}`, or `null` on any transport/parse failure. */
async function fetchJobStatus(
  baseUrl: string,
  jobId: string,
  fetchFn: typeof fetch,
): Promise<RenderTaskResponse | null> {
  try {
    const response = await fetchFn(`${baseUrl}/render/jobs/${jobId}`, { method: 'GET' });
    if (!response.ok) return null;
    return (await response.json()) as RenderTaskResponse;
  } catch {
    return null;
  }
}

/** `POST /render/jobs/{jobId}/cancel` — best-effort; a failure just stops polling anyway. */
async function cancelRenderJob(baseUrl: string, jobId: string, fetchFn: typeof fetch): Promise<void> {
  try {
    await fetchFn(`${baseUrl}/render/jobs/${jobId}/cancel`, { method: 'POST' });
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
    response = await postRenderRequest(baseUrl, '/render', req, fetchFn);
  } catch (error) {
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
  }): ExportResult | null => {
    const status = (task.status ?? 'queued') as RenderJobStatus;
    options.onProgress?.({ jobId, status });
    if (!isTerminalStatus(status)) return null;
    const fallback =
      status === 'cancelled' ? 'Export cancelled.' : `Render did not complete (status: ${status}).`;
    return toExportResult(task.result, fallback);
  };

  const initial = reportAndCheckTerminal({ status: accepted.status });
  if (initial) return initial;

  for (;;) {
    if (options.signal?.aborted) {
      await cancelRenderJob(baseUrl, jobId, fetchFn);
      const cancelled = await fetchJobStatus(baseUrl, jobId, fetchFn);
      return reportAndCheckTerminal(cancelled ?? { status: 'cancelled' }) ?? {
        ok: false,
        error: 'Export cancelled.',
      };
    }

    await sleep(pollIntervalMs);

    const task = await fetchJobStatus(baseUrl, jobId, fetchFn);
    if (!task) {
      return { ok: false, error: `Lost track of render job ${jobId} (status check failed).` };
    }
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
