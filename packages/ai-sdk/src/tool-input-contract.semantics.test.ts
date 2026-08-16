/**
 * The renderer-backed semantic layer that sits on top of each tool's Zod schema.
 *
 * A schema says "a number"; this layer says "a number this renderer will actually
 * honor". Both TS surfaces (agent + MCP) and the Python mirror enforce the same rules,
 * so every case here is also a case `test_tool_contract_overrides.py` must agree with.
 */
import { describe, expect, it } from 'vitest';
import {
  ToolInputContractError,
  assertToolInputSemantics,
  contractedToolParameters,
  parseToolArguments,
} from './tool-input-contract.js';
import { getTool } from './tool-registry.js';

const rejects = (tool: string, args: unknown, pattern: RegExp): void => {
  expect(() => assertToolInputSemantics(tool, args)).toThrow(ToolInputContractError);
  expect(() => assertToolInputSemantics(tool, args)).toThrow(pattern);
};

const accepts = (tool: string, args: unknown): void => {
  expect(() => assertToolInputSemantics(tool, args)).not.toThrow();
};

describe('unscoped input', () => {
  it('ignores a non-object payload rather than crashing the boundary', () => {
    accepts('apply_color_grade', null);
    accepts('apply_color_grade', ['not', 'an', 'object']);
    accepts('a_tool_with_no_semantic_rules', { anything: 1 });
  });
});

describe('map_time direction', () => {
  it('accepts exactly one time domain', () => {
    accepts('map_time', { sourceTime: 1, assetId: 'asset-a' });
    accepts('map_time', { sequenceTime: 1 });
    accepts('map_time', {});
  });

  it('refuses both domains at once, and an asset scope without a source time', () => {
    rejects(
      'map_time',
      { sourceTime: 1, sequenceTime: 2 },
      /one time domain|mutually exclusive|only valid/i,
    );
    rejects('map_time', { assetId: 'asset-a' }, /only valid with sourceTime/i);
    rejects('map_time', { assetId: 'asset-a', sequenceTime: 1 }, /only valid with sourceTime/i);
  });
});

describe('keyframe vocabulary and value domains', () => {
  it('accepts the renderer properties and skips unusable entries', () => {
    accepts('add_keyframes', { keyframes: [{ property: 'scale', value: 1.2 }] });
    accepts('add_keyframes', { keyframes: [{ property: 'x', value: -40 }] });
    // A non-numeric value is the schema's problem, not this layer's — it must not throw
    // a misleading range error on top of the type error the schema already reports.
    accepts('add_keyframes', { keyframes: [{ property: 'scale', value: 'big' }] });
    accepts('add_keyframes', { keyframes: [null] });
    accepts('add_keyframes', { keyframes: 'not-an-array' });
  });

  it('refuses properties no renderer composites, and impossible values', () => {
    rejects('add_keyframes', { keyframes: [{ property: 'blur', value: 2 }] }, /must be one of/i);
    rejects('add_keyframes', { keyframes: [{ property: 42, value: 2 }] }, /must be one of/i);
    rejects('add_keyframes', { keyframes: [{ property: 'scale', value: 0 }] }, /> 0/);
    rejects('add_keyframes', { keyframes: [{ property: 'opacity', value: 1.5 }] }, /0\.\.1/);
  });
});

describe('color grade domains', () => {
  it('accepts the two types the render compiler implements', () => {
    accepts('apply_color_grade', { params: { exposure: 1 } });
    accepts('apply_color_grade', { type: 'lut', params: { path: 'looks/teal.cube' } });
    accepts('apply_color_grade', { type: 'color_grade' });
  });

  it('refuses a transform grade, a pathless LUT, and out-of-domain parameters', () => {
    rejects('apply_color_grade', { type: 'transform' }, /Use color_grade or lut/i);
    rejects(
      'apply_color_grade',
      { type: 'lut', params: { name: 'teal' } },
      /requires params\.path/i,
    );
    rejects('apply_color_grade', { type: 'lut', params: { path: '  ' } }, /requires params\.path/i);
    rejects('apply_color_grade', { params: { vibrance: 1 } }, /Unknown color-grade parameter/i);
    rejects('apply_color_grade', { params: { exposure: 'high' } }, /finite number/i);
    rejects('apply_color_grade', { params: { contrast: 9 } }, /must be within/i);
  });
});

describe('audio domains', () => {
  it('accepts gain inside the renderer range and ignores a non-numeric gain', () => {
    accepts('adjust_audio', { gainDb: -6 });
    accepts('adjust_audio', { gainDb: 'loud' });
  });

  it('refuses gain outside the renderer range', () => {
    rejects('adjust_audio', { gainDb: 99 }, /must be within/i);
  });
});

