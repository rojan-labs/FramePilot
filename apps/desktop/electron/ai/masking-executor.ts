/**
 * Host executor for the `masking` domain (plan/background-removal-ai/11) — the agent's path
 * into the SAME pack jobs the Inspector runs.
 *
 * The model states an objective; this file measures. Detection and single-frame outlines come
 * from Subject Intelligence, cut-outs from the Smart Mask matte service, tracks from the
 * shared mask-track job. Nothing here writes the project: every result is a measurement the
 * orchestrator validates and compiles into editor-core commands (`maskingOpsFromMeasurement`).
 *
 * Three policies are deliberately NOT the panel's, because the agent is not a person at the
 * panel (memory: agent-shares-panel-services):
 *
 * - **The project is the run's working copy**, not the file on disk. The panel's IPC handlers
 *   re-read the saved project because a renderer is not an authority; the agent's working copy
 *   is main-process state, and the mask it tracks may exist only in the patch it is building.
 *   Handing the matte service the saved revision instead would refuse every job as stale.
 * - **A long cut-out is the editor's to start.** Background removal is measured at hundreds of
 *   compute-seconds per footage-second on the CPU provider, and the Inspector asks before a job
 *   over ten minutes. The agent may run only a job the Inspector would have started without
 *   asking; anything longer comes back as `needs_editor_start`, carrying the exact intent, and
 *   the sidebar offers it as one click that starts the Inspector's own job.
 * - **A pack is consent.** `pack_missing` carries the signed proposal to
 *   `PackInstallInlineCard`; the agent cannot install anything.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger, estimateMatteJob, MATTE_HANDLE_SECONDS } from '@framepilot/shared-types';
import {
  CREATE_SHAPE_MASK_TOOL_NAME,
  FIND_MASK_TARGETS_TOOL_NAME,
  FindMaskTargetsArgsSchema,
  MASKING_HOST_TOOL_NAMES,
  MAX_CHOSEN_CANDIDATES,
  REMOVE_BACKGROUND_TOOL_NAME,
  TRACK_MASK_TOOL_NAME,
  TrackMaskArgsSchema,
  ToolRefusalError,
  buildShapeMaskOps,
  candidateIdMatches,
  candidatesOnFrame,
  createMaskRequest,
  createShapeMaskRequest,
  parseCandidateId,
  rankCandidates,
  removeBackgroundRequest,
  resolveMaskTargets,
  type CreateMaskIntent,
  type CreateShapeMaskIntent,
  type CreateMaskMeasurement,
  type HostExecutionContext,
  type HostToolExecutor,
  type HostToolOutcome,
  type MaskCandidate,
  type MaskTargetEvidence,
  type TargetDetection,
  type TrackMeasurement,
} from '@framepilot/ai-sdk';
import { applyPatch, assetDisplaySize, type Operation } from '@framepilot/editor-core';
import { masksOf, type Clip, type Project } from '@framepilot/timeline-schema';
import type { CapabilityPackJobScheduler } from '../capability-packs/job-scheduler.js';
import {
  runMaskTrackJob,
  type MaskTrackJobResult,
} from '../capability-packs/mask-track-service.js';
import type { CapabilityPackMatteService, MatteRunOutcome } from '../capability-packs/matte.js';
import { scheduleMatteJob } from '../capability-packs/matte-ipc.js';
import { buildTrackingWorkerRequest } from '../capability-packs/tracking-request.js';
import type { CapabilityPackTrackingService } from '../capability-packs/tracking.js';

const log = createLogger('desktop:ai:masking');

/** Evidence a host may add to a resolution. Each source is optional and may decline. */
export interface MaskTargetEvidenceSources {
  /**
   * SigLIP text-image similarity for detection crops, when `visual-embed` can score crops.
   * Returns `undefined` when it cannot — the resolver then asks instead of guessing.
   */
  readonly rerank?: (request: {
    readonly project: Project;
    readonly assetId: string;
    readonly description: string;
    readonly candidates: readonly MaskCandidate[];
    readonly signal?: AbortSignal;
  }) => Promise<ReadonlyMap<string, number> | undefined>;
  /** Identity clusters for face candidates. Called ONLY when the project has consented. */
  readonly identities?: (request: {
    readonly project: Project;
    readonly assetId: string;
    readonly candidates: readonly MaskCandidate[];
  }) => Promise<ReadonlyMap<string, string> | undefined>;
  /**
   * Whether this project has opted in to local face recognition (MD-7). Anything but a clear
   * `true` — a rejection, an unreachable engine — is no consent.
   */
  readonly faceRecognitionConsent?: (project: Project) => Promise<boolean>;
}

