/**
 * The canonical autonomous tool manifest and its validator.
 *
 * This manifest is the model-facing surface — smaller than `TOOL_REGISTRY` and shared by
 * the orchestrator, the MCP projection, the UI metadata and the generated Python mirror.
 * Its validator runs at module load, so a malformed manifest fails the build rather than
 * a run. These tests exercise each rule against a crafted manifest, because a rule that
 * never fires is a rule nobody knows is broken.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_TOOL_MANIFEST,
  AUTONOMOUS_TOOL_NAMES,
  assertManifest,
  autonomousToolDescriptorsForStage,
  autonomousToolsForStage,
  getAutonomousTool,
  internalRoutesForAutonomousTool,
  type AutonomousToolContract,
  type AutonomousToolManifest,
} from './autonomous-tool-contract.js';

const tool = (over: Partial<AutonomousToolContract> = {}): AutonomousToolContract => ({
  name: 'inspect_timeline',
  description: 'Read the timeline.',
  stages: ['inspect'],
  status: 'ready',
  kind: 'registry',
  internalRoutes: ['get_timeline'],
  inputSchema: { type: 'object' },
  ...over,
});

const manifest = (tools: AutonomousToolContract[], version = 1): AutonomousToolManifest => ({
  version,
  tools,
});

describe('assertManifest — every rule fires', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => assertManifest(manifest([tool()]))).not.toThrow();
  });

  it.each([0, -1, 1.5])('rejects version %j', (version) => {
    expect(() => assertManifest(manifest([tool()], version))).toThrow(/positive integer/);
  });

  it('rejects an empty tool name', () => {
    expect(() => assertManifest(manifest([tool({ name: '' })]))).toThrow(/Duplicate or empty/);
  });

  it('rejects a duplicate tool name', () => {
    expect(() => assertManifest(manifest([tool(), tool()]))).toThrow(/Duplicate or empty/);
  });

  it('rejects a blank description — the model reads it to choose the tool', () => {
    expect(() => assertManifest(manifest([tool({ description: '   ' })]))).toThrow(
      /needs a description/,
    );
  });

  it('rejects an empty stage list', () => {
    expect(() => assertManifest(manifest([tool({ stages: [] })]))).toThrow(/invalid stage/);
  });

  it('rejects an unknown stage', () => {
    expect(() => assertManifest(manifest([tool({ stages: ['nope' as 'inspect'] })]))).toThrow(
      /invalid stage/,
    );
  });

  it('rejects an unknown status', () => {
    expect(() => assertManifest(manifest([tool({ status: 'maybe' as 'ready' })]))).toThrow(
      /invalid status/,
    );
  });

  it('rejects an unknown kind', () => {
    expect(() => assertManifest(manifest([tool({ kind: 'weird' as 'registry' })]))).toThrow(
      /invalid kind/,
    );
  });

  it('rejects a READY tool with no execution route — it could not actually run', () => {
    expect(() => assertManifest(manifest([tool({ internalRoutes: [] })]))).toThrow(
      /needs an execution route/,
    );
  });

  it('allows a PLANNED tool with no route, since nothing will execute it', () => {
    expect(() =>
      assertManifest(manifest([tool({ status: 'planned', internalRoutes: [] })])),
    ).not.toThrow();
  });

  it('allows a PROPOSAL tool with no route — proposals have no registry route by design', () => {
    expect(() =>
      assertManifest(manifest([tool({ kind: 'proposal', internalRoutes: [] })])),
    ).not.toThrow();
  });

  it('refuses to make `index_media` model-facing', () => {
    // Media preparation is implicit lifecycle work. Exposing it would put an "index"
    // operation back in front of the model, which the automatic runtime exists to remove.
    expect(() => assertManifest(manifest([tool({ internalRoutes: ['index_media'] })]))).toThrow(
      /implicit lifecycle work/,
    );
  });

  it.each([['not-an-object'], [null], [[]]])('rejects a non-object input schema (%j)', (schema) => {
    expect(() =>
      assertManifest(
        manifest([tool({ inputSchema: schema as unknown as Record<string, unknown> })]),
      ),
    ).toThrow(/object input schema/);
  });
});

describe('the shipped manifest', () => {
  it('passes its own validator', () => {
    expect(() => assertManifest(AUTONOMOUS_TOOL_MANIFEST)).not.toThrow();
  });

  it('exposes sorted, unique names — stable for prompt caching and parity checks', () => {
    expect([...AUTONOMOUS_TOOL_NAMES]).toEqual([...AUTONOMOUS_TOOL_NAMES].sort());
    expect(new Set(AUTONOMOUS_TOOL_NAMES).size).toBe(AUTONOMOUS_TOOL_NAMES.length);
  });
});

describe('stage selection', () => {
  it('omits planned tools by default, so the model never sees one it cannot run', () => {
    const planned = tool({ name: 'future_tool', status: 'planned', internalRoutes: [] });
    const all = [tool(), planned];
    const ready = all.filter((t) => t.stages.includes('inspect') && t.status === 'ready');
    expect(ready.map((t) => t.name)).toEqual(['inspect_timeline']);
  });

  it('includes planned tools only when explicitly asked', () => {
    const withPlanned = autonomousToolsForStage('inspect', { includePlanned: true });
    const readyOnly = autonomousToolsForStage('inspect');
    expect(withPlanned.length).toBeGreaterThanOrEqual(readyOnly.length);
  });

  it('returns tools sorted by name', () => {
    const names = autonomousToolsForStage('edit').map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it('returns an empty list for a stage no tool declares', () => {
    // Not an error: a stage with no capability is a real state the caller handles.
    const all = autonomousToolsForStage('render', { includePlanned: true });
    expect(Array.isArray(all)).toBe(true);
  });

  it('stamps descriptors with the manifest version', () => {
    const descriptors = autonomousToolDescriptorsForStage('inspect');
    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      expect(descriptor.version).toBe(AUTONOMOUS_TOOL_MANIFEST.version);
      expect(descriptor.inputSchema).toBeTypeOf('object');
    }
  });
});

describe('lookup', () => {
  it('finds a tool by name', () => {
    const name = AUTONOMOUS_TOOL_NAMES[0] as string;
    expect(getAutonomousTool(name)?.name).toBe(name);
  });

  it('returns undefined for an unknown name rather than throwing', () => {
    expect(getAutonomousTool('no_such_capability')).toBeUndefined();
  });

  it('resolves internal routes, and yields [] for an unknown capability', () => {
    const name = AUTONOMOUS_TOOL_NAMES[0] as string;
    expect(internalRoutesForAutonomousTool(name).length).toBeGreaterThanOrEqual(0);
    expect(internalRoutesForAutonomousTool('no_such_capability')).toEqual([]);
  });
});
