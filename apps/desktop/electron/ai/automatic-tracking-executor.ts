/**
 * Host executor for the media-intelligence tools — the agent's path into the
 * Capability Pack workers.
 *
 * The orchestrator cannot run workers itself (the render/CV boundary lives on
 * the host), and the renderer IPC handler exists for editor-initiated jobs.
 * This executor gives the AGENT the same authority through the same service:
 * objective in, exact pack request built from the working project, isolated
 * worker out, measurements only. It never writes the project — converting
 * samples into a validated reversible patch stays with the orchestrator and
 * editor-core; detections stay evidence and never become geometry an edit can
 * claim.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@framepilot/shared-types';
import {
  AUTOMATIC_TRACKING_TOOL_NAME,
  DETECT_SUBJECTS_TOOL_NAME,
  AutomaticTrackingObjectiveSchema,
  AutomaticTrackingMeasurementSchema,
  SubjectDetectionObjectiveSchema,
  AUTOMATIC_TRACKING_SPECIALIST,
  SUBJECT_DETECTION_SPECIALIST,
  runSpecialist,
  sliceOf,
  silhouetteMasksToTrackSamples,
  type AutomaticTrackingMeasurement,
  type HostToolExecutor,
  type HostToolOutcome,
  type HostExecutionContext,
} from '@framepilot/ai-sdk';
import type { CapabilityPackWorkerResult } from '@framepilot/capability-packs';
import { buildTrackingWorkerRequest } from '../capability-packs/tracking-request.js';
import type { CapabilityPackTrackingService } from '../capability-packs/tracking.js';

const log = createLogger('desktop:ai:automatic-tracking');

export interface AutomaticTrackingExecutorOptions {
  /** Lazily resolves the desktop media-intelligence authority (leases + proposals). */
  readonly tracking: () => Promise<CapabilityPackTrackingService>;
}

/** The tool names this executor owns; everything else must not reach it. */
const EXECUTOR_TOOLS: ReadonlySet<string> = new Set([
  AUTOMATIC_TRACKING_TOOL_NAME,
  DETECT_SUBJECTS_TOOL_NAME,
]);

type ExecutorCall = { name: string; arguments?: unknown };

interface PackJobPlan {
  readonly assetId: string;
  readonly capability:
    | 'tracking.point'
    | 'tracking.region'
    | 'tracking.planar'
    | 'subject.detect'
    | 'subject.segment';
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly fps: number;
  readonly parameters: Readonly<Record<string, unknown>>;
}

interface PackJobSuccess {
  readonly ok: true;
  readonly result: CapabilityPackWorkerResult;
  readonly engine: string;
}
/** A typed refusal from the authority, or from building the exact worker request. */
type PackJobFailureOutcome =
  | Exclude<Awaited<ReturnType<CapabilityPackTrackingService['run']>>, { status: 'completed' }>
  | {
      readonly status: 'failed';
      readonly code: string;
      readonly detail: string;
      readonly retryable: false;
    };
interface PackJobFailure {
  readonly ok: false;
  readonly outcome: PackJobFailureOutcome;
}

export function createAutomaticTrackingExecutor(
  options: AutomaticTrackingExecutorOptions,
): HostToolExecutor {
  return {
    async run(
      call: ExecutorCall,
      ctx: HostExecutionContext,
      signal?: AbortSignal,
    ): Promise<HostToolOutcome> {
      if (!EXECUTOR_TOOLS.has(call.name)) {
        return failed(call.name, 'routing_error', 'This call was routed to the wrong executor.');
      }
      if (call.name === DETECT_SUBJECTS_TOOL_NAME)
        return await runDetection(call, ctx, signal, options);
      return await runTracking(call, ctx, signal, options);
    },
  };
}

/** Shared tail for both tools: build the exact request and run the authority. */
async function runPackJob(
  call: ExecutorCall,
  ctx: HostExecutionContext,
  signal: AbortSignal | undefined,
  options: AutomaticTrackingExecutorOptions,
  plan: PackJobPlan,
): Promise<PackJobSuccess | PackJobFailure> {
  const requestId = randomUUID();
  const built = buildTrackingWorkerRequest(ctx.project, ctx.project.timeline.revision ?? 0, {
    requestId,
    assetId: plan.assetId,
    capability: plan.capability,
    firstFrame: plan.firstFrame,
    lastFrameExclusive: plan.lastFrameExclusive,
    fps: plan.fps,
    parameters: plan.parameters,
  });
  if (built.status === 'rejected') {
    return {
      ok: false,
      outcome: { status: 'failed', code: built.code, detail: built.detail, retryable: false },
    };
  }
  log.action('packJobStart', {
    tool: call.name,
    clipId: plan.assetId,
    capability: plan.capability,
    frames: plan.lastFrameExclusive - plan.firstFrame,
  });
  const outcome = await (
    await options.tracking()
  ).run(built.request, {
    projectRevision: ctx.project.timeline.revision ?? 0,
    mediaRoot: built.mediaRoot,
    ...(signal === undefined ? {} : { signal }),
    onProgress: (progress) => {
      log.debug('worker progress', {
        requestId,
        phase: progress.phase,
        completed: progress.completed,
        total: progress.total,
      });
    },
  });
  if (outcome.status === 'completed') {
    return {
      ok: true,
      result: outcome.result,
      engine: `${outcome.identity.id}@${outcome.identity.version}`,
    };
  }
  return { ok: false, outcome };
}

