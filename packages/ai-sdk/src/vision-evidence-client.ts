/** Strict client for composited frames used by semantic vision review. */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { z } from 'zod/v4';
import { toModelProject } from './model-view.js';
import type { VisionFrame, VisionReviewRequest } from './vision-review.js';

const log = createLogger('ai-sdk:vision-evidence-client');
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 400;

const RenderedFrameResponseSchema = z
  .object({
    media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    base64: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    time_seconds: z.number().nonnegative(),
    duration_seconds: z.number().nonnegative(),
  })
  .passthrough();

export interface VisionEvidenceClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxDimension?: number;
}

export type ProjectVisionFrameAcquirer = (
  project: Project,
  request: VisionReviewRequest,
  signal?: AbortSignal,
) => Promise<readonly VisionFrame[]>;

export class VisionEvidenceClientError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VisionEvidenceClientError';
  }
}

function boundedDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, MAX_ERROR_CHARS);
  } catch {
    // Preserve a bounded plain-text proxy/sidecar error below.
  }
  return body.slice(0, MAX_ERROR_CHARS) || 'no error detail';
}

/**
 * Render exactly the frames declared by a semantic objective from the unsaved working project.
 * Each response is checked for time clamping so a reviewer can never be shown a different moment
 * under the requested frame's identity.
 */
export function createVisionFrameAcquirer(
  options: VisionEvidenceClientOptions,
): ProjectVisionFrameAcquirer {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDimension = options.maxDimension ?? 512;
  return async (project, request, signal) => {
    const frames: VisionFrame[] = [];
    for (const frame of request.frames) {
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = (): void => controller.abort(signal?.reason);
      if (signal?.aborted) controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Vision frame acquisition timed out.'));
      }, timeoutMs);
      try {
        const requestedSeconds = frame / project.fps;
        const response = await fetchFn(`${options.baseUrl}/render/frame`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: toModelProject(project),
            time_seconds: requestedSeconds,
            max_dimension: maxDimension,
            image_format: 'jpeg',
            burn_captions: true,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new VisionEvidenceClientError(
            `Frame renderer rejected frame ${frame} (${response.status}): ${boundedDetail(
              await response.text(),
            )}`,
          );
        }
        const parsed = RenderedFrameResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new VisionEvidenceClientError(
            `Frame renderer returned an invalid response for frame ${frame}.`,
          );
        }
        if (Math.abs(parsed.data.time_seconds - requestedSeconds) > 0.5 / project.fps) {
          throw new VisionEvidenceClientError(
            `Frame ${frame} was clamped to ${parsed.data.time_seconds.toFixed(3)}s.`,
          );
        }
        frames.push({
          frame,
          imageBase64: parsed.data.base64,
          mediaType: parsed.data.media_type,
        });
      } catch (error) {
        if (error instanceof VisionEvidenceClientError) throw error;
        throw new VisionEvidenceClientError(
          signal?.aborted === true
            ? 'Vision frame acquisition was cancelled.'
            : timedOut
              ? `Vision frame acquisition timed out after ${timeoutMs}ms.`
              : `Vision frame acquisition failed for frame ${frame}.`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    log.action('acquire ← semantic review frames', {
      requestId: request.requestId,
      revision: request.projectRevision,
      frames: frames.length,
    });
    return frames;
  };
}
