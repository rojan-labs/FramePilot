/** Tests for tool metadata, implicit lifecycle tools, and scoped descriptors. */
import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, type ToolSpec } from './tool-registry.js';
import { MockProvider } from './providers/mock.js';
import { Orchestrator } from './orchestrator.js';
import type { RunStage } from './kernel/working-state.js';
import {
  IMPLICIT_ONLY_TOOL_NAMES,
  type ToolScope,
  scopedToolDescriptors,
  selectTools,
  toolMetadata,
} from './tool-scope.js';

describe('toolMetadata', () => {
  it('derives sensible defaults per kind for the real registry', () => {
    const read = toolMetadata(TOOL_REGISTRY.find((tool) => tool.name === 'get_timeline')!);
    expect(read.permissions).toEqual(['read']);
    expect(read.version).toBe('1');
    expect(read.cost).toBe('low');

    const mutate = toolMetadata(TOOL_REGISTRY.find((tool) => tool.name === 'trim_clip')!);
    expect(mutate.permissions).toEqual(['read', 'write']);

    const analysis = toolMetadata(TOOL_REGISTRY.find((tool) => tool.name === 'analyze_silence')!);
    expect(analysis.permissions).toEqual(['analysis']);
    expect(analysis.latency).toBe('slow');

    const action = toolMetadata(TOOL_REGISTRY.find((tool) => tool.name === 'export_video')!);
    expect(action.permissions).toEqual(['render']);
    expect(action.cost).toBe('high');
  });

  it('honours a tool that declares its own metadata', () => {
    const tool = {
      name: 't',
      kind: 'read',
      version: '3',
      capabilities: ['captions'],
      permissions: ['read'],
      cost: 'medium',
      latency: 'medium',
    } as unknown as ToolSpec;
    expect(toolMetadata(tool)).toEqual({
      version: '3',
      capabilities: ['captions'],
      permissions: ['read'],
      cost: 'medium',
      latency: 'medium',
    });
  });
});

describe('selectTools', () => {
  it('a read-only scope excludes write, render, and analysis tools', () => {
    const readOnly = selectTools({ permissions: ['read'] });
    expect(
      readOnly.every((tool) =>
        toolMetadata(tool).permissions.every((permission) => permission === 'read'),
      ),
    ).toBe(true);
    expect(readOnly.every((tool) => tool.kind === 'read' || tool.kind === 'ask')).toBe(true);
    expect(readOnly.some((tool) => tool.name === 'trim_clip')).toBe(false);
    expect(readOnly.some((tool) => tool.name === 'ask_user')).toBe(true);
  });

  it('a write scope admits mutating tools but excludes analysis and render', () => {
    const editing = selectTools({ permissions: ['read', 'write'] });
    expect(editing.some((tool) => tool.name === 'trim_clip')).toBe(true);
    expect(editing.some((tool) => tool.name === 'analyze_silence')).toBe(false);
  });

  it('keeps only tools that share a requested capability', () => {
    const analysis = selectTools({ capabilities: ['analysis'] });
    expect(analysis.map((tool) => tool.name).sort()).toEqual(
      [
        'analyze_silence',
        'detect_beats',
        'detect_scenes',
        'search_media',
        'find_similar',
        'search_visual',
        'describe_footage',
        'map_footage',
        'read_edit_signals',
        'session_context',
        'transcribe',
        // Host-backed like `transcribe`: the model asks, the trusted host does the
        // network, and the orchestrator turns the result into a validated patch.
        'search_music',
        'add_music',
      ].sort(),
    );
  });

  it('keeps visual grounding tools but never advertises manual indexing', () => {
    expect(IMPLICIT_ONLY_TOOL_NAMES).toEqual(['index_media']);
    const visual = selectTools({ capabilities: ['visual'] });
    expect(visual.map((tool) => tool.name).sort()).toEqual(
      ['describe_footage', 'map_footage', 'read_edit_signals', 'search_visual'].sort(),
    );
    expect(
      selectTools({ permissions: ['analysis'] }).some((tool) => tool.name === 'index_media'),
    ).toBe(false);
  });

  it('withholds implicit-only tools from EVERY model-facing agent scope', () => {
    // The gap this closes: the contract was asserted here and thrown over in
    // `autonomous-tool-contract.ts`, but the filter lived only in `selectTools` — so
    // `agentTools`, the one surface with a live editor in front of it, offered `index_media`
    // as an ordinary call. A model could start a paced, billable indexing job inside a run
    // whose budget and cancellation semantics assumed it could not.
    const orchestrator = new Orchestrator(new MockProvider());
    const stages: readonly RunStage[] = [
      'interpret',
      'inspect',
      'analyze',
      'plan',
      'apply',
      'verify',
      'complete',
    ];
    const surfaces = [
      orchestrator.agentTools('agent'),
      orchestrator.agentTools('question'),
      orchestrator.agentTools('action-recovery'),
      ...stages.map((stage) => orchestrator.agentTools('agent', stage)),
    ];
    for (const surface of surfaces) {
      for (const implicit of IMPLICIT_ONLY_TOOL_NAMES) {
        expect(surface.map((tool) => tool.name)).not.toContain(implicit);
      }
    }
  });

  it('lets explicit orchestrator setup select an implicit-only tool by name', () => {
    expect(selectTools({ names: ['index_media'] }).map((tool) => tool.name)).toEqual([
      'index_media',
    ]);
  });

  it('uses names as an explicit allowlist while availability remains gated', () => {
    expect(
      selectTools({ names: ['trim_clip', 'get_timeline'] })
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['get_timeline', 'trim_clip']);
    expect(selectTools({ names: ['generate_mask'] })).toHaveLength(0);
    expect(selectTools({ names: ['generate_mask'], includeUnavailable: true })).toHaveLength(1);
  });
});

function syntheticTools(count: number, capabilities: string[]): ToolSpec[] {
  return Array.from({ length: count }, (_, index) => {
    const capability = capabilities[index % capabilities.length]!;
    return {
      name: `synthetic_${capability}_${String(index)}`,
      description: `Synthetic ${capability} tool #${String(index)} with a deliberately verbose description.`,
      mutates: false,
      available: true,
      kind: 'read',
      capabilities: [capability],
      permissions: ['read'],
      parameters: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
      },
      parse: (value: unknown) => value,
    } as unknown as ToolSpec;
  });
}

const promptSize = (scope: ToolScope, tools: ToolSpec[]): number =>
  JSON.stringify(scopedToolDescriptors(scope, tools)).length;

describe('scoped descriptor scale', () => {
  const capabilities = ['captions', 'audio', 'color', 'motion', 'assets', 'render'];

  it('keeps an explicit one-tool prompt flat as the registry grows', () => {
    const small = syntheticTools(120, capabilities);
    const large = syntheticTools(600, capabilities);
    const scope: ToolScope = { capabilities: ['captions'] };
    expect(selectTools(scope, small)).toHaveLength(20);
    expect(selectTools(scope, large)).toHaveLength(100);

    const oneName: ToolScope = { names: ['synthetic_captions_0'] };
    expect(promptSize(oneName, small)).toBe(promptSize(oneName, large));
  });

  it('makes a capability prompt much smaller than the full read registry', () => {
    const tools = syntheticTools(120, capabilities);
    const full = promptSize({ permissions: ['read'] }, tools);
    const scoped = promptSize({ capabilities: ['captions'] }, tools);
    expect(scoped).toBeLessThan(full / 4);
  });
});
