/**
 * AM1.4 at the boundary: a tool that hands model-supplied coordinates to a mask operation is
 * refused by `operationsForCall`, whoever wrote the tool and however valid the shape is.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { Operation } from '@framepilot/editor-core';
import { makeProject } from '../__fixtures__/project.js';
import { mutateTool } from '../domain-tools/tool-factories.js';
import { ToolInvocationError, operationsForCall } from '../tool-dispatch.js';
import { TOOL_REGISTRY } from '../tool-registry.js';
import { UNSOURCED_MASK_GEOMETRY, attestMaskGeometry } from './geometry-provenance.js';

const box = z
  .object({
    clipId: z.string(),
    cx: z.number(),
    cy: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

const maskOp = (a: z.infer<typeof box>): Operation =>
  ({
    type: 'add_mask',
    clipId: a.clipId,
    mask: {
      id: `${a.clipId}__mask`,
      kind: 'rectangle',
      cx: a.cx,
      cy: a.cy,
      width: a.width,
      height: a.height,
    },
  }) as Operation;

/** What a careless new tool would look like: the model's numbers, straight into a mask. */
const INVENTING = mutateTool({ name: 'invent_mask', description: 'test only' }, box, (a) => [
  maskOp(a),
]);
/** The same numbers, but the builder vouches for a measured source. */
const MEASURED = mutateTool({ name: 'measured_mask', description: 'test only' }, box, (a) =>
  attestMaskGeometry([maskOp(a)], { kind: 'measurement', engine: 'pack@1' }),
);

vi.mock('../tool-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-registry.js')>();
  return {
    ...actual,
    getTool: (name: string) =>
      name === 'invent_mask'
        ? INVENTING
        : name === 'measured_mask'
          ? MEASURED
          : actual.getTool(name),
  };
});

const args = { clipId: 'clip_a', cx: 100, cy: 100, width: 50, height: 50 };
const ctx = { project: makeProject() };

describe('the dispatch boundary refuses mask geometry with no source', () => {
  it('refuses a tool that passes the model its own coordinates', () => {
    let refusal: unknown;
    try {
      operationsForCall({ id: '1', name: 'invent_mask', arguments: args }, ctx);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ToolInvocationError);
    expect((refusal as ToolInvocationError).code).toBe('refusal');
    expect((refusal as ToolInvocationError).message).toBe(UNSOURCED_MASK_GEOMETRY);
  });

  it('admits the same shape from a builder that attests a measurement', () => {
    const ops = operationsForCall({ id: '2', name: 'measured_mask', arguments: args }, ctx);
    expect(ops).toHaveLength(1);
  });

  it('leaves no registered tool able to take a mask coordinate from the model', () => {
    // A schema-level audit to go with the runtime gate: no advertised parameter is a vertex
    // list, and the only box-shaped argument on a masking tool is `userShape`, which is
    // checked against the editor's own words before anything is built.
    const suspicious = /^(points|vertices|bounds|polygon|path)$/u;
    const offenders = TOOL_REGISTRY.filter((tool) =>
      (tool.capabilities ?? []).includes('masking'),
    ).flatMap((tool) =>
      Object.keys((tool.parameters.properties ?? {}) as Record<string, unknown>)
        .filter((key) => suspicious.test(key))
        .map((key) => `${tool.name}.${key}`),
    );
    expect(offenders).toEqual([]);
  });
});
