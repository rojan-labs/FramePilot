/**
 * `caption_the_edit` on real ASR timings, replayed from run `7d159862`.
 *
 * The bug this pins: caption cues were segmented without knowing the project frame
 * grid, while `assembleEdit` quantizes sequence times to it with *nearest* rounding.
 * A 0.02s ASR artifact ("build", 18.06→18.08) put a cue's start and end on the same
 * frame at 30fps, so `add_caption_layer.end must be greater than start.` rejected it
 * — and because a patch is all-or-nothing, the other 62 perfectly good cues went with
 * it. That is 584 rejected operations across the run's four attempts
 * (126 + 126 + 206 + 126: every preset the model reached for collapsed the same cue,
 * so no parameter change could escape it), and roughly 10 of its 18 model calls.
 *
 * This is the same defect as `delete-clip-grid.test.ts`, which fixed it for
 * `delete_clip` alone and left the general hazard in place. The transcript below is
 * the real one from that run, unedited — 12 of its 149 words are shorter than a
 * frame, which is ordinary for ASR and must not be able to reject an edit.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project, type TranscriptWord } from '@framepilot/timeline-schema';
import { buildTimelineMap, deriveCaptionCues, captionSegmentConfig } from '@framepilot/editor-core';
import type { AnyOperation } from '@framepilot/editor-core';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { applyProjectPatch } from '@framepilot/editor-core';
import { AGENT_MAX_OPS_PER_TURN } from '../kernel/conductor.js';

const ASSET = 'asset_isom_batch1_assignment1';
/** The clip the run placed: the whole recording, 0 → 49.767s. */
const DURATION = 49.766666666666666;

