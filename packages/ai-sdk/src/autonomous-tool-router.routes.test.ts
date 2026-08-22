/**
 * Routing the compact autonomous surface down to executable internal work.
 *
 * The model sees ~15 capabilities; the registry holds 74 routes. This module is the
 * translation, and its failure mode is specific: a call that routes to the WRONG
 * internal tool still succeeds, so nothing surfaces an error — the run just does
 * something other than what was asked. So these tests assert the resolved internal name
 * and arguments, not merely that routing did not throw.
 */
import { describe, expect, it } from 'vitest';
import {
  AutonomousToolRouteError,
  routeAutonomousToolCall,
  type AutonomousToolCall,
} from './autonomous-tool-router.js';
import { AUTONOMOUS_TOOL_MANIFEST } from './autonomous-tool-contract.js';

/** The smallest argument set each capability needs to route at all. */
function minimalArgsFor(name: string): Record<string, unknown> | undefined {
  switch (name) {
    case 'get_frame':
      return { time: 0 };
    case 'search_media':
      return { mode: 'map' };
    case 'analyze_media':
      return { kind: 'silence' };
    case 'discover_styles':
      return { kind: 'effects' };
    case 'propose_timeline_patch':
    case 'propose_project_patch':
      return {
        reason: 'tighten',
        operations: [{ tool: 'trim_clip', arguments: { clipId: 'c', start: 0, end: 1 } }],
      };
    default:
      return undefined;
  }
}

const call = (name: string, args?: Record<string, unknown>): AutonomousToolCall => ({
  id: 'c1',
  name,
  ...(args ? { arguments: args } : {}),
});

/** The single registry call a route resolved to. */
const routed = (name: string, args?: Record<string, unknown>) => {
  const route = routeAutonomousToolCall(call(name, args));
  if (route.kind !== 'registry') throw new Error(`expected a registry route, got ${route.kind}`);
  return route.calls[0];
};

describe('gatekeeping', () => {
  it('refuses an unknown capability', () => {
    expect(() => routeAutonomousToolCall(call('no_such_tool'))).toThrow(AutonomousToolRouteError);
    try {
      routeAutonomousToolCall(call('no_such_tool'));
    } catch (error) {
      expect((error as AutonomousToolRouteError).code).toBe('unknown_tool');
    }
  });

  it('refuses non-object arguments rather than coercing them', () => {
    expect(() =>
      routeAutonomousToolCall({
        name: 'inspect_timeline',
        arguments: [] as unknown as Record<string, unknown>,
      }),
    ).toThrow(/must be an object/);
  });
});

describe('inspection routes', () => {
  it.each([
    ['inspect_project', 'get_project_state'],
    ['inspect_timeline', 'get_timeline'],
    ['inspect_session', 'session_context'],
    ['render_preview', 'render_preview'],
  ])('%s → %s', (outer, inner) => {
    expect(routed(outer)?.name).toBe(inner);
  });

  it('forwards only the transcript filters that were supplied', () => {
    // An absent filter must be absent, not `undefined` — an explicit undefined would
    // narrow the transcript to nothing on a strict schema.
    expect(routed('inspect_transcript', { start: 1, end: 4 })?.arguments).toEqual({
      start: 1,
      end: 4,
    });
    expect(routed('inspect_transcript')?.arguments).toEqual({});
  });

  it('refuses an asset scope the underlying transcript read cannot honor', () => {
    // The manifest used to advertise `assetId` while `get_transcript` only windows by
    // time, and the sanitizer quietly dropped it — so the agent believed it had read
    // one asset's transcript when it had read the project's. Saying no is recoverable.
    expect(() => routeAutonomousToolCall(call('inspect_transcript', { assetId: 'a1' }))).toThrow(
      /assetId is not allowed/,
    );
  });

  it('refuses non-finite or malformed transcript filters instead of dropping them', () => {
    expect(() =>
      routeAutonomousToolCall(call('inspect_transcript', { start: Number.NaN })),
    ).toThrow(/start/);
    expect(() => routeAutonomousToolCall(call('inspect_transcript', { end: 'x' }))).toThrow(/end/);
  });
});

describe('get_frame', () => {
  it('maps `time` onto the registry’s `timeSeconds`', () => {
    expect(routed('get_frame', { time: 3.5 })).toMatchObject({
      name: 'get_frame',
      arguments: { timeSeconds: 3.5 },
    });
  });

  it.each([[undefined], [-1], ['nope'], [Number.NaN]])(
    'refuses a missing or negative time (%j)',
    (time) => {
      expect(() => routeAutonomousToolCall(call('get_frame', { time }))).toThrow(
        /must be (finite|>= 0)/,
      );
    },
  );
});