async function runDetection(
  call: ExecutorCall,
  ctx: HostExecutionContext,
  signal: AbortSignal | undefined,
  options: AutomaticTrackingExecutorOptions,
): Promise<HostToolOutcome> {
  const objective = SubjectDetectionObjectiveSchema.parse(call.arguments);
  if (!ctx.interaction) {
    return failed(
      DETECT_SUBJECTS_TOOL_NAME,
      'target_unresolved',
      'Subject detection needs a live editor selection — select one video clip in the timeline.',
    );
  }
  // Through the contract (P5.1), not the controller directly: `sliceOf` hands it only the
  // fields it declared, and the envelope is validated in both directions. This was the
  // last production caller reaching past it.
  const resolution = runSpecialist(SUBJECT_DETECTION_SPECIALIST, {
    task: DETECT_SUBJECTS_TOOL_NAME,
    context: sliceOf(SUBJECT_DETECTION_SPECIALIST, ctx),
    constraints: {},
    inputs: objective,
  });
  const detectionPlan = resolution.outputs.plan;
  if (detectionPlan === undefined) {
    const [first] = resolution.errors;
    return failed(
      DETECT_SUBJECTS_TOOL_NAME,
      first?.code ?? 'target_unresolved',
      first?.detail ?? 'Subject detection could not resolve a target.',
    );
  }
  const job = await runPackJob(call, ctx, signal, options, detectionPlan);
  if (!job.ok) return mapJobFailure(DETECT_SUBJECTS_TOOL_NAME, job.outcome);
  if (!('detections' in job.result)) {
    return failed(
      DETECT_SUBJECTS_TOOL_NAME,
      'worker_failed',
      'The worker returned no detection set.',
    );
  }
  const detections = job.result.detections;
  log.action('subjectDetectionComplete', { engine: job.engine, detections: detections.length });
  const byLabel = detections.reduce<Record<string, number>>((counts, detection) => {
    counts[detection.label] = (counts[detection.label] ?? 0) + 1;
    return counts;
  }, {});
  const frames = new Set(detections.map((detection) => detection.frame)).size;
  const labelSummary = Object.entries(byLabel)
    .map(([label, count]) => `${count} ${label}`)
    .join(', ');
  return {
    status: detections.length === 0 ? 'warning' : 'completed',
    summary:
      detections.length === 0
        ? `Detected nothing (looked for ${objective.labels.join(', ')}) — an honest empty ` +
          'result, not a guess. The detector saw the frames and found none of those ' +
          'labels, so asking again for the same labels on the same clip returns the same ' +
          'nothing. Call detect_subjects once with different labels if another subject ' +
          'would do, or continue without a tracked subject and tell the editor.'
        : `Detected ${labelSummary} across ${frames} frame${frames === 1 ? '' : 's'} with ${job.engine}`,
    data: {
      kind: 'detect_subjects',
      clipId: detectionPlan.clipId,
      labels: objective.labels,
      totalDetections: detections.length,
      byLabel,
      framesWithDetections: frames,
      engine: job.engine,
      backend: job.result.backend,
      modelDigests: job.result.modelDigests,
      detections,
    },
  };
}

