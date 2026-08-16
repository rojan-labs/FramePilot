/**
 * The manifest is enforced, not merely advertised.
 *
 * Before this gate, the router read a few optional fields off a generic object and
 * forwarded the rest, so a model could follow the published contract exactly and still
 * have its arguments quietly reshaped. Every autonomous call is now validated against the
 * same JSON Schema the model was shown, and each routed registry call is validated again
 * against the real tool schema — the two halves of the audit's P0-4 invariant.
 *
 * These cases drive each arm of that schema validator through real manifest capabilities.
 */
import { describe, expect, it } from 'vitest';
import { AutonomousToolRouteError, routeAutonomousToolCall } from './autonomous-tool-router.js';

const route = (name: string, args?: Record<string, unknown>) =>
  routeAutonomousToolCall({ id: 'c1', name, ...(args ? { arguments: args } : {}) });

const rejects = (name: string, args: Record<string, unknown>, pattern: RegExp): void => {
  expect(() => route(name, args)).toThrow(AutonomousToolRouteError);
  expect(() => route(name, args)).toThrow(pattern);
};

describe('string constraints', () => {
  it('checks type and length', () => {
    rejects('search_media', { mode: 'keyword', query: 42 }, /query must be a string/i);
    rejects('search_media', { mode: 'keyword', query: '' }, /at least 1 character/i);
    rejects('load_skill', { name: '' }, /at least 1 character/i);
    rejects('ask_user', { question: 'q'.repeat(601) }, /at most 600 character/i);
  });
});

describe('number and integer constraints', () => {
  it('checks finiteness, integrality, and bounds', () => {
    rejects(
      'search_media',
      { mode: 'keyword', query: 'a', limit: 1.5 },
      /limit must be an integer/i,
    );
    rejects('search_media', { mode: 'keyword', query: 'a', limit: 0 }, /limit must be >= 1/i);
    rejects('search_media', { mode: 'keyword', query: 'a', limit: 51 }, /limit must be <= 50/i);
    rejects('search_media', { mode: 'keyword', query: 'a', limit: 'ten' }, /limit must be finite/i);
    rejects('get_frame', { time: Number.POSITIVE_INFINITY }, /time must be finite/i);
    // `end` is exclusiveMinimum 0: a zero-length window reads nothing, so it is a
    // malformed request rather than an empty result the agent should reason about.
    rejects('inspect_transcript', { end: 0 }, /end must be > 0/i);
  });
});

describe('array constraints', () => {
  it('checks the container, its bounds, and its items', () => {
    rejects('search_media', { mode: 'describe', assetIds: 'a1' }, /assetIds must be an array/i);
    rejects('search_media', { mode: 'describe', assetIds: [1] }, /assetIds\[0\] must be a string/i);
    rejects('ask_user', { question: 'q', options: [{ label: 'only-one' }] }, /at least 2 item/i);
    rejects(
      'ask_user',
      { question: 'q', options: Array.from({ length: 6 }, () => ({ label: 'x' })) },
      /at most 5 item/i,
    );
  });

  it('checks each element of a positional (prefixItems) tuple', () => {
    rejects(
      'search_media',
      { mode: 'keyword', query: 'a', timeRange: [-1, 4] },
      /timeRange\[0\] must be >= 0/i,
    );
    rejects(
      'search_media',
      { mode: 'keyword', query: 'a', timeRange: ['a', 4] },
      /timeRange\[0\] must be finite/i,
    );
  });
});

describe('nested object and boolean constraints', () => {
  it('validates inside an array of objects', () => {
    rejects(
      'ask_user',
      { question: 'q', options: [{ label: '' }, { label: 'b' }] },
      /options\[0\]\.label must contain at least 1 character/i,
    );
    rejects(
      'ask_user',
      { question: 'q', options: [{ description: 'no label' }, { label: 'b' }] },
      /options\[0\]\.label is required/i,
    );
    rejects(
      'ask_user',
      { question: 'q', options: [{ label: 'a', extra: 1 }, { label: 'b' }] },
      /options\[0\]\.extra is not allowed/i,
    );
    expect(() =>
      route('ask_user', {
        question: 'q',
        options: [{ label: 'a' }, { label: 'b', description: 'd' }],
      }),
    ).not.toThrow();
  });

  it('checks a boolean field', () => {
    rejects('plan_edit_candidates', { verticalTarget: 'yes' }, /verticalTarget must be a boolean/i);
    expect(() => route('plan_edit_candidates', { verticalTarget: true })).not.toThrow();
  });
});

describe('mode-scoped fields', () => {
  it('refuses a field that belongs to a different search mode', () => {
    // `map` does not search, so a query/limit on it is a request the route cannot honor.
    rejects('search_media', { mode: 'map', query: 'a wave' }, /query/i);
    rejects('search_media', { mode: 'map', limit: 5 }, /limit/i);
    rejects('search_media', { mode: 'describe', query: 'a wave', assetIds: ['a1'] }, /query/i);
    rejects('search_media', { mode: 'map', assetIds: ['a1', 'a2'] }, /at most one asset/i);
  });

  it('routes visual search to its own registry tool', () => {
    const visual = route('search_media', { mode: 'visual', query: 'a wave' });
    expect(visual.kind === 'registry' && visual.calls[0]?.name).toBe('search_visual');
  });
});

describe('call envelope', () => {
  it('refuses a non-object argument envelope', () => {
    expect(() =>
      routeAutonomousToolCall({
        name: 'inspect_timeline',
        arguments: 'nope' as unknown as Record<string, unknown>,
      }),
    ).toThrow(/must be an object/i);
  });
});
