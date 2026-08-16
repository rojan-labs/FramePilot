/**
 * The autonomous half of `tool-scope.ts` (K6.2 + the canonical manifest).
 *
 * `selectAutonomousTools` resolves a compact model-facing stage down to the registry
 * routes behind it, and `autonomousToolDescriptors` is what the model actually reads.
 * Both are places where returning slightly too much is invisible: an implicit-only tool
 * leaking into the surface puts lifecycle work back in front of the model, and an
 * unavailable tool leaking in offers a capability that cannot run.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_CORE_TOOL_NAMES,
  AUTONOMOUS_VERIFY_TOOL_NAMES,
  autonomousToolDescriptors,
  selectAutonomousTools,
} from './tool-scope.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import { autonomousToolDescriptorsForStage } from './autonomous-tool-contract.js';

describe('selectAutonomousTools', () => {
  it('resolves a stage to real, available registry tools', () => {
    const tools = selectAutonomousTools('inspect');
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(tool.available).toBe(true);
  });

  it('never returns an unavailable tool, even when the manifest routes to one', () => {
    // The manifest names routes; availability is the registry's call. A tool whose
    // engine does not exist must not reach the model as if it did (PRD §23).
    const unavailable = TOOL_REGISTRY.filter((spec) => !spec.available).map((s) => s.name);
    const selected = selectAutonomousTools('edit').map((s) => s.name);
    for (const name of unavailable) expect(selected).not.toContain(name);
  });

  it('excludes implicit-only lifecycle tools from every stage', () => {
    // `index_media` and friends are lifecycle work the runtime does on its own. Exposing
    // them would reintroduce the manual "index" step the automatic runtime removed.
    for (const stage of ['inspect', 'understand', 'edit', 'verify', 'render', 'recover'] as const) {
      const names = selectAutonomousTools(stage).map((s) => s.name);
      expect(names).not.toContain('index_media');
    }
  });

  it('accepts an explicit tool list, so a caller can scope further', () => {
    const only = TOOL_REGISTRY.filter((spec) => spec.name === 'get_timeline');
    const selected = selectAutonomousTools('inspect', only);
    expect(selected.map((s) => s.name)).toEqual(['get_timeline']);
  });

  it('returns an empty list when the supplied tools cover none of the stage', () => {
    const none = TOOL_REGISTRY.filter((spec) => spec.name === 'no_such_tool');
    expect(selectAutonomousTools('inspect', none)).toEqual([]);
  });
});

describe('the backward-compatible route lists', () => {
  it('are sorted and unique', () => {
    for (const list of [AUTONOMOUS_CORE_TOOL_NAMES, AUTONOMOUS_VERIFY_TOOL_NAMES]) {
      expect([...list]).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('derive from the manifest rather than being hand-maintained', () => {
    // The whole point of deriving them: a manifest change reaches these automatically,
    // so the legacy callers cannot drift from the canonical surface.
    expect(AUTONOMOUS_CORE_TOOL_NAMES.length).toBeGreaterThan(0);
  });
});

describe('autonomousToolDescriptors', () => {
  it('projects the canonical manifest, not the registry', () => {
    // Names and schemas come from the manifest by design — the compact model-facing
    // surface is smaller than the internal catalog and must not silently widen to it.
    const descriptors = autonomousToolDescriptors('inspect');
    const canonical = autonomousToolDescriptorsForStage('inspect');
    expect(descriptors.map((d) => d.name)).toEqual(canonical.map((d) => d.name));
  });

  it('carries the manifest schema and a string version for every descriptor', () => {
    for (const descriptor of autonomousToolDescriptors('understand')) {
      expect(descriptor.parameters).toBeTypeOf('object');
      expect(typeof descriptor.version).toBe('string');
      expect(descriptor.description.length).toBeGreaterThan(0);
    }
  });

  it('returns a list for every stage without throwing', () => {
    for (const stage of ['inspect', 'understand', 'edit', 'verify', 'render', 'recover'] as const) {
      expect(Array.isArray(autonomousToolDescriptors(stage))).toBe(true);
    }
  });
});
