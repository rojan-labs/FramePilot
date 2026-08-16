/**
 * Marker and transcript axes of the canonical project diff.
 *
 * `diffProject` is what the review UI and the agent both read to decide whether an edit
 * changed anything. It used to cover only timeline/assets/folders, so a patch that moved
 * a marker or replaced the transcript reported "no changes" while genuinely mutating the
 * project — a silent edit is worse than a rejected one.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { diffProject } from './patch.js';
import { applyProjectOperation, type SetTranscriptOp } from './project-operations.js';

const marker = (id: string, time: number, label = 'beat') => ({ id, time, label });

const project = (markers: ReturnType<typeof marker>[] = []): Project =>
  ({
    fps: 30,
    assets: [],
    folders: [],
    markers,
    transcript: [],
    timeline: { revision: 1, tracks: [] },
  }) as Project;

describe('project diff — markers', () => {
  it('reports an added marker', () => {
    const diff = diffProject(project(), project([marker('m1', 4)]));
    expect(diff.summary.join(' ')).toMatch(/marker m1 added at 4s/);
  });

  it('reports a moved or relabelled marker as changed', () => {
    expect(
      diffProject(project([marker('m1', 4)]), project([marker('m1', 6)])).summary.join(' '),
    ).toMatch(/marker m1 changed/);
    expect(
      diffProject(project([marker('m1', 4)]), project([marker('m1', 4, 'hook')])).summary.join(' '),
    ).toMatch(/marker m1 changed/);
  });

  it('reports a removed marker', () => {
    const diff = diffProject(project([marker('m1', 4)]), project());
    expect(diff.summary.join(' ')).toMatch(/marker m1 removed/);
  });

  it('stays silent when the markers are untouched', () => {
    const diff = diffProject(project([marker('m1', 4)]), project([marker('m1', 4)]));
    expect(diff.summary.join(' ')).not.toMatch(/marker/);
  });

  it('diffs a project that carries no markers or transcript at all', () => {
    // Both axes are optional on a Project: older files omit them, and the review preview
    // builds a lightweight project from the pending patch. Reading them unguarded threw
    // and took the whole diff — and the review UI with it — down.
    const bare = {
      fps: 30,
      assets: [],
      folders: [],
      timeline: { revision: 1, tracks: [] },
    } as unknown as Project;
    expect(() => diffProject(bare, bare)).not.toThrow();
    expect(diffProject(bare, project([marker('m1', 2)])).summary.join(' ')).toMatch(
      /marker m1 added/,
    );
  });
});

describe('project diff — transcript', () => {
  it('reports an unattributed whole-project transcript replacement without an asset scope', () => {
    const before = project();
    const op: SetTranscriptOp = {
      type: 'set_transcript',
      words: [{ word: 'hello', start: 0, end: 0.5 }],
    } as SetTranscriptOp;
    const after = applyProjectOperation(before, op);
    const summary = diffProject(before, after).summary.join(' ');
    expect(summary).toMatch(/transcript updated \(0 → 1 word\(s\)\)/);
    expect(summary).not.toMatch(/attributed asset/);
  });
});

describe('transcript asset scope', () => {
  it('refuses a blank asset scope rather than writing unreachable words', () => {
    // A blank scope would attribute words to an asset id nothing can match, so the
    // transcript would silently detach from every asset instead of replacing one.
    expect(() =>
      applyProjectOperation(project(), {
        type: 'set_transcript',
        assetId: '   ',
        words: [{ word: 'hello', start: 0, end: 0.5 }],
      } as SetTranscriptOp),
    ).toThrow(/asset scope cannot be blank/i);
  });

  it('treats an empty attributed payload as a whole-project replacement', () => {
    const before = project();
    const after = applyProjectOperation(before, {
      type: 'set_transcript',
      words: [],
    } as unknown as SetTranscriptOp);
    expect(after.transcript).toEqual([]);
  });
});
