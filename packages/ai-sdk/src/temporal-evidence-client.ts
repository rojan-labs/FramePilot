/** Typed client for deterministic temporal evidence acquisition in the engine sidecar. */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { toEngineProject } from './engine-view.js';
import {
  TemporalEvidenceBatchSchema,
  type TemporalEvidenceBatch,
  type TemporalEvidenceRequest,
} from './temporal-review.js';

const log = createLogger('ai-sdk:temporal-evidence-client');
/**
 * The floor under every acquisition, and what the whole deadline used to be.
 *
 * It is a QUEUEING allowance, not a render one: `/review/temporal-evidence` is serialized
 * process-wide behind one semaphore and the index governor, so a batch waits behind another
 * run's batch, an export and a preview before it renders a frame. Kept as the floor so no
 * batch ever gets less time than it did before the deadline scaled.
 */
const BASE_TIMEOUT_MS = 300_000;
/**
 * What one sampled frame costs the engine at {@link REFERENCE_FRAME_PIXELS}, compiles included.
 *
 * MEASURED, commit ffdcf440, on the real 29-clip / 60 s / five-effect-layer desktop project:
 * a representative review batch of 16 frames at 540x960 with captions took 11.61 s end to
 * end (8.42 s of windowed compiles, the rest compositing), i.e. ~726 ms a frame. The compile
 * is per contiguous run of sampled frames, so it scales with the frames asked for, which is
 * why it is folded into the per-frame figure rather than paid once.
 */
const MEASURED_MS_PER_REFERENCE_FRAME = 726;
/** The render size the per-frame cost was measured at (the 9:16 review size, 540x960). */
const REFERENCE_FRAME_PIXELS = 540 * 960;
/**
 * The engine's cap on a review frame's longest side (`REVIEW_MAX_DIMENSION` in
 * `validation/temporal_evidence.py`). Scope frames are measured at full project resolution.
 */
const REVIEW_MAX_DIMENSION = 960;
/**
 * A whole-timeline compile, paid once by any batch that measures the mix: 32.78 s measured
 * on the same project (ffdcf440). Audio evidence cannot use the windowed compile.
 */
const MEASURED_MIX_COMPILE_MS = 33_000;
/**
 * How far above the measurement the deadline sits. The measurement is one machine and one
 * project; long-GOP camera sources seek slower and a laptop on battery renders slower. A
 * deadline that is too long costs a late review; one that is too short throws evidence away,
 * so it errs generous.
 */
const RENDER_COST_HEADROOM = 3;
/** Nothing waits longer than this, however large the batch. */
const MAX_TIMEOUT_MS = 900_000;
/**
 * How many rendered frames one HTTP call asks for.
 *
 * The acquisition is split so that a deadline or failure part-way keeps what already came
 * back: run `19e20922` lost a whole review — the run's last look at what it made — to one
 * deadline over one all-or-nothing batch. Small chunks cost little: the engine's compile is
 * per contiguous run of frames anyway and its review-window cache carries it across calls.
 * At the measured cost, eight frames is a few seconds of work lost at most.
 */
const CHUNK_FRAME_BUDGET = 8;
const MAX_ERROR_CHARS = 400;

/** The width and height the engine will render a batch's frames at. */
interface ReviewResolution {
  readonly width: number;
  readonly height: number;
}

/** Pixels in a review frame, scaled the way the engine scales it (longest side <= 960). */
function reviewFramePixels(resolution: ReviewResolution): number {
  const longest = Math.max(resolution.width, resolution.height);
  const scale = longest <= REVIEW_MAX_DIMENSION ? 1 : REVIEW_MAX_DIMENSION / longest;
  return resolution.width * scale * (resolution.height * scale);
}

/**
 * How many frames one request makes the engine render, counted the way the engine counts
 * them (`validation/temporal_evidence.py#_plan_visual_frames` / `_scope_plan`).
 *
 * Approximate on purpose — it does not de-duplicate frames two requests share. It only has
 * to be proportional to the work: it sizes chunks and a deadline, it enforces nothing.
 */
function renderedFrames(request: TemporalEvidenceRequest): number {
  switch (request.kind) {
    case 'frame':
      return 1;
    case 'comparison':
      return 2;
    case 'range':
      return Math.ceil((request.endFrame - request.startFrame) / request.sampleEveryFrames);
    case 'scope':
      // Three representative frames, at full project resolution (see the deadline).
      return 3;
    default:
      // Motion is derived from authored keyframes and audio is measured off the mix:
      // neither renders picture.
      return 0;
  }
}

function measuresMix(request: TemporalEvidenceRequest): boolean {
  return request.kind === 'audio' || request.kind === 'loudness';
}

