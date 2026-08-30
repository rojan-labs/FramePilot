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

/**
 * `analysis` + `timeline_dependent` is a self-contradictory pair, and it has now
 * shipped three times.
 *
 * `stageAllowsRole` withholds every `analysis` tool in an execution stage, on the
 * stated premise that its evidence is already stored and can be recalled instead.
 * `EvidenceStore.invalidate` drops every `timeline_dependent` payload — from both
 * `byKey` and `byId`, so the `recall_evidence` handle dies with it — on every
 * applied patch. A tool carrying both labels is therefore unreadable AND
 * unrecallable in exactly the situation that makes a re-read legitimate: the cut
 * just changed the answer.
 *
 * `get_frame` was patched for this by name (`VERIFICATION_LOOK_TOOL_NAMES`), then
 * `get_mapped_transcript` hit it again in run 7d159862 and cost 16 model calls.
 * Listing the pair here does not fix it — it forces the next one to be a decision
 * somebody wrote down rather than a label nobody questioned.
 */
describe('analysis tools whose answer ages with the timeline', () => {
  // Every entry is a deliberate, reviewed choice. Adding a tool here means: it is
  // acceptable that an execution stage can neither call it nor recall it.
  const KNOWN: ReadonlySet<string> = new Set([
    // Exempted by name in `VERIFICATION_LOOK_TOOL_NAMES` — reachable in every stage.
    'get_frame',
    // Genuinely expensive sidecar work whose result the run is expected to gather
    // before it starts cutting. Each remains a candidate for the same exemption if
    // a run is ever observed needing it mid-apply.
    'search_media',
    'read_edit_signals',
    'measure_color',
    'track_subject_automatically',
  ]);

  it('has no unreviewed member', () => {
    const pairs = Object.entries(TOOL_CLASSIFICATION)
      .filter(([, c]) => c.role === 'analysis' && c.scope === 'timeline_dependent')
      .map(([name]) => name)
      .filter((name) => !KNOWN.has(name));
    expect(
      pairs,
      'these tools can be neither called nor recalled once a patch lands — ' +
        'reclassify as `inspection` if they read the arrangement, or add them to ' +
        'KNOWN with the reason',
    ).toEqual([]);
  });

  it('keeps get_mapped_transcript readable while the run is cutting', () => {
    // It derives which words SURVIVED and where they now sit — the arrangement,
    // not the media — and captions/emphasis cannot be written without it.
    expect(TOOL_CLASSIFICATION.get_mapped_transcript).toEqual({
      role: 'inspection',
      scope: 'timeline_dependent',
    });
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
