import { describe, expect, it } from 'vitest';
import { parseToolArguments, ToolInputContractError, withToolInputContract } from './tool-input-contract.js';
import { getTool } from './tool-registry.js';

const tool = (name: string) => {
  const resolved = getTool(name);
  if (!resolved) throw new Error(`missing test tool ${name}`);
  // The registry holds raw tool specs; wrap each lookup so this test observes
  // the same contracted (immutable, per-tool) schema/parse/description that
  // every real consumer (tool-dispatch.ts, tool-scope.ts) sees.
  return withToolInputContract(resolved);
};

describe('relational tool input contracts', () => {
  for (const name of ['get_transcript', 'get_mapped_transcript', 'get_clips']) {
    it(`rejects an inverted ${name} window`, () => {
      expect(() => parseToolArguments(tool(name), { start: 10, end: 5 })).toThrow(
        /end > start/i,
      );
    });
  }

  it('rejects map_time calls that specify both time domains', () => {
    expect(() =>
      parseToolArguments(tool('map_time'), { sourceTime: 1, sequenceTime: 2 }),
    ).toThrow(/exactly one time domain/i);
  });

  it('rejects map_time assetId without sourceTime', () => {
    expect(() => parseToolArguments(tool('map_time'), { assetId: 'asset-1' })).toThrow(
      /only valid with sourceTime/i,
    );
  });

  it('advertises map_time as a flat schema, with the one-domain rule in prose', () => {
    // Anthropic's Messages API rejects `oneOf`/`anyOf`/`allOf` directly under a tool's
    // `input_schema`, so this cannot be a top-level union the way the "exactly one time
    // domain" rule would otherwise suggest. `assertMapTime` still enforces it at parse
    // time (see the two tests above); only the advertised schema is flat.
    const parameters = tool('map_time').parameters as {
      type: string;
      oneOf?: unknown;
      anyOf?: unknown;
      allOf?: unknown;
      properties: Record<string, unknown>;
      description: string;
    };
    expect(parameters.type).toBe('object');
    expect(parameters.oneOf).toBeUndefined();
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.allOf).toBeUndefined();
    expect(Object.keys(parameters.properties)).toEqual(['sourceTime', 'assetId', 'sequenceTime']);
    expect(parameters.description).toMatch(/sourceTime.*sequenceTime|sequenceTime.*sourceTime/is);
  });

  it('rejects explicit inverted punch-in and effect ranges', () => {
    expect(() =>
      parseToolArguments(tool('punch_in'), {
        clipId: 'clip-1',
        startTime: 4,
        endTime: 2,
      }),
    ).toThrow(/endTime > startTime/i);
    expect(() =>
      parseToolArguments(tool('apply_effect'), {
        effectId: 'blur',
        startTime: 4,
        endTime: 2,
      }),
    ).toThrow(/endTime > startTime/i);
  });
});

describe('renderer-backed model-facing schemas', () => {
  it('advertises only clip keyframe properties the renderer consumes', () => {
    const parameters = tool('add_keyframes').parameters as {
      properties?: {
        keyframes?: { items?: { properties?: { property?: { enum?: string[] } } } };
      };
    };
    expect(parameters.properties?.keyframes?.items?.properties?.property?.enum).toEqual([
      'scale',
      'x',
      'y',
      'rotation',
      'opacity',
    ]);
    expect(() =>
      parseToolArguments(tool('add_keyframes'), {
        clipId: 'clip-1',
        keyframes: [{ time: 1, property: 'blur', value: 2 }],
      }),
    ).toThrow(/property must be one of/i);
  });

  it('removes the unrendered transform color type from the advertised schema', () => {
    const parameters = tool('apply_color_grade').parameters as {
      properties?: { type?: { enum?: string[] } };
    };
    expect(parameters.properties?.type?.enum).toEqual(['color_grade', 'lut']);
    expect(() =>
      parseToolArguments(tool('apply_color_grade'), {
        clipId: 'clip-1',
        type: 'transform',
      }),
    ).toThrow(/Unsupported color effect type/i);
    // GAP-017: and it says where transforms DO come from, instead of leaving the model to
    // work out that the arm it just tried has no replacement.
    expect(() =>
      parseToolArguments(tool('apply_color_grade'), { clipId: 'clip-1', type: 'transform' }),
    ).toThrow(/add_keyframes|punch_in/);
  });

  it('rejects unknown and out-of-range color-grade params', () => {
    expect(() =>
      parseToolArguments(tool('apply_color_grade'), {
        clipId: 'clip-1',
        params: { vibrance: 1 },
      }),
    ).toThrow(/Unknown color-grade parameter/i);
    expect(() =>
      parseToolArguments(tool('apply_color_grade'), {
        clipId: 'clip-1',
        params: { exposure: 6 },
      }),
    ).toThrow(/exposure must be within/i);
  });

  it('advertises and enforces the audio gain range', () => {
    const parameters = tool('adjust_audio').parameters as {
      properties?: { gainDb?: { minimum?: number; maximum?: number } };
    };
    expect(parameters.properties?.gainDb).toMatchObject({ minimum: -120, maximum: 24 });
    expect(() =>
      parseToolArguments(tool('adjust_audio'), { clipId: 'clip-1', gainDb: 25 }),
    ).toThrow(/gainDb must be within/i);
  });

  it('advertises normalized tracker bounds and enforces containment', () => {
    const parameters = tool('track_object').parameters as {
      properties?: {
        region?: {
          properties?: {
            x?: { maximum?: number };
            width?: { maximum?: number; exclusiveMinimum?: number };
          };
        };
      };
    };
    expect(parameters.properties?.region?.properties?.x?.maximum).toBe(1);
    expect(parameters.properties?.region?.properties?.width).toMatchObject({
      maximum: 1,
      exclusiveMinimum: 0,
    });
    expect(() =>
      parseToolArguments(tool('track_object'), {
        clipId: 'clip-1',
        target: 'object',
        region: { x: 0.8, y: 0, width: 0.3, height: 0.5 },
      }),
    ).toThrow(/inside the normalized frame/i);
  });
});

describe('transition recovery wording', () => {
  it('uses discover_transitions everywhere after contract installation', () => {
    expect(tool('add_transition').description).toContain('discover_transitions');
    expect(tool('add_transition').description).not.toContain('list_transitions');

    expect(() =>
      parseToolArguments(tool('add_transition'), {
        trackId: 'video-1',
        fromClipId: 'a',
        toClipId: 'b',
        kind: '__definitely_not_real__',
        durationSeconds: 0.5,
      }),
    ).toThrow(ToolInputContractError);
    expect(() =>
      parseToolArguments(tool('add_transition'), {
        trackId: 'video-1',
        fromClipId: 'a',
        toClipId: 'b',
        kind: '__definitely_not_real__',
        durationSeconds: 0.5,
      }),
    ).toThrow(/discover_transitions/i);
  });
});
