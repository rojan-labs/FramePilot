/**
 * The AI sidebar's project updates travel back through the editor's persistence callback,
 * and the editor is the boundary that stripped their history on the way down.
 *
 * P0-1: `projectForAi` empties `history` so a run's context does not carry tens of
 * megabytes of inverse patches. Everything the sidebar derives — a forgotten memory chip,
 * an undone run, a recorded decision — inherits that empty array. Lifted as-is, App's
 * history differ compared the user's real history against `[]`, took the undo branch, and
 * committed the inverses of the user's own edits to disk. The timeline on screen never
 * moved; the loss only showed up on the next reload.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { Editor } from './Editor.js';
import { demoProject } from '../editor/demo.js';

const userEntry = (patchId: string): unknown => ({
  patch: { patchId, createdBy: 'user', reason: patchId, operations: [] },
  inverse: { patchId: `${patchId}__inverse`, createdBy: 'user', reason: patchId, operations: [] },
});

const rememberingProject = (): Project =>
  parseProject({
    ...demoProject,
    aiMemory: { captionStyle: 'bold yellow' },
    // Two real user edits the session must never be talked out of.
    history: [userEntry('u1'), userEntry('u2')],
  });

describe('AI-derived project updates', () => {
  it('keeps the live history when the sidebar forgets a remembered preference', () => {
    const project = rememberingProject();
    const onProjectChange = vi.fn();
    render(<Editor project={project} onProjectChange={onProjectChange} />);

    fireEvent.click(screen.getByLabelText('Remove Remembers caption style: bold yellow'));

    expect(onProjectChange).toHaveBeenCalledTimes(1);
    const lifted = onProjectChange.mock.calls[0]![0] as Project;
    // The forget happened…
    expect(
      (lifted.aiMemory as Record<string, unknown> | undefined)?.['captionStyle'],
    ).toBeUndefined();
    // …and the history it never had is back, by reference, so the differ sees "no
    // transition" instead of "the user reverted their whole session".
    expect(lifted.history).toBe(project.history);
  });
});
