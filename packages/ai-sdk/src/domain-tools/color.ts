/**
 * Colour tools.
 *
 * Two tools, two execution kinds, one domain: you measure a shot through the real
 * render path, and you grade one. Keeping them together is the point of the split —
 * the measurement's contract and the grade's canonical effect id are one subject,
 * and they were three hundred lines apart when the file was grouped by kind.
 *
 * The resolver-backed `professional_color` lives in `professional-color.ts`; these
 * are the primitive surfaces it and the legacy paths share.
 */
import { z } from 'zod/v4';
import type { Effect } from '@framepilot/timeline-schema';
import type { ToolSpec } from '../tool-registry.js';
import { analysisTool, mutateTool } from './tool-factories.js';
import { id } from './tool-args.js';

const measureColorSchema = z.object({ clipId: z.string().trim().min(1) }).strict();

export const COLOR_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    { name: 'apply_color_grade', description: 'Apply a color grade to a clip.' },
    z
      .object({
        clipId: z.string(),
        type: z.enum(['color_grade', 'lut', 'transform']).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    (a) => {
      const effect: Effect = {
        id: id('grade', a.clipId),
        type: a.type ?? 'color_grade',
        params: a.params ?? {},
        keyframes: [],
      };
      return [{ type: 'apply_color_grade', clipId: a.clipId, effect }];
    },
  ),
  analysisTool(
    {
      name: 'measure_color',
      description:
        'Measure one timeline shot through the deterministic render path before matching color. ' +
        'Returns a revision-bound evidence handle with RGB/luma/saturation distributions and ' +
        'whether another visible layer contaminated the sample. Call once for the target and once ' +
        'for the reference, then pass both handles to professional_color match_reference. Never ' +
        'invent or copy the numeric measurements.',
      capabilities: ['color', 'vision'],
      hostUiOnly: true,
    },
    measureColorSchema,
  ),
];
