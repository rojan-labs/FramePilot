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
 */
import { randomUUID } from 'node:crypto';
import {
  TIER1_VERSION,
  colourRerankPlan,
  colourRerankScores,
  type ColourRerankPlan,
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
}

/** Why a re-rank produced nothing; logged, never shown to the model. */
class RerankUnavailable extends Error {}

/**
 * Build the `rerank` evidence source the masking executor calls on every resolution.
 *
 * @returns A source that answers `undefined` whenever it cannot score, so the resolver asks.
 */
export function createCropReranker(options: CropRerankerOptions): CropReranker {
  return async (request) => {
    const plan = colourRerankPlan(request.description, request.candidates);
    if (plan === undefined) return undefined;
    try {
      const scores = await scoreCrops(options, request, plan);
      log.action('cropRerankScored', { candidates: plan.candidates.length, colour: plan.colour });
      return scores;
    } catch (error) {
      log.warn('cropRerankUnavailable', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
}

async function scoreCrops(
  options: CropRerankerOptions,
  request: CropRerankRequest,
  plan: ColourRerankPlan,
): Promise<ReadonlyMap<string, number>> {
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
  const service = await options.tracking();
  const run = async (worker: CapabilityPackWorkerRequest): Promise<CapabilityPackWorkerResult> => {
    const outcome = await service.run(worker, {
      projectRevision: revision,
      mediaRoot: built.mediaRoot,
      whenMissing: 'skip',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.status === 'completed') return outcome.result;
    throw new RerankUnavailable(
      outcome.status === 'pack_missing' ? 'pack_missing' : `${outcome.code}: ${outcome.detail}`,
    );
  };
  const embedded = await run(built.request);
  const texts = await run({
    type: 'request',
    protocolVersion: 1,
    requestId: `rerank-text-${randomUUID()}`,
    projectRevision: revision,
    capability: 'visual.text',
    parameters: { texts: [...plan.prompts] },
  });
  if (embedded.capability !== 'visual.embed' || texts.capability !== 'visual.text') {
    throw new RerankUnavailable('Visual Embed answered a different capability.');
  }
  const byShot = new Map(embedded.shots.map((shot) => [shot.shotIndex, shot.vector]));
  const crops = plan.candidates.map((_candidate, index) => {
    const packed = byShot.get(index);
    if (packed === undefined) throw new RerankUnavailable(`No vector for crop ${String(index)}.`);
    return unpackFp16(packed);
  });
  return colourRerankScores(plan, crops, texts.vectors.map(unpackFp16));
}
