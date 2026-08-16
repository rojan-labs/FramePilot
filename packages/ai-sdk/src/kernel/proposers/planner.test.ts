/** Tests for the Planner proposer (kernel/proposers/planner.ts, K3.3). */
import { describe, expect, it } from 'vitest';
import { compilePlan } from '../plan-compiler.js';
import { buildSemanticIndex } from '../semantic-index/semantic-index.js';
import { getTool } from '../../tool-registry.js';
import { makeProject } from '../../__fixtures__/project.js';
import { planner, summarizeSemanticIndex, toolCapabilities, type PlannerInput } from './planner.js';
import type { Intent } from './intent-parser.js';

const intent: Intent = { goal: 'montage', targets: ['music'], constraints: ['45s'] };

const input = (): PlannerInput => ({
  intent,
  index: summarizeSemanticIndex(buildSemanticIndex(makeProject())),
  capabilities: toolCapabilities([getTool('trim_clip')!, getTool('get_transcript')!]),
  executableEffects: {
    host_tool: ['detect_beats'],
    model: ['propose_edit'],
    patch: ['assemble_patch'],
    verify: ['verify'],
  },
});

describe('summarizeSemanticIndex', () => {
  it('reduces the index to counts + flags', () => {
    const summary = summarizeSemanticIndex(buildSemanticIndex(makeProject()));
    expect(summary.layerCount).toBe(2);
    expect(summary.hasBeatGrid).toBe(false); // no analysisResults bag passed -> honestly null (P4.1)
    expect(summary.silences).toBe(0);
  });
});

describe('toolCapabilities', () => {
  it('projects registry tools to name/kind/mutates/description hints', () => {
    const caps = toolCapabilities([getTool('trim_clip')!]);
    expect(caps[0]).toMatchObject({ name: 'trim_clip', mutates: true });
    expect(typeof caps[0]?.description).toBe('string');
  });

  it('advertises each tool’s required and optional argument names', () => {
    // The Planner writes each step's `args` itself. Told only a name and a description it
    // planned `search_visual` with no `query`, which cannot run — not disobedience, but a
    // model asked to supply arguments whose names it was never shown.
    const [visual, beats] = toolCapabilities([getTool('search_visual')!, getTool('detect_beats')!]);
    expect(visual?.requiredArgs).toEqual(['query']);
    expect(visual?.optionalArgs).toContain('k');
    // A tool with no required argument says so with an empty list, never a missing field.
    expect(beats?.requiredArgs).toEqual([]);
    expect(beats?.optionalArgs).toEqual(['assetId', 'sensitivity']);
  });

  it('says "no arguments" rather than guessing when a tool advertises no schema', () => {
    // An MCP client's tool or a test double can reach here with a bare parameter schema.
    // Reporting empty lists is honest; inventing argument names would be worse than silence.
    const bare = { ...getTool('detect_beats')!, name: 'x', parameters: { type: 'object' } };
    expect(toolCapabilities([bare])[0]).toMatchObject({ requiredArgs: [], optionalArgs: [] });
  });
});

describe('planner.buildRequest', () => {
  it('is a mid-tier effect embedding intent, index summary, and tools', () => {
    expect(planner.tier).toBe('mid');
    const effect = planner.buildRequest(input());
    const user = effect.request.messages[1]?.content ?? '';
    expect(user).toContain('"goal":"montage"');
    expect(user).toContain('Timeline:');
    expect(user).toContain('trim_clip');
    expect(user).toContain('Executable effects:');
    expect(user).toContain('"model":["propose_edit"]');
    // The argument names travel with the tool list — the whole point of advertising them.
    expect(user).toContain('"requiredArgs"');
  });
});

describe('planner.parseResponse', () => {
  it('validates a ProposedPlan that flows straight into compilePlan', () => {
    const raw = JSON.stringify({
      steps: [
        { label: 'read', effect: { kind: 'host_tool', name: 'get_transcript' } },
        { label: 'edit', effect: { kind: 'patch', name: 'assemble' }, deps: ['T1'] },
      ],
    });
    const result = planner.parseResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const graph = compilePlan(result.value);
      expect(graph.nodes.map((n) => n.id)).toEqual(['T1', 'T2']);
    }
  });

  it('preserves explicit ids, args, resource and priority', () => {
    const raw = JSON.stringify({
      steps: [
        {
          id: 'analyze',
          label: 'a',
          effect: { kind: 'host_tool', name: 'analyze_silence', args: { track: 'A' } },
          resource: 'ffmpeg',
          priority: 'analysis',
        },
      ],
    });
    const result = planner.parseResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps[0]).toMatchObject({ id: 'analyze', resource: 'ffmpeg' });
      expect(result.value.steps[0]?.effect.args).toEqual({ track: 'A' });
    }
  });

  it('rejects an empty plan (must have at least one step)', () => {
    expect(planner.parseResponse('{"steps":[]}').ok).toBe(false);
  });

  it('rejects an unknown effect kind', () => {
    const raw = JSON.stringify({ steps: [{ label: 'x', effect: { kind: 'delete', name: 'n' } }] });
    expect(planner.parseResponse(raw).ok).toBe(false);
  });

  it('propagates a JSON parse failure as an error result', () => {
    expect(planner.parseResponse('nonsense').ok).toBe(false);
  });
});