describe('search_media', () => {
  it.each(['keyword', 'semantic'])('%s search routes with its query', (mode) => {
    const result = routed('search_media', { mode, query: 'a wave' });
    expect(result?.arguments).toMatchObject({ query: 'a wave' });
  });

  it.each(['keyword', 'semantic'])('%s search refuses an empty query', (mode) => {
    expect(() => routeAutonomousToolCall(call('search_media', { mode, query: '  ' }))).toThrow(
      /non-empty query/,
    );
  });

  it('describe mode requires one asset id', () => {
    expect(routed('search_media', { mode: 'describe', assetIds: ['a1'] })?.name).toBe(
      'describe_footage',
    );
    expect(() =>
      routeAutonomousToolCall(call('search_media', { mode: 'describe', assetIds: [] })),
    ).toThrow(/requires exactly one asset/);
  });

  it('map mode routes to the footage map, asset id optional', () => {
    expect(routed('search_media', { mode: 'map' })?.name).toBe('map_footage');
    expect(routed('search_media', { mode: 'map', assetIds: ['a1'] })?.arguments).toEqual({
      assetId: 'a1',
    });
  });

  it('refuses an unsupported or absent mode', () => {
    expect(() => routeAutonomousToolCall(call('search_media', { mode: 'psychic' }))).toThrow(
      /mode must be one of/,
    );
    expect(() => routeAutonomousToolCall(call('search_media'))).toThrow(/mode/);
  });

  it('names a malformed assetIds array rather than silently treating it as absent', () => {
    // Dropping the bad list would run a different search than the one requested and
    // report success; naming the offending element lets the model resend a usable list.
    expect(() =>
      routeAutonomousToolCall(call('search_media', { mode: 'describe', assetIds: [1, 'a'] })),
    ).toThrow(/assetIds\[0\] must be a string/);
  });
});

describe('analyze_media', () => {
  it.each([
    ['transcription', 'transcribe'],
    ['silence', 'analyze_silence'],
    ['scenes', 'detect_scenes'],
    ['beats', 'detect_beats'],
  ])('kind %j → %s', (kind, inner) => {
    expect(routed('analyze_media', { kind })?.name).toBe(inner);
  });

  it('merges options and assetId into the internal call', () => {
    expect(
      routed('analyze_media', {
        kind: 'silence',
        assetId: 'a1',
        options: { minSilenceSeconds: 0.4 },
      })?.arguments,
    ).toEqual({ minSilenceSeconds: 0.4, assetId: 'a1' });
  });

  it('refuses an option the target analysis does not accept', () => {
    // `threshold` belongs to detect_scenes, not analyze_silence. Every routed call is
    // re-validated against the real registry schema, so a plausible-looking option
    // cannot reach the host as a silently ignored argument.
    expect(() =>
      routeAutonomousToolCall(
        call('analyze_media', { kind: 'silence', options: { threshold: 0.4 } }),
      ),
    ).toThrow(/analyze_silence/);
  });

  it('refuses a non-object options value', () => {
    expect(() =>
      routeAutonomousToolCall(call('analyze_media', { kind: 'silence', options: 'nope' })),
    ).toThrow(/options must be an object/);
  });

  it('refuses an unsupported or absent kind', () => {
    expect(() => routeAutonomousToolCall(call('analyze_media', { kind: 'vibes' }))).toThrow(
      /kind must be one of/,
    );
    expect(() => routeAutonomousToolCall(call('analyze_media'))).toThrow(/kind/);
  });
});

describe('discover_styles', () => {
  it.each([
    ['captions', 'discover_caption_styles'],
    ['effects', 'discover_effects'],
    ['transitions', 'discover_transitions'],
  ])('kind %j → %s', (kind, inner) => {
    expect(routed('discover_styles', { kind })?.name).toBe(inner);
  });

  it('forwards a query only when one was given', () => {
    expect(routed('discover_styles', { kind: 'effects', query: 'glow' })?.arguments).toEqual({
      query: 'glow',
    });
    expect(routed('discover_styles', { kind: 'effects' })?.arguments).toEqual({});
  });

  it('refuses an unsupported kind', () => {
    expect(() => routeAutonomousToolCall(call('discover_styles', { kind: 'nope' }))).toThrow(
      /kind must be one of/,
    );
  });
});

