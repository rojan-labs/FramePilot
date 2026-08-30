/**
 * @framepilot/ai-sdk/references/analyze-client — turn a reference file into a
 * {@link ReferenceProfile} through the sidecar's `POST /references/analyze` (P3.3).
 *
 * The sidecar measures and caches (by content hash); this side decides the role and
 * renders the constraints. Pure apart from the injected fetch, so the profile builder is
 * table-tested against canned route responses.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import {
  buildReferenceProfile,
  ReferenceImageProfileSchema,
  ReferenceVideoProfileSchema,
  type ReferenceProfile,
} from './profile.js';
import type { ReferenceRole } from './role.js';

const log = createLogger('ai-sdk:references:analyze');

const ResponseSchema = z.object({
  kind: z.enum(['video', 'image']),
  contentHash: z.string().min(8),
  video: ReferenceVideoProfileSchema.optional(),
  image: ReferenceImageProfileSchema.optional(),
  cached: z.boolean().default(false),
});

export interface AnalyzeReferenceOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface AnalyzeReferenceInput {
  readonly id: string;
  /** Absolute path inside the projects sandbox (where the host copied the attachment). */
  readonly inputPath: string;
  readonly fileName: string;
  readonly kind: 'video' | 'image';
  readonly role: ReferenceRole;
  readonly refresh?: boolean;
}

export interface AnalyzeReferenceResult {
  readonly profile: ReferenceProfile;
  readonly cached: boolean;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export function createReferenceAnalyzer(options: AnalyzeReferenceOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  return async (
    input: AnalyzeReferenceInput,
    signal?: AbortSignal,
  ): Promise<AnalyzeReferenceResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchFn(`${options.baseUrl}/references/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input_path: input.inputPath,
          kind: input.kind,
          ...(input.refresh ? { refresh: true } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Reference analysis failed for ${input.fileName} (${String(response.status)}): ${detail.slice(0, 300)}`,
        );
      }
      const parsed = ResponseSchema.parse(await response.json());
      const profile = buildReferenceProfile({
        id: input.id,
        role: input.role,
        kind: parsed.kind,
        fileName: input.fileName,
        contentHash: parsed.contentHash,
        analyzedAt: now().toISOString(),
        ...(parsed.video ? { video: parsed.video } : {}),
        ...(parsed.image ? { image: parsed.image } : {}),
      });
      log.action('reference analyzed', {
        id: input.id,
        kind: parsed.kind,
        role: input.role,
        cached: parsed.cached,
        constraints: profile.constraints.length,
      });
      return { profile, cached: parsed.cached };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
