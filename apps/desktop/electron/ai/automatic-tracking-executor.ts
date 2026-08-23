/**
 * Host executor for `track_subject_automatically` — the agent's path into the
 * Tracking Lite Capability Pack worker.
 *
 * The orchestrator cannot run the worker itself (the render/CV boundary lives
 * on the host), and the renderer IPC handler exists for editor-initiated
 * tracks. This executor gives the AGENT the same authority through the same
 * service: objective in, exact pack request built from the working project,
 * isolated worker out, measurements only. It never writes the project —
 * converting samples into a validated reversible patch stays with the
 * orchestrator and editor-core.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@framepilot/shared-types';
import {
  AUTOMATIC_TRACKING_TOOL_NAME,
  AutomaticTrackingObjectiveSchema,
  AutomaticTrackingMeasurementSchema,
  resolveAutomaticTrackingObjective,
  type AutomaticTrackingMeasurement,
  type HostToolExecutor,
  type HostToolOutcome,
  type HostExecutionContext,
} from '@framepilot/ai-sdk';
import { buildTrackingWorkerRequest } from '../capability-packs/tracking-request.js';
import type { CapabilityPackTrackingService } from '../capability-packs/tracking.js';

const log = createLogger('desktop:ai:automatic-tracking');

export interface AutomaticTrackingExecutorOptions {
  /** Lazily resolves the desktop tracking authority (leases + proposals). */
  readonly tracking: () => Promise<CapabilityPackTrackingService>;
}

export function createAutomaticTrackingExecutor(
  options: AutomaticTrackingExecutorOptions,
): HostToolExecutor {
  return {
    async run(
      call: { name: string; arguments?: unknown },
      ctx: HostExecutionContext,
      signal?: AbortSignal,
    ): Promise<HostToolOutcome> {
      if (call.name !== AUTOMATIC_TRACKING_TOOL_NAME) {
        return {
          status: 'failed',
          summary: `"${call.name}" was routed to the automatic tracking executor by mistake.`,
        };
      }
      const objective = AutomaticTrackingObjectiveSchema.parse(call.arguments);
      if (!ctx.interaction) {
        return failed(
          'target_unresolved',
          'Automatic tracking needs a live editor selection — open the timeline and select the clip to track.',
        );
      }
      const resolution = resolveAutomaticTrackingObjective({
        project: ctx.project,
        interaction: ctx.interaction,
        objective,
      });
      if (resolution.status === 'rejected') {
        return failed(resolution.code, resolution.detail);
      }
      const { plan } = resolution;
      // Same request builder as the renderer path: geometry is protocol-checked
      // here, the media path comes only from this project's own asset list.
      const requestId = randomUUID();
      const built = buildTrackingWorkerRequest(
        ctx.project,
        ctx.project.timeline.revision ?? 0,
        {
          requestId,
          assetId: plan.assetId,
          capability: plan.capability,
          firstFrame: plan.firstFrame,
          lastFrameExclusive: plan.lastFrameExclusive,
          fps: plan.fps,
          parameters: plan.parameters,
        },
      );
      if (built.status === 'rejected') {
        return failed(built.code, built.detail);
      }
      log.action('automaticTrackingStart', {
        clipId: plan.clipId,
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
      if (outcome.status === 'pack_missing') {
        return {
          status: 'failed',
          summary:
            'The Tracking Lite pack is not installed on this machine. The user can install it ' +
            'from Settings › Capability Packs; do not claim the subject was tracked.',
          data: { code: 'pack_missing', proposal: outcome.proposal },
        };
      }
      if (outcome.status === 'failed') {
        if (outcome.code === 'cancelled') {
          return {
            status: 'cancelled',
            summary: 'Stopped "track_subject_automatically" — run cancelled',
          };
        }
        return failed(
          outcome.code,
          `${outcome.detail}${outcome.retryable ? ' (Retryable.)' : ''}`,
        );
      }
      const result = outcome.result;
      if (!('samples' in result) || result.samples.length === 0) {
        return failed('worker_failed', 'The tracking worker returned no track samples.');
      }
      const measurement: AutomaticTrackingMeasurement = {
        objective,
        plan: {
          clipId: plan.clipId,
          maskEffectId: plan.maskEffectId,
          capability: plan.capability,
          fps: plan.fps,
          startSeconds: plan.startSeconds,
        },
        samples: result.samples,
        engine: `${outcome.identity.id}@${outcome.identity.version}`,
        backend: result.backend,
      };
      // Refuse to hand the orchestrator anything it would reject anyway.
      const parsed = AutomaticTrackingMeasurementSchema.safeParse(measurement);
      if (!parsed.success) {
        return failed('worker_failed', 'The tracking worker returned a malformed sample set.');
      }
      log.action('automaticTrackingComplete', {
        requestId,
        engine: measurement.engine,
        samples: measurement.samples.length,
      });
      const measured = measurement.samples.length;
      return {
        status: 'completed',
        summary: `Tracked ${measured} frame${measured === 1 ? '' : 's'} with ${measurement.engine} (${measurement.backend})`,
        data: parsed.data,
      };
    },
  };
}

function failed(code: string, detail: string): HostToolOutcome {
  return {
    status: 'failed',
    summary: `"${AUTOMATIC_TRACKING_TOOL_NAME}" refused (${code}): ${detail}`,
    data: { code, detail },
  };
}
