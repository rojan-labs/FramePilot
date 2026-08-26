/**
 * Context-management Phase 2 — WHICH part of a long project reaches the prompt.
 *
 * Retrieval used to have one query, "near the playhead", and it only ever NARROWED: a
 * 30-second selection on a 60-minute project took the context from 24 clips and 600 words
 * to 11 and 97. Correct for "tighten this"; wrong for "find the strongest hook in this
 * recording", where the selection actively hurts and no path existed by which a request
 * could widen the view.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Clip, type Project } from '@framepilot/timeline-schema';
import {
  type RetrievalQuery,
  deriveRetrievalQuery,
  rankedClipIds,
  rankedDialogue,
} from './context-retrieval.js';
import { requestScopeOf } from './kernel/command-classifier.js';
import { assembleContext } from './context-builder.js';
import type { DialogueSegment } from './kernel/semantic-index/semantic-index.js';

const clips = (n: number): Clip[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `clip_${i}`,
    trackId: 't1',
    assetId: 'asset_1',
    start: i * 4,
    end: i * 4 + 4,
    sourceStart: 0,
    sourceEnd: 4,
    effects: [],
    keyframes: [],
  }));

const dialogue = (n: number): DialogueSegment[] =>
  Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 6,
    text: `line ${i} of the recording here`,
  }));

const query = (over: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
  scope: 'global',
  pinnedClipIds: new Set(),
  ...over,
});

describe('requestScopeOf', () => {
  it('lets an explicit whole-project word beat a live selection', () => {
    // The case that motivated the rule: someone says "find the strongest hook in this
    // recording" while a clip happens to be selected, and the old path answered from the
    // selection.
    expect(requestScopeOf('find the strongest hook in this recording', true)).toBe('global');
    expect(requestScopeOf('cut this to a 45 second reel of the best moments', true)).toBe('global');
  });

  it('treats a selection as local when the request does not say otherwise', () => {
    expect(requestScopeOf('tighten this', true)).toBe('local');
    expect(requestScopeOf('make it punchier', true)).toBe('local');
  });

  it('reads a pointing word as local when nothing is selected', () => {
    expect(requestScopeOf('fix that cut', false)).toBe('local');
    expect(requestScopeOf('add a title here', false)).toBe('local');
  });

  it('defaults to global — with nothing selected and nothing pointed at, it is the project', () => {
    expect(requestScopeOf('add captions', false)).toBe('global');
    expect(requestScopeOf('', false)).toBe('global');
  });
});

describe('deriveRetrievalQuery', () => {
  it('carries pinned clips through and records the selection as a bias', () => {
    const q = deriveRetrievalQuery({
      userPrompt: 'tighten this',
      selection: { start: 10, end: 20 },
      pinned: [
        { kind: 'clip', id: 'clip_7', label: 'Intro' },
        { kind: 'asset', id: 'asset_1', label: 'a.mp4' },
      ],
    });
    expect(q.scope).toBe('local');
    expect(q.bias).toEqual({ start: 10, end: 20 });
    // Assets are not clips; only clip pins constrain clip ranking.
    expect([...q.pinnedClipIds]).toEqual(['clip_7']);
  });

  it('keeps the bias but goes global when the request says the whole recording', () => {
    const q = deriveRetrievalQuery({
      userPrompt: 'find the best moments across the whole recording',
      selection: { start: 10, end: 20 },
    });
    expect(q.scope).toBe('global');
    expect(q.bias).toEqual({ start: 10, end: 20 });
  });
});

describe('rankedClipIds', () => {
  const all = clips(200);

  it('shows everything when everything fits — a ranker only decides what does not', () => {
    expect(rankedClipIds(all, query(), 200).size).toBe(200);
  });

  it('never ranks a pinned clip away, even when it is nowhere near the selection', () => {
    const q = query({
      scope: 'local',
      bias: { start: 0, end: 8 },
      pinnedClipIds: new Set(['clip_199']),
    });
    expect(rankedClipIds(all, q, 12).has('clip_199')).toBe(true);
  });

  it('a local request is narrow and dense around the selection', () => {
    const q = query({ scope: 'local', bias: { start: 400, end: 440 } });
    const shown = [...rankedClipIds(all, q, 12)]
      .map((id) => Number(id.split('_')[1]))
      .sort((a, b) => a - b);
    // Every clip shown is in the neighbourhood of clip 100–110, not the head of the
    // timeline (which is what a `.slice(0, 12)` would have given).
    expect(Math.min(...shown)).toBeGreaterThan(90);
    expect(Math.max(...shown)).toBeLessThan(120);
  });

  it('a global request is wide and sparse across the whole timeline', () => {
    const q = query({ scope: 'global' });
    const shown = [...rankedClipIds(all, q, 12)]
      .map((id) => Number(id.split('_')[1]))
      .sort((a, b) => a - b);
    expect(shown[0]).toBe(0);
    expect(shown.at(-1)).toBe(199);
    // Spread, not clustered: the gap between consecutive shown clips is roughly even.
    const gaps = shown.slice(1).map((n, i) => n - shown[i]!);
    expect(Math.max(...gaps)).toBeLessThan(25);
  });

  it('a global request still leads with the selection when there is one', () => {
    const q = query({ scope: 'global', bias: { start: 400, end: 412 } });
    const shown = rankedClipIds(all, q, 12);
    expect(shown.has('clip_100')).toBe(true);
    expect(shown.has('clip_101')).toBe(true);
    // …and still reaches the far end of the recording, which is the whole point.
    expect(shown.has('clip_199')).toBe(true);
  });
});

describe('rankedDialogue', () => {
  const all = dialogue(300); // 6 words each = 1,800 words

  it('returns everything when the whole transcript fits', () => {
    expect(rankedDialogue(all, query(), 5_000)).toHaveLength(300);
  });

  it('never exceeds the word allowance it was given', () => {
    for (const limit of [12, 60, 600, 1_200]) {
      const shown = rankedDialogue(all, query(), limit);
      const words = shown.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
      expect(words).toBeLessThanOrEqual(limit);
    }
  });

  it('fills the room it has rather than a fraction of it', () => {
    // The bug an average-segment-length estimate produces: uneven segments underfill the
    // prompt by most of its room. The search is exact.
    const shown = rankedDialogue(all, query(), 600);
    const words = shown.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    expect(words).toBeGreaterThan(500);
  });

  it('keeps segments whole — never half a sentence', () => {
    const shown = rankedDialogue(all, query(), 61);
    for (const segment of shown) expect(all).toContain(segment);
  });

  it('a global request samples the whole recording; a local one clusters', () => {
    const global = rankedDialogue(all, query({ scope: 'global' }), 120);
    const local = rankedDialogue(
      all,
      query({ scope: 'local', bias: { start: 1_500, end: 1_560 } }),
      120,
    );
    expect(global.at(-1)!.start).toBeGreaterThan(2_000);
    expect(local.at(-1)!.start).toBeLessThan(2_000);
    expect(local[0]!.start).toBeGreaterThan(1_000);
  });

  it('returns entries in time order whatever the rank', () => {
    const shown = rankedDialogue(
      all,
      query({ scope: 'local', bias: { start: 900, end: 960 } }),
      120,
    );
    const starts = shown.map((s) => s.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

/** A project long enough that the whole thing cannot fit a small budget. */
function longProject(clipCount: number, words: number): Project {
  const transcript = Array.from({ length: words }, (_, i) => ({
    word: `word${i}`,
    // A gap wider than the index's 0.6s utterance threshold every eight words, so the
    // transcript segments into real stretches instead of one unbreakable monologue.
    start: i * 0.4 + Math.floor(i / 8) * 1.5,
    end: i * 0.4 + Math.floor(i / 8) * 1.5 + 0.3,
  }));
  return parseProject({
    id: 'proj_long',
    name: 'Long',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: clipCount * 4 }],
    timeline: { tracks: [{ id: 't1', type: 'video', clips: clips(clipCount) }], revision: 1 },
    transcript,
    aiMemory: {},
    history: [],
  });
}

