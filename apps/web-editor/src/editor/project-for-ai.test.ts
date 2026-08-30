/**
 * The AI-facing project boundary: what `projectForAi` strips, and what
 * `restoreStrippedHistory` owes back before anything derived from it is persisted.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { demoProject } from './demo.js';
import { createEditorState } from './store.js';
import { projectForAi, restoreStrippedHistory } from './project-for-ai.js';

const historyEntry = (patchId: string): unknown => ({
  patch: { patchId, createdBy: 'user', reason: patchId, operations: [] },
  inverse: { patchId: `${patchId}__inverse`, createdBy: 'user', reason: patchId, operations: [] },
});

const withHistory = (...patchIds: readonly string[]): Project =>
  ({ ...demoProject, history: patchIds.map(historyEntry) }) as Project;

describe('projectForAi', () => {
  it('strips history from the copy handed to the model', () => {
    const live = withHistory('u1', 'u2');
    const state = createEditorState(demoProject.timeline);
    expect(projectForAi(live, state).history).toEqual([]);
  });
});

describe('restoreStrippedHistory', () => {
  /**
   * The sidebar derives its updates (forget a memory chip, undo a run, record a decision)
   * from the history-less copy above. Lifting one of those straight into persistence made
   * App's history differ compare the user's real `[u1, u2]` against `[]`, read it as a
   * time-travel to the start of the session, and commit the inverses of the user's own
   * edits to disk — with the on-screen timeline unchanged, so nothing looked wrong until
   * the next reload.
   */
  it('gives an AI-derived update the live history back', () => {
    const live = withHistory('u1', 'u2');
    const aiFacing = projectForAi(live, createEditorState(demoProject.timeline));
    const derived = { ...aiFacing, aiMemory: { captionStyle: 'bold' } } as Project;

    const restored = restoreStrippedHistory(derived, live);

    expect(restored.history).toBe(live.history);
    expect(restored.aiMemory).toEqual({ captionStyle: 'bold' });
  });

  it('leaves a real history transition alone', () => {
    const live = withHistory('u1');
    const advanced = withHistory('u1', 'u2');
    // Only the editor's own lift path produces a non-empty history, and that IS the
    // transition the differ exists to read — overwriting it would lose the new edit.
    expect(restoreStrippedHistory(advanced, live)).toBe(advanced);
  });
});