const TRANSCRIPT: readonly TranscriptWord[] = [
  { word: 'Today', start: 0.06, end: 0.25, assetId: ASSET },
  { word: 'we', start: 0.25, end: 0.35, assetId: ASSET },
  { word: 'are', start: 0.35, end: 0.48, assetId: ASSET },
  { word: 'talking', start: 0.55, end: 0.85, assetId: ASSET },
  { word: 'about', start: 0.85, end: 1.09, assetId: ASSET },
  { word: 'mastering', start: 1.1, end: 1.56, assetId: ASSET },
  { word: 'motion', start: 1.56, end: 1.86, assetId: ASSET },
  { word: 'design.', start: 1.86, end: 2.22, assetId: ASSET },
  { word: 'If', start: 2.48, end: 2.49, assetId: ASSET },
  { word: 'you', start: 2.54, end: 2.6, assetId: ASSET },
  { word: 'want', start: 2.6, end: 2.9, assetId: ASSET },
  { word: 'to', start: 2.9, end: 3.05, assetId: ASSET },
  { word: 'craft', start: 3.05, end: 3.43, assetId: ASSET },
  { word: 'videos', start: 3.43, end: 3.92, assetId: ASSET },
  { word: 'that', start: 3.92, end: 4.2, assetId: ASSET },
  { word: 'make', start: 4.2, end: 4.48, assetId: ASSET },
  { word: 'founders', start: 4.48, end: 5.04, assetId: ASSET },
  { word: 'stop', start: 5.04, end: 5.32, assetId: ASSET },
  { word: 'scrolling,', start: 5.32, end: 5.96, assetId: ASSET },
  { word: 'there', start: 6.3, end: 6.31, assetId: ASSET },
  { word: 'are', start: 6.36, end: 6.47, assetId: ASSET },
  { word: '8', start: 6.47, end: 6.66, assetId: ASSET },
  { word: 'principles', start: 6.66, end: 7.3, assetId: ASSET },
  { word: 'you', start: 7.3, end: 7.49, assetId: ASSET },
  { word: 'need', start: 7.51, end: 7.76, assetId: ASSET },
  { word: 'to', start: 7.76, end: 7.89, assetId: ASSET },
  { word: 'know.', start: 7.89, end: 8.38, assetId: ASSET },
  { word: 'I', start: 8.43, end: 8.44, assetId: ASSET },
  { word: 'call', start: 8.48, end: 8.65, assetId: ASSET },
  { word: 'this', start: 8.65, end: 8.87, assetId: ASSET },
  { word: 'the', start: 8.87, end: 9.04, assetId: ASSET },
  { word: 'motion', start: 9.04, end: 9.37, assetId: ASSET },
  { word: 'archetype.', start: 9.37, end: 10.08, assetId: ASSET },
  { word: 'Hi,', start: 10.2, end: 10.34, assetId: ASSET },
  { word: 'my', start: 10.34, end: 10.46, assetId: ASSET },
  { word: 'name', start: 10.46, end: 10.74, assetId: ASSET },
  { word: 'is', start: 10.74, end: 10.87, assetId: ASSET },
  { word: 'Shamra', start: 10.87, end: 11.27, assetId: ASSET },
  { word: 'Dotto', start: 11.27, end: 11.66, assetId: ASSET },
  { word: 'and', start: 11.66, end: 11.84, assetId: ASSET },
  { word: 'I', start: 11.84, end: 11.9, assetId: ASSET },
  { word: 'am', start: 11.9, end: 12.02, assetId: ASSET },
  { word: 'building', start: 12.02, end: 12.38, assetId: ASSET },
  { word: 'Indian', start: 12.64, end: 12.88, assetId: ASSET },
  { word: 'School', start: 12.88, end: 13.25, assetId: ASSET },
  { word: 'of', start: 13.25, end: 13.37, assetId: ASSET },
  { word: 'Motion.', start: 13.37, end: 13.76, assetId: ASSET },
  { word: "India's", start: 14.1, end: 14.19, assetId: ASSET },
  { word: 'first', start: 14.19, end: 14.5, assetId: ASSET },
  { word: 'motion', start: 14.5, end: 14.88, assetId: ASSET },
  { word: 'design', start: 14.88, end: 15.26, assetId: ASSET },
  { word: 'focus', start: 15.26, end: 15.57, assetId: ASSET },
  { word: 'school', start: 15.57, end: 15.98, assetId: ASSET },
  { word: 'with', start: 15.98, end: 16.34, assetId: ASSET },
  { word: 'one', start: 16.59, end: 16.76, assetId: ASSET },
  { word: 'mission.', start: 16.8, end: 17.58, assetId: ASSET },
  { word: 'To', start: 18, end: 18.01, assetId: ASSET },
  { word: 'build', start: 18.06, end: 18.08, assetId: ASSET },
  { word: "India's", start: 18.08, end: 18.58, assetId: ASSET },
  { word: 'top', start: 18.58, end: 18.79, assetId: ASSET },
  { word: '1%', start: 18.79, end: 19.07, assetId: ASSET },
  { word: 'of', start: 19.07, end: 19.21, assetId: ASSET },
  { word: 'motion', start: 19.31, end: 19.64, assetId: ASSET },
  { word: 'designers.', start: 19.64, end: 20.58, assetId: ASSET },
  { word: 'Why', start: 20.77, end: 20.78, assetId: ASSET },
  { word: 'me?', start: 20.8, end: 21.1, assetId: ASSET },
  { word: "I've", start: 21.28, end: 21.29, assetId: ASSET },
  { word: 'scaled', start: 21.34, end: 21.59, assetId: ASSET },
  { word: 'my', start: 21.59, end: 21.69, assetId: ASSET },
  { word: 'own', start: 21.69, end: 21.84, assetId: ASSET },
  { word: 'YouTube', start: 21.84, end: 22.18, assetId: ASSET },
  { word: 'channel', start: 22.18, end: 22.5, assetId: ASSET },
  { word: 'to', start: 22.58, end: 22.62, assetId: ASSET },
  { word: 'over', start: 22.62, end: 22.82, assetId: ASSET },
  { word: '1,50,000', start: 22.82, end: 23.88, assetId: ASSET },
  { word: 'subscribers', start: 23.98, end: 24.5, assetId: ASSET },
  { word: 'and', start: 24.56, end: 24.67, assetId: ASSET },
  { word: 'worked', start: 24.67, end: 24.98, assetId: ASSET },
  { word: 'with', start: 25.05, end: 25.25, assetId: ASSET },
  { word: 'billion', start: 25.25, end: 25.66, assetId: ASSET },
  { word: 'dollar', start: 25.66, end: 26.01, assetId: ASSET },
  { word: 'companies.', start: 26.01, end: 26.74, assetId: ASSET },
  { word: 'But', start: 26.92, end: 26.97, assetId: ASSET },
  { word: 'why', start: 26.97, end: 27.2, assetId: ASSET },
  { word: 'now?', start: 27.2, end: 27.66, assetId: ASSET },
  { word: 'Because', start: 27.72, end: 28.05, assetId: ASSET },
  { word: 'building', start: 28.05, end: 28.49, assetId: ASSET },
  { word: 'apps', start: 28.49, end: 28.71, assetId: ASSET },
  { word: 'have', start: 28.71, end: 28.88, assetId: ASSET },
  { word: 'been', start: 28.97, end: 29.15, assetId: ASSET },
  { word: 'completely', start: 29.15, end: 29.69, assetId: ASSET },
  { word: 'commoditized', start: 29.69, end: 30.4, assetId: ASSET },
  { word: 'thanks', start: 30.46, end: 30.86, assetId: ASSET },
  { word: 'to', start: 30.86, end: 31.01, assetId: ASSET },
  { word: 'ChatGPT', start: 31.01, end: 31.53, assetId: ASSET },
  { word: 'and', start: 31.53, end: 31.76, assetId: ASSET },
  { word: 'Claude.', start: 31.76, end: 32.5, assetId: ASSET },
  { word: 'Over', start: 32.7, end: 32.82, assetId: ASSET },
  { word: '557,000', start: 32.82, end: 34.42, assetId: ASSET },
  { word: 'apps', start: 34.42, end: 34.74, assetId: ASSET },
  { word: 'were', start: 34.74, end: 34.92, assetId: ASSET },
  { word: 'built', start: 35.14, end: 35.46, assetId: ASSET },
  { word: 'last', start: 35.46, end: 35.76, assetId: ASSET },
  { word: 'year', start: 35.81, end: 36.1, assetId: ASSET },
  { word: 'by', start: 36.1, end: 36.26, assetId: ASSET },
  { word: 'AI', start: 36.26, end: 36.42, assetId: ASSET },
  { word: 'over', start: 36.42, end: 36.74, assetId: ASSET },
  { word: 'a', start: 36.74, end: 36.81, assetId: ASSET },
  { word: 'weekend.', start: 36.87, end: 37.64, assetId: ASSET },
  { word: 'The', start: 37.82, end: 37.83, assetId: ASSET },
  { word: 'product', start: 37.88, end: 38.17, assetId: ASSET },
  { word: "isn't", start: 38.17, end: 38.43, assetId: ASSET },
  { word: 'the', start: 38.43, end: 38.59, assetId: ASSET },
  { word: 'problem', start: 38.59, end: 38.96, assetId: ASSET },
  { word: 'anymore,', start: 38.96, end: 39.46, assetId: ASSET },
  { word: 'getting', start: 39.46, end: 39.99, assetId: ASSET },
  { word: 'attention', start: 39.99, end: 40.67, assetId: ASSET },
  { word: 'is.', start: 40.67, end: 40.84, assetId: ASSET },
  { word: 'And', start: 41.18, end: 41.19, assetId: ASSET },
  { word: 'you', start: 41.24, end: 41.28, assetId: ASSET },
  { word: 'can', start: 41.28, end: 41.5, assetId: ASSET },
  { word: 'be', start: 41.5, end: 41.64, assetId: ASSET },
  { word: 'the', start: 41.64, end: 41.86, assetId: ASSET },
  { word: 'one', start: 41.86, end: 42.08, assetId: ASSET },
  { word: 'to', start: 42.08, end: 42.22, assetId: ASSET },
  { word: 'solve', start: 42.22, end: 42.59, assetId: ASSET },
  { word: 'it.', start: 42.59, end: 42.99, assetId: ASSET },
  { word: 'We', start: 43.11, end: 43.12, assetId: ASSET },
  { word: 'are', start: 43.12, end: 43.28, assetId: ASSET },
  { word: 'not', start: 43.28, end: 43.45, assetId: ASSET },
  { word: 'just', start: 43.45, end: 43.68, assetId: ASSET },
  { word: 'teaching', start: 43.68, end: 44.13, assetId: ASSET },
  { word: 'after', start: 44.15, end: 44.44, assetId: ASSET },
  { word: 'effects', start: 44.44, end: 44.89, assetId: ASSET },
  { word: 'but', start: 44.9, end: 45.13, assetId: ASSET },
  { word: 'how', start: 45.13, end: 45.3, assetId: ASSET },
  { word: 'to', start: 45.51, end: 45.52, assetId: ASSET },
  { word: 'think', start: 45.57, end: 45.89, assetId: ASSET },
  { word: 'from', start: 45.89, end: 46.18, assetId: ASSET },
  { word: 'a', start: 46.23, end: 46.27, assetId: ASSET },
  { word: 'blank', start: 46.27, end: 46.65, assetId: ASSET },
  { word: 'canvas.', start: 46.65, end: 47.38, assetId: ASSET },
  { word: 'So,', start: 47.8, end: 47.81, assetId: ASSET },
  { word: 'welcome', start: 47.86, end: 48, assetId: ASSET },
  { word: 'to', start: 48, end: 48.1, assetId: ASSET },
  { word: 'Indian', start: 48.1, end: 48.43, assetId: ASSET },
  { word: 'School', start: 48.44, end: 48.79, assetId: ASSET },
  { word: 'of', start: 48.79, end: 48.89, assetId: ASSET },
  { word: 'Motion.', start: 48.9, end: 49.48, assetId: ASSET },
];

