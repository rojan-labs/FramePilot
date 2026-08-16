/** Deterministic declarations for edit outcomes that require a human-like visual judgement. */
import { isProjectOperation } from '@framepilot/editor-core';
import type { Clip, Project } from '@framepilot/timeline-schema';
import type { EditResult } from './assemble.js';
import {
  MAX_VISION_FRAMES,
  VISION_REVIEW_VERSION,
  type VisionReviewRequest,
} from './vision-review.js';

const VISUAL_KEYFRAME_PROPERTIES = new Set([
  'x',
  'y',
  'scale',
  'rotation',
  'opacity',
  'width',
  'height',
]);

function clipsById(project: Project): Map<string, Clip> {
  const result = new Map<string, Clip>();
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) result.set(clip.id, clip);
  }
  return result;
}

function boundedFrames(project: Project, clip: Clip, preferred: readonly number[] = []): number[] {
  const lastTimelineFrame = Math.max(
    0,
    Math.ceil(
      Math.max(0, ...project.timeline.tracks.flatMap((track) => track.clips.map((item) => item.end))) *
        project.fps,
    ) - 1,
  );
  const start = Math.round(clip.start * project.fps);
  const end = Math.max(start, Math.ceil(clip.end * project.fps) - 1);
  const midpoint = Math.round((start + end) / 2);
  const candidates = [start, ...preferred, midpoint, end].map((frame) =>
    Math.min(lastTimelineFrame, Math.max(0, frame)),
  );
  return [...new Set(candidates)].slice(0, MAX_VISION_FRAMES);
}

/**
 * Plan only semantic questions that measurements cannot honestly answer. Audio levels, legal
 * scopes, black frames and exact timing stay in deterministic evidence; this planner declares
 * framing, tracking and transition-coherence questions only.
 */
export function planVisionObjectivesForEdit(input: {
  readonly project: Project;
  readonly edit: EditResult;
}): readonly VisionReviewRequest[] {
  const { project, edit } = input;
  const clips = clipsById(project);
  const revision = project.timeline.revision ?? 0;
  const requests = new Map<string, VisionReviewRequest>();
  const declare = (clipId: string, kind: string, objective: string, preferred: readonly number[] = []): void => {
    const clip = clips.get(clipId);
    if (!clip) return;
    const key = `${kind}:${clipId}`;
    requests.set(key, {
      schemaVersion: VISION_REVIEW_VERSION,
      requestId: `${edit.patch.patchId}:${key}`,
      projectRevision: revision,
      objective,
      frames: boundedFrames(project, clip, preferred),
    });
  };

  for (const operation of edit.patch.operations) {
    if (isProjectOperation(operation)) continue;
    switch (operation.type) {
      case 'add_keyframes': {
        const visual = operation.keyframes.filter((keyframe) =>
          VISUAL_KEYFRAME_PROPERTIES.has(keyframe.property),
        );
        const clip = clips.get(operation.clipId);
        if (visual.length === 0 || !clip) break;
        declare(
          operation.clipId,
          'motion-framing',
          'Across the authored move, does the visible subject remain intentionally framed without accidental cropping or leaving the composition?',
          visual.map((keyframe) => Math.round((clip.start + keyframe.time) * project.fps)),
        );
        break;
      }
      case 'set_clip_crop':
        if (operation.crop !== null) {
          declare(
            operation.clipId,
            'crop-framing',
            'After the crop, is the visible subject intentionally framed without cutting off important facial or body features?',
          );
        }
        break;
      case 'add_mask':
        declare(
          operation.clipId,
          'mask-subject',
          'Does the authored mask consistently cover the intended visible subject without obvious spill or clipping?',
          (operation.keyframes ?? []).map((keyframe) => {
            const clip = clips.get(operation.clipId)!;
            return Math.round((clip.start + keyframe.time) * project.fps);
          }),
        );
        break;
      case 'track_object':
        declare(
          operation.clipId,
          'tracked-subject',
          'Does the tracked region remain attached to the same visible subject throughout the sampled motion?',
          (operation.keyframes ?? []).map((keyframe) => {
            const clip = clips.get(operation.clipId)!;
            return Math.round((clip.start + keyframe.time) * project.fps);
          }),
        );
        break;
      case 'add_transition': {
        const incoming = clips.get(operation.toClipId);
        const outgoing = clips.get(operation.fromClipId);
        if (!incoming || !outgoing) break;
        const cut = Math.round(incoming.start * project.fps);
        declare(
          operation.toClipId,
          'transition-coherence',
          'Is the transition visually coherent, with both shots readable and no accidental subject occlusion or broken frame?',
          [Math.max(0, cut - 1), cut, cut + 1],
        );
        break;
      }
      default:
        break;
    }
  }
  return [...requests.values()];
}
