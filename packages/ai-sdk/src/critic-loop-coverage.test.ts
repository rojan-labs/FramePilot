/**
 * The critic's loop check (plan/elements EL7.2, ADR 0192): a loop is keyframes over its clip as it
 * was when the loop was set, so a clip lengthened afterwards loops only part of the way. The critic
 * warns, names the clip, and says how to cover it again; it never blocks.
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, planLoopMotion, type Patch } from '@framepilot/editor-core';
import type { Clip, Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { critique } from './critic.js';

const sticker: Clip = {
  id: 'st',
  assetId: '__shape__',
  trackId: 'o1',
  start: 0,
  end: 3,
  sourceStart: 0,
  sourceEnd: 3,
  effects: [],
  keyframes: [],
};

function looped(end: number): Project {
  const project = makeProject({
    timeline: { tracks: [{ id: 'o1', type: 'overlay', clips: [sticker] }] },
  } as never);
  const plan = planLoopMotion(sticker, { preset: 'pulse', periodSeconds: 1 }, project.resolution);
  if (!plan.ok) throw new Error(plan.detail);
  const patch: Patch = {
    patchId: 'loop' as Patch['patchId'],
    createdBy: 'agent',
    reason: 'Loop',
    operations: [...plan.operations],
  };
  const timeline = applyPatch(project.timeline, patch);
  // Lengthened after the loop was set, as a trim would.
  return {
    ...project,
    timeline: {
      ...timeline,
      tracks: timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, end, sourceEnd: end })),
      })),
    },
  };
}

const loopCheck = (project: Project) =>
  critique(project).checks.find((check) => check.id === 'loop_coverage')!;

describe('the loop coverage check', () => {
  it('passes a loop that covers its clip', () => {
    expect(loopCheck(looped(3)).status).toBe('pass');
  });

  it('warns about a loop its clip has outgrown, naming the clip and the fix', () => {
    const check = loopCheck(looped(6));
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('"st"');
    expect(check.detail).toContain('set_element_animation');
    expect(check.detail).not.toMatch(/\d/);
  });

  it('has nothing to say about a timeline with no loops', () => {
    const plain = makeProject({
      timeline: { tracks: [{ id: 'o1', type: 'overlay', clips: [sticker] }] },
    } as never);
    expect(loopCheck(plain).status).toBe('skipped');
  });
});