describe('plan_edit_candidates', () => {
  it('forwards only the planning inputs that were supplied', () => {
    const silences = [{ start: 1, end: 2 }];
    const result = routed('plan_edit_candidates', { silences, verticalTarget: true });
    expect(result?.name).toBe('read_edit_signals');
    expect(result?.arguments).toEqual({ silences, verticalTarget: true });
  });

  it('refuses planning signals that are not the shape read_edit_signals consumes', () => {
    expect(() => routeAutonomousToolCall(call('plan_edit_candidates', { silences: [1] }))).toThrow(
      /silences\[0\] must be an object/,
    );
  });
});

describe('verify_result', () => {
  it('splits registry checks from runtime checks', () => {
    const route = routeAutonomousToolCall(
      call('verify_result', { checks: ['captions', 'duration'] }),
    );
    if (route.kind !== 'verification') throw new Error('expected a verification route');
    expect(route.calls.map((c) => c.name)).toEqual(['verify_captions']);
    expect(route.runtimeChecks).toEqual(['duration']);
  });

  it('defaults to every check when none were named', () => {
    const route = routeAutonomousToolCall(call('verify_result'));
    if (route.kind !== 'verification') throw new Error('expected a verification route');
    expect(route.calls.map((c) => c.name)).toEqual(['verify_captions', 'verify_transitions']);
    expect(route.runtimeChecks).toEqual(['duration', 'visual', 'render']);
  });

  it('de-duplicates repeated checks, so nothing runs twice', () => {
    const route = routeAutonomousToolCall(
      call('verify_result', { checks: ['captions', 'captions', 'duration', 'duration'] }),
    );
    if (route.kind !== 'verification') throw new Error('expected a verification route');
    expect(route.calls).toHaveLength(1);
    expect(route.runtimeChecks).toEqual(['duration']);
  });

  it('gives each registry check a distinct call id', () => {
    // Two verification calls sharing one id would collide in the event stream and in
    // any result map keyed by call id.
    const route = routeAutonomousToolCall(
      call('verify_result', { checks: ['captions', 'transitions'] }),
    );
    if (route.kind !== 'verification') throw new Error('expected a verification route');
    expect(new Set(route.calls.map((c) => c.id)).size).toBe(route.calls.length);
  });

  it('refuses an unknown check', () => {
    expect(() => routeAutonomousToolCall(call('verify_result', { checks: ['vibes'] }))).toThrow(
      /checks\[0\] must be one of/,
    );
  });
});

describe('pass-through capabilities', () => {
  it.each([
    ['ask_user', { question: 'Which take should I keep?' }],
    ['load_skill', { name: 'remove-silence' }],
    ['recall_evidence', { evidenceId: 'ev_1' }],
    ['manage_assets', { strategy: 'by-kind' }],
  ])('%s forwards its arguments unchanged', (name, args) => {
    expect(routed(name, args)).toMatchObject({ name, arguments: args });
  });

  it.each(['ask_user', 'load_skill', 'recall_evidence', 'manage_assets'])(
    '%s refuses an argument its contract does not declare',
    (name) => {
      // "Pass-through" is about not rewriting arguments, not about skipping validation:
      // these calls are still checked against the manifest before they are forwarded.
      expect(() => routeAutonomousToolCall(call(name, { anything: 1 }))).toThrow(
        AutonomousToolRouteError,
      );
    },
  );
});

describe('the manifest and the switch cannot drift', () => {
  it('every READY manifest capability has a route', () => {
    // This is why the switch's `default:` is unreachable — and this test is what keeps
    // it that way. A capability added to the manifest without a route would advertise
    // itself to the model and then fail at invocation.
    const ready = AUTONOMOUS_TOOL_MANIFEST.tools.filter((tool) => tool.status === 'ready');
    expect(ready.length).toBeGreaterThan(0);
    for (const tool of ready) {
      expect(
        () => routeAutonomousToolCall(call(tool.name, minimalArgsFor(tool.name))),
        tool.name,
      ).not.toThrow(/no ready execution route/);
    }
  });

  it('refuses a PLANNED capability, rather than routing it somewhere plausible', () => {
    const planned = AUTONOMOUS_TOOL_MANIFEST.tools.find((tool) => tool.status !== 'ready');
    if (!planned) return;
    expect(() => routeAutonomousToolCall(call(planned.name))).toThrow(
      /planned but not implemented/,
    );
  });
});

describe('call ids', () => {
  it('derives an id from the outer call when none was supplied', () => {
    const route = routeAutonomousToolCall({ name: 'inspect_timeline' });
    if (route.kind !== 'registry') throw new Error('expected a registry route');
    expect(route.calls[0]?.id).toBe('autonomous-inspect_timeline');
  });

  it('preserves the caller’s id so results can be correlated back', () => {
    expect(routed('inspect_timeline')?.id).toBe('c1');
  });
});