async function runTracking(
  call: ExecutorCall,
  ctx: HostExecutionContext,
  signal: AbortSignal | undefined,
  options: AutomaticTrackingExecutorOptions,
): Promise<HostToolOutcome> {
  const objective = AutomaticTrackingObjectiveSchema.parse(call.arguments);
  if (!ctx.interaction) {
    return failed(
      AUTOMATIC_TRACKING_TOOL_NAME,
      'target_unresolved',
      'Automatic tracking needs a live editor selection — open the timeline and select the clip to track.',
    );
  }
  const resolution = runSpecialist(AUTOMATIC_TRACKING_SPECIALIST, {
    task: AUTOMATIC_TRACKING_TOOL_NAME,
    context: sliceOf(AUTOMATIC_TRACKING_SPECIALIST, ctx),
    constraints: {},
    inputs: objective,
  });
  const plan = resolution.outputs.plan;
  if (plan === undefined) {
    const [first] = resolution.errors;
    return failed(
      AUTOMATIC_TRACKING_TOOL_NAME,
      first?.code ?? 'target_unresolved',
      first?.detail ?? 'Automatic tracking could not resolve a target.',
    );
  }
  // The tracking controller guarantees a mask for every resolved track plan,
  // but the plan type is shared with detection (maskless) — make the
  // dependency explicit instead of asserting.
  if (plan.maskEffectId === undefined) {
    // Its OWN code, not `target_unresolved`: the target resolved fine, and this is the one
    // failure in this file the model can actually repair itself (`add_mask`). Sharing the
    // "only the editor can fix this" code would have hidden that.
    return failed(
      AUTOMATIC_TRACKING_TOOL_NAME,
      'mask_missing',
      'The selected clip has no rectangle or ellipse mask for the track to steer.',
    );
  }
  const job = await runPackJob(call, ctx, signal, options, plan);
  if (!job.ok) return mapJobFailure(AUTOMATIC_TRACKING_TOOL_NAME, job.outcome);
  const result = job.result;
  // A silhouette run comes back as bitmap masks; convert them host-side into
  // region samples so the edit path is identical to geometric tracking.
  let samples: AutomaticTrackingMeasurement['samples'];
  if ('samples' in result) {
    samples = result.samples;
  } else if ('masks' in result) {
    samples = silhouetteMasksToTrackSamples(result.masks);
  } else {
    return failed(
      AUTOMATIC_TRACKING_TOOL_NAME,
      'worker_failed',
      'The worker returned a non-tracking result.',
    );
  }
  if (samples.length === 0) {
    return failed(
      AUTOMATIC_TRACKING_TOOL_NAME,
      'worker_failed',
      'The worker returned no usable measurements.',
    );
  }
  const measurement: AutomaticTrackingMeasurement = {
    objective,
    plan: {
      clipId: plan.clipId,
      maskEffectId: plan.maskEffectId,
      capability: plan.capability as AutomaticTrackingMeasurement['plan']['capability'],
      fps: plan.fps,
      startSeconds: plan.startSeconds,
    },
    samples,
    engine: job.engine,
    backend: result.backend,
  };
  // Refuse to hand the orchestrator anything it would reject anyway.
  const parsed = AutomaticTrackingMeasurementSchema.safeParse(measurement);
  if (!parsed.success) {
    return failed(
      AUTOMATIC_TRACKING_TOOL_NAME,
      'worker_failed',
      'The worker returned a malformed sample set.',
    );
  }
  log.action('automaticTrackingComplete', {
    engine: measurement.engine,
    capability: plan.capability,
    samples: measurement.samples.length,
  });
  const measured = measurement.samples.length;
  return {
    status: 'completed',
    summary: `Tracked ${measured} frame${measured === 1 ? '' : 's'} with ${measurement.engine} (${result.backend})`,
    data: parsed.data,
  };
}

function mapJobFailure(toolName: string, outcome: PackJobFailureOutcome): HostToolOutcome {
  if (outcome.status === 'pack_missing') {
    return {
      status: 'failed',
      // Installing is the EDITOR's move — the install prompt is already on their screen —
      // so the sentence closes the call off rather than leaving the model to re-issue it
      // while the download runs. "Do not claim the measurement succeeded" was the only
      // instruction here, and it says what not to REPORT, never what to do next.
      summary:
        `"${toolName}" needs a Capability Pack that is not installed on this machine. ` +
        'Installing it is the editor’s decision and FramePilot has already offered it to ' +
        `them, so do not call ${toolName} again in this run — carry on with the rest of ` +
        'the edit, tell the editor the pack has to be installed first, and do not claim ' +
        'the measurement succeeded.',
      data: { code: 'pack_missing', proposal: outcome.proposal },
    };
  }
  if (outcome.status === 'failed') {
    if (outcome.code === 'cancelled') {
      return { status: 'cancelled', summary: `Stopped "${toolName}" — run cancelled` };
    }
    // `outcome.detail` is the pack authority's or the worker's own sentence, forwarded
    // verbatim — we do not get to invent an account of a failure we have never seen. What
    // IS ours is whether a second call can help, which the authority states, so the tail
    // below turns its boolean into the move.
    return failed(toolName, outcome.code, outcome.detail, outcome.retryable);
  }
  return failed(toolName, 'worker_failed', 'The pack job ended without a result.');
}

