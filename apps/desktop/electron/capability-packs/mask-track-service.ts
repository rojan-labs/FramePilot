/**
 * One mask-track job, start to finish: resolve → measure in the pack worker → commit the artifact.
 *
 * This was written inline in the renderer's IPC handler. The agent's `track_mask` and
 * `create_mask` need exactly the same job — same resolution, same worker, same artifact, same
 * flagged ranges — so it lives here and both call it. What differs between the two callers is
 * only WHICH project they hand in: the IPC handler re-reads the saved project from disk (the
 * renderer's view is never the authority), while the agent hands in its run's working project,
 * because the mask it is tracking may exist only in the patch it is about to propose. That is a
 * caller's decision, not this function's, which is why the project is a parameter.
 */
import type { CapabilityPackProposalResultWire } from '@framepilot/shared-types';
import type { CapabilityPackWorkerProgress } from '@framepilot/capability-packs';
import type { TrackSegment } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { buildTrackingWorkerRequest } from './tracking-request.js';
import type { CapabilityPackTrackingService } from './tracking.js';
import {
  commitMaskTrack,
  maskTrackMeasurements,
  measurementIntent,
  resolveMaskTrack,
  segmentFromSamples,
  type MaskTrackIntent,
} from './track-run.js';

export type MaskTrackJobResult =
  | {
      readonly ok: true;
      readonly artifact: { readonly key: string; readonly sha256: string };
      readonly method: MaskTrackIntent['method'];
      readonly frames: number;
      readonly flagged: readonly { readonly start: number; readonly end: number }[];
      readonly worstResidualPx: number;
      readonly engine: string;
      readonly projectRevision: number;
    }
  | {
      readonly ok: false;
      readonly code: 'pack_missing';
      readonly proposal: CapabilityPackProposalResultWire;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error: string;
      readonly retryable: boolean;
    };

export interface MaskTrackJobInput {
  /** The project whose mask is tracked. See the module comment for who passes which. */
  readonly project: Project;
  /** The open project's folder; the track artifact is written under it. */
  readonly projectDir: string;
  readonly intent: MaskTrackIntent;
  readonly tracking: () => Promise<CapabilityPackTrackingService>;
  readonly signal: AbortSignal;
  /** Progress across ALL of the job's measurements, so a caller shows one bar. */
  readonly onProgress?: (progress: {
    readonly phase: CapabilityPackWorkerProgress['phase'];
    readonly completed: number;
    readonly total: number;
  }) => void;
}

const failed = (code: string, error: string, retryable = false): MaskTrackJobResult => ({
  ok: false,
  code,
  error,
  retryable,
});

export async function runMaskTrackJob(input: MaskTrackJobInput): Promise<MaskTrackJobResult> {
  const { project, intent } = input;
  const revision = project.timeline.revision ?? 0;
  const resolution = resolveMaskTrack(project, intent, Number(project.fps));
  if (resolution.status === 'rejected') return failed(resolution.code, resolution.detail);
  const resolved = resolution.resolved;
  const measurements = maskTrackMeasurements(resolved, intent, undefined);
  if (measurements.length === 0) {
    return failed(
      'nothing_to_track',
      'There is nothing to track in that direction. Move the playhead and try again.',
    );
  }
  const segments: TrackSegment[] = [];
  let engine = '';
  let releaseDigest = '';
  let packId = '';
  let packVersion = '';
  try {
    for (const [index, measurement] of measurements.entries()) {
      const built = buildTrackingWorkerRequest(
        project,
        revision,
        measurementIntent(resolved, measurement, intent, index),
      );
      if (built.status === 'rejected') return failed(built.code, built.detail);
      const outcome = await (
        await input.tracking()
      ).run(built.request, {
        projectRevision: revision,
        mediaRoot: built.mediaRoot,
        signal: input.signal,
        onProgress: (progress: CapabilityPackWorkerProgress) => {
          input.onProgress?.({
            phase: progress.phase,
            completed: index * progress.total + progress.completed,
            total: measurements.length * progress.total,
          });
        },
      });
      if (outcome.status === 'pack_missing') {
        return { ok: false, code: 'pack_missing', proposal: outcome.proposal };
      }
      if (outcome.status === 'failed') {
        return failed(outcome.code, outcome.detail, outcome.retryable);
      }
      if (!('samples' in outcome.result)) {
        return failed('worker_failed', 'This job did not return a track.');
      }
      packId = outcome.identity.id;
      packVersion = outcome.identity.version;
      releaseDigest = outcome.identity.releaseDigest;
      engine = `${packId}@${packVersion}`;
      const segment = segmentFromSamples(resolved, measurement, outcome.result.samples);
      if (segment !== null) segments.push(segment);
    }
    const committed = await commitMaskTrack({
      projectDir: input.projectDir,
      resolved,
      segments,
      // The pinned digest is what makes an artifact trustworthy; this fingerprint only has
      // to change when the same request would measure different footage, which the asset's
      // identity, path, measured size and duration already say.
      fingerprint: [
        resolved.asset.id,
        resolved.asset.path,
        `${resolved.geometry.codedWidth}x${resolved.geometry.codedHeight}`,
        String(resolved.asset.durationSeconds ?? ''),
      ].join('|'),
      pack: { id: packId, version: packVersion, releaseDigest },
    });
    if (committed.status === 'failed') {
      return failed(committed.code, committed.detail, committed.code === 'no_frames');
    }
    return {
      ok: true,
      artifact: { key: committed.key, sha256: committed.sha256 },
      method: resolved.request.method,
      frames: committed.frames,
      flagged: committed.flagged,
      worstResidualPx: committed.worstResidualPx,
      engine,
      projectRevision: revision,
    };
  } catch (error) {
    return failed('worker_failed', error instanceof Error ? error.message : 'Tracking failed.');
  }
}
