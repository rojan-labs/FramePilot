/** Tests for the proposer contract (kernel/proposers/types.ts, K3.3). */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { parseJsonResponse, proposerModelEffect } from './types.js';

describe('proposerModelEffect', () => {
  it('builds an inert model effect with a system+user turn at temperature 0', () => {
    const effect = proposerModelEffect('SYS', 'USER');
    expect(effect.kind).toBe('model');
    expect(effect.request.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(effect.request.temperature).toBe(0);
    expect(effect.request.tools).toBeUndefined();
  });

  it('scopes tool descriptors onto the request when provided', () => {
    const tools = [{ name: 't', description: 'd', parameters: {} }];
    const effect = proposerModelEffect('SYS', 'USER', { tools });
    expect(effect.request.tools).toEqual(tools);
  });
});

describe('parseJsonResponse', () => {
  const schema = z.object({ n: z.number() });

  it('parses a bare JSON body', () => {
    expect(parseJsonResponse('{"n":1}', schema)).toEqual({ ok: true, value: { n: 1 } });
  });

  it('unwraps a ```json fenced block', () => {
    expect(parseJsonResponse('```json\n{"n":2}\n```', schema)).toEqual({
      ok: true,
      value: { n: 2 },
    });
  });

  it('unwraps a bare ``` fenced block', () => {
    expect(parseJsonResponse('```\n{"n":3}\n```', schema)).toEqual({ ok: true, value: { n: 3 } });
  });

  it('recovers one schema-valid JSON object from harmless provider prose', () => {
    expect(parseJsonResponse('Here is the requested result:\n{"n":4}\nDone.', schema)).toEqual({
      ok: true,
      value: { n: 4 },
    });
  });

  it('handles braces and escapes inside strings while recovering wrapped JSON', () => {
    const stringSchema = z.object({ text: z.string(), n: z.number() });
    expect(
      parseJsonResponse('Result: {"text":"keep {this} and \\"that\\"","n":5}.', stringSchema),
    ).toEqual({ ok: true, value: { text: 'keep {this} and "that"', n: 5 } });
  });

  it('skips a schema-invalid wrapper object and accepts the bounded valid candidate', () => {
    expect(parseJsonResponse('metadata {"kind":"result"}\npayload {"n":6}', schema)).toEqual({
      ok: true,
      value: { n: 6 },
    });
  });

  it('caps embedded-object recovery at 3 candidates so runaway prose cannot scan forever', () => {
    // Four wrapper objects, only the fourth schema-valid. Recovery stops scanning after
    // the 3rd embedded candidate, so the valid one past the cap is never reached and the
    // call reports the (only) schema error it did see, not a false success.
    const result = parseJsonResponse('a {"kind":1} b {"kind":2} c {"kind":3} d {"n":7}', schema);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-JSON body without throwing', () => {
    const result = parseJsonResponse('not json at all', schema);
    expect(result).toEqual({ ok: false, error: 'model response was not valid JSON' });
  });

  it('rejects a schema mismatch and reports the offending path', () => {
    const result = parseJsonResponse('{"n":"x"}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('at n');
  });

  it('reports schema failures with no path (top-level type error)', () => {
    const result = parseJsonResponse('[]', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/schema validation failed:/);
  });
});
