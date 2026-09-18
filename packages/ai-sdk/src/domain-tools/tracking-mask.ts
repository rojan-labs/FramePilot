/**
 * The tracker effect. Masks are not made here any more (plan 11, AM1.2).
 *
 * This file used to hold `add_mask` (a whole-frame shape the model placed by naming it) and
 * `generate_mask` (registered and unavailable, because a segmentation was a bitmap and masks
 * steered by rectangle bounds). Schema v22 gave masks a raster kind and the Smart Mask pack
 * gave them a measured one, so both are replaced by `create_mask` in `masking.ts`, where a
 * mask's geometry always comes from a candidate, a measurement or the editor's own numbers.
 */
import { z } from 'zod/v4';
import type { ToolSpec } from '../tool-registry.js';
import { mutateTool } from './tool-factories.js';
import { filterString, seconds } from './tool-args.js';

export const TRACKING_MASK_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    {
      name: 'track_object',
      description:
        'Attach an object tracker EFFECT to a clip, with NO motion in it: it marks the region ' +
        '(frame fractions) a highlight or mask should follow, and nothing here computes the ' +
        'path. To make a MASK follow a subject, load the masking tools and use create_mask with ' +
        'track:true, or track_mask on an existing mask. Never describe the subject as tracked ' +
        'from this call alone. Attaching a second tracker to the same ' +
        'clip replaces the first — repeating the call does not compute anything.',
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
];
