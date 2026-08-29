/**
 * Deterministic timeline outcomes for the journeys `plan/system-mission/USE-CASES.md`
 * routes through P4.1 — the task's own "Done when".
 *
 * ## Why this file exists instead of eight new semantic operations
 *
 * P4.1 tabled eight named ops (`cut_to_beat`, `create_hook`, `tighten_pacing`,
 * `insert_broll`, `emphasize_word`, `match_reference_style`, `create_transition`,
 * `add_motion_graphic`). Only one of them, `remove_silences`, was ever built, and it was
 * built because a measurement PROVED a failure the primitives could not survive: 6/6
 * baseline dead-air runs died echoing ~110 silence ranges through an 8,192-token output
 * window. The measured after-runs do not produce that shape for any of the other eight
 * (the refusals are written up in `04-EDITING-QUALITY-AND-VERIFICATION.md` and
 * `docs/reports/system-mission/04-after.md`), so what P4.1 actually owes is not more tool
 * surface — it is proof that the COMPOSITIONS those names describe land the timeline
 * outcome the journey asks for.
 *
 * That is what each test below asserts: the clip times, counts and keyframes on the
 * timeline after a real `streamAgent` run, plus — where the journey promises it — that the
 * whole thing inverts back to the timeline the user started with.
 *
 * Rows covered elsewhere, deliberately not duplicated here:
 *  - **UC-03** (remove dead air) — `remove-silences.test.ts` (ripple deletes, last to
 *    first, and the seconds removed) and `silence-cut.test.ts` (the arithmetic).
 *  - **UC-05** (sync cuts to music) — `beat-grid-wiring.test.ts` asserts that near-miss
 *    picture cuts are snapped onto the DETECTED onsets in a real run. That is
 *    `cut_to_beat`, already deterministic and already wired.
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, invertPatch, type Patch } from '@framepilot/editor-core';
import { parseProject, type Project, type Timeline } from '@framepilot/timeline-schema';
import type { AiEvent } from './events.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { HostToolExecutor } from './tool-executor.js';
import { Orchestrator, type StreamOptions } from './orchestrator.js';

interface ScriptedCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Emits one scripted batch of tool calls on the first turn, then settles. */
class ScriptedProvider implements AiProvider {
  private index = 0;
  public readonly name = 'mock' as const;
  public constructor(private readonly calls: readonly ScriptedCall[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    if (this.index === 1) {
      return {
        text: '',
        toolCalls: this.calls.map((call, i) => ({ id: `c${String(i)}`, ...call })),
      };
    }
    return { text: 'Done.', toolCalls: [] };
  }
}

/** No host tool is needed by any journey here; every call is an in-process mutation. */
const inertExecutor: HostToolExecutor = {
  async run() {
    return { status: 'completed', summary: 'ok' };
  },
};

const FPS = 30;
const FRAME = 1 / FPS;
/** Half a frame — the grid tolerance the mission rubric uses. */
const HALF_FRAME = FRAME / 2;

function options(id: string): StreamOptions {
  return { conversationId: `conv_${id}`, turnId: `turn_${id}`, now: () => 1000 };
}

/** Run one turn and return every event it emitted. */
async function runTurn(
  project: Project,
  userPrompt: string,
  calls: readonly ScriptedCall[],
  id: string,
): Promise<AiEvent[]> {
  const orchestrator = new Orchestrator(new ScriptedProvider(calls), { executor: inertExecutor });
  const events: AiEvent[] = [];
  for await (const event of orchestrator.streamAgent({ project, userPrompt }, options(id))) {
    events.push(event);
  }
  return events;
}

/** The patches the run actually applied, in order. */
function appliedPatches(events: readonly AiEvent[]): Patch[] {
  const patches: Patch[] = [];
  for (const event of events) {
    if (event.type !== 'diff') continue;
    if (!event.edit.validation.valid) continue;
    patches.push(event.edit.patch as Patch);
  }
  return patches;
}

/** Replay the applied patches onto the starting timeline — the state the user is left in. */
function timelineAfter(project: Project, patches: readonly Patch[]): Timeline {
  let working = project.timeline;
  for (const patch of patches) working = applyPatch(working, patch);
  return working;
}

/**
 * Undo every applied patch, newest first — "one undo reverts all", walked for real.
 *
 * Returns the TRACKS rather than the whole timeline: `revision` is a monotonic counter that
 * every apply bumps, including the inverse ones, so it is expected to differ after a
 * round-trip and comparing it would assert the opposite of what undo promises.
 */
function tracksAfterUndo(project: Project, patches: readonly Patch[]): Timeline['tracks'] {
  const inverses: Patch[] = [];
  let working = project.timeline;
  for (const patch of patches) {
    inverses.push(invertPatch(working, patch));
    working = applyPatch(working, patch);
  }
  for (let i = inverses.length - 1; i >= 0; i -= 1) working = applyPatch(working, inverses[i]!);
  return working.tracks;
}

const trackOf = (timeline: Timeline, id: string) => {
  const track = timeline.tracks.find((candidate) => candidate.id === id);
  if (!track) throw new Error(`no track ${id}`);
  return track;
};

const pictureClips = (timeline: Timeline) =>
  timeline.tracks.filter((t) => t.type === 'video' || t.type === 'overlay').flatMap((t) => t.clips);

/** Every clip edge, which is what the frame-grid and mid-word checks are asked about. */
const edges = (timeline: Timeline): number[] =>
  pictureClips(timeline).flatMap((clip) => [clip.start, clip.end]);

const offGrid = (seconds: number): number => Math.abs(seconds - Math.round(seconds * FPS) / FPS);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Raw footage in the bin, an empty picture track to assemble onto. UC-01, UC-11. */
function rawFootageProject(): Project {
  return parseProject({
    id: 'proj_uc',
    name: 'Raw footage',
    version: 1,
    fps: FPS,
    resolution: { width: 1080, height: 1920 },
    assets: [1, 2, 3, 4, 5].map((n) => ({
      id: `asset_${String(n)}`,
      path: `media/raw${String(n)}.mov`,
      kind: 'video' as const,
      durationSeconds: 40,
    })),
    timeline: {
      tracks: [
        { id: 'video_1', type: 'video', clips: [] },
        { id: 'overlay_1', type: 'overlay', clips: [] },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/**
 * A single long take with a word-timed transcript. UC-02, UC-10.
 *
 * One word every second, half a second of speech and half a second of gap, so a cut on a
 * whole second is clean and a cut at `n + 0.25` is squarely inside a word — the two cases
 * `no-mid-word-cuts` distinguishes.
 */
function talkProject(): Project {
  const words = Array.from({ length: 120 }, (_, i) => ({
    word: i === 42 ? 'product' : `w${String(i)}`,
    start: i,
    end: i + 0.5,
  }));
  return parseProject({
    id: 'proj_talk',
    name: 'Talk',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset_talk', path: 'media/talk.mp4', kind: 'video', durationSeconds: 120 },
      { id: 'asset_broll', path: 'media/broll.mov', kind: 'video', durationSeconds: 20 },
    ],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_take',
              assetId: 'asset_talk',
              trackId: 'video_1',
              start: 0,
              end: 120,
              sourceStart: 0,
              sourceEnd: 120,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
    transcript: words,
    aiMemory: {},
    history: [],
  });
}

/** Is `time` strictly inside a spoken word? The rubric's `no-mid-word-cuts` question. */
function insideAWord(project: Project, time: number): boolean {
  return project.transcript.some((word) => time > word.start + 1e-6 && time < word.end - 1e-6);
}

// ---------------------------------------------------------------------------
// UC-01 — raw recording → 30-second social montage
// ---------------------------------------------------------------------------

describe('UC-01 raw recording → 30-second montage (plan/system-mission P4.1)', () => {
  /** Eight varied shots that sum to exactly 30s, laid out with one `add_clips` call. */
  const SHOTS = [
    { assetId: 'asset_1', start: 0, end: 4 },
    { assetId: 'asset_2', start: 4, end: 7 },
    { assetId: 'asset_3', start: 7, end: 12 },
    { assetId: 'asset_4', start: 12, end: 14 },
    { assetId: 'asset_5', start: 14, end: 19 },
    { assetId: 'asset_1', start: 19, end: 22 },
    { assetId: 'asset_2', start: 22, end: 26 },
    { assetId: 'asset_3', start: 26, end: 30 },
  ];

  it('lands a 30s montage of varied shots, on frames, with no overlaps', async () => {
    const project = rawFootageProject();
    const events = await runTurn(
      project,
      'make a 30 second montage of the best moments',
      [{ name: 'add_clips', arguments: { trackId: 'video_1', clips: SHOTS } }],
      'uc01',
    );
    const patches = appliedPatches(events);
    expect(patches.length).toBeGreaterThan(0);
    const after = timelineAfter(project, patches);
    const clips = [...trackOf(after, 'video_1').clips].sort((a, b) => a.start - b.start);

    // ≥N clips placed on the picture track.
    expect(clips.length).toBe(SHOTS.length);
    // Total ≈ 30s ±1s.
    const duration = Math.max(...clips.map((c) => c.end));
    expect(duration).toBeGreaterThanOrEqual(29);
    expect(duration).toBeLessThanOrEqual(31);
    // Cuts on frames.
    for (const edge of edges(after)) expect(offGrid(edge)).toBeLessThanOrEqual(HALF_FRAME);
    // No overlaps, and no gap left behind: the montage is a continuous cut.
    for (let i = 1; i < clips.length; i += 1) {
      expect(clips[i]!.start).toBeCloseTo(clips[i - 1]!.end, 6);
    }
    // Shot lengths actually vary — a montage, not eight equal slices.
    const lengths = new Set(clips.map((c) => Number((c.end - c.start).toFixed(3))));
    expect(lengths.size).toBeGreaterThan(1);
  });

  it('reverts to the empty timeline in one undo', async () => {
    const project = rawFootageProject();
    const events = await runTurn(
      project,
      'make a 30 second montage of the best moments',
      [{ name: 'add_clips', arguments: { trackId: 'video_1', clips: SHOTS } }],
      'uc01undo',
    );
    const patches = appliedPatches(events);
    expect(patches.length).toBeGreaterThan(0);
    expect(tracksAfterUndo(project, patches)).toEqual(project.timeline.tracks);
  });
});

// ---------------------------------------------------------------------------
// UC-02 — podcast highlight
// ---------------------------------------------------------------------------

describe('UC-02 podcast highlight (plan/system-mission P4.1)', () => {
  it('trims to a transcript-grounded 60s window without cutting a word in half', async () => {
    const project = talkProject();
    // 20.5 and 80.5 sit in the GAPS after words 20 and 80 — the choice a transcript-led
    // trim makes. The window is 60s, which is what the journey asked for.
    const events = await runTurn(
      project,
      'pull the best 60 seconds for a clip',
      [{ name: 'trim_clip', arguments: { clipId: 'clip_take', start: 20.5, end: 80.5 } }],
      'uc02',
    );
    const after = timelineAfter(project, appliedPatches(events));
    const clip = trackOf(after, 'video_1').clips[0]!;
    expect(clip.end - clip.start).toBeCloseTo(60, 1);
    for (const edge of [clip.start, clip.end]) {
      expect(insideAWord(project, edge)).toBe(false);
      expect(offGrid(edge)).toBeLessThanOrEqual(HALF_FRAME);
    }
  });

  it('the mid-word case the check is meant to catch really is mid-word', () => {
    // Guards the assertion above: if `insideAWord` could never be true, the test proves
    // nothing. Word 20 runs 20.0–20.5, so 20.25 is inside it.
    expect(insideAWord(talkProject(), 20.25)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UC-10 — b-roll insertion
// ---------------------------------------------------------------------------

describe('UC-10 b-roll over a transcript-anchored range (plan/system-mission P4.1)', () => {
  it('places the cutaway on the picture layer without overlapping the take (ADR 0140)', async () => {
    const project = talkProject();
    // The anchor is read off the transcript, not invented: the word "product" is at 42.
    const anchor = project.transcript.find((w) => w.word === 'product')!;
    const start = anchor.start;
    const end = anchor.start + 3;

    const events = await runTurn(
      project,
      'add b-roll over the part where I talk about the product',
      [
        { name: 'split_clip', arguments: { clipId: 'clip_take', at: start } },
        { name: 'delete_range', arguments: { trackId: 'video_1', start, end } },
        {
          name: 'add_clip',
          arguments: {
            trackId: 'video_1',
            assetId: 'asset_broll',
            start,
            end,
            sourceStart: 0,
          },
        },
      ],
      'uc10',
    );
    const after = timelineAfter(project, appliedPatches(events));
    const clips = [...trackOf(after, 'video_1').clips].sort((a, b) => a.start - b.start);

    // The cutaway occupies exactly the anchored range…
    const cutaway = clips.find((c) => c.assetId === 'asset_broll');
    expect(cutaway).toBeDefined();
    expect(cutaway!.start).toBeCloseTo(start, 6);
    expect(cutaway!.end).toBeCloseTo(end, 6);
    // …and nothing else on the picture layer overlaps it (ADR 0140: cutaway, not overlay).
    for (const clip of clips) {
      if (clip === cutaway) continue;
      expect(clip.end <= cutaway!.start + 1e-6 || clip.start >= cutaway!.end - 1e-6).toBe(true);
    }
    // The take is not shortened overall — a cutaway replaces picture, it does not ripple.
    expect(Math.max(...clips.map((c) => c.end))).toBeCloseTo(120, 6);
  });
});

// ---------------------------------------------------------------------------
// UC-11 — animated motion graphic (lower third)
// ---------------------------------------------------------------------------

describe('UC-11 lower third with keyframes (plan/system-mission P4.1)', () => {
  it('creates the text clip and animates it, and undo removes both', async () => {
    const project = rawFootageProject();
    const events = await runTurn(
      project,
      'add a lower third that says Rojan Acharya',
      [
        {
          name: 'add_text_layer',
          arguments: {
            trackId: 'overlay_1',
            text: 'Rojan Acharya',
            start: 1,
            end: 5,
            sizePercent: 8,
            yPercent: 80,
          },
        },
      ],
      'uc11',
    );
    const patches = appliedPatches(events);
    const after = timelineAfter(project, patches);
    const overlay = trackOf(after, 'overlay_1').clips;
    expect(overlay.length).toBe(1);
    const lowerThird = overlay[0]!;
    expect(lowerThird.start).toBeCloseTo(1, 6);
    expect(lowerThird.end).toBeCloseTo(5, 6);

    // Animate it in a second turn, against the timeline the first turn produced.
    const animated = { ...project, timeline: after } as Project;
    const second = await runTurn(
      animated,
      'animate it in',
      [
        {
          name: 'add_keyframes',
          arguments: {
            clipId: lowerThird.id,
            keyframes: [
              { property: 'opacity', time: 0, value: 0 },
              { property: 'opacity', time: 0.5, value: 1 },
            ],
          },
        },
      ],
      'uc11kf',
    );
    const secondPatches = appliedPatches(second);
    const finalTimeline = timelineAfter(animated, secondPatches);
    const finalClip = trackOf(finalTimeline, 'overlay_1').clips[0]!;
    expect(finalClip.keyframes.length).toBe(2);
    expect(finalClip.keyframes.map((k) => k.property)).toEqual(['opacity', 'opacity']);

    // Both steps invert as units: the keyframes go, then the clip goes.
    expect(tracksAfterUndo(animated, secondPatches)).toEqual(after.tracks);
    expect(tracksAfterUndo(project, patches)).toEqual(project.timeline.tracks);
  });
});