function talkingHeadProject(fps: number): Project {
  return parseProject({
    id: 'project_talking_ne_mtfnjwek2zac',
    name: 'Talking head',
    version: 1,
    fps,
    resolution: { width: 1080, height: 1920 },
    assets: [
      {
        id: ASSET,
        path: 'media/ISOM_Batch1_Assignment1.mp4',
        kind: 'video',
        durationSeconds: DURATION,
      },
    ],
    transcript: TRANSCRIPT,
    timeline: {
      tracks: [
        {
          id: 'v_main',
          type: 'video',
          clips: [
            {
              id: 'clip__v_main_asset_isom_batch1_assignment1_0',
              assetId: ASSET,
              trackId: 'v_main',
              start: 0,
              end: DURATION,
              sourceStart: 0,
              sourceEnd: DURATION,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'captions_main', type: 'caption', clips: [] },
      ],
      markers: [],
    },
  });
}

/** Build and assemble exactly what the failing turns sent. */
function captionTheEdit(
  project: Project,
  args: Record<string, unknown>,
): ReturnType<typeof assembleEdit> {
  const tool = getTool('caption_the_edit');
  if (!tool || tool.kind !== 'mutate') throw new Error('caption_the_edit is not a mutate tool');
  const ops = tool.buildOps({ trackId: 'captions_main', ...args }, { project }) as AnyOperation[];
  return assembleEdit(project, ops, 'caption the edit', 'agent');
}

/** The four argument sets the run actually tried, in order. */
const ATTEMPTS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['attempt 1 (short-form / 4)', { preset: 'short-form', maxWordsPerCue: 4 }],
  ['attempt 2 (short-form / 4, identical)', { preset: 'short-form', maxWordsPerCue: 4 }],
  ['attempt 3 (subtitle / 5)', { preset: 'subtitle', maxWordsPerCue: 5 }],
  ['attempt 4 (short-form / 4, identical)', { preset: 'short-form', maxWordsPerCue: 4 }],
];

describe('caption_the_edit against the run 7d159862 transcript', () => {
  for (const [label, args] of ATTEMPTS) {
    it(`assembles cleanly — ${label}`, () => {
      const assembled = captionTheEdit(talkingHeadProject(30), args);
      const errors = assembled.validation.issues.filter((issue) => issue.severity === 'error');
      expect(errors).toEqual([]);
      expect(assembled.patch.operations.length).toBeGreaterThan(0);
    });
  }

  it('emits no operation the frame grid can round out of existence, at any rate', () => {
    // Nearest-rounding is applied per edge, so a range narrower than half a frame
    // collapses. Assert against the ASSEMBLED patch — after normalization — because
    // that is the shape the operation contract actually judges.
    for (const fps of [24, 25, 29.97, 30, 50, 60]) {
      for (const preset of ['short-form', 'subtitle', 'one-word'] as const) {
        const assembled = captionTheEdit(talkingHeadProject(fps), { preset });
        expect(
          assembled.validation.issues.filter((i) => i.severity === 'error'),
          `${preset} @ ${fps}fps`,
        ).toEqual([]);
        for (const op of assembled.patch.operations) {
          if (op.type !== 'add_caption_layer') continue;
          expect(op.end, `${preset} @ ${fps}fps: ${JSON.stringify(op)}`).toBeGreaterThan(op.start);
        }
      }
    }
  });

  it('gives every cue a clip id of its own', () => {
    // Ids embed the cue start in milliseconds. Two cues inside one millisecond would
    // collide and `insertClip` would reject the patch for a different reason.
    const assembled = captionTheEdit(talkingHeadProject(30), { preset: 'one-word' });
    const ids = assembled.patch.operations
      .filter(
        (op): op is Extract<typeof op, { type: 'add_caption_layer' }> =>
          op.type === 'add_caption_layer',
      )
      .map((op) => op.clipId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every spoken word — coalescing merges cues, it never drops speech', () => {
    const project = talkingHeadProject(30);
    const cues = deriveCaptionCues(
      buildTimelineMap(project.timeline),
      TRANSCRIPT,
      captionSegmentConfig('short-form', { maxWordsPerCue: 4 }),
      project.fps,
    );
    const captioned = cues.flatMap((cue) => cue.words.map((word) => word.word));
    expect(captioned).toEqual(TRANSCRIPT.map((word) => word.word));
  });
});

/**
 * The SECOND defect in run `7d159862`, and the one that outlived the frame-grid fix
 * above: the operations assemble and validate perfectly, and are then thrown away
 * whole by a blast-radius cap that no layer reports.
 *
 * `caption_the_edit` emits `existingClips + 2 × cues` operations — 3 per cue on a
 * re-caption. A 50-second talking head is ~110 of them. The streaming agent path
 * (`orchestrator.ts`'s `agentRun`, which is what the desktop app runs) bails at
 * `DEFAULT_MAX_OPS_PER_TURN = 100` and returns a turn result with neither a note nor
 * a rejection; the reducer that would have printed "Turn rejected: N operations
 * exceeds the per-turn cap" holds its own, larger copy of the same constant (200) and
 * so never fires. The user is shown `313 proposed changes couldn't be applied to the
 * timeline (; ; )` — three empty strings where three reasons should be.
 *
 * The header above records the counts this cost: 126 + 126 + 206 + 126 operations.
 * Every one of those four attempts was over the cap the moment it was built.
 */
describe('caption_the_edit fits the blast-radius bound the agent enforces', () => {
  /** The project after a first captioning pass — the state a re-caption starts from. */
  function alreadyCaptioned(): Project {
    const first = captionTheEdit(talkingHeadProject(30), { preset: 'short-form' });
    return applyProjectPatch(talkingHeadProject(30), first.patch);
  }

  it('re-captions a 50s talking head within one turn', () => {
    const project = alreadyCaptioned();
    const captions = project.timeline.tracks.find((track) => track.id === 'captions_main');
    expect(captions?.clips.length).toBeGreaterThan(30);

    const again = captionTheEdit(project, { preset: 'short-form' });
    expect(again.validation.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // A re-caption clears every existing cue and writes two operations per new one, so
    // it costs roughly 3 per cue where a first pass costs 2. This is what tipped the
    // captured run over the cap the streaming path enforces but never reports.
    expect(again.patch.operations.length).toBeLessThanOrEqual(AGENT_MAX_OPS_PER_TURN);
  });
});