export interface MaskingExecutorOptions {
  readonly tracking: () => Promise<CapabilityPackTrackingService>;
  readonly matte: () => Promise<CapabilityPackMatteService>;
  readonly scheduler?: CapabilityPackJobScheduler;
  /** Path of the open project file, or null when none is open. */
  readonly activeProjectPath: () => Promise<string | null>;
  readonly evidence?: MaskTargetEvidenceSources;
}

type ExecutorCall = { name: string; arguments?: unknown };

/** One `subject.detect` detection as the protocol carries it (`class` is a wire keyword). */
type WireDetection = Omit<TargetDetection, 'objectClass'> & {
  readonly class?: TargetDetection['objectClass'];
};

/** The resolver's view of a wire detection: `class` becomes `objectClass`, absent stays absent. */
function targetDetection(detection: WireDetection): TargetDetection {
  const { class: objectClass, classScore, ...rest } = detection;
  return objectClass === undefined || classScore === undefined
    ? rest
    : { ...rest, objectClass, classScore };
}

/** Frames one detection window covers, and how many windows a long range is sampled with. */
const TARGET_WINDOW_FRAMES = 48;
const TARGET_WINDOWS = 3;
/** Detections asked for per frame: a crowded scene still lists every face. The resolver's cap. */
const TARGET_MAX_DETECTIONS = MAX_CHOSEN_CANDIDATES;

/** The tool names this executor owns; everything else must not reach it. */
export const MASKING_EXECUTOR_TOOLS: ReadonlySet<string> = new Set(MASKING_HOST_TOOL_NAMES);

export function createMaskingExecutor(options: MaskingExecutorOptions): HostToolExecutor {
  // Candidates this process has measured, by id. A cache, never the authority: an id that is
  // not here is re-resolved by re-detecting the frame it names (`resolveCandidate`).
  const measured = new Map<string, MaskCandidate>();
  return {
    async run(
      call: ExecutorCall,
      ctx: HostExecutionContext,
      signal?: AbortSignal,
    ): Promise<HostToolOutcome> {
      if (!MASKING_EXECUTOR_TOOLS.has(call.name)) {
        return failed(call.name, 'routing_error', 'This call was routed to the wrong executor.');
      }
      try {
        const run = new MaskingRun(options, ctx, signal, measured, call.name);
        switch (call.name) {
          case FIND_MASK_TARGETS_TOOL_NAME:
            return await run.findTargets(call.arguments);
          case TRACK_MASK_TOOL_NAME:
            return await run.trackMask(call.arguments);
          case REMOVE_BACKGROUND_TOOL_NAME:
            return await run.createMask(removeBackgroundRequest(call.arguments));
          case CREATE_SHAPE_MASK_TOOL_NAME:
            return await run.shapeMask(createShapeMaskRequest(call.arguments));
          default:
            return await run.createMask(createMaskRequest(call.arguments));
        }
      } catch (error) {
        if (error instanceof HostRefusal) return error.outcome;
        // A refusal written for the model (a bad clip id, an unsupported intent) travels as is.
        if (error instanceof ToolRefusalError) return refused(call.name, String(error.message));
        throw error;
      }
    },
  };
}

/** A typed stop inside a run; carries the outcome the model and the sidebar read. */
class HostRefusal extends Error {
  public constructor(public readonly outcome: HostToolOutcome) {
    super(outcome.summary);
    this.name = 'HostRefusal';
  }
}

interface ResolvedClip {
  readonly clip: Clip;
  readonly assetId: string;
  readonly fps: number;
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
}

