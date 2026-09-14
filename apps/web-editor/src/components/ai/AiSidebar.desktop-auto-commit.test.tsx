/**
 * D10 — desktop must not double-record an AI memory accept.
 *
 * Desktop's durable run policy commits every auto-policy patch directly in Electron's
 * main process (`beforePublish` in `apps/desktop/electron/main.ts`), which records the
 * accept itself (`recordAutoAcceptedMemory`, covered by
 * `apps/desktop/electron/ai/auto-accept-memory.test.ts`). The renderer must stand down
 * for that same patch rather than committing — and recording — it a second time.
 *
 * `AiSidebar`'s only call to `recordAccepted` lives behind the auto-apply effect that
 * commits an uncommitted streamed diff, and that effect explicitly returns early whenever
 * `getBridge()?.commitProjectPatch` exists (see `AiSidebar.tsx`). This test simulates the
 * desktop bridge and proves that stand-down: the diff still renders, but nothing here
 * calls `commitProjectPatch` or applies the patch through `editor.applyPatchChecked` —
 * the renderer leaves the commit, and the memory write, entirely to Electron.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnEmitter, type AiEvent, type EditResult } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
import type { UseEditor } from '../../editor/useEditor.js';
import { AiSidebar } from './AiSidebar.js';

const commitProjectPatch = vi.fn();

vi.mock('../../editor/bridge.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../editor/bridge.js')>('../../editor/bridge.js');
  return {
    ...actual,
    isDesktop: () => true,
    getBridge: () => ({ commitProjectPatch }),
  };
});

const fakeEdit = {
  text: 'Trim dead air',
  validation: { valid: true, issues: [] },
  diff: { summary: [] },
  patch: {
    patchId: 'p1',
    createdBy: 'agent',
    reason: 'Trim dead air',
    operations: [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 3 }],
  },
} as unknown as EditResult;

class DiffSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('editing');
    yield e.diff(fakeEdit);
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

const project: Project = parseProject({
  id: 'p',
  name: 'D',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  timeline: { tracks: [] },
  transcript: [],
  aiMemory: {},
  history: [],
});

afterEach(() => {
  resetConversationsRemountCache();
  commitProjectPatch.mockClear();
});

describe('AiSidebar on desktop stands down for a durable auto-commit run', () => {
  it('never calls commitProjectPatch or applyPatchChecked for a streamed diff itself', async () => {
    const applyPatchChecked = vi.fn(() => []);
    const editor = { applyPatchChecked } as unknown as UseEditor;
    const onProjectCommit = vi.fn();
    render(
      <AiSidebar
        project={project}
        editor={editor}
        onProjectCommit={onProjectCommit}
        session={new DiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Trim dead air')).toBeTruthy());

    // The diff arrived and rendered, but the renderer's own commit lane — the only place
    // it would ever call `recordAccepted` for this patch — never ran. Electron's
    // `beforePublish` is the sole committer and the sole memory-recorder for this patch.
    expect(commitProjectPatch).not.toHaveBeenCalled();
    expect(applyPatchChecked).not.toHaveBeenCalled();
    expect(onProjectCommit).not.toHaveBeenCalled();
  });
});
