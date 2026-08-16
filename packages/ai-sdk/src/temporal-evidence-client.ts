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
 * Long enough to cover the largest batch the engine will accept.
 *
 * This is the client half of one shared budget; the engine half is
 * `MAX_RENDERED_FRAMES` in `validation/temporal_evidence.py`, and the two are
 * only meaningful together. The old 120s was below the cost of even a *default*
 * 48-request plan on a real sequence (~134s), so temporal review timed out as a
 * matter of course on any project big enough to want reviewing, and every edit
 * came back "applied but not perceptually reviewed".
 *
 * Since ADR 0124 review measures at `REVIEW_MAX_DIMENSION` rather than the
 * project's resolution, and a sampled frame costs 38ms rather than 273ms
 * (measured, 8-clip 2160x3840 sequence). The worst-case batch is therefore
 * ~3 compiles + 400x38ms ≈ 30s, comfortably inside this. The timeout is kept at
 * 300s deliberately: it is headroom for a slow machine and a heavier sequence,
 * not a target, and lowering it would buy nothing except a new way to report a
 * healthy engine as unreachable.
 */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_ERROR_CHARS = 400;

export interface TemporalEvidenceClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (project, requests, signal) => {
    if (requests.length === 0) {
      throw new TemporalEvidenceClientError(
        'Temporal evidence acquisition requires a non-empty plan.',
      );
    }
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
        throw new TemporalEvidenceClientError(
          'Temporal evidence response did not match its contract.',
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
            ? `Temporal evidence acquisition timed out after ${timeoutMs}ms.`
            : 'Temporal evidence acquisition failed.',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