class MaskingRun {
  public constructor(
    private readonly options: MaskingExecutorOptions,
    private readonly ctx: HostExecutionContext,
    private readonly signal: AbortSignal | undefined,
    private readonly measured: Map<string, MaskCandidate>,
    private readonly tool: string,
  ) {}

  private get project(): Project {
    return this.ctx.project;
  }

  private fail(code: string, detail: string, retryable = false): never {
    throw new HostRefusal(failed(this.tool, code, detail, retryable));
  }

  private resolveClip(clipId: string): ResolvedClip {
    const clip = this.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((item) => item.id === clipId);
    if (clip === undefined) this.fail('unknown_clip', 'That clip is not on the timeline.');
    const asset = this.project.assets.find((item) => item.id === clip.assetId);
    if (asset === undefined || asset.kind !== 'video')
      this.fail('unsupported_media', 'Only video clips can be masked this way.');
    const fps = Number(this.project.fps);
    if (!Number.isFinite(fps) || fps <= 0)
      this.fail('unsupported_media', 'The project has no usable frame rate.');
    const firstFrame = Math.max(0, Math.round(clip.sourceStart * fps));
    return {
      clip,
      assetId: asset.id,
      fps,
      firstFrame,
      lastFrameExclusive: Math.max(firstFrame + 1, Math.round(clip.sourceEnd * fps)),
    };
  }

