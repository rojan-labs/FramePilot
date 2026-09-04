/**
 * Re-stamping a turn-start selection onto the timeline the agent has since changed.
 *
 * Run `137d8fd0`: 153 steps took the timeline from revision 56 to 127, and every
 * `professional_audio` and `track_subject_automatically` call after the agent's first
 * edit was refused with `stale_context: Interaction context targets …@56, but the
 * project is …@100`. The user's selection had not changed and the tools were not
 * misused — they were simply dead for the rest of the run.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import {
  captureEditorInteractionContext,
  rebaseEditorInteractionContext,
} from './interaction-context.js';
import { resolveEditorTarget } from './target-resolver.js';

const clip = (over: Record<string, unknown>) => ({
  assetId: 'asset-a',
  trackId: 'v1',
  start: 0,
  end: 5,
  sourceStart: 0,
  sourceEnd: 5,
  effects: [],
  keyframes: [],
  ...over,
});

const project = (revision: number, clips = [clip({ id: 'a' })]): Project =>
  ({
    id: 'project-1',
    name: 'Rebase fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset-a', name: 'A', path: 'media/a.mp4', kind: 'video', durationSeconds: 20 }],
    folders: [],
    markers: [],
    transcript: [],
    aiMemory: {},
    history: [],
    timeline: { revision, tracks: [{ id: 'v1', name: 'V1', type: 'video', clips }] },
  }) as unknown as Project;

const captured = (over: Record<string, unknown> = {}) =>
  captureEditorInteractionContext({
    project: project(56),
    projectRevision: 56,
    playheadSeconds: 1,
    selectedClipIds: ['a'],
    primaryClipId: 'a',
    ...over,
  });

describe('rebaseEditorInteractionContext', () => {
  it('is a no-op when nothing has moved on', () => {
    const context = captured();
    expect(rebaseEditorInteractionContext(context, project(56), 56)).toBe(context);
  });

  it('carries an intact selection onto a later revision', () => {
    const rebased = rebaseEditorInteractionContext(captured(), project(100), 100);
    expect(rebased.timelineRevision).toBe(100);
    expect(rebased.projectRevision).toBe(100);
    expect(rebased.selection.clipIds).toEqual(['a']);
    // Nothing else is invented on the user's behalf.
    expect(rebased.playhead).toEqual(captured().playhead);
  });

  it('lets a selection-authored target resolve after the agent has edited', () => {
    const later = project(100);
    const stale = resolveEditorTarget(
      later,
      captured(),
      { kind: 'clips', referent: 'selected' },
      {
        projectRevision: 100,
      },
    );
    expect(stale).toMatchObject({ status: 'unresolved', reason: 'stale_context' });

    const rebased = rebaseEditorInteractionContext(captured(), later, 100);
    expect(
      resolveEditorTarget(
        later,
        rebased,
        { kind: 'clips', referent: 'selected' },
        {
          projectRevision: 100,
        },
      ),
    ).toMatchObject({ status: 'resolved' });
  });

  it('refuses when a selected clip is gone', () => {
    const context = captured();
    expect(rebaseEditorInteractionContext(context, project(100, []), 100)).toBe(context);
  });

  it('refuses when the selected time range no longer falls inside the selection', () => {
    const context = captured({ timeRange: { start: 1, end: 4 } });
    const retimed = project(100, [clip({ id: 'a', start: 12, end: 17 })]);
    expect(rebaseEditorInteractionContext(context, retimed, 100)).toBe(context);
  });

  it('refuses across a different project', () => {
    const context = captured();
    const other = { ...project(100), id: 'project-2' } as Project;
    expect(rebaseEditorInteractionContext(context, other, 100)).toBe(context);
  });
});
