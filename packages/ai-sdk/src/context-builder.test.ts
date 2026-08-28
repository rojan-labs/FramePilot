/**
 * Tests for the context builder (PRD §8.2): deterministic message assembly.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_CONTEXT_BUDGET,
  MAX_HISTORY_MESSAGES,
  SYSTEM_PROMPT,
  assembleContext,
  boundedHistory,
  budgetTokens,
  buildContext,
  estimateTokens,
  focusedClipIds,
  MIN_CLIPS_PER_LAYER,
  MIN_TRANSCRIPT_WORDS,
  allocateGroundingSlice,
  summarizeMediaBin,
  summarizeSourceMedia,
  summarizeTimeline,
  summarizeTranscript,
} from './context-builder.js';
import {
  assertEditorInteractionReferences,
  captureEditorInteractionContext,
} from './editor-context/interaction-context.js';
import type { AiMessage } from './providers/types.js';
import type { ContextBudget } from './reliability/types.js';
import { setPreference } from './memory-store.js';
import { makeProject } from './__fixtures__/project.js';

const mkClip = (id: string, trackId: string, assetId: string): Clip => ({
  id,
  trackId,
  assetId,
  start: 0,
  end: 5,
  sourceStart: 0,
  sourceEnd: 5,
  effects: [],
  keyframes: [],
});

describe('summaries', () => {
  it('summarizes layers by z-order + content kind, and an empty timeline', () => {
    const project = makeProject();
    const assetKinds = new Map(project.assets.map((a) => [a.id, a.kind]));
    const summary = summarizeTimeline(project.timeline, assetKinds);
    // Layers are described by z-order (front→back) and content kind, not a fixed type.
    expect(summary).toContain('front');
    expect(summary).toContain('"video_1"');
    expect(summary).toContain('"audio_1": empty');
    expect(summarizeTimeline({ tracks: [] })).toBe('Timeline: (empty)');
  });

  it('derives clip kinds for text overlay, caption, audio, and image assets', () => {
    const tl: Timeline = {
      tracks: [
        { id: 'a', type: 'video', clips: [mkClip('c1', 'a', '__text__')] },
        { id: 'b', type: 'caption', clips: [mkClip('c2', 'b', '__caption__')] },
        { id: 'c', type: 'audio', clips: [mkClip('c3', 'c', 'aud')] },
        { id: 'd', type: 'video', clips: [mkClip('c4', 'd', 'img')] },
      ],
    };
    const assetKinds = new Map<string, string>([
      ['aud', 'audio'],
      ['img', 'image'],
    ]);
    const s = summarizeTimeline(tl, assetKinds);
    expect(s).toContain('text');
    expect(s).toContain('caption');
    expect(s).toContain('audio');
    expect(s).toContain('image');
    // Four tracks → front, mid, mid, back
    expect(s).toContain('mid');
  });

  it('summarizes a transcript and notes truncation', () => {
    expect(summarizeTranscript(makeProject())).toContain('hello world');
    expect(summarizeTranscript(makeProject({ transcript: [] }))).toBe('Transcript: (none)');
    const long = makeProject({
      transcript: Array.from({ length: 700 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 1 })),
    });
    expect(summarizeTranscript(long)).toContain('…(truncated)');
  });
});

describe('editor interaction context', () => {
  it('injects the live playhead and selected clip references as a selection-tier block', () => {
    const project = makeProject();
    project.timeline.tracks[0]!.clips[0]!.keyframes.push({
      id: 'kf_1',
      property: 'x',
      time: 1,
      value: 0.5,
      easing: 'linear',
    });
    project.timeline.tracks.push({
      id: 'fx_1',
      type: 'effect',
      clips: [],
      effectLayers: [
        {
          id: 'fx_layer_1',
          effectId: 'halo-bloom',
          kind: 'bloom',
          start: 0,
          end: 5,
          params: {},
          keyframes: [],
        },
      ],
    });
    const interaction = captureEditorInteractionContext({
      project,
      projectRevision: 8,
      playheadSeconds: 1,
      selectedClipIds: ['clip_a'],
      primaryClipId: 'clip_a',
      selectedEffectLayerIds: ['fx_layer_1', 'missing'],
      selectedKeyframes: [
        { clipId: 'clip_a', property: 'x', time: 1 },
        { clipId: 'clip_a', property: 'missing', time: 1 },
      ],
      sourceMonitor: {
        assetId: project.assets[0]!.id,
        rate: { numerator: 30, denominator: 1 },
        playhead: { seconds: 2, frame: 60 },
        markedRange: { startFrame: 30, endFrame: 90 },
      },
    });

    const assembled = assembleContext({ project, userPrompt: 'move this', interaction });
    expect(assembled.messages.at(-1)?.content).toContain('Editor state (revision 8');
    expect(assembled.messages.at(-1)?.content).toContain('Playhead: frame 30');
    expect(assembled.messages.at(-1)?.content).toContain('Selected effect layers: fx_layer_1');
    expect(assembled.messages.at(-1)?.content).toContain('clip_a:x@1s');
    expect(assembled.messages.at(-1)?.content).toContain('Source marks: frames 30–90');
    expect(interaction.selection.effectLayerIds).toEqual(['fx_layer_1']);
    expect(interaction.selection.keyframes).toEqual([{ clipId: 'clip_a', property: 'x', time: 1 }]);
    expect(() => assertEditorInteractionReferences(project, interaction)).not.toThrow();
    expect(() =>
      assertEditorInteractionReferences(project, {
        ...interaction,
        sourceMonitor: {
          assetId: 'missing',
          rate: { numerator: 30, denominator: 1 },
          playhead: { seconds: 0, frame: 0 },
        },
      }),
    ).toThrow('asset:missing');
    expect(assembled.sections).toContainEqual(
      expect.objectContaining({ tier: 'selection', label: 'editor interaction state' }),
    );
  });
});

describe('buildContext', () => {
  it('emits a system message then a context+prompt user message', () => {
    const messages = buildContext({ project: makeProject(), userPrompt: 'tighten the intro' });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(messages[1]?.content).toContain('User request:\ntighten the intro');
    expect(messages[1]?.content).toContain('Project: "Demo"');
  });

  it('includes selection, platform, and learned memory when present', () => {
    const project = setPreference(makeProject(), 'captionStyle', 'bold yellow');
    const messages = buildContext({
      project,
      userPrompt: 'caption it',
      selection: { start: 1.2, end: 3.4 },
      targetPlatform: 'reels',
    });
    const content = messages[1]?.content ?? '';
    expect(content).toContain('Selected range: 1.2–3.4s');
    expect(content).toContain('Target platform: reels');
    expect(content).toContain('Caption style: bold yellow');
  });

  it('surfaces a "Pinned context" block for user-pinned clips/assets (P8.7)', () => {
    const content =
      buildContext({
        project: makeProject(),
        userPrompt: 'match the pace of the intro',
        pinned: [
          { kind: 'clip', id: 'c1', label: 'intro.mp4 0–5s' },
          { kind: 'asset', id: 'a2', label: 'broll.mp4' },
        ],
      })[1]?.content ?? '';
    expect(content).toContain(
      'Pinned context (user-selected, in addition to any selection above):',
    );
    expect(content).toContain('- [clip] intro.mp4 0–5s (id: c1)');
    expect(content).toContain('- [asset] broll.mp4 (id: a2)');
  });

  it('omits the "Pinned context" block when nothing is pinned (browser-only, honest-by-default)', () => {
    const content = buildContext({ project: makeProject(), userPrompt: 'hi' })[1]?.content ?? '';
    expect(content).not.toContain('Pinned context');
    const empty =
      buildContext({ project: makeProject(), userPrompt: 'hi', pinned: [] })[1]?.content ?? '';
    expect(empty).not.toContain('Pinned context');
  });

  it('omits the memory block when nothing is remembered', () => {
    const content = buildContext({ project: makeProject(), userPrompt: 'hi' })[1]?.content ?? '';
    expect(content).not.toContain('Project memory');
  });

  it('injects the narrative session-context digest when the host supplies one (B6.3)', () => {
    const content =
      buildContext({
        project: makeProject(),
        userPrompt: 'tighten it',
        sessionContext: '### Edits this user rejected before\n## no captions over faces',
      })[1]?.content ?? '';
    expect(content).toContain('What we have learned on this project so far:');
    expect(content).toContain('no captions over faces');
  });

  it('omits the session-context block when absent or blank (no sidecar, nothing learned)', () => {
    const none = buildContext({ project: makeProject(), userPrompt: 'hi' })[1]?.content ?? '';
    expect(none).not.toContain('What we have learned');
    const blank =
      buildContext({ project: makeProject(), userPrompt: 'hi', sessionContext: '  \n ' })[1]
        ?.content ?? '';
    expect(blank).not.toContain('What we have learned');
  });

  it('injects the visual-index status line when the host supplies one (MI6.2)', () => {
    const content =
      buildContext({
        project: makeProject(),
        userPrompt: 'cut to the product shot',
        visualStatus:
          'Visual index: 3/4 assets, 2841 vectors, sqlite-vec backend — use search_visual.',
      })[1]?.content ?? '';
    expect(content).toContain('Visual index: 3/4 assets');
    expect(content).toContain('search_visual');
  });

  it('omits the visual-index line when absent or blank (browser build, no sidecar)', () => {
    const none = buildContext({ project: makeProject(), userPrompt: 'hi' })[1]?.content ?? '';
    expect(none).not.toContain('Visual index:');
    const blank =
      buildContext({ project: makeProject(), userPrompt: 'hi', visualStatus: '   ' })[1]?.content ??
      '';
    expect(blank).not.toContain('Visual index:');
  });

  it('injects the footage-map digest right after visual status when the host supplies one (FI3.3)', () => {
    const content =
      buildContext({
        project: makeProject(),
        userPrompt: 'map the footage',
        footageMap: 'Footage map (2:05 total) — the structure of what is IN the footage, in order:',
      })[1]?.content ?? '';
    expect(content).toContain('Footage map (2:05 total)');
  });

  it('omits the footage-map block when absent or blank', () => {
    const none = buildContext({ project: makeProject(), userPrompt: 'hi' })[1]?.content ?? '';
    expect(none).not.toContain('Footage map');
    const blank =
      buildContext({ project: makeProject(), userPrompt: 'hi', footageMap: '   ' })[1]?.content ??
      '';
    expect(blank).not.toContain('Footage map');
  });

  it('fills blank project memory from the user scope, but the project value wins', () => {
    // Project remembers a pacing preference but no caption style; the user scope
    // supplies the caption-style default (K5.1). The project caption style, when set,
    // overrides the user default.
    const project = setPreference(makeProject(), 'preferredPacing', 'fast');
    const filled =
      buildContext({
        project,
        userPrompt: 'caption it',
        userMemory: { captionStyle: 'karaoke', favoriteExportPlatforms: ['reels'] },
      })[1]?.content ?? '';
    expect(filled).toContain('Preferred pacing: fast'); // project scope
    expect(filled).toContain('Caption style: karaoke'); // filled from user scope
    expect(filled).toContain('Export platforms: reels');

    const overridden =
      buildContext({
        project: setPreference(project, 'captionStyle', 'minimal'),
        userPrompt: 'caption it',
        userMemory: { captionStyle: 'karaoke', favoriteExportPlatforms: [] },
      })[1]?.content ?? '';
    expect(overridden).toContain('Caption style: minimal'); // project wins
    expect(overridden).not.toContain('Caption style: karaoke');
  });

  it('threads bounded history between the system and current prompt', () => {
    const history: AiMessage[] = [
      { role: 'user', content: 'cut the intro' },
      { role: 'assistant', content: 'Trimmed the first clip.' },
    ];
    const messages = buildContext({
      project: makeProject(),
      userPrompt: 'make it shorter',
      history,
    });
    expect(messages).toHaveLength(4); // system + 2 history + current
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'cut the intro' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Trimmed the first clip.' });
    expect(messages[3]?.content).toContain('User request:\nmake it shorter');
  });

  it('keeps the two-message shape when history is empty', () => {
    expect(buildContext({ project: makeProject(), userPrompt: 'hi', history: [] })).toHaveLength(2);
  });
});

describe('selection-scoped timeline (B3)', () => {
  const track = (id: string, clips: Clip[]): Timeline['tracks'][number] => ({
    id,
    type: 'video',
    clips,
  });
  const clipAt = (id: string, start: number, end: number): Clip => ({
    ...mkClip(id, 't1', 'a1'),
    start,
    end,
  });

  const manyClips = Array.from({ length: 10 }, (_, i) => clipAt(`c${i}`, i * 5, i * 5 + 5));

  it('shows clips overlapping the focus + immediate neighbours, collapsing the rest', () => {
    const tl: Timeline = { tracks: [track('t1', manyClips)] };
    const focus = { start: 26, end: 29 }; // overlaps c5 (25–30)
    const s = summarizeTimeline(tl, new Map(), focus);
    expect(s).toContain('focused on 26–29s');
    expect(s).toContain('c5['); // the overlapping clip
    expect(s).toContain('c4['); // immediate neighbour before
    expect(s).toContain('c6['); // immediate neighbour after
    expect(s).toContain('more clip(s)');
    expect(s).not.toContain('c0['); // far clips collapsed
  });

  it('orders equal-start clips by id (stable sort tiebreak)', () => {
    // Two clips share a start → the comparator falls through to the id tiebreak.
    const ids = focusedClipIds([clipAt('b', 5, 10), clipAt('a', 5, 8)], { start: 6, end: 7 });
    expect(ids).toEqual(new Set(['a', 'b']));
  });

  it('picks the bounding neighbours when the focus is in a gap', () => {
    const clips = [clipAt('a', 0, 5), clipAt('b', 20, 25)];
    const ids = focusedClipIds(clips, { start: 10, end: 12 });
    expect(ids).toEqual(new Set(['a', 'b']));
  });

  it('shows all clips in full when none are omitted', () => {
    const clips = [clipAt('a', 0, 5), clipAt('b', 5, 10)];
    const s = summarizeTimeline({ tracks: [track('t1', clips)] }, new Map(), { start: 1, end: 9 });
    expect(s).toContain('a[');
    expect(s).toContain('b[');
    expect(s).not.toContain('more clip(s)');
  });

  it('collapses to only a summary when the focus has no shown clips on a track', () => {
    // Focus overlaps nothing and there is no clip after it → only a "before" neighbour.
    const clips = [clipAt('a', 0, 5)];
    const ids = focusedClipIds(clips, { start: 100, end: 110 });
    expect(ids).toEqual(new Set(['a']));
  });

  it('assembleContext scopes the timeline when a selection is present', () => {
    const project = makeProject({
      timeline: { tracks: [track('t1', manyClips)] },
    });
    const scoped = assembleContext({ project, userPrompt: 'x', selection: { start: 26, end: 29 } });
    const unscoped = assembleContext({ project, userPrompt: 'x' });
    expect(scoped.messages.at(-1)?.content).toContain('focused on 26–29s');
    expect(unscoped.messages.at(-1)?.content).not.toContain('focused on');
  });
});

describe('bounded timeline slice (K2.2)', () => {
  const track = (id: string, clips: Clip[]): Timeline['tracks'][number] => ({
    id,
    type: 'video',
    clips,
  });
  const clipAt = (id: string, start: number, end: number): Clip => ({
    ...mkClip(id, 't1', 'a1'),
    start,
    end,
  });
  const bigLayer = Array.from({ length: 200 }, (_, i) => clipAt(`c${i}`, i, i + 1));

  it('caps an unfocused layer to maxClipsPerLayer and collapses the rest', () => {
    const s = summarizeTimeline({ tracks: [track('t1', bigLayer)] }, new Map(), undefined, 12);
    expect(s).toContain('c0['); // first clips shown
    expect(s).toContain('c11['); // up to the cap
    expect(s).not.toContain('c12['); // beyond the cap collapsed
    expect(s).toContain('+188 more clip(s) over 12–200s');
    expect(s).toContain('(200 clip(s), 0–200s)'); // header still reports the true count/span
  });

  it('leaves a layer at or under the cap fully expanded', () => {
    const small = Array.from({ length: 12 }, (_, i) => clipAt(`c${i}`, i, i + 1));
    const s = summarizeTimeline({ tracks: [track('t1', small)] }, new Map(), undefined, 12);
    expect(s).toContain('c11[');
    expect(s).not.toContain('more clip(s)');
  });

  it('is uncapped by default (Infinity) — behaviour unchanged for existing callers', () => {
    const s = summarizeTimeline({ tracks: [track('t1', bigLayer)] }, new Map());
    expect(s).toContain('c199[');
    expect(s).not.toContain('more clip(s)');
  });

  it('the bounded slice is dramatically smaller than the whole-timeline dump', () => {
    const tl: Timeline = { tracks: [track('t1', bigLayer)] };
    const dump = summarizeTimeline(tl, new Map());
    const slice = summarizeTimeline(tl, new Map(), undefined, MIN_CLIPS_PER_LAYER);
    expect(estimateTokens(slice)).toBeLessThan(estimateTokens(dump) / 5);
  });

  it('assembleContext shows a large timeline in full when the model has room (P1.3)', () => {
    // This used to collapse at 12 clips per layer whatever the model was, because the cap
    // was a compile-time constant. 200 clips is nothing against a real window, and the
    // whole point of the allocation is that the model gets to see them.
    const project = makeProject({ timeline: { tracks: [track('t1', bigLayer)] } });
    const content = assembleContext({ project, userPrompt: 'x' }).messages.at(-1)?.content ?? '';
    expect(content).toContain('c199[');
    expect(content).not.toContain('more clip(s)');
  });

  it('still bounds the slice when the room is genuinely small', () => {
    const project = makeProject({ timeline: { tracks: [track('t1', bigLayer)] } });
    const assetKinds = new Map(project.assets.map((a) => [a.id, a.kind]));
    const tight = allocateGroundingSlice(project, assetKinds, 400);
    expect(tight.maxClipsPerLayer).toBeGreaterThanOrEqual(MIN_CLIPS_PER_LAYER);
    expect(tight.maxClipsPerLayer).toBeLessThan(bigLayer.length);
    // And what it allocated actually fits what it was given.
    expect(
      estimateTokens(
        summarizeTimeline(project.timeline, assetKinds, undefined, tight.maxClipsPerLayer),
      ),
    ).toBeLessThanOrEqual(400);
  });

  it('never falls below the historical floor, even with no room at all', () => {
    const project = makeProject({ timeline: { tracks: [track('t1', bigLayer)] } });
    const assetKinds = new Map(project.assets.map((a) => [a.id, a.kind]));
    // Negative room is the honest case for a window smaller than the system contract.
    // The allocation pins to the floor and DROP_ORDER takes over, exactly as before P1.3.
    for (const room of [-5_000, 0, 1]) {
      const allocation = allocateGroundingSlice(project, assetKinds, room);
      expect(allocation.maxClipsPerLayer).toBe(MIN_CLIPS_PER_LAYER);
      // Capped by what exists: this fixture has two words, and the floor is an allowance,
      // not a demand for words the project does not have.
      expect(allocation.maxTranscriptWords).toBeLessThanOrEqual(MIN_TRANSCRIPT_WORDS);
    }
  });

  it('a focused request is selected by relevance, not grown by budget', () => {
    const project = makeProject({ timeline: { tracks: [track('t1', bigLayer)] } });
    const assetKinds = new Map(project.assets.map((a) => [a.id, a.kind]));
    const focused = allocateGroundingSlice(project, assetKinds, 1_000_000, { start: 10, end: 20 });
    expect(focused.maxClipsPerLayer).toBe(MIN_CLIPS_PER_LAYER);
    expect(focused.maxTranscriptWords).toBe(MIN_TRANSCRIPT_WORDS);
  });

  it('hands the timeline the room a small transcript does not need', () => {
    const wordy = makeProject({
      timeline: { tracks: [track('t1', bigLayer)] },
      transcript: Array.from({ length: 5_000 }, (_, i) => ({
        word: `word${i}`,
        start: i * 0.4,
        end: i * 0.4 + 0.35,
      })),
    });
    const silent = makeProject({ timeline: { tracks: [track('t1', bigLayer)] }, transcript: [] });
    const assetKinds = new Map(silent.assets.map((a) => [a.id, a.kind]));
    const room = 900;
    // Same timeline, same room: the one with nothing to say in the transcript tier must
    // not have half the room reserved for it.
    expect(allocateGroundingSlice(silent, assetKinds, room).maxClipsPerLayer).toBeGreaterThan(
      allocateGroundingSlice(wordy, assetKinds, room).maxClipsPerLayer,
    );
  });
});

describe('transcript relevance window (K2.2)', () => {
  const longTranscript = Array.from({ length: 100 }, (_, i) => ({
    word: `word${i}`,
    start: i,
    end: i + 1,
  }));

  it('slices the transcript to the dialogue around a focus range', () => {
    const project = makeProject({ transcript: longTranscript });
    const s = summarizeTranscript(project, { start: 50, end: 52 });
    expect(s).toContain('focused on 50–52s');
    // words within the focus ± 2s pad are present; far words are not.
    expect(s).toContain('word50');
    expect(s).not.toContain('word0');
    expect(s).not.toContain('word99');
  });

  it('reports an empty window honestly when no dialogue overlaps', () => {
    const project = makeProject({ transcript: longTranscript });
    const s = summarizeTranscript(project, { start: 500, end: 505 });
    expect(s).toBe('Transcript (focused on 500–505s): (no dialogue in range)');
  });

  it('falls back to the head-truncation view without a focus', () => {
    const project = makeProject({ transcript: longTranscript });
    expect(summarizeTranscript(project)).toContain('word0');
  });

  it('assembleContext biases toward the selection without walling off the rest (P2.2)', () => {
    // Before Phase 2 a selection HARD-narrowed the transcript: a 30s selection on a
    // 60-minute project took the model from 600 words to 97, which is right for "tighten
    // this" and wrong for "find the strongest hook". A selection is now a bias, so the
    // dialogue around it leads and the rest of the recording stays eligible for the room.
    const project = makeProject({ transcript: longTranscript });
    const content =
      assembleContext({ project, userPrompt: 'x', selection: { start: 50, end: 52 } }).messages.at(
        -1,
      )?.content ?? '';
    expect(content).toContain('focused on 50–52s');
    expect(content).toContain('word0');
  });
});

describe('token budgeting (B2)', () => {
  it('estimateTokens uses the ~4-chars-per-token heuristic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('budgetTokens subtracts output + headroom and clamps at 0', () => {
    expect(budgetTokens({ contextWindow: 1000, maxOutputTokens: 200, headroom: 100 })).toBe(700);
    expect(budgetTokens({ contextWindow: 100, maxOutputTokens: 200, headroom: 100 })).toBe(0);
    expect(DEFAULT_CONTEXT_BUDGET.contextWindow).toBeGreaterThan(0);
  });

  it('does not trim a small project under the default budget', () => {
    const { trimmed } = assembleContext({ project: makeProject(), userPrompt: 'hi' });
    expect(trimmed).toEqual([]);
  });

  it('drops lowest-priority tiers first to fit a tight budget', () => {
    const project = setPreference(
      makeProject({
        transcript: Array.from({ length: 400 }, (_, i) => ({
          word: `word${i}`,
          start: i,
          end: i + 1,
        })),
      }),
      'captionStyle',
      'bold',
    );
    // A tiny window forces dropping transcript, then timeline (system + header +
    // request already consume most of it).
    const budget: ContextBudget = { contextWindow: 120, maxOutputTokens: 0, headroom: 0 };
    const { trimmed, messages } = assembleContext({
      project,
      userPrompt: 'tighten',
      selection: { start: 0, end: 1 },
      budget,
    });
    // Transcript is the first to go; the request + project header always remain.
    expect(trimmed[0]).toBe('transcript');
    expect(trimmed).toContain('timeline');
    const content = messages.at(-1)?.content ?? '';
    expect(content).toContain('User request:\ntighten');
    expect(content).toContain('Project:');
    expect(content).not.toContain('word399');
  });

  it('drops history and selection only under extreme pressure, reporting each', () => {
    const budget: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };
    const { trimmed } = assembleContext({
      project: makeProject(),
      userPrompt: 'x',
      selection: { start: 0, end: 1 },
      history: [{ role: 'user', content: 'earlier turn' }],
      budget,
    });
    expect(trimmed).toEqual(
      expect.arrayContaining(['transcript', 'timeline', 'history', 'selection']),
    );
  });

  it('injects the skills manifest as its own tier and omits it when absent (ADR 0057)', () => {
    const skill = {
      name: 'keyframe-animation',
      description: 'How to animate with keyframes.',
      tools: ['add_keyframes'],
      body: '# body',
    };
    const withSkills = assembleContext({
      project: makeProject(),
      userPrompt: 'zoom in',
      skills: [skill],
    });
    const content = withSkills.messages.at(-1)?.content ?? '';
    expect(content).toContain('load_skill');
    expect(content).toContain('- keyframe-animation — How to animate with keyframes.');
    // No skills passed → no manifest text anywhere.
    const without = assembleContext({ project: makeProject(), userPrompt: 'zoom in' });
    expect(without.messages.at(-1)?.content).not.toContain('load_skill');
  });

  it('drops skills after timeline but before memory under budget pressure (ADR 0057)', () => {
    const project = setPreference(makeProject(), 'captionStyle', 'bold');
    const budget: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };
    const { trimmed } = assembleContext({
      project,
      userPrompt: 'x',
      skills: [{ name: 's', description: 'd', tools: [], body: 'b' }],
      budget,
    });
    expect(trimmed).toEqual(expect.arrayContaining(['timeline', 'skills', 'memory']));
    expect(trimmed.indexOf('timeline')).toBeLessThan(trimmed.indexOf('skills'));
    expect(trimmed.indexOf('skills')).toBeLessThan(trimmed.indexOf('memory'));
  });

  it('drops the session-context digest with the memory tier under pressure (B6.3)', () => {
    const budget: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };
    const { messages, trimmed } = assembleContext({
      project: makeProject(),
      userPrompt: 'x',
      sessionContext: '### Edits this user rejected before\n## no captions over faces',
      budget,
    });
    expect(trimmed).toContain('memory');
    expect(messages.at(-1)?.content).not.toContain('no captions over faces');
  });

  it('drops pinned before selection under extreme pressure (pinned ranks just below selection)', () => {
    const budget: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };
    const { trimmed } = assembleContext({
      project: makeProject(),
      userPrompt: 'x',
      selection: { start: 0, end: 1 },
      pinned: [{ kind: 'clip', id: 'c1', label: 'intro.mp4 0–5s' }],
      budget,
    });
    expect(trimmed).toEqual(expect.arrayContaining(['pinned', 'selection']));
    // pinned is dropped before selection — verify by relative order in the drop list.
    expect(trimmed.indexOf('pinned')).toBeLessThan(trimmed.indexOf('selection'));
  });
});

describe('boundedHistory', () => {
  it('drops system/tool roles and blank turns', () => {
    const result = boundedHistory([
      { role: 'system', content: 'ignore me' },
      { role: 'tool', content: 'tool output' },
      { role: 'user', content: '   ' },
      { role: 'user', content: 'keep me' },
    ]);
    expect(result).toEqual([{ role: 'user', content: 'keep me' }]);
  });

  it('keeps only the most-recent window', () => {
    const many: AiMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    const result = boundedHistory(many);
    expect(result).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(result.at(-1)?.content).toBe('m19');
  });

  it('returns empty for undefined/empty input', () => {
    expect(boundedHistory(undefined)).toEqual([]);
    expect(boundedHistory([])).toEqual([]);
  });
});

describe('per-section accounting (ADR 0080)', () => {
  it('reports every assembled block with a label and a cost', () => {
    const project = makeProject();
    const { sections } = assembleContext({ project, userPrompt: 'tighten the intro' });
    const labels = sections.map((s) => s.label);
    expect(labels).toContain('system contract');
    expect(labels).toContain('project header');
    expect(labels).toContain('timeline summary');
    expect(labels).toContain('user request');
    for (const section of sections) {
      expect(section.tokenEstimate).toBeGreaterThan(0);
    }
  });

  // GAP-012 (run `fc10301a`). `summarizeTimeline` describes what has been PLACED; nothing
  // described the material waiting to be placed. So a montage run spent a `list_assets`
  // call to learn what it was editing, and — because the action log keeps payloads for
  // only its two freshest entries — more calls recalling the same list later. That run
  // retrieved one unchanging list of 62 asset ids five times.
  describe('media bin', () => {
    const withAssets = (count: number, placedIds: readonly string[] = []) =>
      makeProject({
        assets: Array.from({ length: count }, (_, i) => ({
          id: `asset_p${String(i)}`,
          path: `media/p${String(i)}.jpeg`,
          kind: 'image' as const,
          durationSeconds: 5,
        })),
        timeline: {
          tracks: [
            {
              id: 'video_1',
              type: 'video' as const,
              clips: placedIds.map((assetId, i) => ({
                id: `c_${assetId}`,
                assetId,
                trackId: 'video_1',
                start: i,
                end: i + 1,
                sourceStart: 0,
                sourceEnd: 1,
                effects: [],
                keyframes: [],
              })),
            },
          ],
        },
      } as never);

    it('answers "what have I not used yet" — the question a montage asks every turn', () => {
      const text = summarizeMediaBin(withAssets(4, ['asset_p0', 'asset_p2']));
      expect(text).toContain('4 asset(s), 2 placed, 2 not yet used');
      expect(text).toContain('- asset_p0 [image] 5s · placed');
      expect(text).toContain('- asset_p1 [image] 5s');
      expect(text).not.toContain('- asset_p1 [image] 5s · placed');
    });

    it('bounds itself by characters and says how to read the rest', () => {
      const text = summarizeMediaBin(withAssets(400));
      expect(text.length).toBeLessThan(4500);
      // Never trails off: a run told "+37 more" with no route to them invents ids.
      expect(text).toMatch(/…and \d+ more — call list_assets to read them all/);
    });

    it('shows a 61-photo library whole — the size an editor actually imports', () => {
      const text = summarizeMediaBin(withAssets(61));
      expect(text).not.toContain('more — call list_assets');
      expect(text).toContain('asset_p60');
    });

    it('is absent for a project with an empty bin', () => {
      expect(summarizeMediaBin(makeProject({ assets: [] } as never))).toBe('');
    });

    it('is absent once every asset is on the timeline', () => {
      // The block answers "what is there still to place". With nothing left, the timeline
      // summary above is already the complete account of the project's material, and a
      // second listing of the same ids is weight the grounding tiers could have used.
      expect(summarizeMediaBin(withAssets(2, ['asset_p0', 'asset_p1']))).toBe('');
    });
  });

  describe('summarizeSourceMedia', () => {
    it('states file, dimensions and whether the source fits the sequence orientation', () => {
      const project = makeProject({
        resolution: { width: 1080, height: 1920 },
        assets: [
          { id: 'a1', path: 'media/p/camera.mov', kind: 'video', durationSeconds: 40, media: { width: 3840, height: 2160 } },
          { id: 'a2', path: 'media/p/vertical.mp4', kind: 'video', durationSeconds: 30, media: { width: 1080, height: 1920 } },
          { id: 'a3', path: 'media/p/beat.wav', kind: 'audio', durationSeconds: 30 },
          { id: 'a4', path: 'media/p/unknown.mp4', kind: 'video' },
        ],
      } as never);
      const text = summarizeSourceMedia(project);
      expect(text).toContain('- a1 camera.mov · 3840×2160 landscape — sequence is portrait: fills the frame only with a crop, else letterboxed');
      expect(text).toContain('- a2 vertical.mp4 · 1080×1920 portrait — matches the sequence');
      expect(text).toContain('- a3 beat.wav · audio');
      expect(text).toContain('- a4 unknown.mp4');
      expect(text).not.toContain('a4 unknown.mp4 ·');
    });

    it('is absent with no assets and bounds itself with a route to the rest', () => {
      expect(summarizeSourceMedia(makeProject({ assets: [] } as never))).toBe('');
      const many = makeProject({
        assets: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, path: `media/x/photo-${i}.jpg`, kind: 'image', media: { width: 4000, height: 3000 } })),
      } as never);
      const text = summarizeSourceMedia(many);
      expect(text.length).toBeLessThan(2100);
      expect(text).toMatch(/…and \d+ more — call list_assets/);
    });

    it('reaches the assembled context beside the media bin', () => {
      const project = makeProject({
        resolution: { width: 1080, height: 1920 },
        assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30, media: { width: 1920, height: 1080 } }],
      } as never);
      const messages = buildContext({ project, userPrompt: 'make it vertical' });
      const all = messages.map((m) => m.content).join('\n');
      expect(all).toContain('Source media');
      expect(all).toContain('1920×1080 landscape — sequence is portrait');
    });
  });

  it('distinguishes blocks that share a tier, so the UI can name what took the room', () => {
    const project = makeProject();
    const { sections } = assembleContext({
      project,
      userPrompt: 'cut it down',
      visualStatus: 'Visual index: 100% covered, 420 vectors, local backend.',
      footageMap: 'Chapter 1 (0–12s): the hook.',
    });
    const timeline = sections.filter((s) => s.tier === 'timeline').map((s) => s.label);
    // No media-bin block here: this fixture's only asset is already on the timeline, so
    // the bin has nothing to add (GAP-012).
    expect(timeline).toEqual(['timeline summary', 'source media', 'visual index status', 'footage map']);
  });

  it('adds the media bin to the timeline tier when material is waiting to be placed', () => {
    const { sections } = assembleContext({
      project: makeProject({
        assets: [
          { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 },
          { id: 'asset_2', path: 'media/b.jpeg', kind: 'image', durationSeconds: 5 },
        ],
      } as never),
      userPrompt: 'cut it down',
    });
    const timeline = sections.filter((s) => s.tier === 'timeline').map((s) => s.label);
    // Directly under the timeline summary: together they are "what has been placed" and
    // "what there is to place", which is the pair a montage reasons over.
    expect(timeline).toEqual(['timeline summary', 'media bin', 'source media']);
  });

  it('keeps a dropped section in the account, marked not-included', () => {
    const project = makeProject({ transcript: [{ word: 'hello', start: 0, end: 1 }] });
    const tight: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };
    const { sections, trimmed } = assembleContext({
      project,
      userPrompt: 'shorten this',
      budget: tight,
    });
    expect(trimmed).toContain('transcript');
    const transcript = sections.find((s) => s.tier === 'transcript');
    expect(transcript).toMatchObject({ included: false });
    expect(transcript?.tokenEstimate).toBeGreaterThan(0);
  });

  it('totals the dropped tokens so compaction can be reported as a real amount', () => {
    const project = makeProject({ transcript: [{ word: 'hello', start: 0, end: 1 }] });
    const tight: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };
    const { sections, droppedTokenEstimate } = assembleContext({
      project,
      userPrompt: 'shorten this',
      budget: tight,
    });
    const omitted = sections
      .filter((s) => !s.included)
      .reduce((sum, s) => sum + s.tokenEstimate, 0);
    expect(droppedTokenEstimate).toBe(omitted);
    expect(droppedTokenEstimate).toBeGreaterThan(0);
  });

  it('reports zero dropped tokens when nothing was trimmed', () => {
    const project = makeProject();
    const { droppedTokenEstimate, sections } = assembleContext({
      project,
      userPrompt: 'add captions',
    });
    expect(droppedTokenEstimate).toBe(0);
    expect(sections.every((s) => s.included)).toBe(true);
  });

  it('counts the whole history window, and marks it excluded when history is dropped', () => {
    const project = makeProject();
    const history: AiMessage[] = [
      { role: 'user', content: 'make it punchier' },
      { role: 'assistant', content: 'done — trimmed 4s of silence' },
    ];
    const kept = assembleContext({ project, userPrompt: 'now add captions', history });
    const historySection = kept.sections.find((s) => s.tier === 'history');
    expect(historySection?.included).toBe(true);
    expect(historySection?.label).toContain('2 of 2');

    const tight: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };
    const dropped = assembleContext({
      project,
      userPrompt: 'now add captions',
      history,
      budget: tight,
    });
    expect(dropped.sections.find((s) => s.tier === 'history')?.included).toBe(false);
  });
});
