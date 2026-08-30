import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY } from '@framepilot/ai-sdk';
import {
  SESSION_TOOLS,
  UI_INDEPENDENT_HOST_TOOLS,
  buildMcpTools,
  getSessionTool,
  servableOverMcp,
} from './tools.js';

describe('buildMcpTools (registry → MCP auto-sync)', () => {
  const tools = buildMcpTools();
  const names = new Set(tools.map((t) => t.name));

  it('exposes every AVAILABLE registry tool this surface can actually serve', () => {
    for (const tool of TOOL_REGISTRY.filter((t) => t.available && !t.hostUiOnly)) {
      expect(names.has(tool.name)).toBe(true);
    }
  });

  it('advertises EXACTLY the orchestrator-invocable registry set (full parity, no drift)', () => {
    // The orchestrator and the MCP session both invoke tools via the same registry
    // `available` gate, so the MCP registry surface must equal the available set —
    // no more (would fake capability), no less (would hide a tool the agent can use).
    // The one exception is `hostUiOnly`, and it is the same principle rather than a hole
    // in it: those tools need a human looking at FramePilot's own UI, which this surface
    // does not have. Advertising `ask_user` here would promise a question nobody could
    // ever answer.
    const sessionNames = new Set(SESSION_TOOLS.map((t) => t.name));
    const mcpRegistryTools = [...names].filter((name) => !sessionNames.has(name)).sort();
    const availableRegistry = TOOL_REGISTRY.filter(servableOverMcp)
      .map((t) => t.name)
      .sort();
    expect(mcpRegistryTools).toEqual(availableRegistry);
  });

  it('does NOT expose a host-UI-only tool (no UI here to ask through)', () => {
    // Concrete guard, not just the abstract set test above: an MCP client is itself an
    // agent with its own user — if it wants to ask something it asks them directly.
    const uiDependent = TOOL_REGISTRY.filter(
      (t) => t.hostUiOnly && !UI_INDEPENDENT_HOST_TOOLS.has(t.name),
    );
    expect(uiDependent.map((t) => t.name)).toContain('ask_user'); // guard the test is meaningful
    for (const tool of uiDependent) expect(names.has(tool.name)).toBe(false);
  });

  it('serves the host-resolved tools that need no UI state', () => {
    // `hostUiOnly` carries two meanings: "needs live editor interaction state" (why
    // MCP refuses) and "not mirrored into the Python sidecar" (why engine parity
    // skips). `caption_the_edit` is only the second — pure computation over the
    // project, excluded from the mirror solely because caption segmentation must
    // have one authority (ADR 0071). Refusing it here would push MCP clients back
    // onto add_caption_layer one cue at a time, the failure it exists to remove.
    for (const name of UI_INDEPENDENT_HOST_TOOLS) {
      const tool = TOOL_REGISTRY.find((t) => t.name === name);
      expect(tool, `${name} must still be a registered tool`).toBeDefined();
      expect(tool?.hostUiOnly).toBe(true);
      expect(names.has(name)).toBe(true);
    }
  });

  it('auto-exposes newly-added registry tools (e.g. set_track_flags)', () => {
    // Concrete guard: a tool added to the registry must appear over MCP with no
    // hand-editing here — proves the auto-sync, not just the abstract set test.
    expect(names.has('set_track_flags')).toBe(true);
  });

  it('exposes the visual grounding tools (MI6.1)', () => {
    // search_visual/describe_footage/index_media are analysis-kind tools an external
    // agent can drive over MCP, so they must ride the auto-synced surface.
    for (const name of ['search_visual', 'describe_footage', 'index_media']) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('does NOT expose unavailable registry tools (build-order invariant)', () => {
    const unavailable = TOOL_REGISTRY.filter((t) => !t.available);
    expect(unavailable.length).toBeGreaterThan(0); // guard the test is meaningful
    for (const tool of unavailable) {
      expect(names.has(tool.name)).toBe(false);
    }
  });

  it('reuses the registry JSON Schema verbatim (no drift)', () => {
    for (const descriptor of tools) {
      const registered = TOOL_REGISTRY.find((t) => t.name === descriptor.name);
      if (registered) expect(descriptor.inputSchema).toEqual(registered.parameters);
      expect(descriptor.inputSchema.type).toBe('object');
    }
  });

  it('exposes the session tools', () => {
    for (const tool of SESSION_TOOLS) expect(names.has(tool.name)).toBe(true);
  });
});

describe('getSessionTool', () => {
  it('finds a known session tool and returns undefined otherwise', () => {
    expect(getSessionTool('open_project')?.name).toBe('open_project');
    expect(getSessionTool('trim_clip')).toBeUndefined();
  });
});
