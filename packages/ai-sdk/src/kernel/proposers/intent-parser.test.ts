/** Tests for the IntentParser proposer (kernel/proposers/intent-parser.ts, K3.3). */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../../__fixtures__/project.js';
import {
  intentParser,
  projectHeaderOf,
  type IntentParserInput,
  type ProjectHeader,
} from './intent-parser.js';

const header = (over: Partial<ProjectHeader> = {}): ProjectHeader => ({
  durationSeconds: 30,
  resolution: { width: 1080, height: 1920 },
  layerCount: 2,
  ...over,
});

describe('projectHeaderOf', () => {
  it('derives a tiny header (duration = latest clip end, layer count, resolution)', () => {
    const h = projectHeaderOf(makeProject());
    expect(h).toEqual({
      durationSeconds: 10, // clip_b ends at 10
      resolution: { width: 1920, height: 1080 },
      layerCount: 2,
    });
  });

  it('includes the platform only when provided (exact-optional)', () => {
    expect(projectHeaderOf(makeProject(), 'reels').platform).toBe('reels');
    expect('platform' in projectHeaderOf(makeProject())).toBe(false);
  });
});

describe('intentParser.buildRequest', () => {
  it('is a small-tier model effect that embeds header, selection, and request', () => {
    expect(intentParser.tier).toBe('small');
    const input: IntentParserInput = {
      userText: 'make a 45s montage',
      header: header({ platform: 'tiktok' }),
      selection: { start: 2, end: 6 },
    };
    const effect = intentParser.buildRequest(input);
    const user = effect.request.messages[1]?.content ?? '';
    expect(user).toContain('1080x1920');
    expect(user).toContain('platform tiktok');
    expect(user).toContain('Selection: 2.00s–6.00s');
    expect(user).toContain('make a 45s montage');
  });

  it('omits the selection line when there is no selection', () => {
    const effect = intentParser.buildRequest({ userText: 'trim it', header: header() });
    const user = effect.request.messages[1]?.content ?? '';
    expect(user).not.toContain('Selection:');
  });
});

describe('intentParser.parseResponse', () => {
  it('validates a well-formed intent and defaults empty arrays', () => {
    const result = intentParser.parseResponse('{"goal":"shorten","platform":"reels"}');
    expect(result).toEqual({
      ok: true,
      value: { goal: 'shorten', targets: [], constraints: [], platform: 'reels' },
    });
  });

  it('keeps supplied targets/constraints and omits an absent platform', () => {
    const result = intentParser.parseResponse(
      '{"goal":"cut","targets":["clip_a"],"constraints":["<45s"]}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targets).toEqual(['clip_a']);
      expect(result.value.constraints).toEqual(['<45s']);
      expect(result.value.platform).toBeUndefined();
    }
  });

  it('rejects a bad platform enum value', () => {
    const result = intentParser.parseResponse('{"goal":"x","platform":"myspace"}');
    expect(result.ok).toBe(false);
  });

  it('rejects a missing goal', () => {
    expect(intentParser.parseResponse('{"targets":[]}').ok).toBe(false);
  });
});
