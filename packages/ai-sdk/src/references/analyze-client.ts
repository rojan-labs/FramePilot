/**
 * @framepilot/ai-sdk/references/analyze-client — turn a reference file into a
 * {@link ReferenceProfile} through the sidecar's `POST /references/analyze` (P3.3).
 *
 * The sidecar measures and caches (by content hash); this side decides the role and
 * renders the constraints. Pure apart from the injected fetch, so the profile builder is
 * table-tested against canned route responses.
 */
import { z } from 'zod/v4';
import { fromEngine } from '../engine-optional.js';
import { createLogger } from '@framepilot/shared-types';
import {
  buildReferenceProfile,
  ReferenceImageProfileSchema,
  ReferenceVideoProfileSchema,
  type ReferenceProfile,
} from './profile.js';
import type { ReferenceRole } from './role.js';

const log = createLogger('ai-sdk:references:analyze');

/**
 * What `/references/analyze` actually puts on the wire.
 *
 * `video` and `image` are `fromEngine`, not `.optional()`, and that one difference is the
 * whole bug this schema used to have. The route's `response_model` declares
 * `video: dict | None = None`, and FastAPI serialises an unset optional as an explicit
 * `null` — so analysing an IMAGE returned `{"kind":"image","video":null,"image":{…}}`,
 * `.optional()` refused the null, and attaching a photo failed with
 *
 *     [{"expected":"object","code":"invalid_type","path":["video"],
 *       "message":"Invalid input: expected object, received null"}]
 *
 * printed verbatim on the reference chip. The field it rejected is one nothing reads for
 * an image.
 *
 * The fields INSIDE those two objects are safe as `.optional()`: the engine builds them
 * with `analysis_to_dict`, which dumps `exclude_none=True`, so an unmeasured inner field
 * is an absent key rather than a null. Only the top level is serialised by FastAPI.
 */
const ResponseSchema = z.object({
  kind: z.enum(['video', 'image']),
  contentHash: z.string().min(8),
  video: fromEngine(ReferenceVideoProfileSchema),
  image: fromEngine(ReferenceImageProfileSchema),
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

/**
 * Parse the route's payload, or fail in a sentence a person can read.
 *
 * `ResponseSchema.parse` throws a `ZodError` whose `.message` is a JSON dump of its issue
 * list. That string had a clear path to the screen: the analyzer's rejection is stored on
 * the attachment and rendered on its chip, so the editor's answer to "why did my photo
 * fail?" was a serialised array of `invalid_type` objects sitting above a Re-analyze
 * button — which, being deterministic, was guaranteed to fail the same way.
 *
 * A shape mismatch here is not something an editor can act on, so the message says what
 * happened, names the file, and points at the one thing that does change the outcome. The
 * detail stays in the log, where it is useful.
 */
function parseResponse(payload: unknown, fileName: string): z.infer<typeof ResponseSchema> {
  const result = ResponseSchema.safeParse(payload);
  if (result.success) return result.data;
  const fields = [
    ...new Set(
      result.error.issues.map((issue) => issue.path.join('.')).filter((path) => path !== ''),
    ),
  ];
  log.error('reference analysis response did not match its contract', {
    fileName,
    issues: result.error.issues,
  });
  throw new Error(
    `Could not read the analysis of ${fileName}: the engine returned ` +
      `${fields.length > 0 ? `an unexpected ${fields.join(', ')}` : 'an unexpected shape'}. ` +
      'This is a FramePilot problem, not a problem with the file — re-analyzing will not ' +
      'change it. The attachment is still on the message; the reference detail is missing.',
  );
}


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
      const parsed = parseResponse(await response.json(), input.fileName);
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