/**
 * The deadline this acquisition gets, in milliseconds: the queueing floor plus the measured
 * render cost of every frame it asks for at the size it will be rendered, with headroom.
 *
 * Exported so the decision is testable on its own: it is the difference between a review
 * that waits out a queue and one that throws away the moments it had not reached yet.
 *
 * @param requests - The whole acquisition.
 * @param resolution - The project's resolution; absent, frames are costed at the reference
 *   review size.
 * @returns A deadline of at least {@link BASE_TIMEOUT_MS} and at most {@link MAX_TIMEOUT_MS}.
 */
export function estimatedBatchDeadline(
  requests: readonly TemporalEvidenceRequest[],
  resolution?: ReviewResolution,
): number {
  const reviewScale = resolution ? reviewFramePixels(resolution) / REFERENCE_FRAME_PIXELS : 1;
  const scopeScale = resolution
    ? (resolution.width * resolution.height) / REFERENCE_FRAME_PIXELS
    : 1;
  let renderMs = requests.some(measuresMix) ? MEASURED_MIX_COMPILE_MS : 0;
  for (const request of requests) {
    const scale = request.kind === 'scope' ? scopeScale : reviewScale;
    renderMs += renderedFrames(request) * MEASURED_MS_PER_REFERENCE_FRAME * scale;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.round(BASE_TIMEOUT_MS + RENDER_COST_HEADROOM * renderMs));
}

/**
 * Split an acquisition into the HTTP calls that make it, in plan order.
 *
 * A request is never split (the engine answers whole requests), so one larger than
 * {@link CHUNK_FRAME_BUDGET} travels alone. A request that renders nothing still counts as
 * one, so a chunk of motion checks stays bounded too; one that measures the mix fills a
 * chunk on its own, because it compiles the whole timeline.
 *
 * @param requests - The whole acquisition.
 * @returns Non-empty chunks whose concatenation is `requests`.
 */
export function chunkTemporalRequests(
  requests: readonly TemporalEvidenceRequest[],
): readonly (readonly TemporalEvidenceRequest[])[] {
  const chunks: TemporalEvidenceRequest[][] = [];
  let current: TemporalEvidenceRequest[] = [];
  let weight = 0;
  for (const request of requests) {
    const cost = measuresMix(request) ? CHUNK_FRAME_BUDGET : Math.max(1, renderedFrames(request));
    if (current.length > 0 && weight + cost > CHUNK_FRAME_BUDGET) {
      chunks.push(current);
      current = [];
      weight = 0;
    }
    current.push(request);
    weight += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface TemporalEvidenceClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  /**
   * A fixed deadline for every batch, overriding the batch-scaled one.
   *
   * For tests and for a caller that knows its own budget. Absent — the default — the
   * deadline grows with the frames the batch asks for.
   */
  readonly timeoutMs?: number;
}

/**
 * What an acquisition returns: the engine's batch, plus why it is short when it is.
 */
export interface TemporalEvidenceAcquisition extends TemporalEvidenceBatch {
  /**
   * Set only when the acquisition stopped early — a deadline, or some of its calls failing —
   * and kept the results that had already come back. Requests with no result were then NOT
   * CHECKED, which is not the same as failing: the reviewer must say so rather than turn a
   * shorter review into findings. Absent, every call came back.
   */
  readonly incomplete?: string;
}

export type TemporalEvidenceAcquirer = (
  project: Project,
  requests: readonly TemporalEvidenceRequest[],
  signal?: AbortSignal,
) => Promise<TemporalEvidenceAcquisition>;

export class TemporalEvidenceClientError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TemporalEvidenceClientError';
  }
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, MAX_ERROR_CHARS);
  } catch {
    // A proxy or crashed sidecar may return plain text; preserve a bounded excerpt.
  }
  return body.slice(0, MAX_ERROR_CHARS) || 'no error detail';
}

