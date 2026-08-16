/** Tests for the PlanCompiler (kernel/plan-compiler.ts, Phase K3.1). */
import { describe, expect, it } from 'vitest';
import { compilePlan } from './plan-compiler.js';

describe('compilePlan', () => {
  it('assigns T{n} ids in order and fills resource/priority defaults', () => {
    const g = compilePlan({
      steps: [
        { label: 'read', effect: { kind: 'host_tool', name: 'get_transcript' } },
        { label: 'edit', effect: { kind: 'patch', name: 'assemble_patch' }, deps: ['T1'] },
      ],
    });
    expect(g.nodes.map((n) => n.id)).toEqual(['T1', 'T2']);
    expect(g.byId.get('T1')).toMatchObject({ resource: 'host', priority: 'edit' });
    expect(g.byId.get('T2')?.resource).toBe('pure'); // patch → pure
    expect(g.byId.get('T2')?.effect.args).toEqual({ from: 'T1' });
  });

  it('honours explicit ids, resource, and priority overrides', () => {
    const g = compilePlan({
      steps: [
        {
          id: 'analyze',
          label: 'a',
          effect: { kind: 'host_tool', name: 'analyze_silence' },
          resource: 'ffmpeg',
          priority: 'analysis',
        },
      ],
    });
    expect(g.byId.get('analyze')).toMatchObject({ resource: 'ffmpeg', priority: 'analysis' });
  });

  it('defaults model/analysis/verify resource classes by effect kind', () => {
    const g = compilePlan({
      steps: [
        { label: 'm', effect: { kind: 'model', name: 'planner' } },
        { label: 'a', effect: { kind: 'analysis', name: 'synth' } },
        { label: 'v', effect: { kind: 'verify', name: 'verify' } },
      ],
    });
    expect(g.nodes.map((n) => n.resource)).toEqual(['model', 'pure', 'pure']);
  });

  it('rejects a plan with a dangling dependency', () => {
    expect(() =>
      compilePlan({ steps: [{ label: 'x', effect: { kind: 'patch', name: 'p' }, deps: ['T9'] }] }),
    ).toThrow('unknown task "T9"');
  });

  it('derives a multi-source pure-leaf binding from the validated DAG dependencies', () => {
    const graph = compilePlan({
      steps: [
        { id: 'shots', label: 'shots', effect: { kind: 'host_tool', name: 'detect_scenes' } },
        { id: 'beats', label: 'beats', effect: { kind: 'host_tool', name: 'detect_beats' } },
        {
          id: 'compose',
          label: 'compose',
          effect: { kind: 'analysis', name: 'synth_pacing_ops' },
          deps: ['shots', 'beats'],
        },
      ],
    });

    expect(graph.byId.get('compose')?.effect.args).toEqual({ from: ['shots', 'beats'] });
  });

  it('rejects an explicit leaf binding that is not a declared dependency', () => {
    expect(() =>
      compilePlan({
        steps: [
          { id: 'proposal', label: 'proposal', effect: { kind: 'model', name: 'propose_edit' } },
          {
            label: 'assemble',
            effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'other' } },
            deps: ['proposal'],
          },
        ],
      }),
    ).toThrow('reads undeclared upstream task: other');
  });

  it('closes a terminal mutation proposal with compiler-owned assembly and verification', () => {
    const graph = compilePlan({
      steps: [
        {
          id: 'proposal',
          label: 'propose edit',
          effect: { kind: 'model', name: 'propose_edit' },
        },
      ],
    });

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'proposal',
      '__final_assemble',
      '__final_verify',
    ]);
    expect(graph.byId.get('__final_assemble')).toMatchObject({
      deps: ['proposal'],
      effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'proposal' } },
    });
    expect(graph.byId.get('__final_verify')).toMatchObject({
      deps: ['__final_assemble'],
      effect: { kind: 'verify', name: 'verify' },
    });
  });

  it('combines an earlier assembly with a mutation proposed after its verification', () => {
    const graph = compilePlan({
      steps: [
        { id: 'build', label: 'build', effect: { kind: 'model', name: 'propose_edit' } },
        {
          id: 'assembly',
          label: 'assemble',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['build'],
        },
        {
          id: 'check',
          label: 'check',
          effect: { kind: 'verify', name: 'verify' },
          deps: ['assembly'],
        },
        {
          id: 'polish',
          label: 'polish',
          effect: { kind: 'model', name: 'propose_edit' },
          deps: ['check'],
        },
      ],
    });

    expect(graph.byId.get('__final_assemble')).toMatchObject({
      deps: ['assembly', 'polish'],
      effect: {
        kind: 'patch',
        name: 'assemble_patch',
        args: { from: ['assembly', 'polish'] },
      },
    });
    expect(graph.byId.get('__final_verify')?.deps).toEqual(['__final_assemble']);
  });

  it('adds only verification when one assembly already covers every proposal', () => {
    const graph = compilePlan({
      steps: [
        { id: 'proposal', label: 'proposal', effect: { kind: 'model', name: 'propose_edit' } },
        {
          id: 'assembly',
          label: 'assembly',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['proposal'],
        },
      ],
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(['proposal', 'assembly', '__final_verify']);
    expect(graph.byId.get('__final_verify')?.deps).toEqual(['assembly']);
  });

  it('bumps a compiler-generated id to avoid colliding with a model-authored task of the same name', () => {
    const graph = compilePlan({
      steps: [
        {
          id: '__final_assemble',
          label: 'a model-authored task that happens to reuse the compiler-owned name',
          effect: { kind: 'patch', name: 'assemble_patch' },
        },
        { id: 'proposal', label: 'propose edit', effect: { kind: 'model', name: 'propose_edit' } },
      ],
    });
    expect(graph.byId.get('__final_assemble_2')).toBeDefined();
    expect(graph.byId.get('__final_assemble_2')?.deps).toEqual(['__final_assemble', 'proposal']);
  });

  it('does not re-walk an ancestor already reached via a sibling branch (diamond dependencies)', () => {
    // Two proposals merge through a shared analysis step, which then feeds two
    // follow-on assemblies that themselves merge into one final assembly — a diamond.
    // Neither individual assembly (nor the final one, which never reaches the THIRD,
    // unrelated proposal) covers every proposal, so the compiler must fall through to
    // the frontier + uncovered-proposals repair path, which re-derives ancestry through
    // the same shared node from both diamond branches without infinite-looping on it.
    const graph = compilePlan({
      steps: [
        { id: 'p1', label: 'p1', effect: { kind: 'model', name: 'propose_edit' } },
        { id: 'p2', label: 'p2', effect: { kind: 'model', name: 'propose_edit' } },
        { id: 'p3', label: 'p3 (unrelated)', effect: { kind: 'model', name: 'propose_edit' } },
        {
          id: 'merged',
          label: 'merge p1+p2 facts',
          effect: { kind: 'analysis', name: 'synth' },
          deps: ['p1', 'p2'],
        },
        {
          id: 'a1',
          label: 'assemble branch a',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['merged'],
        },
        {
          id: 'a2',
          label: 'assemble branch b',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['merged'],
        },
        {
          id: 'final',
          label: 'combine both branches',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['a1', 'a2'],
        },
      ],
    });

    expect(graph.byId.get('__final_assemble')?.deps).toEqual(['final', 'p3']);
    expect(graph.byId.get('__final_verify')?.deps).toEqual(['__final_assemble']);
  });

  it('rejects an explicit "from" binding that is neither a string nor an array of strings', () => {
    expect(() =>
      compilePlan({
        steps: [
          { id: 'a', label: 'a', effect: { kind: 'patch', name: 'x' } },
          {
            id: 'b',
            label: 'b',
            effect: { kind: 'patch', name: 'y', args: { from: 42 } },
            deps: ['a'],
          },
        ],
      }),
    ).toThrow('has an invalid upstream "from" binding');
  });

  it('pluralizes the undeclared-upstream message for more than one bad reference', () => {
    expect(() =>
      compilePlan({
        steps: [
          { id: 'a', label: 'a', effect: { kind: 'patch', name: 'x' } },
          {
            id: 'b',
            label: 'b',
            effect: { kind: 'patch', name: 'y', args: { from: ['other1', 'other2'] } },
            deps: ['a'],
          },
        ],
      }),
    ).toThrow('reads undeclared upstream tasks: other1, other2');
  });

  it('does not duplicate an already closed mutation lifecycle', () => {
    const graph = compilePlan({
      steps: [
        { id: 'proposal', label: 'proposal', effect: { kind: 'model', name: 'propose_edit' } },
        {
          id: 'assembly',
          label: 'assembly',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['proposal'],
        },
        {
          id: 'verify',
          label: 'verify',
          effect: { kind: 'verify', name: 'verify' },
          deps: ['assembly'],
        },
      ],
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(['proposal', 'assembly', 'verify']);
  });
});