/**
 * The move the model can make, per failure code this executor produces.
 *
 * goal.md Workstream C: "Errors are prompts too." Every sentence in this file used to stop
 * at the fact — "The worker returned no detection set.", "Automatic tracking could not
 * resolve a target." — which is the shape `packages/ai-sdk/src/reliability/next-action.ts`
 * pins as a dead end: true, unactionable, and answered by repeating the call.
 *
 * Written the way `VISUAL_REASON_GUIDANCE` and `reliability/refusal-notes.ts` are written:
 * whether retrying helps, then a tool the model can call or an explicit close. Nothing
 * here tells it to author coordinates — the one thing the automatic-tracking contract
 * forbids the model to do (`domain-tools/automatic-tracking.ts`), which is why the
 * worker-failure arm names no substitute and simply stops.
 *
 * `{tool}` renders as the failing tool's own name. A code with no entry falls through to
 * {@link externalFailureGuidance}, because inventing an "instead" for a worker error we
 * have never seen is the one thing this file must not do.
 */
const FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  target_unresolved:
    'This needs the clip the editor has selected in the timeline, and only the editor can ' +
    'change that selection — calling {tool} again resolves the same way. Check what is ' +
    'selected with get_selected_range; if it is not the clip you meant, tell the editor ' +
    'which clip to select and carry on with the rest of the edit.',
  mask_missing:
    'A track steers an existing mask, so there is nothing to move yet. Add one with ' +
    'add_mask on that clip and then call {tool} again for it.',
  worker_failed:
    'This is the measurement itself failing, not your arguments, and repeating it measures ' +
    'the same shot the same way. Do not call {tool} again for this clip — tell the editor ' +
    'that automatic tracking could not produce a usable measurement and that nothing was ' +
    'changed.',
  routing_error:
    'This is a FramePilot routing bug, not something your arguments can fix, and it will ' +
    'answer the same way every time. Do not call {tool} again — tell the editor this tool ' +
    'is misrouted in this build.',
};

/**
 * The tail for a code this file does not author — the pack authority's or the worker's.
 *
 * The detail is theirs and is forwarded verbatim; the only thing we know for certain is
 * what the authority told us about retrying, so that is the only thing this adds.
 */
function externalFailureGuidance(toolName: string, retryable: boolean): string {
  return retryable
    ? `The pack worker reports this as worth one more attempt. Call ${toolName} once more; ` +
        `if it fails the same way, do not call it again — tell the editor that automatic ` +
        `tracking could not run and carry on with the rest of the edit.`
    : `The pack worker reports this as final, so a second attempt answers the same way. Do ` +
        `not call ${toolName} again for this clip — tell the editor that automatic tracking ` +
        `could not run and carry on with the rest of the edit.`;
}

/**
 * One refusal from this executor, as the model reads it.
 *
 * @param toolName - The registry name of the call that failed.
 * @param code - The failure code, which is also the key into {@link FAILURE_GUIDANCE}.
 * @param detail - What went wrong, in this file's or the worker's words.
 * @param retryable - The authority's verdict, used only when the code is not one of ours.
 */
function failed(
  toolName: string,
  code: string,
  detail: string,
  retryable = false,
): HostToolOutcome {
  const guidance = FAILURE_GUIDANCE[code]?.replaceAll('{tool}', toolName);
  const instead = guidance ?? externalFailureGuidance(toolName, retryable);
  // The detail may or may not be punctuated (this file's sentences are; a worker's may not
  // be), and the two halves have to read as two sentences either way.
  const said = detail.trim().replace(/[.!?]+$/, '');
  return {
    status: 'failed',
    summary: `"${toolName}" refused (${code}): ${said}. ${instead}`,
    data: { code, detail },
  };
}

/**
 * Every sentence {@link failed} can produce for a code this file authors.
 *
 * Exported so the desktop failure-quality gate WALKS the table rather than quoting it: a
 * list copied into a test rots on the commit that adds a code, which is the failure mode
 * the gate exists to end.
 */
export function trackingFailureNoteEntries(): readonly {
  readonly tool: string;
  readonly code: string;
  readonly note: string;
}[] {
  const tools = [AUTOMATIC_TRACKING_TOOL_NAME, DETECT_SUBJECTS_TOOL_NAME];
  const codes = [...Object.keys(FAILURE_GUIDANCE), 'an_unrecognized_worker_code'];
  return tools.flatMap((tool) =>
    codes.flatMap((code) =>
      [true, false].map((retryable) => ({
        tool,
        code: `${code} (retryable=${String(retryable)})`,
        note: failed(tool, code, 'The worker said something we do not recognize', retryable)
          .summary,
      })),
    ),
  );
}
