/**
 * `caption_the_edit` over stacked footage, replayed from run `137d8fd0`.
 *
 * The bug this pins: the run's timeline carried the same asset twice over the same
 * sequence seconds — `v_main` showing source 18–21s at sequence 0–3s, and a b-roll
 * track showing source 0–3s at the *same* sequence 0–3s. Caption runs are per-clip, so
 * both clips contributed speech to the same instants, both produced a cue starting on
 * frame 2, and both cues derived the clip id `caption_<track>_70`.
 *
 * `add_caption_layer` rejects a duplicate id, and a caption patch is all-or-nothing, so
 * one collision discarded every cue in the call. The run made nine further
 * `caption_the_edit` attempts, each rejected at the same operation with the same
 * message, and finished with no captions at all — roughly 3,100 proposed changes and a
 * large share of its $26 budget spent on a retry that could not have succeeded.
 *
 * Stacking is not exotic: a cutaway, a second angle, or a picture-in-picture puts two
 * clips over one instant, and the caption track can only ever show one cue at a time.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project, type TranscriptWord } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';
import { applyProjectPatch } from '@framepilot/editor-core';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';

const ASSET = 'asset_raw_skating';
const DURATION = 570;

/** Speech every half second across the source, so every clip retains some. */
const TRANSCRIPT: readonly TranscriptWord[] = Array.from({ length: 120 }, (_, i) => {
  const start = +(i * 0.5).toFixed(3);
  return { word: `w${i}`, start, end: +(start + 0.4).toFixed(3), assetId: ASSET };
});

/**
 * Two video tracks reading different source ranges over the same sequence seconds —
 * the exact shape `get_timeline` reported at 18:45 in the run.
 */
function stackedProject(): Project {
  const clip = (id: string, trackId: string, sourceStart: number) => ({
    id,
    assetId: ASSET,
    trackId,
    start: 0,
    end: 3,
    sourceStart,
    sourceEnd: sourceStart + 3,
    effects: [],
    keyframes: [],
  });
  return parseProject({
    id: 'project_editing_test_mtl8rrmietle',
    name: 'Snowboard highlight',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [
      { id: ASSET, path: 'media/raw_skating.mp4', kind: 'video', durationSeconds: DURATION },
    ],
    transcript: TRANSCRIPT,
    timeline: {
      tracks: [
        { id: 'v_main', type: 'video', clips: [clip('clip_main', 'v_main', 18)] },
        { id: 'video_cutaway_5', type: 'video', clips: [clip('clip_broll', 'video_cutaway_5', 0)] },
        { id: 'captions', type: 'caption', clips: [] },
      ],
      markers: [],
    },
  });
}

function captionTheEdit(project: Project): ReturnType<typeof assembleEdit> {
  const tool = getTool('caption_the_edit');
  if (!tool || tool.kind !== 'mutate') throw new Error('caption_the_edit is not a mutate tool');
  const ops = tool.buildOps(
    { trackId: 'captions', preset: 'short-form' },
    { project },
  ) as AnyOperation[];
  return assembleEdit(project, ops, 'caption the edit', 'agent');
}

describe('caption_the_edit over stacked footage (run 137d8fd0)', () => {
  it('gives every cue a clip id of its own', () => {
    const ops = captionTheEdit(stackedProject()).patch.operations;
    const ids = ops.filter((op) => op.type === 'add_caption_layer').map((op) => op.clipId);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('applies — no duplicate id can reject the whole patch', () => {
    const project = stackedProject();
    const applied = applyProjectPatch(project, captionTheEdit(project).patch);
    const track = applied.timeline.tracks.find((t) => t.id === 'captions');
    expect(track?.clips.length).toBeGreaterThan(1);
  });

  it('leaves no two cues on screen at once', () => {
    const project = stackedProject();
    const clips = [
      ...(applyProjectPatch(project, captionTheEdit(project).patch).timeline.tracks.find(
        (t) => t.id === 'captions',
      )?.clips ?? []),
    ].sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i += 1) {
      expect(clips[i]!.start).toBeGreaterThanOrEqual(clips[i - 1]!.end - 1e-9);
    }
  });

  it('re-captioning an already-captioned stacked timeline still applies', () => {
    const project = stackedProject();
    const once = applyProjectPatch(project, captionTheEdit(project).patch);
    const twice = applyProjectPatch(once, captionTheEdit(once).patch);
    const track = twice.timeline.tracks.find((t) => t.id === 'captions');
    expect(track?.clips.length).toBe(
      once.timeline.tracks.find((t) => t.id === 'captions')?.clips.length,
    );
  });
});
