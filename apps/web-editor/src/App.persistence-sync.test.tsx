/**
 * Renderer→host persistence synchronisation: the two writes App owes for every change,
 * and what happens when one of them is refused.
 *
 * A validated manual edit is committed to the desktop host as its own reversible patch;
 * anything the patch lane cannot express (a rename, an AI-memory write, an undo the differ
 * has no patch for) is owed a full-document save instead. These tests pin the interleavings
 * where one of those two paths used to cancel or erase the other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Project } from '@framepilot/timeline-schema';
import type { ProjectPatchCommitResult } from '@framepilot/shared-types';
import { App } from './App.js';
import type { RendererBridge } from './editor/bridge.js';
import { resetProjectBridgeCacheForTests } from './editor/bridge.js';
import { demoProject } from './editor/demo.js';

const PROJECT_PATH = '/projects/demo.fp.json';
const OPEN_REVISION = 5;

interface SyncBridgeOverrides {
  readonly commitProjectPatch?: RendererBridge['commitProjectPatch'];
  readonly saveProject?: RendererBridge['saveProject'];
}

type SavedCall = readonly [string, Project, number | undefined];

function installBridge(overrides: SyncBridgeOverrides = {}): {
  readonly bridge: RendererBridge;
  readonly saveProject: ReturnType<typeof vi.fn>;
  readonly commitProjectPatch: ReturnType<typeof vi.fn>;
} {
  const saveProject =
    (overrides.saveProject as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (path: string) => ({ ok: true as const, path, revision: OPEN_REVISION + 1 }));
  const commitProjectPatch =
    (overrides.commitProjectPatch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(
      async (): Promise<ProjectPatchCommitResult> => ({
        ok: true,
        revision: OPEN_REVISION + 1,
        project: demoProject,
        rebased: false,
      }),
    );
  const bridge = {
    ping: vi.fn(async () => 'pong' as const),
    sidecarStatus: vi.fn(async () => ({ phase: 'stopped' as const, baseUrl: null, detail: null })),
    openProject: vi.fn(async () => ({ ok: false as const, error: 'no' })),
    openProjectDialog: vi.fn(async () => ({
      ok: true as const,
      path: PROJECT_PATH,
      project: demoProject,
      revision: OPEN_REVISION,
    })),
    saveProject,
    saveProjectDefault: vi.fn(async () => ({ ok: true as const, path: PROJECT_PATH })),
    projectsDir: vi.fn(async () => '/projects'),
    revealProject: vi.fn(async () => ({ ok: true as const })),
    recentProjects: vi.fn(async () => []),
    exportVideoStart: vi.fn(async () => 'req-1'),
    exportVideoCancel: vi.fn(),
    onExportProgress: vi.fn(() => () => {}),
    exportSaveAs: vi.fn(async () => ({ ok: false as const, error: 'cancelled' })),
    onProjectChanged: vi.fn(() => () => {}),
    commitProjectPatch,
  } as unknown as RendererBridge;
  window.framepilot = bridge;
  return { bridge, saveProject, commitProjectPatch };
}

const savedCalls = (saveProject: ReturnType<typeof vi.fn>): readonly SavedCall[] =>
  saveProject.mock.calls as unknown as readonly SavedCall[];

/** Open the seeded desktop project so App has a real path and a non-zero revision. */
async function openDesktopProject(): Promise<void> {
  render(<App />);
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Open Project'));
  });
}

/** A real, validated timeline edit: the only kind the patch lane carries. */
function splitClip(clipId: string, atSeconds: number): void {
  fireEvent.click(screen.getByLabelText(`clip ${clipId}`));
  fireEvent.change(screen.getByLabelText('playhead'), { target: { value: String(atSeconds) } });
  fireEvent.click(screen.getByRole('button', { name: 'Split' }));
}

const splitIntroClip = (): void => splitClip('clip_intro', 3);

