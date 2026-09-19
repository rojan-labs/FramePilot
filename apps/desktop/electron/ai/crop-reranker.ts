/**
 * The desktop's colour re-ranker for `find_mask_targets` (AM2.5; plan 11 target resolution).
 *
 * "The red car" with two cars on screen: Subject Intelligence says both are `car`, so the host
 * asks the Visual Embed pack to embed each car's CROP and the phrase "a photo of a {colour} car"
 * in every colour of the palette, and hands the resolver the named colour's share per candidate.
 * What to crop and how to score is decided in `@framepilot/ai-sdk` (`colourRerankPlan`,
 * `colourRerankScores`); this file only runs the pack.
 *
 * Optional evidence, never a gate: no plan, no installed Visual Embed (or one older than 1.1.0,
 * which cannot crop), a failed job or a malformed answer all return `undefined`, and the resolver
 * then asks the editor — the pre-AM2.5 behaviour. A missing pack is never offered for install
 * from here: the editor did not ask for it, and a re-rank is not worth a download prompt.
 *
 * **One process per request once warm (AM2.6).** The palette prompts for a noun are the same
 * sentences every time, so their vectors are kept per pack release ({@link PromptVectorCache});
 * the `visual.text` run happens once per noun and release, not once per request. Measured on the
 * M1 Pro: 7.8 s for the first "red car" request, 1.8 s for the next.
 *
 * **Measured colour beside SigLIP (AM2.7).** With a `measure` source (the engine's
 * `/masking/crop-colour`, `crop-colour-client.ts`), each candidate's crop is also measured in
 * CIELAB — in parallel with the pack run — and a candidate is picked only when both signals agree.
 * That is what lets "the white car" or "the silver car" resolve: SigLIP barely separates the
 * neutral colours. A failed measurement is logged and the scores are SigLIP's alone, as before.
 */
import { randomUUID } from 'node:crypto';
import {
  TIER1_VERSION,
  colourRerankPlan,
  colourRerankScores,
  type ColourRerankPlan,
  type CropColourMeasurement,
  type MaskCandidate,
} from '@framepilot/ai-sdk';
import type {
  CapabilityPackWorkerRequest,
  CapabilityPackWorkerResult,
} from '@framepilot/capability-packs';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { buildTrackingWorkerRequest } from '../capability-packs/tracking-request.js';
import type { CapabilityPackTrackingService } from '../capability-packs/tracking.js';
import type { CropColourSource } from './crop-colour-client.js';
import { unpackFp16 } from './packed-vector.js';

const log = createLogger('desktop:ai:crop-rerank');

export interface CropRerankRequest {
  readonly project: Project;
  readonly assetId: string;
  readonly description: string;
  readonly candidates: readonly MaskCandidate[];
  readonly signal?: AbortSignal;
}

export type CropReranker = (
  request: CropRerankRequest,
) => Promise<ReadonlyMap<string, number> | undefined>;

export interface CropRerankerOptions {
  /** The same pack authority the masking executor detects with. */
  readonly tracking: () => Promise<CapabilityPackTrackingService>;
  /** Prompt vectors kept across requests; one per reranker by default. Injected in tests. */
  readonly promptCache?: PromptVectorCache;
  /** The engine's colour measurement of each crop (AM2.7). Absent: SigLIP alone decides. */
  readonly measure?: CropColourSource;
}

/** Most prompt vectors kept: 12 palette sentences for about 40 nouns. */
export const MAX_CACHED_PROMPT_VECTORS = 512;

/**
 * Text vectors of the palette prompts, per exact pack release (AM2.6).
 *
 * Keyed by the release digest as well as the sentence: a vector from one release is never scored
 * against a crop from another. Bounded; the oldest entry goes first.
 */
export class PromptVectorCache {
  private readonly vectors = new Map<string, readonly number[]>();

  public constructor(private readonly limit = MAX_CACHED_PROMPT_VECTORS) {}

  /** Every prompt's vector for this release, or `undefined` when any one is missing. */
  public all(release: string, prompts: readonly string[]): number[][] | undefined {
    const found = prompts.map((prompt) => this.vectors.get(`${release}\0${prompt}`));
    return found.every((vector) => vector !== undefined)
      ? found.map((vector) => [...vector!])
      : undefined;
  }

  public remember(release: string, prompts: readonly string[], vectors: readonly number[][]): void {
    prompts.forEach((prompt, index) => {
      const key = `${release}\0${prompt}`;
      this.vectors.delete(key);
      this.vectors.set(key, vectors[index]!);
    });
    while (this.vectors.size > this.limit) {
      this.vectors.delete(this.vectors.keys().next().value!);
    }
  }
}

/** Why a re-rank produced nothing; logged, never shown to the model. */
class RerankUnavailable extends Error {}

/**
 * Build the `rerank` evidence source the masking executor calls on every resolution.
 *
 * @returns A source that answers `undefined` whenever it cannot score, so the resolver asks.
 */
