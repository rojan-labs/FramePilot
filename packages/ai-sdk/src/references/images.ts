/**
 * @framepilot/ai-sdk/references/images — the attached reference IMAGE itself, sent to a
 * vision model as a real image part (EQ18).
 *
 * WHY this exists beside the profile. {@link ReferenceProfile} is a dozen measured lines —
 * size, palette, tone — and that is all an attached image used to be to the model. Those
 * numbers answer "grade toward this look"; they cannot answer "put this logo in the corner"
 * (what does it say?), "keep this person in frame" (who?) or "titles like this design"
 * (what layout, what type?). The picture can. So a model that reads images is now shown the
 * picture, on the same channel `get_frame` uses (`AiMessage.images`), and the profile stays
 * as what the planner cites and what a text-only model still gets.
 *
 * Only IMAGE references travel as pixels. A reference video is still its measured profile:
 * a few stills of it would say little about pacing, which is what a video reference is for.
 *
 * Pure apart from the injected fetch in {@link createReferenceStillLoader}.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import type { AiImage } from '../providers/types.js';
import type { ReferenceProfile } from './profile.js';

const log = createLogger('ai-sdk:references:images');

/** One attached reference's picture, keyed to the profile it belongs to. */
export interface ReferenceImage {
  /** The {@link ReferenceProfile.id} this picture is of. */
  readonly referenceId: string;
  readonly image: AiImage;
}

/**
 * What an image costs a provider when its size is unknown. Anthropic bills
 * `width × height / 750` tokens; a 1024 × 1024 still — the largest the engine sends — is
 * ~1,400, so this errs toward reserving slightly too much room rather than too little.
 */
const UNKNOWN_SIZE_IMAGE_TOKENS = 1_600;
const PIXELS_PER_TOKEN = 750;

/**
 * Estimate the input tokens an image costs, so the context budgeter can make room for it.
 *
 * @param image - The image as it will be sent.
 * @returns Tokens, from its pixel count when known, else a conservative constant.
 */
export function estimateImageTokens(image: AiImage): number {
  const { width, height } = image;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return UNKNOWN_SIZE_IMAGE_TOKENS;
  }
  return Math.ceil((width * height) / PIXELS_PER_TOKEN);
}

/**
 * The images to attach for the references in force, in the order the references are listed.
 *
 * A picture is attached only for an IMAGE reference that is actually in `profiles`. That
 * rule is what keeps the two in step: a reference the editor dismissed has left `profiles`
 * (`activeReferences`), and its picture must stop being shown with it — the model must
 * never see a logo it has no line of text telling it what to do with.
 *
 * Each image is labelled with its reference id and file name, because the label is the only
 * thing that tells the model which of several attached pictures is the logo and which is
 * the colour target.
 *
 * @param profiles - The references in force this turn.
 * @param images - The pictures the host loaded, in any order; extras are ignored.
 * @returns Labelled images, one per image reference that has a picture, de-duplicated.
 */
export function referenceImagesFor(
  profiles: readonly ReferenceProfile[],
  images: readonly ReferenceImage[] | undefined,
): readonly AiImage[] {
  if (images === undefined || images.length === 0 || profiles.length === 0) return [];
  const byId = new Map(images.map((entry) => [entry.referenceId, entry.image]));
  const attached: AiImage[] = [];
  for (const profile of profiles) {
    if (profile.kind !== 'image') continue;
    const image = byId.get(profile.id);
    if (image === undefined) continue;
    byId.delete(profile.id);
    attached.push({
      ...image,
      label: `reference ${profile.id} · ${profile.fileName} (${profile.role})`,
    });
  }
  return attached;
}

/**
 * The text that travels with the attached reference pictures: which is which, and what
 * they are for. Empty when nothing is attached.
 */
export function referenceImagesBlock(images: readonly AiImage[]): string {
  if (images.length === 0) return '';
  const lines = images.map((image, index) => `${index + 1}. ${image.label ?? 'a reference'}`);
  return (
    `Attached to this message ${images.length === 1 ? 'is the reference image' : `are ${images.length} reference images`} ` +
    `the editor gave you, in this order:\n${lines.join('\n')}\n` +
    'Look at them for what the measured lines cannot say — the words and marks in a logo, ' +
    'who a person is, how a design lays out its text. These are the editor’s files, not ' +
    'frames of the timeline.'
  );
}

/** What `/references/still` puts on the wire. */
const StillResponseSchema = z.object({
  media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export interface ReferenceStillLoaderOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ReferenceStillInput {
  readonly referenceId: string;
  /** Absolute path inside the projects sandbox (where the host copied the attachment). */
  readonly inputPath: string;
  readonly fileName: string;
}

/** A still is one image decode and resize — seconds, never minutes. */
const DEFAULT_STILL_TIMEOUT_MS = 30_000;

/**
 * A loader for an attached image's picture, through the sidecar's `POST /references/still`.
 *
 * @param options - The sidecar's base URL and an injectable fetch.
 * @returns A function that resolves one reference to its {@link ReferenceImage}, and
 *   rejects with a sentence naming the file when the engine cannot produce it.
 */
export function createReferenceStillLoader(options: ReferenceStillLoaderOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  return async (input: ReferenceStillInput, signal?: AbortSignal): Promise<ReferenceImage> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_STILL_TIMEOUT_MS,
    );
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchFn(`${options.baseUrl}/references/still`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_path: input.inputPath }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Could not load ${input.fileName} to show the model (${String(response.status)}): ${detail.slice(0, 300)}`,
        );
      }
      const parsed = StillResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        log.error('reference still response did not match its contract', {
          fileName: input.fileName,
          issues: parsed.error.issues,
        });
        throw new Error(
          `Could not load ${input.fileName} to show the model: the engine returned an unexpected shape.`,
        );
      }
      const { media_type: mediaType, base64, width, height } = parsed.data;
      log.debug('reference still loaded', { referenceId: input.referenceId, width, height });
      return { referenceId: input.referenceId, image: { mediaType, base64, width, height } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