  /** One Subject Intelligence job over a frame range. */
  private async packJob(
    resolved: ResolvedClip,
    capability: 'subject.detect' | 'subject.segment',
    firstFrame: number,
    lastFrameExclusive: number,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<{ result: Record<string, unknown>; engine: string }> {
    const revision = this.project.timeline.revision ?? 0;
    const built = buildTrackingWorkerRequest(this.project, revision, {
      requestId: randomUUID(),
      assetId: resolved.assetId,
      capability,
      firstFrame,
      lastFrameExclusive,
      fps: resolved.fps,
      parameters,
    });
    if (built.status === 'rejected') this.fail(built.code, built.detail);
    log.action('packJobStart', {
      tool: this.tool,
      capability,
      frames: lastFrameExclusive - firstFrame,
    });
    const outcome = await (
      await this.options.tracking()
    ).run(built.request, {
      projectRevision: revision,
      mediaRoot: built.mediaRoot,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    if (outcome.status === 'pack_missing')
      throw new HostRefusal(packMissing(this.tool, outcome.proposal));
    if (outcome.status === 'failed') {
      if (outcome.code === 'cancelled') throw new HostRefusal(cancelled(this.tool));
      this.fail(outcome.code, outcome.detail, outcome.retryable);
    }
    return {
      result: outcome.result as unknown as Record<string, unknown>,
      engine: `${outcome.identity.id}@${outcome.identity.version}`,
    };
  }

  private async detect(
    resolved: ResolvedClip,
    firstFrame: number,
    lastFrameExclusive: number,
  ): Promise<{ detections: TargetDetection[]; engine: string }> {
    const job = await this.packJob(resolved, 'subject.detect', firstFrame, lastFrameExclusive, {
      labels: ['face', 'person', 'object'],
      maxDetections: TARGET_MAX_DETECTIONS,
      // AM2.5: name each object's COCO class. The tracking service drops the flag for a pack
      // older than 1.1.0, whose detections then carry the label alone (and objects ask).
      classes: true,
    });
    if (!Array.isArray(job.result.detections))
      this.fail('worker_failed', 'The worker returned no detection set.');
    return {
      detections: (job.result.detections as readonly WireDetection[]).map(targetDetection),
      engine: job.engine,
    };
  }

  public async findTargets(rawArgs: unknown): Promise<HostToolOutcome> {
    const args = FindMaskTargetsArgsSchema.parse(rawArgs);
    const resolved = this.resolveClip(args.clipId);
    const range = frameRange(resolved, args.range);
    const detections: TargetDetection[] = [];
    const sampledFrames: number[] = [];
    let engine = '';
    for (const [first, last] of detectionWindows(range.first, range.lastExclusive)) {
      const window = await this.detect(resolved, first, last);
      detections.push(...window.detections);
      engine = window.engine;
      for (let frame = first; frame < last; frame += 1) sampledFrames.push(frame);
    }
    const base = {
      clipId: resolved.clip.id,
      assetId: resolved.assetId,
      description: args.description,
      fps: resolved.fps,
      sampledFrames,
      detections,
      engine,
    };
    // Rank once without optional evidence to know WHICH candidates exist, then let each source
    // score them. A source that declines leaves its field absent — "not measured", never a guess.
    // The sources see plain ids: the result's pick ids cannot be turned back into them.
    const plain = rankCandidates(base).map(
      ({ grounding: _grounding, observedClasses: _observed, ...candidate }) => candidate,
    );
    const evidence = await this.gatherEvidence(resolved, args.description, plain);
    const result = resolveMaskTargets(
      Object.keys(evidence).length === 0 ? base : { ...base, evidence },
    );
    // Keyed by the id exactly as listed, marker included: a pick id with its marker stripped is
    // not a key here, and re-detection refuses it too (AM5.3).
    for (const candidate of result.candidates) this.measured.set(candidate.candidateId, candidate);
    log.action('maskTargetsResolved', {
      status: result.status,
      candidates: result.candidates.length,
      reranker: result.reranker,
    });
    return {
      status: result.status === 'resolved' ? 'completed' : 'warning',
      summary: `Looked for "${args.description}" on ${resolved.clip.id}: ${result.status} with ${engine}`,
      data: result,
    };
  }

  private async gatherEvidence(
    resolved: ResolvedClip,
    description: string,
    candidates: readonly MaskCandidate[],
  ): Promise<MaskTargetEvidence> {
    const sources = this.options.evidence;
    const plain = candidates;
    if (sources === undefined || plain.length === 0) return ledgerEvidence(this.ctx, resolved);
    const rerank = await sources.rerank?.({
      project: this.project,
      assetId: resolved.assetId,
      description,
      candidates: plain,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    // Identity is biometric: not even computed without the project's opt-in (MD-7, plan 12 P15).
    const consented = await (
      sources.faceRecognitionConsent?.(this.project) ?? Promise.resolve(false)
    ).catch(() => false);
    const identities =
      consented === true
        ? await sources.identities?.({
            project: this.project,
            assetId: resolved.assetId,
            candidates: plain.filter((candidate) => candidate.label === 'face'),
          })
        : undefined;
    return {
      ...ledgerEvidence(this.ctx, resolved),
      ...(rerank === undefined ? {} : { rerank }),
      ...(identities === undefined ? {} : { identities }),
    };
  }

  /** A candidate by id: this process's cache, else re-detect the one frame the id names. */
  private async resolveCandidate(
    resolved: ResolvedClip,
    candidateId: string,
  ): Promise<MaskCandidate> {
    const parsed = parseCandidateId(candidateId);
    if (parsed === null) {
      this.fail('unknown_candidate', 'That candidateId did not come from find_mask_targets.');
    }
    const cached = this.measured.get(candidateId);
    if (cached !== undefined) return cached;
    const { detections } = await this.detect(resolved, parsed.frame, parsed.frame + 1);
    const again = candidatesOnFrame(
      { assetId: resolved.assetId, fps: resolved.fps, detections },
      parsed.frame,
    ).find((candidate) => candidateIdMatches(candidateId, candidate.candidateId));
    if (again === undefined) {
      this.fail(
        'unknown_candidate',
        'That candidate is no longer found on its frame of this clip.',
      );
    }
    const listed = { ...again, candidateId };
    this.measured.set(candidateId, listed);
    return listed;
  }

  /**
   * `create_shape_mask` (MK8): the only measurement a preset needs is its candidate, re-resolved
   * on its frame like `create_mask`'s. Placed on the frame or from the editor's numbers, nothing
   * is measured and the clip is echoed; the orchestrator builds the preset either way.
   */
  public async shapeMask(intent: CreateShapeMaskIntent): Promise<HostToolOutcome> {
    const resolved = this.resolveClip(intent.clipId);
    const candidate =
      intent.candidateId === undefined
        ? undefined
        : await this.resolveCandidate(resolved, intent.candidateId);
    return completed(`Placed a ${intent.preset.replace('_', ' ')} mask on ${resolved.clip.id}`, {
      kind: 'create_shape_mask' as const,
      clipId: resolved.clip.id,
      ...(candidate === undefined ? {} : { candidate }),
    });
  }

  public async createMask(intent: CreateMaskIntent): Promise<HostToolOutcome> {
    const resolved = this.resolveClip(intent.clipId);
    const candidate =
      intent.candidateId === undefined
        ? undefined
        : await this.resolveCandidate(resolved, intent.candidateId);
    if (intent.precision === 'cutout') return await this.cutout(resolved, candidate);
    const matte =
      intent.shape === 'path' && candidate !== undefined
        ? await this.outline(resolved, candidate)
        : undefined;
    const shape = {
      kind: 'create_mask' as const,
      precision: 'shape' as const,
      clipId: resolved.clip.id,
      ...(candidate === undefined ? {} : { candidate }),
      ...(matte === undefined ? {} : { matte }),
    };
    if (!intent.track)
      return completed(`Fitted a ${intent.shape ?? 'shape'} mask on ${resolved.clip.id}`, shape);
    // The mask does not exist yet: build it exactly as the orchestrator will, and track THAT.
    const built = buildShapeMaskOps(this.project, intent, shape);
    const track = await this.track(
      withOperations(this.project, built.operations),
      resolved.clip.id,
      built.maskId,
      undefined,
      candidate?.sourceTime,
    );
    return completed(
      `Fitted and tracked a mask on ${resolved.clip.id} (${String(track.frames)} frames)`,
      { ...shape, track },
    );
  }

  /** A single-frame outline of the candidate, for a path fit. */
  private async outline(
    resolved: ResolvedClip,
    candidate: MaskCandidate,
  ): Promise<{ width: number; height: number; counts: number[] } | undefined> {
    const frame = Math.round(candidate.sourceTime * resolved.fps);
    const job = await this.packJob(resolved, 'subject.segment', frame, frame + 1, {
      region: candidate.box,
    });
    const masks = Array.isArray(job.result.masks)
      ? (job.result.masks as { width: number; height: number; counts: number[] }[])
      : [];
    const [mask] = masks;
    return mask === undefined
      ? undefined
      : { width: mask.width, height: mask.height, counts: mask.counts };
  }

  private async cutout(
    resolved: ResolvedClip,
    candidate: MaskCandidate | undefined,
  ): Promise<HostToolOutcome> {
    const projectPath = await this.options.activeProjectPath();
    if (projectPath === null) this.fail('no_project', 'No project is open.');
    const asset = this.project.assets.find((item) => item.id === resolved.assetId);
    const job = {
      assetId: resolved.assetId,
      clipId: resolved.clip.id,
      sourceStart: Math.max(0, resolved.clip.sourceStart - MATTE_HANDLE_SECONDS),
      sourceEnd: resolved.clip.sourceEnd + MATTE_HANDLE_SECONDS,
      // A candidate becomes the box prompt the pack was measured with; none asks for the main subject.
      prompts:
        candidate === undefined
          ? []
          : [{ kind: 'box' as const, sourceTime: candidate.sourceTime, box: candidate.box }],
      foreground: true,
      previewHeight: 540,
      timelineRevision: this.project.timeline.revision ?? 0,
    };
    const estimate = estimateMatteJob(
      job.sourceEnd - job.sourceStart,
      assetDisplaySize(asset?.media),
    );
    if (estimate.needsConfirmation) {
      log.action('matteNeedsEditorStart', {
        clipId: resolved.clip.id,
        estimateSeconds: Math.round(estimate.computeSeconds),
      });
      throw new HostRefusal(needsEditorStart(this.tool, job, estimate.computeSeconds));
    }
    const outcome = await scheduleMatteJob(
      {
        matte: this.options.matte,
        // The run's working copy is the authority here; see the module comment.
        readProject: async () => this.project,
        ...(this.options.scheduler === undefined ? {} : { scheduler: this.options.scheduler }),
      },
      projectPath,
      { ...job, requestId: randomUUID() },
      'interactive',
      false,
    );
    return matteOutcome(this.tool, outcome, resolved.clip.id, candidate);
  }

  public async trackMask(rawArgs: unknown): Promise<HostToolOutcome> {
    const args = TrackMaskArgsSchema.parse(rawArgs);
    const resolved = this.resolveClip(args.clipId);
    if (!masksOf(resolved.clip).some((mask) => mask.id === args.maskId)) {
      this.fail('unknown_mask', 'That clip has no mask with that id.');
    }
    const track = await this.track(this.project, args.clipId, args.maskId, args.method, undefined);
    return completed(
      `Tracked mask ${args.maskId} on ${args.clipId} (${String(track.frames)} frames)`,
      {
        kind: 'track_mask',
        clipId: args.clipId,
        maskId: args.maskId,
        track,
      },
    );
  }

  private async track(
    project: Project,
    clipId: string,
    maskId: string,
    method: TrackMeasurement['method'] | undefined,
    referenceSourceTime: number | undefined,
  ): Promise<TrackMeasurement> {
    const projectPath = await this.options.activeProjectPath();
    if (projectPath === null) this.fail('no_project', 'No project is open.');
    const clip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((item) => item.id === clipId);
    const reference = referenceSourceTime ?? clip?.sourceStart ?? 0;
    const result: MaskTrackJobResult = await runMaskTrackJob({
      project,
      projectDir: path.dirname(projectPath),
      intent: {
        requestId: randomUUID(),
        clipId,
        maskId,
        method: method ?? 'position-scale-rotation',
        // From the frame the shape was measured on, both ways: the whole clip follows.
        direction: 'both',
        referenceSourceTime: reference,
      },
      tracking: this.options.tracking,
      signal: this.signal ?? new AbortController().signal,
    });
    if (!result.ok) {
      if ('proposal' in result) throw new HostRefusal(packMissing(this.tool, result.proposal));
      this.fail(result.code, result.error, result.retryable);
    }
    return {
      artifact: result.artifact,
      method: result.method,
      referenceSourceTime: reference,
      flagged: result.flagged.map((range) => ({ start: range.start, end: range.end })),
      frames: result.frames,
      worstResidualPx: result.worstResidualPx,
      engine: result.engine,
    };
  }
}

/** The project with a not-yet-proposed mask applied, so the track job can resolve it. */
function withOperations(project: Project, operations: readonly Operation[]): Project {
  return {
    ...project,
    timeline: applyPatch(project.timeline, {
      patchId: 'masking_executor_preview' as never,
      createdBy: 'agent',
      reason: 'Mask to be tracked',
      operations,
    }),
  };
}

function frameRange(
  resolved: ResolvedClip,
  range: { start: number; end: number } | undefined,
): { first: number; lastExclusive: number } {
  if (range === undefined)
    return { first: resolved.firstFrame, lastExclusive: resolved.lastFrameExclusive };
  // Timeline seconds → this clip's source frames, clamped to what the clip shows.
  const toSource = (seconds: number): number =>
    resolved.clip.sourceStart + (seconds - resolved.clip.start);
  const first = Math.min(
    Math.max(Math.round(toSource(range.start) * resolved.fps), resolved.firstFrame),
    resolved.lastFrameExclusive - 1,
  );
  const last = Math.min(
    Math.max(Math.round(toSource(range.end) * resolved.fps), first + 1),
    resolved.lastFrameExclusive,
  );
  return { first, lastExclusive: last };
}

/**
 * The frames to look at: the whole range when it is short, else evenly spread windows, so
 * persistence is measured across the range without detecting on every frame of a long clip.
 */
export function detectionWindows(first: number, lastExclusive: number): [number, number][] {
  const length = lastExclusive - first;
  if (length <= TARGET_WINDOW_FRAMES * TARGET_WINDOWS) return [[first, lastExclusive]];
  const stride = (length - TARGET_WINDOW_FRAMES) / (TARGET_WINDOWS - 1);
  return Array.from({ length: TARGET_WINDOWS }, (_, index) => {
    const start = first + Math.round(index * stride);
    return [start, start + TARGET_WINDOW_FRAMES] as [number, number];
  });
}

/** A tier-1 label below this is the labeller shrugging, not a fact worth ranking by. */
const LEDGER_MIN_CONFIDENCE = 0.5;

/**
 * What the shot ledger says this clip's subject is, when the run carries a ledger.
 *
 * Only shots of the clip's asset that overlap the part of the source the clip SHOWS count, and
 * the kind they most agree on wins. Absent ledger, absent tier or no confident label all yield
 * `{}`: "not measured", which the resolver treats as no opinion — never as disagreement.
 */
export function ledgerEvidence(
  ctx: Pick<HostExecutionContext, 'ledger'>,
  resolved: Pick<ResolvedClip, 'assetId' | 'clip'>,
): MaskTargetEvidence {
  const votes = new Map<string, number>();
  for (const shot of ctx.ledger?.shots ?? []) {
    if (shot.assetId !== resolved.assetId) continue;
    if (shot.t1 <= resolved.clip.sourceStart || shot.t0 >= resolved.clip.sourceEnd) continue;
    const kind = shot.labelled?.subjectKind;
    if (kind === undefined || kind === null || kind.p < LEDGER_MIN_CONFIDENCE) continue;
    votes.set(kind.value, (votes.get(kind.value) ?? 0) + kind.p);
  }
  const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return best === undefined ? {} : { ledgerSubjectKind: best[0] };
}

function matteOutcome(
  tool: string,
  outcome: MatteRunOutcome,
  clipId: string,
  candidate: MaskCandidate | undefined,
): HostToolOutcome {
  if (outcome.status === 'pack_missing') return packMissing(tool, outcome.proposal);
  if (outcome.status === 'needs_prompt') {
    return failed(
      tool,
      'no_main_subject',
      'No main subject could be found automatically on this clip.',
    );
  }
  if (outcome.status === 'failed') {
    return outcome.code === 'cancelled'
      ? cancelled(tool)
      : failed(tool, outcome.code, outcome.detail, outcome.retryable);
  }
  const measurement: CreateMaskMeasurement = {
    kind: 'create_mask',
    precision: 'cutout',
    clipId,
    ...(candidate === undefined ? {} : { candidate }),
    artifact: {
      ...outcome.artifact,
      files: outcome.artifact.files.map((file) => ({ ...file })),
      modelDigests: [...outcome.artifact.modelDigests],
    },
    needsReview: outcome.needsReview.map((range) => ({ start: range.start, end: range.end })),
    verifiedFrames: outcome.summary.verifiedFrames,
    flaggedFrames: outcome.summary.flaggedFrames,
  };
  log.action('matteMeasured', {
    clipId,
    flagged: measurement.needsReview.length,
    cacheHit: outcome.cacheHit,
  });
  return completed(
    `Cut out the subject on ${clipId} with ${outcome.artifact.packId}@${outcome.artifact.packVersion}`,
    measurement,
  );
}

const completed = (summary: string, data: unknown): HostToolOutcome => ({
  status: 'completed',
  summary,
  data,
});

const cancelled = (tool: string): HostToolOutcome => ({
  status: 'cancelled',
  summary: `Stopped "${tool}" — run cancelled`,
});

/** A refusal whose sentence already carries its remedy (written in ai-sdk for the model). */
const refused = (tool: string, sentence: string): HostToolOutcome => ({
  status: 'failed',
  summary: `"${tool}" refused: ${sentence}`,
  data: { code: 'refused', detail: sentence },
});

/**
 * Installing is the EDITOR's move — the install card is already on their screen — so the
 * sentence closes the call off rather than leaving the model to re-issue it while a download runs.
 */
function packMissing(tool: string, proposal: unknown): HostToolOutcome {
  return {
    status: 'failed',
    summary:
      `"${tool}" needs a Capability Pack that is not installed on this machine. Installing it is ` +
      'the editor’s decision and FramePilot has already offered it to them, so do not call ' +
      `${tool} again in this run — carry on with the rest of the edit, tell the editor the pack ` +
      'has to be installed first, and do not claim the mask was made.',
    data: { code: 'pack_missing', proposal },
  };
}

/**
 * A cut-out too long for the agent to start. The number lives in `data` for the card; the
 * sentence carries none, so a repeat is the same guard key every time.
 */
function needsEditorStart(
  tool: string,
  job: Record<string, unknown>,
  estimateSeconds: number,
): HostToolOutcome {
  return {
    status: 'failed',
    summary:
      `"${tool}" did not start: this cut-out is a long background job, and starting one is the ` +
      'editor’s decision. FramePilot has offered it to them with its estimated time, and it runs ' +
      `while they keep editing. Do not call ${tool} again for this clip in this run — tell the ` +
      'editor it is waiting for them to start, and that a shape mask (precision "shape") is ' +
      'immediate if an approximate edge is enough.',
    data: { code: 'needs_editor_start', job, estimateSeconds: Math.round(estimateSeconds) },
  };
}

/** The move the model can make, per failure code this executor authors. `{tool}` is the caller. */
const FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  unknown_clip: 'Call get_clips for the real clip ids, then call {tool} with one of them.',
  unknown_mask:
    'Call get_masks for that clip to list its mask ids, then call {tool} with one of them.',
  unknown_candidate:
    'Call find_mask_targets for that clip again and pass one of the candidateIds it returns; never write one yourself.',
  unsupported_media:
    'This answers the same way every time for this clip, so do not call {tool} for it again — tell the editor it cannot be masked this way.',
  no_project:
    'Nothing can be measured without an open project. Do not call {tool} again — tell the editor to open or save the project.',
  no_main_subject:
    'Call find_mask_targets for this clip and pass the candidateId of the subject the editor means; if it finds none, tell the editor to click the subject in the Inspector’s Remove background.',
  routing_error:
    'This is a FramePilot routing bug, not something your arguments can fix. Do not call {tool} again — tell the editor this tool is misrouted in this build.',
};

function externalGuidance(tool: string, retryable: boolean): string {
  return retryable
    ? `The pack reports this as worth one more attempt. Call ${tool} once more; if it fails the same way, do not call it again — tell the editor the mask could not be made and carry on.`
    : `The pack reports this as final, so a second attempt answers the same way. Do not call ${tool} again for this clip — tell the editor the mask could not be made and carry on.`;
}

function failed(tool: string, code: string, detail: string, retryable = false): HostToolOutcome {
  const guidance =
    FAILURE_GUIDANCE[code]?.replaceAll('{tool}', tool) ?? externalGuidance(tool, retryable);
  const said = detail.trim().replace(/[.!?]+$/u, '');
  return {
    status: 'failed',
    summary: `"${tool}" refused (${code}): ${said}. ${guidance}`,
    data: { code, detail },
  };
}

/** Every sentence this executor authors, for the desktop failure-quality gate to WALK. */
export function maskingFailureNoteEntries(): readonly {
  readonly tool: string;
  readonly code: string;
  readonly note: string;
}[] {
  const tools = [...MASKING_EXECUTOR_TOOLS];
  const authored = tools.flatMap((tool) =>
    [...Object.keys(FAILURE_GUIDANCE), 'an_unrecognized_pack_code'].flatMap((code) =>
      [true, false].map((retryable) => ({
        tool,
        code: `${code} (retryable=${String(retryable)})`,
        note: failed(tool, code, 'The pack said something we do not recognize', retryable).summary,
      })),
    ),
  );
  return [
    ...authored,
    ...tools.map((tool) => ({ tool, code: 'pack_missing', note: packMissing(tool, {}).summary })),
    ...tools.map((tool) => ({
      tool,
      code: 'needs_editor_start',
      note: needsEditorStart(tool, {}, 0).summary,
    })),
  ];
}
