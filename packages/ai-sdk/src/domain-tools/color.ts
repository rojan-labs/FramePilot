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
import { COLOR_GRADE_PARAMETER_CONTRACTS } from '@framepilot/editor-core';
import { analysisTool, mutateTool } from './tool-factories.js';
import { id } from './tool-args.js';

const measureColorSchema = z.object({ clipId: z.string().trim().min(1) }).strict();

/**
 * The grade's parameters and their real ranges, written out for the model.
 *
 * Derived from {@link COLOR_GRADE_PARAMETER_CONTRACTS} rather than typed out, because the
 * two things a model needs — the names and the bounds — are already enforced on both
 * sides of the boundary (`tool-input-contract.ts` and the sidecar's
 * `contract_overrides.py`) and a second hand-written copy would drift from them.
 *
 * The gap this closes: `apply_color_grade`'s description was "Apply a color grade to a
 * clip." and its `params` was an untyped record. Every name and bound was enforced and
 * none was advertised, so a model could only learn the contract by guessing and being
 * refused — while `discover_effects` sits in the same registry precisely because
 * "the ids and parameter names are not guessable". The `color-grading` playbook instructs
 * this tool and speaks of keeping corrections "within ±0.3", naming a range for parameters
 * it never names. Run `fc10301a` loaded that playbook and applied no grade at all.
 */
const GRADE_PARAMS = Object.entries(COLOR_GRADE_PARAMETER_CONTRACTS)
  .map(([name, { min, max }]) => `${name} (${String(min)}..${String(max)})`)
  .join(', ');

export const COLOR_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    {
      name: 'apply_color_grade',
      description:
        'Grade ONE clip. Two kinds: `color_grade` (the default) takes signed offsets ' +
        `where 0 changes nothing — ${GRADE_PARAMS}. A value outside its range, or a name ` +
        'not on that list, is refused rather than silently ignored, and every parameter ' +
        'you omit stays at 0, so a correction can name only the axis it fixes. ' +
        '`lut` instead takes params.path — a .cube file inside the project. There is no ' +
        'grade for position, scale or rotation: those are keyframes (add_keyframes, ' +
        'punch_in). Grading is per clip, so a whole-sequence look is one call per clip.',
    },
    z
      .object({
        clipId: z.string(),
        // `transform` is deliberately still ACCEPTED by this Zod enum and deliberately not
        // ADVERTISED: `tool-input-contract.ts#colorGradeParameters` already narrows the
        // published schema to `['color_grade','lut']`, so the model never sees the arm,
        // while `assertColorGrade` gets to answer a caller that sends it anyway with the
        // sentence that helps — position, scale and rotation are keyframes, not a grade.
        // Narrowing here instead would hand back Zod's generic "invalid_value" and throw
        // that explanation away.
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
