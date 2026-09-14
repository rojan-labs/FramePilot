/**
 * D10 follow-up — a GLOBAL undo (Cmd+Z, menu Undo — anything that calls `editor.undo()`
 * other than `AiSidebar`'s own "Undo run" button, which already recorded this) must
 * record the same negative learning signal: the user watched an AI-origin edit on the
 * timeline and took it back.
 *
 * Driven through the real `Editor` component (the real `useEditor` store, the real
 * keyboard shortcut, the real effect added to `Editor.tsx`) with a small host-simulating
 * wrapper that feeds `onProjectChange`'s output back in as the next `project` prop — the
 * same round trip `App.tsx` performs. That round trip matters here: the fix is a
 * multi-render "catch up" against the freshly-lifted project (see the comment above the
 * effect in `Editor.tsx` for why), so a bare spy that never re-renders `Editor` with the
 * updated project would never let it run to completion.
 */
import { useCallback, useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { Editor } from './Editor.js';
import { demoProject } from '../editor/demo.js';

const entry = (patchId: string, createdBy: 'agent' | 'user'): unknown => ({
  patch: { patchId, createdBy, reason: patchId, operations: [] },
  inverse: {
    patchId: `${patchId}__inverse`,
    createdBy,
    reason: `undo ${patchId}`,
    operations: [],
  },
});

const projectWithTopEntry = (patchId: string, createdBy: 'agent' | 'user'): Project =>
  parseProject({
    ...demoProject,
    aiMemory: {},
    history: [entry(patchId, createdBy)],
  });

const rejectedPatchIds = (project: Project): readonly string[] =>
  ((project.aiMemory as { rejectedEdits?: readonly { patchId: string }[] } | undefined)
    ?.rejectedEdits ?? []
  ).map((e) => e.patchId);

/**
 * Mirrors what `App.tsx` does: hold `project` in state and feed `onProjectChange`'s
 * result straight back down, while also exposing the latest value to the test via a ref.
 */
function Host({
  initial,
  latest,
  injectConcurrentReject,
}: {
  readonly initial: Project;
  readonly latest: { current: Project };
  /**
   * Simulates `AiSidebar`'s "Undo run" landing in the SAME commit as `Editor`'s own
   * lift — i.e. a caller other than this effect already recorded the rejection before
   * this effect gets to look. Applied once, to the first project this host receives
   * whose history is shorter than the one it is currently holding (the undo lift).
   */
  readonly injectConcurrentReject?: string;
}): JSX.Element {
  const [project, setProjectState] = useState(initial);
  const injected = useRef(false);
  const setProject = useCallback(
    (next: Project) => {
      let toStore = next;
      if (
        injectConcurrentReject &&
        !injected.current &&
        Array.isArray(next.history) &&
        Array.isArray(project.history) &&
        next.history.length < project.history.length
      ) {
        injected.current = true;
        toStore = {
          ...next,
          aiMemory: {
            ...(next.aiMemory as Record<string, unknown>),
            rejectedEdits: [
              ...((next.aiMemory as { rejectedEdits?: unknown[] } | undefined)?.rejectedEdits ??
                []),
              { patchId: injectConcurrentReject, reason: 'undo run' },
            ],
          },
        };
      }
      latest.current = toStore;
      setProjectState(toStore);
    },
    [injectConcurrentReject, project.history, latest],
  );
  return <Editor project={project} onProjectChange={setProject} />;
}

const undo = (): void => {
  fireEvent.keyDown(window, { key: 'z', metaKey: true });
};

describe('global undo records an AI-origin edit as rejected (D10 follow-up)', () => {
  it('Cmd+Z on an AI-origin entry records a rejection', async () => {
    const initial = projectWithTopEntry('ai_1', 'agent');
    const latest = { current: initial };
    render(<Host initial={initial} latest={latest} />);

    undo();

    await waitFor(() => expect(rejectedPatchIds(latest.current)).toContain('ai_1'));
    // Exactly once — a single Cmd+Z press must not fan out into repeats.
    expect(rejectedPatchIds(latest.current).filter((id) => id === 'ai_1')).toHaveLength(1);
  });

  it('Cmd+Z on a human-authored entry records nothing', async () => {
    const initial = projectWithTopEntry('human_1', 'user');
    const latest = { current: initial };
    render(<Host initial={initial} latest={latest} />);

    undo();

    // The undo itself still has to land (history shrinks) — only the MEMORY write must
    // be absent, not the undo.
    await waitFor(() => expect(Array.isArray(latest.current.history)).toBe(true));
    await waitFor(() =>
      expect((latest.current.history as unknown[]).length).toBeLessThan(
        (initial.history as unknown[]).length,
      ),
    );
    expect(rejectedPatchIds(latest.current)).toEqual([]);
  });

  it('does not double-record when another caller (Undo run) already recorded the same patch', async () => {
    const initial = projectWithTopEntry('ai_1', 'agent');
    const latest = { current: initial };
    render(<Host initial={initial} latest={latest} injectConcurrentReject="ai_1" />);

    undo();

    await waitFor(() => expect(rejectedPatchIds(latest.current)).toContain('ai_1'));
    // The concurrent write already recorded it once; this effect's own dedupe check
    // (against the project it is handed) must see that and add nothing more.
    expect(rejectedPatchIds(latest.current).filter((id) => id === 'ai_1')).toHaveLength(1);
  });
});
