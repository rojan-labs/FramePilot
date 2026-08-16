import { describe, expect, it } from 'vitest';
import { AutonomousToolRouteError, routeAutonomousToolCall } from './autonomous-tool-router.js';

describe('routeAutonomousToolCall', () => {
  it('aliases compact inspection and frame calls to existing registry tools', () => {
    expect(routeAutonomousToolCall({ name: 'inspect_project' })).toEqual({
      kind: 'registry',
      calls: [
        {
          id: 'autonomous-inspect_project',
          name: 'get_project_state',
          arguments: {},
        },
      ],
    });
    expect(
      routeAutonomousToolCall({ id: 'call-1', name: 'get_frame', arguments: { time: 2.5 } }),
    ).toEqual({
      kind: 'registry',
      calls: [{ id: 'call-1', name: 'get_frame', arguments: { timeSeconds: 2.5 } }],
    });
  });

  it('routes every search mode without exposing manual indexing', () => {
    expect(
      routeAutonomousToolCall({
        name: 'search_media',
        arguments: { mode: 'keyword', query: 'launch', limit: 4 },
      }),
    ).toMatchObject({ kind: 'registry', calls: [{ name: 'search_media' }] });
    expect(
      routeAutonomousToolCall({
        name: 'search_media',
        arguments: { mode: 'semantic', query: 'excited reaction' },
      }),
    ).toMatchObject({ kind: 'registry', calls: [{ name: 'find_similar' }] });
    expect(
      routeAutonomousToolCall({
        name: 'search_media',
        arguments: {
          mode: 'visual',
          query: 'product close-up',
          assetIds: ['asset-1'],
          timeRange: [1, 4],
        },
      }),
    ).toMatchObject({ kind: 'registry', calls: [{ name: 'search_visual' }] });
    expect(
      routeAutonomousToolCall({
        name: 'search_media',
        arguments: { mode: 'describe', assetIds: ['asset-1'] },
      }),
    ).toMatchObject({ kind: 'registry', calls: [{ name: 'describe_footage' }] });
    expect(
      routeAutonomousToolCall({ name: 'search_media', arguments: { mode: 'map' } }),
    ).toMatchObject({ kind: 'registry', calls: [{ name: 'map_footage' }] });
  });

  it('routes one analysis contract to the correct deterministic analyzer', () => {
    expect(
      routeAutonomousToolCall({
        name: 'analyze_media',
        arguments: {
          kind: 'silence',
          assetId: 'asset-1',
          options: { minSilenceSeconds: 0.4 },
        },
      }),
    ).toEqual({
      kind: 'registry',
      calls: [
        {
          id: 'autonomous-analyze_media',
          name: 'analyze_silence',
          arguments: { minSilenceSeconds: 0.4, assetId: 'asset-1' },
        },
      ],
    });
  });

  it('forces the correct scope on the two compact proposal surfaces', () => {
    const timeline = routeAutonomousToolCall({
      name: 'propose_timeline_patch',
      arguments: {
        reason: 'Trim the opening',
        evidenceIds: ['ev-1'],
        operations: [{ tool: 'trim_clip', arguments: { clipId: 'clip-a', start: 0, end: 3 } }],
      },
    });
    expect(timeline).toMatchObject({
      kind: 'proposal',
      proposal: { scope: 'timeline', reason: 'Trim the opening' },
    });

    const project = routeAutonomousToolCall({
      name: 'propose_project_patch',
      arguments: {
        reason: 'Organize assets',
        operations: [{ tool: 'manage_assets', arguments: { strategy: 'by-kind' } }],
      },
    });
    expect(project).toMatchObject({
      kind: 'proposal',
      proposal: { scope: 'project', reason: 'Organize assets' },
    });
  });

  it('separates registry verification from runtime completion checks', () => {
    expect(
      routeAutonomousToolCall({
        name: 'verify_result',
        arguments: { checks: ['captions', 'transitions', 'duration', 'visual', 'render'] },
      }),
    ).toEqual({
      kind: 'verification',
      calls: [
        {
          id: 'autonomous-verify_result-captions',
          name: 'verify_captions',
          arguments: {},
        },
        {
          id: 'autonomous-verify_result-transitions',
          name: 'verify_transitions',
          arguments: {},
        },
      ],
      runtimeChecks: ['duration', 'visual', 'render'],
    });
  });

  it('refuses planned capabilities instead of advertising a fake route', () => {
    expect(() =>
      routeAutonomousToolCall({
        name: 'probe_media',
        arguments: { assetId: 'asset-1' },
      }),
    ).toThrow(AutonomousToolRouteError);
    try {
      routeAutonomousToolCall({ name: 'probe_media', arguments: { assetId: 'asset-1' } });
    } catch (error) {
      expect(error).toMatchObject({ code: 'tool_not_ready', toolName: 'probe_media' });
    }
  });

  it('rejects missing required mode-specific arguments', () => {
    expect(() =>
      routeAutonomousToolCall({
        name: 'search_media',
        arguments: { mode: 'visual' },
      }),
    ).toThrow('visual search requires a non-empty query');
  });
});
