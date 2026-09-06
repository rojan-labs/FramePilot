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

describe('add_clips per-entry ordering', () => {
  // The tool description promises "the reason names the entry: fix that one and send the
  // batch again". `assertOrdered` reads top-level fields only, and a contract rejection is
  // reported without an operation index, so without a per-entry check that promise held on
  // the sidecar and not in Agent mode — the path the batch tool exists for.
  it('names the entry that is wrong, not just the batch', () => {
    rejects(
      'add_clips',
      {
        trackId: 'video_1',
        clips: [
          { assetId: 'a', start: 0, end: 1 },
          { assetId: 'a', start: 2, end: 2 },
        ],
      },
      /add_clips entry 1: end must be greater than start/,
    );
  });

  it('accepts a batch whose every entry is ordered', () => {
    accepts('add_clips', {
      trackId: 'video_1',
      clips: [
        { assetId: 'a', start: 0, end: 1 },
        { assetId: 'a', start: 1, end: 2.5 },
      ],
    });
    accepts('add_clips', { trackId: 'video_1', clips: 'not an array' });
  });
});

/**
 * Run `137d8fd0` sent `add_clip` `start: 44, end: 6`, then `start: 44, end: 14.233`,
 * then `start: 60, end: 15` — three attempts, each read back a restatement of the rule it
 * had already misunderstood. A positive `end` below `start` is not a typo; it is `end`
 * read as a LENGTH. The refusal now names the value that would have worked.
 */
describe('an ordered range refused because end was read as a duration', () => {
  it('names the end the model should have sent', () => {
    rejects(
      'add_clip',
      { assetId: 'stock_1', trackId: 'v_cutaways', start: 44, end: 6, sourceStart: 0 },
      /for a 6s span starting at 44, pass end: 50\./,
    );
    rejects(
      'add_clip',
      { assetId: 'stock_1', trackId: 'v_cutaways', start: 44, end: 14.233, sourceStart: 0 },
      /pass end: 58\.233\./,
    );
  });

  it('still states the rule, and still quotes what it was given', () => {
    rejects('trim_clip', { clipId: 'c', start: 10, end: 4 }, /requires end > start/);
    rejects('trim_clip', { clipId: 'c', start: 10, end: 4 }, /You gave start 10 and end 4\./);
  });

  it('offers no length reading where there is none to offer', () => {
    // A zero or negative end is a different mistake, and guessing at it would be noise.
    rejects('delete_range', { trackId: 't', start: 5, end: 0 }, /requires end > start/);
    expect(() =>
      assertToolInputSemantics('delete_range', { trackId: 't', start: 5, end: 0 }),
    ).toThrow(/^(?!.*pass end:).*$/s);
  });

  it('leaves a legal range alone', () => {
    accepts('add_clip', { assetId: 'a', trackId: 'v', start: 44, end: 50 });
  });
});
