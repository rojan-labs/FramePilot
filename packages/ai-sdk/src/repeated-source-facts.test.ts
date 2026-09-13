/**
 * TRACKING Q5 — the agent can see which clips replay a take.
 *
 * A live run asked to "drop the duplicate takes" deleted two unique clips: nothing it read
 * related two clips' source ranges, so it answered from asset identity. The fact now rides on
 * the clip row the model plans from and on `get_clips`, from the same editor-core definition
 * the duplicate-takes rubric scores against.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { summarizeTimeline, withRepeatedSourceFacts } from './context-builder.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import type { ToolContext } from './tool-context.js';

/** The fixture plus a third clip replaying clip_a's source (0–6s of asset_1). */
function withRepeat(): Project {
  const base = makeProject();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      tracks: base.timeline.tracks.map((track) =>
        track.id === 'video_1'
          ? {
              ...track,
              clips: [
                ...track.clips,
                {
                  ...track.clips[0]!,
                  id: 'clip_again',
                  start: 10,
                  end: 16,
                  sourceStart: 1,
                  sourceEnd: 7,
                },
              ],
            }
          : track,
      ),
    },
  };
}

function getClips(project: Project): Array<Record<string, unknown>> {
  const spec = TOOL_REGISTRY.find((tool) => tool.name === 'get_clips');
  if (!spec?.read) throw new Error('get_clips is not a read tool');
  const ctx: ToolContext = { project };
  return (spec.read({}, ctx) as { clips: Array<Record<string, unknown>> }).clips;
}

describe('repeated-source facts on the clip row', () => {
  it('marks the repeat, naming the first clip that plays the material', () => {
    const project = withRepeat();
    const summary = summarizeTimeline(
      project.timeline,
      new Map(),
      undefined,
      Infinity,
      undefined,
      withRepeatedSourceFacts(project, undefined),
    );
    expect(summary).toContain('clip_again[10–16s] · replays clip_a source');
    // clip_b is a DIFFERENT moment of the same asset (source 6–10), not a repeat.
    expect(summary).not.toContain('clip_b[6–10s] · replays');
    expect(summary).not.toContain('clip_a[0–6s] · replays');
  });

  it('merges with the ledger’s picture words instead of replacing them', () => {
    const merged = withRepeatedSourceFacts(withRepeat(), new Map([['clip_again', 'MS man']]));
    expect(merged?.get('clip_again')).toBe('MS man · replays clip_a source');
  });

  it('leaves a project with no repeats exactly as it was — the prompt does not move', () => {
    const facts = new Map([['clip_a', 'WS street']]);
    expect(withRepeatedSourceFacts(makeProject(), facts)).toBe(facts);
    expect(withRepeatedSourceFacts(makeProject(), undefined)).toBeUndefined();
  });
});

describe('get_clips names the take a clip replays', () => {
  it('carries replaysSourceOf on the repeat only', () => {
    const rows = getClips(withRepeat());
    expect(rows.find((row) => row.id === 'clip_again')?.replaysSourceOf).toBe('clip_a');
    expect(rows.find((row) => row.id === 'clip_a')).not.toHaveProperty('replaysSourceOf');
    expect(rows.find((row) => row.id === 'clip_b')).not.toHaveProperty('replaysSourceOf');
  });

  it('adds nothing to a timeline with no repeats', () => {
    for (const row of getClips(makeProject())) expect(row).not.toHaveProperty('replaysSourceOf');
  });
});