describe('tracker geometry', () => {
  it('accepts a normalized rectangle inside the frame', () => {
    accepts('track_object', { region: { x: 0, y: 0, width: 1, height: 1 } });
    accepts('track_object', { region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
    accepts('track_object', {});
    // Non-numeric geometry is the schema's error to report, not a range error.
    accepts('track_object', { region: { x: 'left', y: 0, width: 1, height: 1 } });
  });

  it('refuses pixel-shaped or out-of-frame rectangles', () => {
    // The field is documented as frame fractions; 640 means the model sent pixels, and
    // silently accepting it would track a region that does not exist.
    rejects('track_object', { region: { x: 640, y: 0, width: 0.5, height: 0.5 } }, /0\.\.1/);
    rejects('track_object', { region: { x: 0, y: 0, width: 0, height: 0.5 } }, /positive/i);
    rejects(
      'track_object',
      { region: { x: 0.8, y: 0.1, width: 0.5, height: 0.5 } },
      /inside the normalized frame/i,
    );
  });
});

describe('provider-facing schemas advertise the runtime rules', () => {
  it('closes the keyframe property to the renderer vocabulary', () => {
    const tool = getTool('add_keyframes');
    const parameters = contractedToolParameters(tool!);
    const keyframes = (parameters.properties as Record<string, { items?: unknown }>).keyframes;
    const property = (keyframes as { items: { properties: Record<string, { enum?: string[] }> } })
      .items.properties.property;
    expect(property.enum).toEqual(['scale', 'x', 'y', 'rotation', 'opacity']);
  });

  it('publishes the normalized tracker bounds', () => {
    const parameters = contractedToolParameters(getTool('track_object')!);
    const region = (
      parameters.properties as Record<string, { properties: Record<string, unknown> }>
    ).region;
    expect(region.properties.x).toMatchObject({ minimum: 0, maximum: 1 });
    expect(region.properties.width).toMatchObject({ exclusiveMinimum: 0, maximum: 1 });
  });

  it('still publishes the contract when the base schema has nothing to merge into', () => {
    // A tool whose parameters carry no `properties` (or a nested shape the generator
    // spelled differently) must still advertise the constraint rather than silently
    // publishing an unconstrained schema the runtime would then reject calls against.
    const bare = { name: 'add_keyframes', parameters: { type: 'object' } };
    const keyframes = (
      contractedToolParameters(bare as unknown as Parameters<typeof contractedToolParameters>[0])
        .properties as Record<string, { items: { properties: Record<string, unknown> } }>
    ).keyframes;
    expect(keyframes.items.properties.property).toMatchObject({ type: 'string' });

    const bareTracker = { name: 'track_object', parameters: { type: 'object', properties: null } };
    const region = (
      contractedToolParameters(
        bareTracker as unknown as Parameters<typeof contractedToolParameters>[0],
      ).properties as Record<string, { properties: Record<string, unknown> }>
    ).region;
    expect(region.properties.x).toMatchObject({ minimum: 0, maximum: 1 });
  });

  it('publishes only the color types the renderer implements', () => {
    const parameters = contractedToolParameters(getTool('apply_color_grade')!);
    const type = (parameters.properties as Record<string, { enum?: string[] }>).type;
    expect(type.enum).toEqual(['color_grade', 'lut']);
  });
});

describe('parseToolArguments', () => {
  it('returns parsed arguments for a valid call', () => {
    expect(parseToolArguments(getTool('adjust_audio')!, { clipId: 'c', gainDb: -3 })).toMatchObject(
      {
        clipId: 'c',
        gainDb: -3,
      },
    );
  });

  it('names the offending argument instead of failing opaquely', () => {
    expect(() => parseToolArguments(getTool('adjust_audio')!, { clipId: 'c' })).toThrow(/gainDb/i);
    expect(() =>
      parseToolArguments(getTool('adjust_audio')!, { clipId: 'c', gainDb: -3, bogus: 1 }),
    ).toThrow(/Unrecognized key/i);
  });

  it('applies the semantic layer after the schema, not instead of it', () => {
    expect(() =>
      parseToolArguments(getTool('adjust_audio')!, { clipId: 'c', gainDb: 999 }),
    ).toThrow(/must be within/i);
  });
});

describe('ordered windows', () => {
  it('refuses an inverted window on every read that takes one', () => {
    for (const tool of ['get_transcript', 'get_mapped_transcript', 'get_clips']) {
      rejects(tool, { start: 10, end: 5 }, /start/i);
      accepts(tool, { start: 5, end: 10 });
      accepts(tool, { start: 5 });
      accepts(tool, {});
    }
  });

  it('refuses an inverted edit window', () => {
    for (const tool of ['apply_effect', 'punch_in']) {
      rejects(tool, { startTime: 5, endTime: 5 }, /start/i);
      accepts(tool, { startTime: 1, endTime: 5 });
      accepts(tool, { startTime: 1 });
    }
  });
});