/** One HTTP call for one chunk; throws on a rejection or a contract mismatch. */
async function postChunk(
  fetchFn: typeof fetch,
  baseUrl: string,
  engineProject: unknown,
  requests: readonly TemporalEvidenceRequest[],
  signal: AbortSignal,
): Promise<TemporalEvidenceBatch> {
  const response = await fetchFn(`${baseUrl}/review/temporal-evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: engineProject, requests }),
    signal,
  });
  if (!response.ok) {
    const detail = errorDetail(await response.text());
    throw new TemporalEvidenceClientError(
      `Temporal evidence engine rejected the batch (${response.status}): ${detail}`,
    );
  }
  const parsed = TemporalEvidenceBatchSchema.safeParse(await response.json());
  if (!parsed.success) {
    // NAME THE FIELDS. This is the only place a TS/Python contract drift on the
    // review path can be caught, and a bare "did not match its contract" is a dead
    // end: run `137d8fd0` lost all seven of its reviews to `perceptualHash: null`
    // and the sentence gave nobody anything to look at. The path list is what turns
    // that into a one-line diagnosis.
    const where = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    const more =
      parsed.error.issues.length > 5 ? `, and ${String(parsed.error.issues.length - 5)} more` : '';
    log.error('acquire ← temporal evidence failed its contract', {
      issues: parsed.error.issues.length,
      where,
    });
    throw new TemporalEvidenceClientError(
      `Temporal evidence response did not match its contract — ${where}${more}.`.slice(
        0,
        MAX_ERROR_CHARS + 120,
      ),
    );
  }
  return parsed.data;
}

/**
 * Create a cancelling acquisition callback that keeps what landed.
 *
 * The requests go to the engine in small chunks ({@link chunkTemporalRequests}) under ONE
 * deadline for the whole acquisition ({@link estimatedBatchDeadline}). When the deadline
 * passes or a chunk fails after others came back, the results already received are returned
 * with {@link TemporalEvidenceAcquisition.incomplete} saying why the rest are missing. It
 * still fails closed when nothing came back, and always on cancellation: an answer that
 * arrives after the editor moved on is not consent to use it.
 */
export function createTemporalEvidenceAcquirer(
  options: TemporalEvidenceClientOptions,
): TemporalEvidenceAcquirer {
  const fetchFn = options.fetchFn ?? fetch;
  return async (project, requests, signal) => {
    if (requests.length === 0) {
      throw new TemporalEvidenceClientError(
        'Temporal evidence acquisition requires a non-empty plan.',
      );
    }
    // SCALED WITH THE BATCH, not fixed. The acquirer knows how many frames it is asking
    // for and at what size; the deadline that was right for a three-frame probe was the
    // one that discarded a whole review of a long sequence.
    const timeoutMs = options.timeoutMs ?? estimatedBatchDeadline(requests, project.resolution);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Temporal evidence timed out.'));
    }, timeoutMs);

    const engineProject = toEngineProject(project);
    const chunks = chunkTemporalRequests(requests);
    const landed: TemporalEvidenceBatch[] = [];
    let acquired = 0;
    let failed = 0;
    let firstFailure: TemporalEvidenceClientError | undefined;
    try {
      for (const chunk of chunks) {
        if (controller.signal.aborted) break;
        try {
          landed.push(
            await postChunk(fetchFn, options.baseUrl, engineProject, chunk, controller.signal),
          );
          acquired += chunk.length;
        } catch (error) {
          // A deadline or a cancellation ends the acquisition; any other failure costs
          // only its own chunk; the next may well succeed (one request past the
          // timeline's end is rejected, the rest are fine).
          if (controller.signal.aborted) break;
          failed += chunk.length;
          firstFailure ??=
            error instanceof TemporalEvidenceClientError
              ? error
              : new TemporalEvidenceClientError('Temporal evidence acquisition failed.', {
                  cause: error,
                });
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted === true) {
      throw new TemporalEvidenceClientError('Temporal evidence acquisition was cancelled.');
    }
    const timeoutText = `timed out after ${timeoutMs}ms`;
    const first = landed[0];
    if (first === undefined) {
      if (timedOut && firstFailure === undefined) {
        throw new TemporalEvidenceClientError(
          `Temporal evidence acquisition ${timeoutText} for ${requests.length} request(s). The engine serializes one batch at a time, so this may be a queue behind an export or another run rather than a slow render.`,
        );
      }
      throw (
        firstFailure ?? new TemporalEvidenceClientError('Temporal evidence acquisition failed.')
      );
    }

    const results = landed.flatMap((batch) => batch.results);
    const missing = requests.length - acquired;
    const reasons = [
      ...(firstFailure ? [`${String(failed)} failed (${firstFailure.message})`] : []),
      ...(missing - failed > 0
        ? [`${String(missing - failed)} not reached before the acquisition ${timeoutText}`]
        : []),
    ];
    const incomplete =
      missing > 0
        ? `${String(missing)} of ${String(requests.length)} evidence request(s) came back without evidence: ${reasons.join('; ')}.`
        : undefined;
    const resultRenderSettings = [
      ...new Set(
        results.flatMap((result) =>
          result.renderSettings ? [result.renderSettings.identity] : [],
        ),
      ),
    ];
    const logFields = {
      revision: requests[0]?.projectRevision,
      requests: requests.length,
      chunks: chunks.length,
      results: results.length,
      renderSettings:
        resultRenderSettings.length > 0
          ? resultRenderSettings.join(',')
          : first.renderSettings.identity,
    };
    if (incomplete) log.warn('acquire ← temporal evidence (partial)', { ...logFields, incomplete });
    else log.action('acquire ← temporal evidence', logFields);
    return {
      renderSettings: first.renderSettings,
      results,
      ...(incomplete === undefined ? {} : { incomplete }),
    };
  };
}
