/**
 * The frame round trip closes (context-management P3.2 / ADR 0146).
 *
 * "Cut right before she says *but*" is the request the whole phase is about. It has three
 * legs, and until now the middle one was missing:
 *
 *  1. `get_mapped_transcript` reports which FRAME the word starts on.
 *  2. The edit is requested at that frame's time.
 *  3. The applied timeline cuts on that exact frame — not 0.4 of a frame away.
 *
 * These tests walk that round trip through the real tools and the real patch authority,
 * so a change to either end that breaks the correspondence fails here rather than in a
 * render nobody diffed.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  commitProjectPatch,
  emptyHistory,
  frameToSeconds,
  snapSecondsToFrame,
} from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { getTool } from './tool-registry.js';
import type { ToolContext } from './tool-context.js';

const FPS = 30;

/** One 20-second take with a real transcript, so a word boundary is a real place. */
function spokenProject(): Project {
  const words = ['the', 'hand', 'lands', 'but', 'the', 'audio', 'runs', 'on'];
  return parseProject({
    id: 'proj_words',
    name: 'Take',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/take.mp4', kind: 'video', durationSeconds: 20 }],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: 0,
              end: 20,
              sourceStart: 0,
              sourceEnd: 20,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
      revision: 1,
    },
    // Deliberately off-grid word times — a transcriber does not report frames.
    transcript: words.map((word, i) => ({
      word,
      start: 1 + i * 1.1374,
      end: 1 + i * 1.1374 + 0.9,
    })),
    aiMemory: {},
    history: [],
  });
}

const run = (name: string, args: Record<string, unknown>, project: Project): unknown => {
  const tool = getTool(name);
  if (!tool) throw new Error(`no tool ${name}`);
  const ctx: ToolContext = { project };
  return (tool as { readonly read?: (a: never, c: ToolContext) => unknown }).read?.(
    tool.parse(args) as never,
    ctx,
  );
};

describe('a cut aimed at a word lands on that word’s frame', () => {
  const project = spokenProject();

  it('get_mapped_transcript reports a frame span for every word', () => {
    const mapped = run('get_mapped_transcript', {}, project) as {
      fps: number;
      words: { word: string; start: number; startFrame: number; endFrame: number }[];
    };
    expect(mapped.fps).toBe(FPS);
    const but = mapped.words.find((w) => w.word === 'but')!;
    expect(Number.isInteger(but.startFrame)).toBe(true);
    // The reported frame is the nearest one to the word's actual start — not a floor that
    // would place the cut a frame early and clip the consonant.
    expect(Math.abs(frameToSeconds(but.startFrame, FPS) - but.start)).toBeLessThanOrEqual(
      0.5 / FPS + 1e-9,
    );
  });

  /**
   * The word-boundary trap (REMAINING §2.4). Three turns of the session-6 run were lost to
   * a cut landing one frame inside a word, and in every case the run had read the CORRECT
   * frame here and then passed seconds — because every cut tool takes seconds — which
   * `quantizePatch` rounded back across the word edge.
   *
   * The tool was publishing two different answers to "when does this word begin". It now
   * publishes the edit points in both units, naming the same instant, so a run that copies
   * either one lands on the same frame. The raw measurement stays in the payload.
   */
  it('reports the edit point in seconds and in frames as the SAME instant', () => {
    const mapped = run('get_mapped_transcript', {}, project) as {
      fps: number;
      words: {
        word: string;
        start: number;
        end: number;
        startFrame: number;
        endFrame: number;
        startSeconds: number;
        endSeconds: number;
      }[];
    };
    for (const w of mapped.words) {
      expect(w.startSeconds).toBe(frameToSeconds(w.startFrame, FPS));
      expect(w.endSeconds).toBe(frameToSeconds(w.endFrame, FPS));
    }
    // And the raw measurement is still there — the two are not the same number, which is
    // the whole reason publishing only the raw one was a trap.
    const but = mapped.words.find((w) => w.word === 'but')!;
    expect(typeof but.start).toBe('number');
    expect(but.startSeconds).not.toBe(but.start);
  });

  it('a cut aimed at the reported SECONDS survives the quantizer unchanged', () => {
    const mapped = run('get_mapped_transcript', {}, project) as {
      fps: number;
      words: { word: string; startSeconds: number }[];
    };
    for (const w of mapped.words) {
      // `quantizePatch` snaps to the nearest frame; a value already on a frame is a
      // fixed point of it, so no cut can be rounded across the boundary it was aimed at.
      expect(snapSecondsToFrame(w.startSeconds, FPS)).toBe(w.startSeconds);
    }
  });

  it('splitting at the reported frame produces a cut on exactly that frame', () => {
    const mapped = run('get_mapped_transcript', {}, project) as {
      words: { word: string; startFrame: number }[];
    };
    const but = mapped.words.find((w) => w.word === 'but')!;
    const committed = commitProjectPatch(project, emptyHistory(), {
      patchId: 'patch_word' as PatchId,
      createdBy: 'agent',
      reason: 'cut before "but"',
      operations: [
        { type: 'split_clip', clipId: 'clip_a', at: frameToSeconds(but.startFrame, FPS) },
      ],
    });
    const boundaries = run('list_edit_boundaries', {}, committed.project) as {
      frame: number;
      at: number;
    }[];
    expect(boundaries).toHaveLength(1);
    // The round trip: the frame the read reported is the frame the cut is on.
    expect(boundaries[0]!.frame).toBe(but.startFrame);
  });

  it('closes even when the model asks in seconds a hair off the frame', () => {
    // The realistic failure: the model reads the transcript, returns 12.3874s, and 0.4 of
    // a frame decides which frame the cut means. The grid decides it, once, for everyone.
    const mapped = run('get_mapped_transcript', {}, project) as {
      words: { word: string; start: number; startFrame: number }[];
    };
    const but = mapped.words.find((w) => w.word === 'but')!;
    const committed = commitProjectPatch(project, emptyHistory(), {
      patchId: 'patch_float' as PatchId,
      createdBy: 'agent',
      reason: 'cut before "but", in raw seconds',
      operations: [{ type: 'split_clip', clipId: 'clip_a', at: but.start }],
    });
    const boundaries = run('list_edit_boundaries', {}, committed.project) as { frame: number }[];
    expect(boundaries[0]!.frame).toBe(but.startFrame);
  });

  it('map_time answers in frames, in both directions', () => {
    const forward = run('map_time', { sequenceTime: 12.3874 }, project) as {
      sequenceFrame: number;
      fps: number;
      at: { clipId: string } | null;
    };
    expect(forward.fps).toBe(FPS);
    expect(forward.sequenceFrame).toBe(372);
    expect(forward.at?.clipId).toBe('clip_a');

    const backward = run('map_time', { sourceTime: 12.3874, assetId: 'asset_1' }, project) as {
      hits: { sequenceFrame: number }[];
      fps: number;
    };
    expect(backward.hits[0]!.sequenceFrame).toBe(372);
  });
});
