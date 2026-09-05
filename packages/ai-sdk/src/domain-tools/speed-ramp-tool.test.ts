/**
 * The motion domain promised speed ramps and shipped no tool for one (run `137d8fd0`).
 *
 * The domain's own summary reads "keyframes, punch-ins, camera moves and **speed ramps**",
 * and its tools were `add_keyframes`, `remove_keyframes`, `punch_in`, `set_clip_speed`,
 * `set_clip_crop`, `professional_motion`. The `set_clip_speed_ramp` OPERATION has existed
 * since schema v15 (ADR 0090) and the renderer has understood `Clip.speedRamp` for as
 * long — `render/compiler.py` and `effects/speed_curve.py` both integrate it. Only the AI
 * route was missing.
 *
 * What that cost: the brief asked in so many words to "ramp into the 7:40 wipeout — fast
 * in, slow on the impact, back up after". The run named the ramp as outstanding SIX times
 * across 48 minutes, called `set_clip_speed` once, produced no ramp, and reported
 * "Applied 416 edits" without ever saying the ramp had not happened.
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, type Patch } from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { DOMAIN_SUMMARY, domainMembers } from '../tool-domains.js';

function project(): Project {
  return parseProject({
    id: 'ramp_project',
    name: 'Ramp fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'hero_asset', path: 'hero.mp4', kind: 'video', durationSeconds: 20 }],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'hero_asset',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
  });
}

const ctx = (): ToolContext => ({ project: project() }) as unknown as ToolContext;

const call = (args: unknown) =>
  operationsForCall({ id: 'c1', name: 'set_clip_speed_ramp', arguments: args }, ctx());

describe('set_clip_speed_ramp is reachable from the motion domain', () => {
  it('is in the domain whose own summary advertises speed ramps', () => {
    // The summary is the discovery surface — the model picks a domain from this sentence.
    expect(DOMAIN_SUMMARY.motion).toMatch(/speed ramps/i);
    expect(domainMembers('motion')).toContain('set_clip_speed_ramp');
  });

  it('builds the ramp the brief asked for — fast in, slow on the impact, back up', () => {
    const ops = call({
      clipId: 'clip_a',
      ramp: [
        { sourceTime: 0, rate: 2 },
        { sourceTime: 1.5, rate: 0.25, easing: 'ease-out' },
        { sourceTime: 2.5, rate: 1 },
      ],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'set_clip_speed_ramp', clipId: 'clip_a' });
    const ramp = (ops[0] as { ramp: { rate: number; easing: string }[] }).ramp;
    expect(ramp.map((p) => p.rate)).toEqual([2, 0.25, 1]);
    expect(ramp.map((p) => p.easing)).toEqual(['linear', 'ease-out', 'linear']);
  });

  it('derives the point ids rather than taking them from the model', () => {
    const ops = call({
      clipId: 'clip_a',
      ramp: [
        { sourceTime: 0, rate: 2 },
        { sourceTime: 2, rate: 1 },
      ],
    });
    const ramp = (ops[0] as { ramp: { id: string }[] }).ramp;
    expect(ramp.map((p) => p.id)).toEqual(['ramp_clip_a_0', 'ramp_clip_a_1']);
  });

  it('applies cleanly and re-derives the clip length from the curve', () => {
    const ops = call({
      clipId: 'clip_a',
      ramp: [
        { sourceTime: 0, rate: 4 },
        { sourceTime: 2, rate: 2 },
        { sourceTime: 4, rate: 4 },
      ],
    });
    const before = project();
    const patch = {
      patchId: 'patch_ramp' as PatchId,
      createdBy: 'agent',
      reason: 'ramp the wipeout',
      operations: ops,
    } as unknown as Patch;
    const after = applyPatch(before.timeline, patch, { fps: 30 });
    const clip = after.tracks[0]!.clips[0]!;
    expect(clip.speedRamp).toBeDefined();
    // Sped up throughout, so the clip is shorter than its 4s source and still positive.
    expect(clip.end - clip.start).toBeGreaterThan(0);
    expect(clip.end - clip.start).toBeLessThan(4);
  });

  it('clears the curve with ramp: null', () => {
    const ops = call({ clipId: 'clip_a', ramp: null });
    expect(ops[0]).toEqual({ type: 'set_clip_speed_ramp', clipId: 'clip_a', ramp: null });
  });
});
