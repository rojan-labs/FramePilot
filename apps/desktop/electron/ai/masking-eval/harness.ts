/**
 * The AI masking eval harness (AM5.2): every labelled request through the real tool path.
 *
 * What is real: the orchestrator's agent loop (tool dispatch, `create_mask` argument rules, the
 * editor's-numbers and editor's-pick checks, the geometry-provenance boundary, the validator),
 * the desktop `createMaskingExecutor` (detection windows, target resolution, the candidate
 * cache, candidate re-resolution) and the ai-sdk op builders. What is supplied:
 *
 * - **The packs.** A fake Subject Intelligence service that emits exactly the scene's detector
 *   hits — the "recorded or synthetic" pack output the plan allows — with the COCO class a 1.1
 *   pack reports when the request asks for it (AM2.5). Every box it emits is logged, so a landed
 *   mask can be traced back to a labelled thing. A fake Visual Embed answers crop and text
 *   requests with synthetic vectors: a crop sits on its thing's colour axis (no colour → no
 *   axis), a prompt on the axis of the colour it names. That proves the wiring and the decision
 *   rules with ground truth by construction; it says nothing about SigLIP's accuracy.
 * - **The model.** A scripted policy, not an LLM: it passes the item's target phrase to
 *   `find_mask_targets` and masks what was chosen, or — for the adversarial items — tries to get
 *   round a rule (use an id the editor was asked to pick, strip its `pick.` marker, send a shape
 *   the editor never typed, invent a candidate id). The model's own phrasing is therefore NOT
 *   measured here; a real-model run would measure it, and is not run on this machine.
 * - **Evidence sources exactly as `main.ts` ships them:** the crop re-ranker (built by the same
 *   `createCropReranker`, over the fake packs), no identity source, and face-recognition consent
 *   read per scene.
 *
 * Deterministic: no clock, no randomness, no network. Same fixture ⇒ byte-identical report.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COLOUR_WORDS,
  MaskTargetsResultSchema,
  Orchestrator,
  carriesMaskGeometry,
  type AiEvent,
  type AiProvider,
  type AiResponse,
  type ContextInput,
  type HostExecutionContext,
  type HostToolExecutor,
  type HostToolOutcome,
  type MaskTargetsResult,
} from '@framepilot/ai-sdk';
import {
  negotiatePackRequest,
  type CapabilityPackWorkerRequest,
} from '@framepilot/capability-packs';
import type { AnyOperation } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { CapabilityPackMatteService } from '../../capability-packs/matte.js';
import type { CapabilityPackTrackingService } from '../../capability-packs/tracking.js';
import { createCropReranker } from '../crop-reranker.js';
import { createMaskingExecutor } from '../masking-executor.js';
import { packFp16 } from '../packed-vector.js';
import type { EvalRequest, RequestSet, Scene, SceneThing } from './fixture.js';
import {
  judge,
  summarise,
  traceMaskBox,
  type EmittedBox,
  type EvalSummary,
  type ItemVerdict,
  type MaskTrace,
  type NormalisedBox,
  type RunStatus,
} from './scoring.js';

const log = createLogger('desktop:ai:masking-eval');

const CLIP_ID = 'shot';
const ASSET_ID = 'asset';
/** The pack releases the eval stands in for: the AM2.5 ones, unless a run asks for 1.0. */
export const CURRENT_PACK_VERSION = '1.1.0';
export const LEGACY_PACK_VERSION = '1.0.0';
const packIdentity = (version: string) => ({
  id: 'framepilot.subject-intelligence',
  version,
  releaseDigest: 'e'.repeat(64),
});
const embedIdentity = (version: string) => ({
  id: 'framepilot.visual-embed',
  version,
  releaseDigest: 'f'.repeat(64),
});
/** A crop's region matches a thing's box on that frame when they overlap at least this much. */
const CROP_MATCH_IOU = 0.9;
/** A well-formed candidate id nothing measured, for the `invent_candidate` policy. */
const INVENTED_CANDIDATE_ID = 'f24_0badc0de';
const PICK_MARKER = 'pick.';

