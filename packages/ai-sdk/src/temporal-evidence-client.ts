/** Typed client for deterministic temporal evidence acquisition in the engine sidecar. */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { toModelProject } from './model-view.js';
import {
  TemporalEvidenceBatchSchema,
  type TemporalEvidenceBatch,
  type TemporalEvidenceRequest,
} from './temporal-review.js';

const log = createLogger('ai-sdk:temporal-evidence-client');
/**
 * The floor under every batch, and what the whole deadline used to be.
 *
 * The old fixed 300s was set as headroom for the worst batch the engine will accept
 * (~3 compiles + 400 frames x 38ms ≈ 30s of RENDER). What it did not cover is the
 * WAITING: `/review/temporal-evidence` is serialized process-wide behind one semaphore
 * and the index governor, so a batch queues behind another run's batch, an export and a
 * preview before it renders a frame. On a ~110s project with 400+ caption cues and
 * several overlay tracks, run `19e20922`'s final review — the run's only chance to look
 * at what it had made — crossed the deadline and the whole acquisition was discarded.
 */
const BASE_TIMEOUT_MS = 300_000;
/**
 * Per rendered frame, on top of {@link BASE_TIMEOUT_MS}.
 *
 * Deliberately far above the measured 38ms per sampled frame: this is not a render
 * budget, it is a queueing one, and it must be wrong on the generous side. A full
 * 400-frame batch is allowed 300s + 200s.
 */
const PER_FRAME_TIMEOUT_MS = 500;
/** Nothing waits longer than this, however large the batch. */
const MAX_TIMEOUT_MS = 900_000;
const MAX_ERROR_CHARS = 400;

/**
 * How many frames this batch will make the engine render, counted the way the engine
 * counts them (`validation/temporal_evidence.py#acquire_temporal_evidence`).
 *
 * Approximate on purpose — it does not de-duplicate frames two requests share, and the
 * engine's own cap is the authority on what is acceptable. It only has to be
 * proportional to the work, because it is scaling a deadline rather than enforcing one.
 *
 * @param requests - The batch about to be sent.
 * @returns A frame count, at least 1.
 */
function estimatedFrames(requests: readonly TemporalEvidenceRequest[]): number {
  let frames = 0;
  for (const request of requests) {
    switch (request.kind) {
      case 'frame':
        frames += 1;
        break;
      case 'comparison':
        frames += 2;
        break;
      case 'range':
        frames +=
          Math.ceil((request.endFrame - request.startFrame) / request.sampleEveryFrames) + 1;
        break;
      case 'scope':
        frames += request.endFrame - request.startFrame;
        break;
      default:
        // Motion is derived from authored keyframes and audio is measured off the mix:
        // neither renders picture, so neither buys the batch any more time.
        break;
    }
  }
  return Math.max(1, frames);
}

/**
 * The deadline this batch gets, in milliseconds.
 *
 * Exported so the decision is testable on its own: it is the difference between a review
 * that waits out a queue and one that throws away every frame it had already rendered.
 *
 * @param requests - The batch about to be sent.
 * @returns A deadline of at least {@link BASE_TIMEOUT_MS} and at most {@link MAX_TIMEOUT_MS}.
 */
export function estimatedBatchDeadline(requests: readonly TemporalEvidenceRequest[]): number {
  return Math.min(
    MAX_TIMEOUT_MS,
    BASE_TIMEOUT_MS + PER_FRAME_TIMEOUT_MS * estimatedFrames(requests),
  );
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

export type TemporalEvidenceAcquirer = (
  project: Project,
  requests: readonly TemporalEvidenceRequest[],
  signal?: AbortSignal,
) => Promise<TemporalEvidenceBatch>;

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

/**
 * Create a strict, cancelling acquisition callback. Unlike optional cache warmers,
 * this fails closed: a run cannot claim temporal verification after an HTTP,
 * timeout, cancellation, or response-schema failure.
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
    // for and at what settings; the deadline that was right for a three-frame probe was
    // the one that discarded a whole review of a long sequence.
    const timeoutMs = options.timeoutMs ?? estimatedBatchDeadline(requests);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Temporal evidence timed out.'));
    }, timeoutMs);
    try {
      const response = await fetchFn(`${options.baseUrl}/review/temporal-evidence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: toModelProject(project), requests }),
        signal: controller.signal,
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
          parsed.error.issues.length > 5
            ? `, and ${String(parsed.error.issues.length - 5)} more`
            : '';
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
      const resultRenderSettings = [
        ...new Set(
          parsed.data.results.flatMap((result) =>
            result.renderSettings ? [result.renderSettings.identity] : [],
          ),
        ),
      ];
      log.action('acquire ← temporal evidence', {
        revision: requests[0]?.projectRevision,
        requests: requests.length,
        results: parsed.data.results.length,
        renderSettings:
          resultRenderSettings.length > 0
            ? resultRenderSettings.join(',')
            : parsed.data.renderSettings.identity,
      });
      return parsed.data;
    } catch (error) {
      if (error instanceof TemporalEvidenceClientError) throw error;
      const cancelled = signal?.aborted === true;
      throw new TemporalEvidenceClientError(
        cancelled
          ? 'Temporal evidence acquisition was cancelled.'
          : timedOut
            ? `Temporal evidence acquisition timed out after ${timeoutMs}ms for ${requests.length} request(s). The engine serializes one batch at a time, so this may be a queue behind an export or another run rather than a slow render.`
            : 'Temporal evidence acquisition failed.',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