const renameProject = (name: string): void => {
  fireEvent.click(screen.getByLabelText('project name'));
  const input = screen.getByLabelText('rename project');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

const saveState = (): string | null =>
  screen.getByLabelText('save state').getAttribute('data-state');

const clipCountOnVideoTrack = (project: Project): number =>
  project.timeline.tracks.find((track) => track.id === 'video_1')?.clips.length ?? 0;

afterEach(() => {
  delete window.framepilot;
  resetProjectBridgeCacheForTests();
  localStorage.clear();
  vi.useRealTimers();
});

describe('a full save that is still owed', () => {
  /**
   * P0-2. A change no patch carried (here a rename; an undone AI edit behaves the same way)
   * schedules the debounced full save. The next edit DOES go down the patch lane and sets
   * `suppressFullAutosaveOnce` — but the autosave effect's cleanup clears the pending
   * timeout on every project change, so the owed snapshot died with the timer and never
   * reached disk. The host then kept applying later patches to a document missing it.
   */
  it('survives a patch-lane edit that lands inside the debounce', async () => {
    vi.useFakeTimers();
    const { saveProject, commitProjectPatch } = installBridge();
    await openDesktopProject();

    renameProject('Renamed Session');
    expect(saveState()).toBe('dirty');

    // Well inside the 2s debounce: the old code cancelled the rename's save right here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    splitIntroClip();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // The split went down the patch lane…
    expect(commitProjectPatch).toHaveBeenCalledTimes(1);
    // …and the rename still got its whole-document write.
    expect(saveProject).toHaveBeenCalledTimes(1);
    const [path, saved] = savedCalls(saveProject)[0]!;
    expect(path).toBe(PROJECT_PATH);
    expect(saved.name).toBe('Renamed Session');
    // Carrying the newer edit too, so the snapshot is not a rollback of the split.
    expect(clipCountOnVideoTrack(saved)).toBe(3);
  });
});

describe('a manual patch the host refuses', () => {
  /**
   * P0-3. The edit is already on screen — the store applied it optimistically before the
   * commit was queued — so bailing out with an error chip left renderer and host
   * permanently divergent: every later patch was computed against a base the host did not
   * have, and the next commit that happened to succeed reset the chip to "Saved".
   */
  it('falls back to a full snapshot of what the renderer is showing', async () => {
    vi.useFakeTimers();
    const commitProjectPatch = vi.fn(
      async (): Promise<ProjectPatchCommitResult> => ({
        ok: false,
        code: 'invalid_patch',
        error: 'the host rejected this patch',
      }),
    );
    const { saveProject } = installBridge({
      commitProjectPatch: commitProjectPatch as unknown as RendererBridge['commitProjectPatch'],
    });
    await openDesktopProject();

    splitIntroClip();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(commitProjectPatch).toHaveBeenCalledTimes(1);
    expect(saveProject).toHaveBeenCalledTimes(1);
    const [, saved] = savedCalls(saveProject)[0]!;
    // The whole document, including the edit the host would not take as a delta.
    expect(clipCountOnVideoTrack(saved)).toBe(3);
    // Reconciled: the two sides agree again, so the chip is honest about it.
    expect(saveState()).toBe('saved');
  });

  it('keeps the failure visible and the patch lane closed until a snapshot lands', async () => {
    vi.useFakeTimers();
    const commitProjectPatch = vi.fn(
      async (): Promise<ProjectPatchCommitResult> => ({
        ok: false,
        code: 'invalid_patch',
        error: 'the host rejected this patch',
      }),
    );
    const { saveProject } = installBridge({
      commitProjectPatch: commitProjectPatch as unknown as RendererBridge['commitProjectPatch'],
      saveProject: vi.fn(async () => ({
        ok: false as const,
        error: 'disk full',
      })) as unknown as RendererBridge['saveProject'],
    });
    await openDesktopProject();

    splitIntroClip();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(saveState()).toBe('error');

    // A second edit while the divergence is unresolved must NOT go down the patch lane:
    // it would be a delta against a base the host never received, and its success would
    // clear the error chip — the only evidence the user has that anything was lost.
    splitClip('clip_body', 10);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(commitProjectPatch).toHaveBeenCalledTimes(1);
    // Routed to a whole-document save instead, which is the only write that can put the
    // host back in step.
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(saveState()).toBe('error');
    expect(screen.getByLabelText('save state').title).toContain('disk full');
  });
});
