import { describe, expect, it } from 'vitest';
import { toolContract } from './tool-contract.js';
import { getTool, TOOL_REGISTRY } from './tool-registry.js';
import { classifyTool } from './tool-classification.js';
import { QUESTION_ROUTE_PERMISSIONS, selectTools } from './tool-scope.js';

const contract = (name: string) => {
  const tool = getTool(name);
  if (!tool) throw new Error(`missing test tool ${name}`);
  return toolContract(tool);
};

describe('first-class tool execution contracts', () => {
  it('classifies transcribe as a serial host mutation requiring write permission', () => {
    expect(contract('transcribe')).toEqual({
      executionPlane: 'host',
      effectClass: 'mutation',
      permissions: ['analysis', 'write'],
      concurrency: 'serial',
      stateDependency: 'asset_content',
      cacheScope: 'none',
    });
  });

  it('classifies index_media as a serial host mutation with no cache', () => {
    expect(contract('index_media')).toMatchObject({
      executionPlane: 'host',
      effectClass: 'mutation',
      permissions: ['analysis', 'write'],
      concurrency: 'serial',
      stateDependency: 'asset_content',
      cacheScope: 'none',
    });
  });

  it.each(['get_frame', 'measure_color'])(
    'ties %s to the current project revision but never memoizes it',
    (name) => {
      // `stateDependency` and `cacheScope` say different things here, deliberately. The
      // result DEPENDS on the timeline, but `Timeline.revision` is a mapping counter that
      // stands still through every picture-only edit, so it cannot be used as the memo
      // key for a picture measurement — see the declaration's own note.
      expect(contract(name)).toEqual({
        executionPlane: 'host',
        effectClass: 'pure_read',
        permissions: ['analysis'],
        concurrency: 'parallel',
        stateDependency: 'project_revision',
        cacheScope: 'none',
      });
    },
  );

  it('never memoizes search_media, whose answer depends on the asset bin', () => {
    // The bin is not the timeline. `add_asset` / `manage_assets` / `index_media` change
    // what this tool can find and none of them moves `Timeline.revision` (project
    // operations never reach `applyOperation`'s mapping bump), so a `project_revision`
    // memo would serve the pre-import answer to a run that just imported the file.
    expect(contract('search_media')).toEqual({
      executionPlane: 'host',
      effectClass: 'pure_read',
      permissions: ['analysis'],
      concurrency: 'parallel',
      stateDependency: 'project_revision',
      cacheScope: 'none',
    });
  });

  it('memoizes only tools whose answer no edit can reach', () => {
    // A class-level pin, not a spot check. Three separate tools (`get_frame`,
    // `measure_color`, `search_media`) each shipped a stale-answer bug by inheriting a
    // memo keyed on `Timeline.revision` — a MAPPING counter that advances only when clip
    // timing moves (`editor-core/operations.ts#mappingChanged`) and is blind to colour
    // grades, effects, masks and every project-level bin operation. Each was found from
    // the outside, after a run reasoned about the timeline it had before its own edit.
    //
    // The rule now: a cacheable tool must be `revision_independent` — describing source
    // material, which invariant 1 says no edit can change. Anything a run can move under
    // its own question runs fresh.
    const cacheable = TOOL_REGISTRY.filter((tool) => toolContract(tool).cacheScope !== 'none');
    for (const tool of cacheable) {
      expect({ [tool.name]: classifyTool(tool.name, tool.kind, tool.mutates).scope }).toEqual({
        [tool.name]: 'revision_independent',
      });
    }
    // Guard against the assertion above passing because nothing is cacheable at all — the
    // per-run memo on the catalogue searches is load-bearing (metered provider quotas).
    expect(cacheable.map((tool) => tool.name)).toContain('search_music');
  });

  it('never caches export actions', () => {
    expect(contract('export_video')).toMatchObject({
      executionPlane: 'host',
      effectClass: 'action',
      permissions: ['render'],
      concurrency: 'serial',
      stateDependency: 'project_revision',
      cacheScope: 'none',
    });
  });

  it('keeps ordinary in-process reads parallel but revision-dependent', () => {
    expect(contract('get_timeline')).toMatchObject({
      executionPlane: 'in_process',
      effectClass: 'pure_read',
      permissions: ['read'],
      concurrency: 'parallel',
      stateDependency: 'project_revision',
      cacheScope: 'none',
    });
  });
});
/**
 * The invariant that would have caught `add_music`/`add_stock` shipping as pure reads.
 *
 * `mutates` cannot be the detector here — an `analysisTool` always sets it false, and a
 * sourcing tool that downloads a file and places a clip is exactly the case where that
 * flag lies. So `analysis`-kind tools are classified EXHAUSTIVELY, the same way
 * `tool-classification.ts` fixed the identical drift for run memory: a new analysis tool
 * appears in neither set, the exhaustiveness assertion fails, and somebody has to decide
 * whether it changes project state before it can ship.
 *
 * Getting this wrong is not cosmetic. A missing `write` puts the tool inside
 * `QUESTION_ROUTE_PERMISSIONS` (`['read','analysis']`), so a turn that cannot apply ops
 * still advertises it; a non-`none` cacheScope lets a memoized placement replay a stale
 * edit as fresh; `parallel` lets it overlap other work against the live timeline.
 */
describe('analysis-kind tools are exhaustively classified by project-state effect', () => {
  /** Host-backed ANALYSIS tools that nonetheless change project state. */
  const MUTATING = [
    'remove_silences',
    'add_music',
    'add_stock',
    'index_media',
    'track_subject_automatically',
    'transcribe',
  ];

  /** Host-backed ANALYSIS tools that only measure and report. */
  const READ_ONLY = [
    'analyze_silence',
    'describe_footage',
    'detect_beats',
    'detect_scenes',
    'detect_subjects',
    'find_similar',
    'get_frame',
    'map_footage',
    'measure_color',
    'search_media',
    'search_music',
    'search_stock',
    'search_visual',
    'session_context',
  ];

  const analysisToolNames = TOOL_REGISTRY.filter((tool) => tool.kind === 'analysis')
    .map((tool) => tool.name)
    .sort();

  it('classifies every analysis tool exactly once', () => {
    expect([...MUTATING, ...READ_ONLY].sort()).toEqual(analysisToolNames);
  });

  it.each(MUTATING)('%s declares a serial, uncacheable, write-permitted mutation', (name) => {
    const resolved = contract(name);
    expect(resolved.effectClass).toBe('mutation');
    expect(resolved.permissions).toContain('write');
    expect(resolved.concurrency).toBe('serial');
    expect(resolved.cacheScope).toBe('none');
  });

  it.each(READ_ONLY)('%s stays a pure read and never gains write permission', (name) => {
    const resolved = contract(name);
    expect(resolved.effectClass).toBe('pure_read');
    expect(resolved.permissions).not.toContain('write');
  });

  it('keeps every state-changing tool off the question route', () => {
    const questionRoute = new Set(
      selectTools({ permissions: [...QUESTION_ROUTE_PERMISSIONS] }).map((tool) => tool.name),
    );
    for (const name of MUTATING) expect(questionRoute.has(name)).toBe(false);
  });
});
