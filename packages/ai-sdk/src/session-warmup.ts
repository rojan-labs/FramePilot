/**
 * @framepilot/ai-sdk/session-warmup — fire-and-forget bin analysis on project open
 * (plan/ORCHESTRATION_ENHANCEMENT_PLAN.md B5.6).
 *
 * When a project opens on the desktop, the brain is cold — the first "find where I said X"
 * or "remove the silences" pays the full ffmpeg/probe cost mid-conversation. This driver
 * warms it ahead of time: it paces the chunked ``POST /analyze/batch`` route (B5.2) over
 * the project's assets at the ``quick`` tier, one bounded slice at a time, until the whole
 * bin is analysed (or the run is cancelled). Already-analysed assets are cache hits, so a
 * re-open is cheap.
 *
 * Discipline (B5.6):
 *  - **Off in the browser** — there is no sidecar, so the caller simply never invokes this
 *    (the desktop main process is the only caller); a `fetch` that can't reach an engine
 *    settles as an honest `unavailable`/`failed`, never a fabricated success.
 *  - **Cancellable** — every request honours `signal`; opening another project aborts the
 *    previous warmup so a stale run can't keep burning ffmpeg.
 *  - **Never blocks the UI** — the caller does not await this; it is pure background work.
 *  - **Bounded** — a `maxSlices` backstop stops a pathological loop even if the engine
 *    never reports `done`.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:session-warmup');

/** Assets analysed per warmup slice — small so no single request blocks long. */
export const DEFAULT_WARMUP_SLICE = 2;
/** Backstop on slices per warmup, so a never-`done` engine can't loop forever. */
export const DEFAULT_MAX_WARMUP_SLICES = 100;

/** How a warmup settled. */
export type SessionWarmupStatus =
  | 'completed' // the whole bin was analysed (or served from cache)
  | 'empty' // the project has no analysable assets
  | 'cancelled' // aborted (another project opened / app closing)
  | 'unavailable' // the brain/sidecar is not available (honest degrade)
  | 'failed'; // a transport/HTTP error or the slice backstop tripped

/** What the caller needs to start one project's warmup. */
export interface SessionWarmupRequest {
  readonly baseUrl: string;
  readonly projectId: string;
  /** A saved project file to analyse (desktop open); one of projectPath/project required. */
  readonly projectPath?: string;
  /** An inline working document (alternative to a saved path). */
  readonly project?: unknown;
  /** Injected fetch (Electron `net.fetch`); defaults to the global. */
  readonly fetchFn?: typeof fetch;
  /** Analysis tier per asset; defaults to `quick` (probe+silence — the cheap pass). */
  readonly depth?: 'quick' | 'standard' | 'deep';
  /** Assets per slice; defaults to {@link DEFAULT_WARMUP_SLICE}. */
  readonly maxAssetsPerSlice?: number;
  /** Slice backstop; defaults to {@link DEFAULT_MAX_WARMUP_SLICES}. */
  readonly maxSlices?: number;
  /** Cancels the whole warmup (aborts the in-flight slice too). */
  readonly signal?: AbortSignal;
  /** Called after each slice with the running progress (for a subtle UI hint). */
  readonly onProgress?: (progress: { cursor: number; total: number; done: boolean }) => void;
}

/** The outcome of a warmup run. */
export interface SessionWarmupResult {
  readonly status: SessionWarmupStatus;
  /** Assets processed (cursor reached). */
  readonly analysed: number;
  /** Total assets in the worklist (0 until the first slice returns). */
  readonly total: number;
  /** Slices posted (batch calls made). */
  readonly slices: number;
  /** Set for unavailable/failed: why. */
  readonly reason?: string;
}

/** The subset of the batch response this driver reads. */
interface BatchSliceResponse {
  readonly available?: boolean;
  readonly reason?: string;
  readonly jobId?: string;
  readonly cursor?: number;
  readonly total?: number;
  readonly done?: boolean;
}

/**
 * Drive ``/analyze/batch`` to completion in the background, one bounded slice per call.
 * Returns the settled outcome; the caller (desktop main) does NOT await it.
 */
export async function runSessionWarmup(req: SessionWarmupRequest): Promise<SessionWarmupResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const depth = req.depth ?? 'quick';
  const maxAssets = req.maxAssetsPerSlice ?? DEFAULT_WARMUP_SLICE;
  const maxSlices = req.maxSlices ?? DEFAULT_MAX_WARMUP_SLICES;
  let jobId: string | undefined;
  let cursor = 0;
  let total = 0;
  let slices = 0;

  log.action('runSessionWarmup → starting', { projectId: req.projectId, depth });
  for (;;) {
    if (req.signal?.aborted) {
      log.debug('runSessionWarmup → cancelled', { projectId: req.projectId, analysed: cursor });
      return { status: 'cancelled', analysed: cursor, total, slices };
    }
    if (slices >= maxSlices) {
      log.warn('runSessionWarmup → slice backstop tripped', { projectId: req.projectId, slices });
      return {
        status: 'failed',
        analysed: cursor,
        total,
        slices,
        reason: `warmup exceeded ${String(maxSlices)} slices without completing`,
      };
    }

    let body: BatchSliceResponse;
    try {
      const response = await fetchFn(`${req.baseUrl}/analyze/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: req.projectId,
          ...(req.projectPath !== undefined ? { project_path: req.projectPath } : {}),
          ...(req.project !== undefined ? { project: req.project } : {}),
          depth,
          maxAssets,
          ...(jobId !== undefined ? { jobId } : {}),
        }),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (!response.ok) {
        return {
          status: 'failed',
          analysed: cursor,
          total,
          slices,
          reason: `analyze/batch HTTP ${String(response.status)}`,
        };
      }
      body = (await response.json()) as BatchSliceResponse;
    } catch (error) {
      // An abort surfaces as a thrown fetch — report it as cancelled, not failed.
      if (req.signal?.aborted) return { status: 'cancelled', analysed: cursor, total, slices };
      const reason = error instanceof Error ? error.message : String(error);
      log.debug('runSessionWarmup → request failed', { projectId: req.projectId, reason });
      return { status: 'failed', analysed: cursor, total, slices, reason };
    }

    slices += 1;
    if (body.available === false) {
      log.debug('runSessionWarmup → brain unavailable', {
        projectId: req.projectId,
        reason: body.reason,
      });
      return {
        status: 'unavailable',
        analysed: cursor,
        total,
        slices,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      };
    }
    jobId = body.jobId;
    cursor = body.cursor ?? cursor;
    total = body.total ?? total;
    req.onProgress?.({ cursor, total, done: body.done ?? false });

    if (total === 0) {
      log.debug('runSessionWarmup → no analysable assets', { projectId: req.projectId });
      return { status: 'empty', analysed: 0, total: 0, slices };
    }
    if (body.done) {
      log.action('runSessionWarmup → completed', {
        projectId: req.projectId,
        analysed: cursor,
        total,
        slices,
      });
      return { status: 'completed', analysed: cursor, total, slices };
    }
  }
}
