/**
 * Parity between `TOOL_CLASSIFICATION` and `TOOL_REGISTRY`.
 *
 * This is the drift guard. The tables this module replaced were opt-in allowlists whose
 * default branch silently disabled the run's memory for anything unlisted, and they had
 * fallen behind the registry by a dozen tools. A new tool must now fail CI until somebody
 * decides what it means for the run's memory — that decision can no longer be made by
 * omission.
 */
import { describe, expect, it } from 'vitest';
import {
  TOOL_CLASSIFICATION,
  type ToolEvidenceScope,
  type ToolRole,
  classifyTool,
  factScopeOf,
} from './tool-classification.js';
import { TOOL_REGISTRY } from './tool-registry.js';

const registryNames = TOOL_REGISTRY.map((tool) => tool.name).sort();
const classifiedNames = Object.keys(TOOL_CLASSIFICATION).sort();

describe('TOOL_CLASSIFICATION parity with TOOL_REGISTRY', () => {
  it('classifies every registered tool', () => {
    const missing = registryNames.filter((name) => !(name in TOOL_CLASSIFICATION));
    expect(missing, `unclassified tools — add them to TOOL_CLASSIFICATION`).toEqual([]);
  });

  it('classifies nothing that is not registered', () => {
    const extra = classifiedNames.filter((name) => !registryNames.includes(name));
    expect(extra, `classified tools that no longer exist in TOOL_REGISTRY`).toEqual([]);
  });

  it('agrees with the registry on which tools mutate', () => {
    const disagreements = TOOL_REGISTRY.filter(
      (tool) => tool.mutates !== (TOOL_CLASSIFICATION[tool.name]?.role === 'mutation'),
    ).map((tool) => tool.name);
    expect(disagreements).toEqual([]);
  });

  it('scopes every mutation as timeline-dependent', () => {
    const wrong = Object.entries(TOOL_CLASSIFICATION)
      .filter(([, c]) => c.role === 'mutation' && c.scope !== 'timeline_dependent')
      .map(([name]) => name);
    expect(wrong).toEqual([]);
  });
});

describe('the tools whose misclassification caused the re-analysis loop', () => {
  // Each of these was absent from at least one of the two allowlists this module
  // replaced, which is why a beat-synced run re-ran them after every applied cut.
  const regressions: readonly [string, ToolRole, ToolEvidenceScope][] = [
    ['detect_beats', 'analysis', 'revision_independent'],
    ['index_media', 'analysis', 'revision_independent'],
    ['describe_footage', 'analysis', 'revision_independent'],
    ['find_similar', 'analysis', 'revision_independent'],
    ['list_assets', 'inspection', 'asset_dependent'],
    ['get_project_state', 'inspection', 'timeline_dependent'],
    ['map_time', 'inspection', 'timeline_dependent'],
    ['transcribe', 'analysis', 'transcript_dependent'],
  ];

  it.each(regressions)('%s is %s / %s', (name, role, scope) => {
    expect(classifyTool(name)).toEqual({ role, scope });
  });

  it('keeps a beat map through an applied cut', () => {
    expect(factScopeOf(classifyTool('detect_beats').scope)).toBe('revision_independent');
  });

  it('still ages search_media with the arrangement — it returns clip placements', () => {
    expect(classifyTool('search_media').scope).toBe('timeline_dependent');
  });
});

describe('classifyTool fallback', () => {
  it('derives a floor for an unregistered name', () => {
    expect(classifyTool('some_future_tool', 'analysis')).toEqual({
      role: 'analysis',
      scope: 'revision_independent',
    });
    expect(classifyTool('some_future_tool', 'read')).toEqual({
      role: 'inspection',
      scope: 'timeline_dependent',
    });
    expect(classifyTool('some_future_tool', undefined, true)).toEqual({
      role: 'mutation',
      scope: 'timeline_dependent',
    });
    expect(classifyTool('some_future_tool')).toEqual({
      role: 'other',
      scope: 'timeline_dependent',
    });
  });

  it('prefers the declared classification over the kind-derived floor', () => {
    // `search_media` is an `analysis` kind whose declared scope is deliberately narrower.
    expect(classifyTool('search_media', 'analysis').scope).toBe('timeline_dependent');
  });
});

describe('factScopeOf', () => {
  it('narrows asset/transcript dependence to revision-independent for facts', () => {
    expect(factScopeOf('asset_dependent')).toBe('revision_independent');
    expect(factScopeOf('transcript_dependent')).toBe('revision_independent');
    expect(factScopeOf('revision_independent')).toBe('revision_independent');
    expect(factScopeOf('timeline_dependent')).toBe('timeline_dependent');
  });
});