export function createCropReranker(options: CropRerankerOptions): CropReranker {
  const promptCache = options.promptCache ?? new PromptVectorCache();
  return async (request) => {
    const plan = colourRerankPlan(request.description, request.candidates);
    if (plan === undefined) return undefined;
    try {
      const { scores, measured } = await scoreCrops(options, promptCache, request, plan);
      log.action('cropRerankScored', {
        candidates: plan.candidates.length,
        colour: plan.colour,
        measured,
      });
      return scores;
    } catch (error) {
      log.warn('cropRerankUnavailable', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
}

/**
 * The engine's measurement of every planned crop, or `undefined` when there is no source or it
 * failed. Never rejects: it runs beside the pack job, and its failure must not fail the re-rank.
 */
async function measureCrops(
  source: CropColourSource | undefined,
  absolutePath: string | undefined,
  plan: ColourRerankPlan,
  frames: readonly number[],
  fps: number,
  signal: AbortSignal | undefined,
): Promise<readonly (CropColourMeasurement | undefined)[] | undefined> {
  if (source === undefined || absolutePath === undefined) return undefined;
  try {
    const measured = await source({
      absolutePath,
      fps,
      crops: plan.candidates.map((candidate, index) => ({
        timeSeconds: frames[index]! / fps,
        box: candidate.box,
      })),
      ...(signal === undefined ? {} : { signal }),
    });
    if (measured.length !== plan.candidates.length) {
      throw new Error('The colour measurement answered a different number of crops.');
    }
    return measured;
  } catch (error) {
    log.warn('cropColourUnmeasured', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function scoreCrops(
  options: CropRerankerOptions,
  promptCache: PromptVectorCache,
  request: CropRerankRequest,
  plan: ColourRerankPlan,
): Promise<{ readonly scores: ReadonlyMap<string, number>; readonly measured: boolean }> {
  const { project } = request;
  const revision = project.timeline.revision ?? 0;
  const fps = Number(project.fps);
  const frames = plan.candidates.map((candidate) => Math.round(candidate.sourceTime * fps));
  const built = buildTrackingWorkerRequest(project, revision, {
    requestId: `rerank-${randomUUID()}`,
    assetId: request.assetId,
    capability: 'visual.embed',
    firstFrame: Math.min(...frames),
    lastFrameExclusive: Math.max(...frames) + 1,
    fps,
    parameters: {
      promptBankVersion: TIER1_VERSION,
      shots: plan.candidates.map((candidate, index) => ({
        shotIndex: index,
        keyframeT: frames[index]! / fps,
        region: candidate.box,
      })),
    },
  });
  if (built.status === 'rejected') throw new RerankUnavailable(built.detail);
  // Started before the pack job and awaited after it: the decode and the embedding overlap.
  const measuring = measureCrops(
    options.measure,
    // The builder has just checked this asset is a video with an absolute path.
    project.assets?.find((asset) => asset.id === request.assetId)?.path,
    plan,
    frames,
    fps,
    request.signal,
  );
  const service = await options.tracking();
  const run = async (
    worker: CapabilityPackWorkerRequest,
  ): Promise<{ result: CapabilityPackWorkerResult; release: string }> => {
    const outcome = await service.run(worker, {
      projectRevision: revision,
      mediaRoot: built.mediaRoot,
      whenMissing: 'skip',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.status === 'completed') {
      return { result: outcome.result, release: outcome.identity.releaseDigest };
    }
    throw new RerankUnavailable(
      outcome.status === 'pack_missing' ? 'pack_missing' : `${outcome.code}: ${outcome.detail}`,
    );
  };
  const { result: embedded, release } = await run(built.request);
  if (embedded.capability !== 'visual.embed') {
    throw new RerankUnavailable('Visual Embed answered a different capability.');
  }
  const embedPrompts = async (): Promise<number[][]> => {
    const texts = await run({
      type: 'request',
      protocolVersion: 1,
      requestId: `rerank-text-${randomUUID()}`,
      projectRevision: revision,
      capability: 'visual.text',
      parameters: { texts: [...plan.prompts] },
    });
    if (texts.result.capability !== 'visual.text') {
      throw new RerankUnavailable('Visual Embed answered a different capability.');
    }
    // Crops and prompts must come from one release: an update between the two runs voids both.
    if (texts.release !== release) {
      throw new RerankUnavailable('Visual Embed changed between the crop and prompt runs.');
    }
    const vectors = texts.result.vectors.map(unpackFp16);
    promptCache.remember(release, plan.prompts, vectors);
    log.debug('cropRerankPromptsEmbedded', { prompts: vectors.length });
    return vectors;
  };
  const promptVectors = promptCache.all(release, plan.prompts) ?? (await embedPrompts());
  const byShot = new Map(embedded.shots.map((shot) => [shot.shotIndex, shot.vector]));
  const crops = plan.candidates.map((_candidate, index) => {
    const packed = byShot.get(index);
    if (packed === undefined) throw new RerankUnavailable(`No vector for crop ${String(index)}.`);
    return unpackFp16(packed);
  });
  const measurements = await measuring;
  return {
    scores: colourRerankScores(plan, crops, promptVectors, measurements),
    measured: measurements !== undefined,
  };
}
