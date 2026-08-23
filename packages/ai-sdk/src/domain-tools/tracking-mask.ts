/**
 * Tracking and mask tools — including the one that still does not work.
 *
 * `detect_faces` became real through the Subject Intelligence pack (see
 * `automatic-tracking.ts`'s `detect_subjects`, which supersedes it with
 * person/object labels included). `generate_mask` remains registered and
 * explicitly unavailable because a segmentation is a bitmap and the timeline
 * mask model steers by rectangle bounds; the measured path that DOES exist is
 * `track_subject_automatically` with subject="silhouette", which segments
 * inside a drawn mask and follows the silhouette's bounding box. This file
 * keeps the honest statement of what the domain cannot do beside what it can.
 */
import { z } from 'zod/v4';
import type { ToolSpec } from '../tool-registry.js';
import { mutateTool, unavailableTool } from './tool-factories.js';
import { filterString, seconds } from './tool-args.js';

export const TRACKING_MASK_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    { name: 'add_mask', description: 'Add a mask shape to a clip.' },
    z.object({ clipId: z.string(), shape: z.enum(['rectangle', 'ellipse', 'polygon']) }).strict(),
    (a) => [{ type: 'add_mask', clipId: a.clipId, shape: a.shape }],
  ),
  mutateTool(
    {
      name: 'track_object',
      description:
        'Attach an object tracker to a clip. target="object" tracks an arbitrary ' +
        'picked region (frame fractions); a track is computed by the tracking engine.',
    },
    z
      .object({
        clipId: z.string(),
        target: z.enum(['face', 'bounding_box', 'object']),
        region: z
          .object({ x: seconds, y: seconds, width: seconds, height: seconds })
          .strict()
          .optional(),
        engine: filterString(),
      })
      .strict(),
    (a) => [
      {
        type: 'track_object',
        clipId: a.clipId,
        target: a.target,
        ...(a.region ? { region: a.region } : {}),
        ...(a.engine ? { engine: a.engine } : {}),
      },
    ],
  ),
  unavailableTool(
    {
      name: 'generate_mask',
      description:
        'Generate a subject mask (unavailable — segmentation produces bitmap masks, and timeline ' +
        'masks steer by rectangle bounds). The measured alternative is ' +
        'track_subject_automatically with subject="silhouette": it segments inside a drawn mask ' +
        'and animates that mask to follow the measured silhouette.',
    },
    true,
  ),
];