describe('assembleContext retrieval, end to end', () => {
  const project = longProject(900, 9_000);
  // Deliberately too small for the whole project: ranking only decides what does NOT fit,
  // so a budget that fits everything measures nothing.
  const budget = { contextWindow: 10_000, maxOutputTokens: 4_000, headroom: 0 } as const;
  const bodyOf = (userPrompt: string, selection?: { start: number; end: number }): string =>
    assembleContext({
      project,
      userPrompt,
      budget,
      ...(selection ? { selection } : {}),
    }).messages.at(-1)?.content ?? '';

  it('a global request over a long project reaches the far end of the recording', () => {
    const body = bodyOf('find the three strongest moments in this recording', {
      start: 1_800,
      end: 1_830,
    });
    expect(body).toContain('clip_899[');
  });

  it('a local request stays in the neighbourhood of the selection', () => {
    const body = bodyOf('tighten this', { start: 1_800, end: 1_830 });
    expect(body).toContain('clip_450[');
    // The opening of a one-hour recording is not what "tighten this" is about — and it is
    // exactly what `.slice(0, 12)` used to return.
    expect(body).not.toContain('clip_0[');
  });

  it('declares what it left out, with the span and the call that returns it', () => {
    const body = bodyOf('tighten this', { start: 1_800, end: 1_830 });
    expect(body).toMatch(/\+\d+ more clip\(s\) over [\d.]+–[\d.]+s.*get_clips lists them/);
    expect(body).toMatch(/more stretch\(es\) of dialogue between [\d.]+–[\d.]+s/);
    expect(body).toContain('read any window with get_transcript');
  });

  it('tells the MODEL when a whole tier did not fit, not only the UI', () => {
    const assembled = assembleContext({
      project,
      userPrompt: 'tighten this',
      // Smaller than the system contract: everything droppable goes.
      budget: { contextWindow: 1_200, maxOutputTokens: 100, headroom: 0 },
    });
    const body = assembled.messages.at(-1)?.content ?? '';
    expect(assembled.trimmed.length).toBeGreaterThan(0);
    expect(body).toContain('NOT IN THIS PROMPT');
    // Naming the recovery call is the point: a model that does not know the transcript
    // was dropped reasons as though the project has no dialogue.
    if (assembled.trimmed.includes('transcript')) {
      expect(body).toContain('read any window with get_transcript');
    }
  });

  it('says nothing about omissions when nothing was omitted', () => {
    const small = assembleContext({ project: longProject(4, 40), userPrompt: 'add captions' });
    expect(small.messages.at(-1)?.content ?? '').not.toContain('NOT IN THIS PROMPT');
  });
});