function evalProject(set: RequestSet, dir: string): Project {
  const { fps, seconds, width, height } = set.clip;
  return parseProject({
    id: 'masking_eval',
    name: 'AI masking eval',
    version: 1,
    fps,
    resolution: { width, height },
    assets: [
      {
        id: ASSET_ID,
        path: path.join(dir, 'scene.mp4'),
        kind: 'video',
        durationSeconds: seconds,
        media: { width, height, fps },
      },
    ],
    timeline: {
      revision: 1,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: CLIP_ID,
              assetId: ASSET_ID,
              trackId: 'v1',
              start: 0,
              end: seconds,
              sourceStart: 0,
              sourceEnd: seconds,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/** The scene's detector hit for one thing on one frame, or none. */
function hitOn(thing: SceneThing, frame: number): NormalisedBox | null {
  if (thing.detector === null || thing.box === undefined) return null;
  if (thing.frames !== undefined && (frame < thing.frames[0] || frame >= thing.frames[1])) {
    return null;
  }
  const [dx, dy] = thing.drift ?? [0, 0];
  const [x, y, width, height] = thing.box;
  return { x: x + dx * frame, y: y + dy * frame, width, height };
}

/** The class a Subject Intelligence 1.1 pack reports for a thing: `person` for people. */
function classOf(thing: SceneThing): string | undefined {
  return thing.detector === 'person' ? 'person' : thing.class;
}

function overlap(a: NormalisedBox, b: NormalisedBox): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const inter =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/** A unit vector on one colour's axis, or an even spread when the colour is unknown. */
function colourAxis(colour: string | undefined): number[] {
  const known = colour !== undefined && COLOUR_WORDS.includes(colour);
  const spread = 1 / Math.sqrt(COLOUR_WORDS.length);
  return COLOUR_WORDS.map((each) => (known ? (each === colour ? 1 : 0) : spread));
}

interface SceneRequest {
  capability: string;
  media?: { firstFrame: number; lastFrameExclusive: number; fps: number };
  parameters: {
    classes?: boolean;
    shots?: { shotIndex: number; keyframeT: number; region?: NormalisedBox }[];
    texts?: string[];
  };
}

function detect(
  scene: Scene,
  emitted: EmittedBox[],
  request: SceneRequest,
  version: string,
): unknown {
  const media = request.media!;
  const detections = [];
  for (let frame = media.firstFrame; frame < media.lastFrameExclusive; frame++) {
    for (const thing of scene.things) {
      const box = hitOn(thing, frame);
      if (box === null) continue;
      emitted.push({ thingId: thing.id, box });
      const objectClass = request.parameters.classes === true ? classOf(thing) : undefined;
      detections.push({
        frame,
        label: thing.detector,
        box,
        confidence: thing.confidence,
        // A 1.1 pack's classScore is the conditional class probability, which is at least the
        // joint confidence; the confidence is used as that lower bound.
        ...(objectClass === undefined ? {} : { class: objectClass, classScore: thing.confidence }),
      });
    }
  }
  return {
    status: 'completed',
    identity: packIdentity(version),
    result: { backend: 'eval-fixture', modelDigests: [], detections },
  };
}

/** Visual Embed's crop answer: each crop on its thing's colour axis, found by the crop's box. */
function embedCrops(scene: Scene, request: SceneRequest, version: string): unknown {
  const fps = request.media!.fps;
  const shots = (request.parameters.shots ?? []).map((shot) => {
    const frame = Math.round(shot.keyframeT * fps);
    const thing = scene.things.find((candidate) => {
      const box = hitOn(candidate, frame);
      return (
        box !== null && shot.region !== undefined && overlap(box, shot.region) >= CROP_MATCH_IOU
      );
    });
    return { shotIndex: shot.shotIndex, vector: packFp16(colourAxis(thing?.colour)) };
  });
  return {
    status: 'completed',
    identity: embedIdentity(version),
    result: { capability: 'visual.embed', shots },
  };
}

/** Visual Embed's text answer: each prompt on the axis of the colour it names. */
function embedTexts(request: SceneRequest, version: string): unknown {
  const vectors = (request.parameters.texts ?? []).map((text) =>
    packFp16(colourAxis(COLOUR_WORDS.find((colour) => text.split(' ').includes(colour)))),
  );
  return {
    status: 'completed',
    identity: embedIdentity(version),
    result: { capability: 'visual.text', vectors },
  };
}

/**
 * Subject Intelligence and Visual Embed stand-ins that answer from the scene, as the release
 * `version` would: every request first goes through the tracking service's own negotiation, so
 * a 1.0 run never sees a class and never gets a crop scored.
 */
function scenePack(
  scene: Scene,
  emitted: EmittedBox[],
  version: string,
): () => Promise<CapabilityPackTrackingService> {
  const run = async (sent: CapabilityPackWorkerRequest): Promise<unknown> => {
    const negotiated = negotiatePackRequest(sent, version);
    if (negotiated.status === 'pack_outdated') {
      return {
        status: 'failed',
        code: 'pack_outdated',
        detail: negotiated.detail,
        retryable: false,
      };
    }
    const request = negotiated.request as unknown as SceneRequest;
    if (request.capability === 'subject.detect') return detect(scene, emitted, request, version);
    if (request.capability === 'visual.embed') return embedCrops(scene, request, version);
    if (request.capability === 'visual.text') return embedTexts(request, version);
    return {
      status: 'failed',
      code: 'worker_failed',
      detail: `The eval packs only detect and embed; ${request.capability} was asked for.`,
      retryable: false,
    };
  };
  return async () => ({ run }) as unknown as CapabilityPackTrackingService;
}

const noMatte = async (): Promise<CapabilityPackMatteService> => {
  throw new Error('The AI masking eval measures shapes only; no matte job may start.');
};

type Observed = { find?: MaskTargetsResult };

/** The executor, with what `find_mask_targets` returned kept for the scripted model to read. */
function observing(executor: HostToolExecutor, observed: Observed): HostToolExecutor {
  return {
    run: async (call, ctx: HostExecutionContext, signal?: AbortSignal) => {
      const outcome: HostToolOutcome = await executor.run(call, ctx, signal);
      if (call.name === 'find_mask_targets' && outcome.data !== undefined) {
        const parsed = MaskTargetsResultSchema.safeParse(outcome.data);
        if (parsed.success) observed.find = parsed.data;
      }
      return outcome;
    },
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args,
});

/** `create_mask` arguments for one candidate or one typed shape. */
function createArgs(item: EvalRequest, source: Record<string, unknown>): Record<string, unknown> {
  return {
    clipId: CLIP_ID,
    ...source,
    precision: 'shape',
    purpose: item.purpose === 'cutout' ? 'hide' : item.purpose,
    ...(item.effect === undefined ? {} : { effect: item.effect }),
    edge: 'soft',
    track: false,
  };
}

/** What the scripted model does after `find_mask_targets` answered. */
function afterFind(item: EvalRequest, find: MaskTargetsResult | undefined): AiResponse {
  const done: AiResponse = { text: 'Asked the editor.', toolCalls: [] };
  if (find === undefined) return done;
  if (find.status === 'resolved') {
    return {
      text: '',
      toolCalls: find.chosenCandidateIds.map((candidateId, index) =>
        toolCall(`mask_${String(index)}`, 'create_mask', createArgs(item, { candidateId })),
      ),
    };
  }
  const first = find.candidates[0]?.candidateId;
  if (first === undefined) return done;
  if (item.policy === 'force_pick') {
    return {
      text: '',
      toolCalls: [toolCall('force', 'create_mask', createArgs(item, { candidateId: first }))],
    };
  }
  if (item.policy === 'strip_pick') {
    const stripped = first.startsWith(PICK_MARKER) ? first.slice(PICK_MARKER.length) : first;
    return {
      text: '',
      toolCalls: [toolCall('strip', 'create_mask', createArgs(item, { candidateId: stripped }))],
    };
  }
  return done;
}

/** The scripted model: one policy, deterministic, reading only what the tools returned. */
class PolicyModel implements AiProvider {
  public readonly name = 'mock' as const;
  private step = 0;

  public constructor(
    private readonly item: EvalRequest,
    private readonly observed: Observed,
  ) {}

  public async complete(): Promise<AiResponse> {
    const step = this.step;
    this.step += 1;
    if (step === 0) return this.opening();
    if (step === 1 && this.startsWithFind()) return afterFind(this.item, this.observed.find);
    return { text: 'Done.', toolCalls: [] };
  }

  private startsWithFind(): boolean {
    return this.item.policy !== 'user_shape' && this.item.policy !== 'invent_candidate';
  }

  private opening(): AiResponse {
    const { item } = this;
    if (item.policy === 'user_shape') {
      return {
        text: '',
        toolCalls: [
          toolCall('typed', 'create_mask', createArgs(item, { userShape: item.userShape })),
        ],
      };
    }
    if (item.policy === 'invent_candidate') {
      return {
        text: '',
        toolCalls: [
          toolCall(
            'invented',
            'create_mask',
            createArgs(item, { candidateId: INVENTED_CANDIDATE_ID }),
          ),
        ],
      };
    }
    return {
      text: '',
      toolCalls: [
        toolCall('find', 'find_mask_targets', { clipId: CLIP_ID, description: item.description }),
      ],
    };
  }
}

/** A landed mask's geometry as a normalised box, or null for a kind that has none. */
function maskBox(
  mask: Record<string, unknown>,
  width: number,
  height: number,
): NormalisedBox | null {
  const num = (key: string): number => Number(mask[key]);
  if (mask.kind === 'rectangle') {
    return {
      x: (num('cx') - num('width') / 2) / width,
      y: (num('cy') - num('height') / 2) / height,
      width: num('width') / width,
      height: num('height') / height,
    };
  }
  if (mask.kind === 'ellipse') {
    return {
      x: (num('cx') - num('rx')) / width,
      y: (num('cy') - num('ry')) / height,
      width: (2 * num('rx')) / width,
      height: (2 * num('ry')) / height,
    };
  }
  return null;
}

/** Trace every geometry-bearing operation the run's patches carried. */
function traceOperations(
  operations: readonly AnyOperation[],
  set: RequestSet,
  emitted: readonly EmittedBox[],
  item: EvalRequest,
): MaskTrace[] {
  const traces: MaskTrace[] = [];
  for (const operation of operations) {
    if (!carriesMaskGeometry(operation)) continue;
    if (operation.type !== 'add_mask') {
      // The scripted model never tracks or reshapes, so any other geometry is unexplained.
      traces.push({ kind: 'untraced', operation: operation.type });
      continue;
    }
    const mask = (operation as { mask: Record<string, unknown> }).mask;
    traces.push(
      traceMaskBox(maskBox(mask, set.clip.width, set.clip.height), emitted, item.typedShape),
    );
  }
  return traces;
}

function statusOf(observed: Observed, events: readonly AiEvent[]): RunStatus {
  if (observed.find !== undefined) return observed.find.status;
  const findCalled = events.some(
    (event) => event.type === 'tool_call' && event.toolName === 'find_mask_targets',
  );
  return findCalled ? 'tool_failed' : 'not_called';
}

/** Run ONE labelled request through the orchestrator and the desktop executor. */
export async function runItem(
  set: RequestSet,
  item: EvalRequest,
  dir: string,
  packVersion = CURRENT_PACK_VERSION,
): Promise<{ verdict: ItemVerdict }> {
  const scene = set.scenes[item.scene]!;
  const emitted: EmittedBox[] = [];
  const observed: Observed = {};
  const packs = scenePack(scene, emitted, packVersion);
  const executor = createMaskingExecutor({
    tracking: packs,
    matte: noMatte,
    activeProjectPath: async () => path.join(dir, 'project.fp.json'),
    // As main.ts ships it: consent, and the crop re-ranker over the same packs; no identity source.
    evidence: {
      faceRecognitionConsent: async () => scene.consent === true,
      rerank: createCropReranker({ tracking: packs }),
    },
  });
  const input: ContextInput = {
    project: evalProject(set, dir),
    userPrompt: item.request,
    ...(item.history === undefined
      ? {}
      : {
          history: item.history.flatMap((content) => [
            { role: 'user' as const, content },
            { role: 'assistant' as const, content: 'Done.' },
          ]),
        }),
  };
  const orchestrator = new Orchestrator(new PolicyModel(item, observed), {
    executor: observing(executor, observed),
  });
  const events: AiEvent[] = [];
  for await (const event of orchestrator.streamAgent(input, {
    conversationId: `masking-eval-${item.id}`,
    turnId: 't1',
    now: () => 0,
  })) {
    events.push(event);
  }
  const operations = events.flatMap((event) =>
    event.type === 'diff' ? (event.edit.patch.operations as readonly AnyOperation[]) : [],
  );
  const verdict = judge({
    request: item,
    status: statusOf(observed, events),
    landed: traceOperations(operations, set, emitted, item),
  });
  return { verdict };
}

export interface MaskingEvalReport {
  readonly $comment: string;
  readonly fixture: string;
  readonly configuration: Readonly<Record<string, string>>;
  readonly summary: EvalSummary;
  readonly items: readonly ItemVerdict[];
}

/**
 * Run the whole request set and build the report.
 *
 * @param set - The checked request set.
 * @param fixture - Repo-relative path of the set, recorded in the report.
 * @param packVersion - The pack releases to stand in for. `1.0.0` replays what installed users
 *   have until the AM2.5 releases are signed: no classes, no crops.
 */
export async function runMaskingEval(
  set: RequestSet,
  fixture: string,
  packVersion = CURRENT_PACK_VERSION,
): Promise<MaskingEvalReport> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fp-masking-eval-'));
  try {
    const verdicts: ItemVerdict[] = [];
    for (const item of set.requests) {
      verdicts.push((await runItem(set, item, dir, packVersion)).verdict);
    }
    const summary = summarise(verdicts);
    log.action('maskingEvalComplete', {
      items: summary.items,
      targetAccuracy: summary.targetAccuracy.rate,
      ambiguousAskRate: summary.ambiguousAskRate.rate,
      confidentWrong: summary.confidentWrong,
      inventedGeometry: summary.inventedGeometry,
    });
    return {
      $comment:
        'AM5.2 AI masking eval. Generated by apps/desktop/electron/ai/masking-eval; do not edit. ' +
        'Regenerate with: pnpm --filter @framepilot/desktop exec vitest run ' +
        'electron/ai/masking-eval/masking-eval.test.ts -u',
      fixture,
      configuration: {
        path: 'Orchestrator.streamAgent -> desktop createMaskingExecutor -> resolveMaskTargets -> create_mask -> validator',
        pack: 'synthetic Subject Intelligence 1.1 detections (with COCO classes) and Visual Embed 1.1 crop/text vectors (colour axes) from the fixture scenes',
        model:
          'scripted policy (not an LLM): passes the labelled target phrase; adversarial items try to bypass the rules',
        evidence:
          'as main.ts ships it: the crop colour re-ranker, no identity source, consent per scene',
        installed:
          'these numbers are for Subject Intelligence and Visual Embed 1.1.0, which carry classes and crops. ' +
          'Installed users run 1.0 until those releases are signed and published (maintainer actions MO-1..MO-5); ' +
          'with 1.0 packs described objects ask, and the legacy-pack test holds confident-wrong and invented geometry at 0.',
      },
      summary,
      items: verdicts,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
