/** Tests for internal and compact autonomous tool display metadata. */
import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_TOOL_MANIFEST, TOOL_REGISTRY } from '@framepilot/ai-sdk';
import { TOOL_META, isToolAvailable, toolMeta } from './toolMeta.js';

describe('toolMeta', () => {
  it('maps every internal registry and canonical autonomous tool', () => {
    const unmappedRegistry = TOOL_REGISTRY.filter((tool) => !(tool.name in TOOL_META)).map(
      (tool) => tool.name,
    );
    const unmappedAutonomous = AUTONOMOUS_TOOL_MANIFEST.tools
      .filter((tool) => !(tool.name in TOOL_META))
      .map((tool) => tool.name);

    expect(unmappedRegistry).toEqual([]);
    expect(unmappedAutonomous).toEqual([]);
  });

  it('returns a label and icon for known tools and a humanized extension fallback', () => {
    expect(toolMeta('delete_range').label).toBe('Delete range');
    expect(toolMeta('propose_timeline_patch').label).toBe('Propose timeline edit');
    expect(toolMeta('totally_unknown').label).toBe('Totally unknown');
    expect(typeof toolMeta('delete_range').Icon).toBe('object');
  });

  it('reports readiness from the matching registry or autonomous contract', () => {
    expect(isToolAvailable('delete_range')).toBe(true);
    expect(isToolAvailable('detect_faces')).toBe(false);
    expect(isToolAvailable('inspect_project')).toBe(true);
    expect(isToolAvailable('probe_media')).toBe(false);
    // An unknown extension tool is assumed available because no contract gates it.
    expect(isToolAvailable('custom_tool')).toBe(true);
  });
});
