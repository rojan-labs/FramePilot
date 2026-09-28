import { describe, expect, it } from 'vitest';
import { JsonValueSchema, toJsonValue } from './run-contracts.js';

describe('toJsonValue (what the durable run log stores)', () => {
  it('stores a tool result whose keys are undefined — the measure_color crash', () => {
    // measure_color's evidence carries absent channels as undefined keys; a bare
    // JsonValueSchema.parse rejected them and ended the run (run 6cb12e30, the 2026-09-28
    // harness baseline).
    const event = {
      type: 'tool_result',
      data: { samples: [{ frame: 3, coverageRatio: undefined, mean: undefined, p10: 0.1 }] },
    };
    expect(() => JsonValueSchema.parse(event)).toThrow();
    expect(toJsonValue(event)).toEqual({
      type: 'tool_result',
      data: { samples: [{ frame: 3, p10: 0.1 }] },
    });
  });

  it('keeps what JSON keeps and maps a bare undefined to null', () => {
    expect(toJsonValue(undefined)).toBeNull();
    expect(toJsonValue([1, undefined, 'a'])).toEqual([1, null, 'a']);
  });

  it('still refuses what cannot be serialised at all', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => toJsonValue(cyclic)).toThrow();
  });
});
