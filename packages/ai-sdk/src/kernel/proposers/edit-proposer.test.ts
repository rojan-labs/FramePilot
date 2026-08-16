/** Tests for the EditProposer proposer (kernel/proposers/edit-proposer.ts, K3.3). */
import { describe, expect, it } from 'vitest';
import { getTool, type ToolSpec } from '../../tool-registry.js';
import { editProposer, type EditProposerInput } from './edit-proposer.js';
import type { PlanStepSpec } from '../plan-compiler.js';

const trim = getTool('trim_clip')!;
const split = getTool('split_clip')!;
const tools: ToolSpec[] = [trim, split];

const step: PlanStepSpec = { label: 'tighten', effect: { kind: 'patch', name: 'trim_clip' } };
const input = (): EditProposerInput => ({
  step,
  slice: { clips: ['clip_a'] },
  identities: {
    assets: [{ assetId: 'asset_1', kind: 'video', durationSeconds: 30 }],
    tracks: [{ trackId: 'video_1', type: 'video' }],
    clips: [{ clipId: 'clip_a', assetId: 'asset_1', trackId: 'video_1', start: 0, end: 6 }],
  },
  tools,
});

describe('editProposer.buildRequest', () => {
  it('is a mid-tier effect scoping the step to only the relevant tool descriptors', () => {
    expect(editProposer.tier).toBe('mid');
    const effect = editProposer.buildRequest(input());
    expect(effect.request.tools?.map((t) => t.name)).toEqual(['trim_clip', 'split_clip']);
    const user = effect.request.messages[1]?.content ?? '';
    expect(user).toContain('tighten');
    expect(user).toContain('clip_a');
    expect(user).toContain('"assetId":"asset_1"');
    expect(user).toContain('"trackId":"video_1"');
    expect(user).toContain('"clipId":"clip_a"');
    expect(user).toContain('separate namespaces');
  });

  it('names the analyses that returned nothing, and forbids inventing a stand-in', () => {
    // Regression: beat detection was killed by a timeout and the run "routed around"
    // it, which left the proposer with simply no beat grid. It filled the hole — 33
    // identically-spaced cuts through the assets in library order — and reported a
    // beat-synced montage. An absence has to be stated to be reasoned about.
    const effect = editProposer.buildRequest({
      ...input(),
      evidenceGaps: [{ tool: 'detect_beats', detail: '"detect_beats" timed out after 120s' }],
    });
    const user = effect.request.messages[1]?.content ?? '';
    expect(user).toContain('MISSING EVIDENCE');
    expect(user).toContain('detect_beats');
    expect(user).toMatch(/do not substitute regular intervals/i);
  });

  it('says nothing about gaps when every analysis returned', () => {
    const user = editProposer.buildRequest(input()).request.messages[1]?.content ?? '';
    expect(user).not.toContain('MISSING EVIDENCE');
  });

  it('reserves reply room for a proposal whose length scales with the edit', () => {
    // A montage cut on every drum hit is ~60 tool calls. Without an explicit reservation
    // the provider default truncated it mid-object into "not valid JSON".
    const effect = editProposer.buildRequest(input());
    expect(effect.request.maxTokens).toBeGreaterThanOrEqual(16_000);
  });
});

describe('editProposer.parseResponse (registry-validated)', () => {
  it('accepts a well-formed call and assigns a deterministic id when omitted', () => {
    const raw = JSON.stringify({
      toolCalls: [{ name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 5 } }],
    });
    const result = editProposer.parseResponse(raw, tools);
    expect(result).toEqual({
      ok: true,
      value: [
        { id: 'call_1', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 5 } },
      ],
    });
  });

  it('keeps a model-supplied id and returns coerced args (numeric strings → numbers)', () => {
    const raw = JSON.stringify({
      toolCalls: [
        { id: 'x9', name: 'trim_clip', arguments: { clipId: 'c', start: '1.5', end: '3' } },
      ],
    });
    const result = editProposer.parseResponse(raw, tools);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toEqual({
        id: 'x9',
        name: 'trim_clip',
        arguments: { clipId: 'c', start: 1.5, end: 3 },
      });
    }
  });

  it('defaults absent arguments to {} then validates them', () => {
    // trim_clip requires clipId/start/end, so an empty-args call is rejected by the tool.
    const raw = JSON.stringify({ toolCalls: [{ name: 'trim_clip' }] });
    const result = editProposer.parseResponse(raw, tools);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid arguments for "trim_clip"');
  });

  it('rejects a hallucinated / out-of-scope tool name', () => {
    const raw = JSON.stringify({ toolCalls: [{ name: 'delete_range', arguments: {} }] });
    const result = editProposer.parseResponse(raw, tools);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('out-of-scope tool "delete_range"');
  });

  it('accepts an empty tool-call list (a step needing no call)', () => {
    const result = editProposer.parseResponse('{"toolCalls":[]}', tools);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('rejects a malformed JSON body', () => {
    expect(editProposer.parseResponse('not json', tools).ok).toBe(false);
  });

  it('rejects a response missing the toolCalls array', () => {
    expect(editProposer.parseResponse('{"calls":[]}', tools).ok).toBe(false);
  });

  it('survives a tool whose parse throws a non-Error (stringifies it)', () => {
    // A tool may throw anything; validateCalls must not itself throw.
    const rogue = {
      ...trim,
      name: 'rogue',
      parse: () => {
        throw 'boom';
      },
    } as ToolSpec;
    const raw = JSON.stringify({ toolCalls: [{ name: 'rogue', arguments: {} }] });
    const result = editProposer.parseResponse(raw, [rogue]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('boom');
  });

  it('validates multiple calls and reports the first invalid one', () => {
    const raw = JSON.stringify({
      toolCalls: [
        { name: 'split_clip', arguments: { clipId: 'c', at: 2 } },
        { name: 'trim_clip', arguments: { clipId: 'c' } }, // missing start/end
      ],
    });
    const result = editProposer.parseResponse(raw, tools);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('trim_clip');
  });
});
