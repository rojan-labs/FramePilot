/**
 * Tracking and mask tools — including the two that do not work.
 *
 * `detect_faces` and `generate_mask` are registered and explicitly unavailable
 * because no CV engine is bundled, and they belong in this file precisely for
 * that reason: the honest statement of what this domain cannot do sits beside
 * what it can, where the next person to add a tracker will read it. Splitting the
 * registry by kind had them in a trailing `unavailableTools` array, filed by their
 * brokenness rather than by their subject.
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
      name: 'detect_faces',
      description:
        'Detect faces via a dedicated CV model (unavailable — no face detector is bundled). ' +
        'FramePilot cannot determine who or what is on screen without that capability; ask ' +
        'the editor rather than guessing.',
    },
    false,
  ),
  unavailableTool(
    { name: 'generate_mask', description: 'Generate a subject mask (engine TBD).' },
    true,
  ),
];
