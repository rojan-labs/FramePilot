/**
 * The Inspector's background-removal row (BR6.1).
 *
 * What is asserted is the promise the row makes to an editor who does not have the pack: the
 * capability is visible, it is disabled with a reason attached to the button, installing is one
 * approved click, and the row believes the install happened only because main said so — including
 * when the install came from somewhere else entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MaskLayerSchema, type Asset, type Timeline } from '@framepilot/timeline-schema';
import type {
  CapabilityPackInstalledEventWire,
  CapabilityPackStatusWire,
  MatteValidationIssueWire,
} from '@framepilot/shared-types';
import { OpenedMatteIssuesProvider } from '../../../editor/openedMattes.js';
import { useEditor } from '../../../editor/useEditor.js';
import { BackgroundRemovalRow, subjectPrompts } from './BackgroundRemovalRow.js';
import { MatteJobStore } from './matteJobStore.js';
import { forgetRelinkedMatteIssues, relinkAsset } from '../../../editor/relinkAsset.js';
import { useMatteJobCommits } from './useMatteJob.js';
import { MaskToolStore } from './useMaskTools.js';

const bridge = vi.hoisted(() => ({
  matteRecheckMedia: vi.fn(),
  capabilityPackStatus: vi.fn(),
  onCapabilityPackInstalled: vi.fn(),
  capabilityPackPropose: vi.fn(),
  capabilityPackInstall: vi.fn(),
  onCapabilityPackProgress: vi.fn(() => () => {}),
  capabilityPackCancel: vi.fn(),
  capabilityPackMatte: vi.fn(),
  capabilityPackCancelMatte: vi.fn(),
  onCapabilityPackMatteProgress: vi.fn(() => () => {}),
}));

vi.mock('../../../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

const PROPOSAL = {
  proposalId: 'p1',
  identity: {
    id: 'smart-mask',
    version: '1.0.0',
    releaseDigest: 'd'.repeat(64),
    artifactDigest: 'e'.repeat(64),
    os: 'darwin' as const,
    arch: 'arm64' as const,
  },
  capabilities: ['subject.matte'],
  displayName: 'Smart Mask',
  description: 'Removes backgrounds on this computer.',
  downloadBytes: 1_050_000_000,
  installedBytes: 1_200_000_000,
  licenses: [{ spdx: 'Apache-2.0', name: 'Apache 2.0', noticeUrl: 'https://example.invalid' }],
  privacy: {
    execution: 'local' as const,
    mediaLeavesDevice: false,
    disclosure: 'Nothing is uploaded.',
  },
};

const READY: CapabilityPackStatusWire = {
  state: 'ready',
  capability: 'subject.matte',
  pack: PROPOSAL.identity,
};
const MISSING: CapabilityPackStatusWire = {
  state: 'missing',
  capability: 'subject.matte',
  proposal: { ok: true, proposal: PROPOSAL },
};

const assets: readonly Asset[] = [
  {
    id: 'a1',
    path: 'media/a1.mp4',
    kind: 'video',
    media: { width: 1920, height: 1080 },
  } as unknown as Asset,
];

const timeline: Timeline = {
  revision: 2,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 'v1',
          start: 0,
          end: 4,
          sourceStart: 2,
          sourceEnd: 6,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
} as unknown as Timeline;

/** The same project after a run: one matte on the clip, nothing behind it. */
const timelineWithMatte: Timeline = {
  revision: 2,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 'v1',
          start: 0,
          end: 4,
          sourceStart: 2,
          sourceEnd: 6,
          effects: [],
          keyframes: [],
          masks: [
            MaskLayerSchema.parse({
              id: 'c1__mask',
              kind: 'matte',
              artifact: {
                key: 'a'.repeat(64),
                files: [{ name: 'matte.mkv', sha256: 'b'.repeat(64) }],
                width: 1920,
                height: 1080,
                coverage: { sourceStart: 0, sourceEnd: 8 },
                packId: 'smart-mask',
                packVersion: '1.0.0',
                modelDigests: ['b'.repeat(64)],
              },
              review: { flagged: [], approved: [], locked: [] },
            }),
          ],
        },
      ],
    },
  ],
} as unknown as Timeline;

/** The shell-level committer, which is what turns an outcome into a notice. */
function Committer({ jobs }: { readonly jobs: MatteJobStore }): null {
  const editor = useEditor(timeline, { assets });
  useMatteJobCommits(editor, jobs);
  return null;
}

function Harness({
  jobs,
  withMatte = false,
}: {
  readonly jobs: MatteJobStore;
  readonly withMatte?: boolean;
}): JSX.Element {
  const editor = useEditor(withMatte ? timelineWithMatte : timeline, { assets });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return (
    <BackgroundRemovalRow
      editor={editor}
      clip={clip}
      store={new MaskToolStore()}
      jobs={jobs}
      developmentBuild={false}
    />
  );
}

let jobs: MatteJobStore;

beforeEach(() => {
  jobs = new MatteJobStore();
  // jsdom has no `confirm`; a long job asks for one, and refusing is not what these tests measure.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  bridge.onCapabilityPackInstalled.mockImplementation(() => () => {});
  bridge.capabilityPackStatus.mockResolvedValue(READY);
});

afterEach(() => {
  vi.clearAllMocks();
  forgetRelinkedMatteIssues();
});

describe('BackgroundRemovalRow', () => {
  it('shows the warning, keeps the button visible and disables it when the pack is missing', async () => {
    bridge.capabilityPackStatus.mockResolvedValue(MISSING);
    render(<Harness jobs={jobs} />);

    const warning = await screen.findByText("Background removal isn't installed.");
    expect(screen.getByText(/1\.1 GB download/)).toBeTruthy();
    expect(screen.getByText(/Apache-2\.0/)).toBeTruthy();

    const button = screen.getByRole('button', { name: 'Remove background' });
    expect(button.hasAttribute('disabled')).toBe(true);
    // The reason is attached to the control, not only shown near it.
    expect(button.getAttribute('aria-describedby')).toBe(warning.parentElement?.id);
    // Politeness, not urgency: the Inspector re-renders on every clip selection.
    expect(warning.parentElement?.getAttribute('role')).toBe('status');
    expect(warning.parentElement?.getAttribute('aria-live')).toBe('polite');
  });

  it('installs exactly the proposal it showed, then re-checks', async () => {
    bridge.capabilityPackStatus.mockResolvedValueOnce(MISSING).mockResolvedValue(READY);
    bridge.capabilityPackPropose.mockResolvedValue({ ok: true, proposal: PROPOSAL });
    bridge.capabilityPackInstall.mockResolvedValue({ ok: true, operationId: 'op1' });
    let emit: ((message: unknown) => void) | null = null;
    bridge.onCapabilityPackProgress.mockImplementation(((handler: (m: unknown) => void) => {
      emit = handler;
      return () => {};
    }) as never);

    render(<Harness jobs={jobs} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install 1.1 GB' }));

    await waitFor(() => expect(bridge.capabilityPackInstall).toHaveBeenCalled());
    expect(bridge.capabilityPackInstall.mock.calls[0]![0]).toMatchObject({
      proposalId: 'p1',
      approvedSizeBytes: PROPOSAL.downloadBytes,
      approvedLicenseSpdx: ['Apache-2.0'],
      approvedMediaEgress: false,
    });
    emit!({
      operationId: 'op1',
      identity: PROPOSAL.identity,
      phase: 'installed',
      completedBytes: 1,
      totalBytes: 1,
    });

    expect(await screen.findByRole('button', { name: 'Remove background' })).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it('refreshes without a restart when any surface installs the pack', async () => {
    bridge.capabilityPackStatus.mockResolvedValueOnce(MISSING).mockResolvedValue(READY);
    let installed: ((event: CapabilityPackInstalledEventWire) => void) | null = null;
    bridge.onCapabilityPackInstalled.mockImplementation(((
      handler: (event: CapabilityPackInstalledEventWire) => void,
    ) => {
      installed = handler;
      return () => {};
    }) as never);

    render(<Harness jobs={jobs} />);
    await screen.findByText("Background removal isn't installed.");

    installed!({ kind: 'installed', identity: PROPOSAL.identity });

    await waitFor(() =>
      expect(screen.queryByText("Background removal isn't installed.")).toBeNull(),
    );
  });

  it('runs the job with the clip’s coverage plus handles, and no prompt in auto mode', async () => {
    bridge.capabilityPackMatte.mockResolvedValue({ ok: false, code: 'needs_prompt' });
    render(<Harness jobs={jobs} />);

    const button = await screen.findByRole('button', { name: 'Remove background' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(bridge.capabilityPackMatte).toHaveBeenCalled());
    expect(bridge.capabilityPackMatte.mock.calls[0]![0]).toMatchObject({
      assetId: 'a1',
      clipId: 'c1',
      sourceStart: 0,
      sourceEnd: 8,
      prompts: [],
      timelineRevision: 2,
    });
  });

  it('asks for a click before running in pick mode instead of guessing a subject', async () => {
    render(<Harness jobs={jobs} />);
    fireEvent.click(await screen.findByRole('combobox', { name: 'background removal subject' }));
    fireEvent.click(screen.getByRole('option', { name: 'Click to pick' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove background' }));

    expect(await screen.findByText('Click the subject on the monitor first.')).toBeTruthy();
    expect(bridge.capabilityPackMatte).not.toHaveBeenCalled();
  });

  it('shows the estimate before anything runs', async () => {
    render(<Harness jobs={jobs} />);
    // 8 s of 1080p coverage at the measured 520 compute-seconds per footage second.
    expect(await screen.findByText(/About 69 minutes on this computer/)).toBeTruthy();
    expect(screen.getByText(/Covers this clip plus 2 s of handles/)).toBeTruthy();
  });
  it('defaults to Fast where the host offers it, with its own estimate, and sends the choice (plan 13)', async () => {
    bridge.capabilityPackStatus.mockResolvedValue({ ...READY, fastMatte: true });
    bridge.capabilityPackMatte.mockResolvedValue({ ok: false, code: 'needs_prompt' });
    render(<Harness jobs={jobs} />);
    // 8 s of 1080p at the measured 10 compute-seconds per footage second, not 69 minutes.
    expect(await screen.findByText(/About 80 seconds on this computer|About 1 minute on this computer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove background' }));
    await waitFor(() => expect(bridge.capabilityPackMatte).toHaveBeenCalled());
    expect(bridge.capabilityPackMatte.mock.calls[0]![0]).toMatchObject({ quality: 'fast' });
    expect(screen.getByText(/Fast works best with one clear subject/)).toBeTruthy();

    fireEvent.click(screen.getByRole('combobox', { name: 'background removal speed' }));
    fireEvent.click(screen.getByRole('option', { name: 'Best quality (can take hours)' }));
    expect(await screen.findByText(/About 69 minutes on this computer/)).toBeTruthy();
    expect(screen.queryByText(/Fast works best with one clear subject/)).toBeNull();
  });

  it('offers no speed choice, and sends none, where only the models can run', async () => {
    bridge.capabilityPackMatte.mockResolvedValue({ ok: false, code: 'needs_prompt' });
    render(<Harness jobs={jobs} />);
    const button = await screen.findByRole('button', { name: 'Remove background' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('combobox', { name: 'background removal speed' })).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(bridge.capabilityPackMatte).toHaveBeenCalled());
    expect(bridge.capabilityPackMatte.mock.calls[0]![0]).not.toHaveProperty('quality');
  });

  it('offers Reinstall, not Install, when the installed pack failed its health check', async () => {
    bridge.capabilityPackStatus.mockResolvedValue({
      state: 'unhealthy',
      capability: 'subject.matte',
      reason: 'the entry point did not answer',
      proposal: { ok: true, proposal: PROPOSAL },
    });
    render(<Harness jobs={jobs} />);

    expect(
      await screen.findByText('The Smart Mask pack is installed but failed its health check.'),
    ).toBeTruthy();
    expect(screen.getByText('the entry point did not answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reinstall' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Install/ })).toBeNull();
  });

  it('names the hardware and offers no download on an unsupported computer', async () => {
    bridge.capabilityPackStatus.mockResolvedValue({
      state: 'unsupported_platform',
      capability: 'subject.matte',
      hardware: {
        requirement: 'an Apple Silicon Mac or a Windows x64 PC',
        platformSupported: false,
        minMemoryBytes: 16e9,
        memoryBytes: 8e9,
        meets: false,
      },
    });
    render(<Harness jobs={jobs} />);

    expect(
      await screen.findByText("Background removal isn't available for this computer yet."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install|Reinstall/ })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says a build without a catalog cannot download the pack', async () => {
    bridge.capabilityPackStatus.mockResolvedValue({
      state: 'catalog_unconfigured',
      capability: 'subject.matte',
    });
    render(<Harness jobs={jobs} />);

    expect(await screen.findByText("Smart Mask can't be installed from this build.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull();
  });

  it('warns about memory below the minimum before anything is downloaded', async () => {
    bridge.capabilityPackStatus.mockResolvedValue({
      ...READY,
      hardware: {
        requirement: 'an Apple Silicon Mac with 16 GB of memory',
        platformSupported: true,
        minMemoryBytes: 16e9,
        memoryBytes: 8e9,
        meets: false,
      },
    });
    render(<Harness jobs={jobs} />);

    expect(
      await screen.findByText(
        'Needs 16 GB of memory; this computer has 8 GB, so it will run slower.',
      ),
    ).toBeTruthy();
    // A warning, not a block: the tool still runs, slower.
    expect(
      (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it('shows the phase, the round, the counts and an ETA while the job runs', async () => {
    let emitProgress: ((message: unknown) => void) | null = null;
    bridge.onCapabilityPackMatteProgress.mockImplementation(((handler: (m: unknown) => void) => {
      emitProgress = handler;
      return () => {};
    }) as never);
    let settle: ((result: unknown) => void) | null = null;
    bridge.capabilityPackMatte.mockImplementation(((intent: { requestId: string }) => {
      requestId = intent.requestId;
      return new Promise((resolve) => {
        settle = resolve;
      });
    }) as never);
    let requestId = '';

    render(<Harness jobs={jobs} />);
    const button = await screen.findByRole('button', { name: 'Remove background' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(bridge.capabilityPackMatte).toHaveBeenCalled());

    act(() =>
      emitProgress!({
        requestId,
        phase: 'self-correct',
        completed: 30,
        total: 120,
        round: 2,
        etaSeconds: 240,
      }),
    );

    expect(await screen.findByText('Correcting itself (round 2 of 3)')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Background removal progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    // A pack that reports only the step: the counts and the time are the STEP's, and say so.
    expect(bar.getAttribute('aria-valuetext')).toBe('Correcting itself (round 2 of 3): 30 of 120');
    expect(screen.getByText(/about 4 minutes left in this step/)).toBeTruthy();

    // Plan 13: whole-job frames take over the bar and the time left; the step is only named.
    act(() =>
      emitProgress!({
        requestId,
        phase: 'segment',
        completed: 12,
        total: 240,
        etaSeconds: 40,
        overallCompleted: 600,
        overallTotal: 1500,
        jobEtaSeconds: 300,
      }),
    );
    expect(await screen.findByText('Finding the subject · 40% of the clip')).toBeTruthy();
    expect(bar.getAttribute('aria-valuenow')).toBe('600');
    expect(bar.getAttribute('aria-valuetext')).toBe('600 of 1500 frames');
    expect(screen.getByText(/about 5 minutes left$/)).toBeTruthy();

    // Cancel goes to main by request id; the outcome still comes back through the promise.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.capabilityPackCancelMatte).toHaveBeenCalledWith(requestId);
    await act(async () => {
      settle!({ ok: false, code: 'cancelled', error: 'Cancelled.', retryable: true });
      await Promise.resolve();
    });
  });

  it('keeps the job when the editor selects another clip and comes back', async () => {
    let settle: ((result: unknown) => void) | null = null;
    bridge.capabilityPackMatte.mockImplementation(
      (() =>
        new Promise((resolve) => {
          settle = resolve;
        })) as never,
    );

    const view = render(<Harness jobs={jobs} />);
    const button = await screen.findByRole('button', { name: 'Remove background' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(bridge.capabilityPackMatte).toHaveBeenCalledTimes(1));

    // The Inspector row unmounts on a selection change and re-mounts when the editor returns.
    view.unmount();
    expect(jobs.getState().jobs.c1).toBeDefined();
    render(<Harness jobs={jobs} />);

    // Re-mounting reconnects to the live job rather than starting a second run.
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(bridge.capabilityPackMatte).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle!({ ok: false, code: 'cancelled', error: 'Cancelled.', retryable: true });
      await Promise.resolve();
    });
  });

  it('does not offer a second run while one is in flight', async () => {
    bridge.capabilityPackMatte.mockImplementation((() => new Promise(() => {})) as never);
    render(<Harness jobs={jobs} />);
    const button = await screen.findByRole('button', { name: 'Remove background' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });
  it('offers text behind the subject once a background removal is applied', async () => {
    bridge.matteRecheckMedia.mockResolvedValue({ ok: true, issues: [] });
    render(<Harness jobs={jobs} withMatte />);

    const field = await screen.findByLabelText('Text behind the subject');
    const button = screen.getByRole('button', { name: 'Put text behind subject' });
    // Nothing to put behind anything until there is text.
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field, { target: { value: 'BEHIND' } });
    fireEvent.click(screen.getByRole('button', { name: 'Put text behind subject' }));
    expect(await screen.findByText('Text added behind the subject.')).toBeTruthy();
  });

  it('warns that the removed area exports as black with nothing below the clip', async () => {
    bridge.matteRecheckMedia.mockResolvedValue({ ok: true, issues: [] });
    render(<Harness jobs={jobs} withMatte />);
    expect(
      await screen.findByText(/Nothing below this clip, so the removed area exports as black/),
    ).toBeTruthy();
  });

  it('replaces the clip’s background removal when it runs again, so a stale one is gone (E2E.6)', async () => {
    const fresh = 'c'.repeat(64);
    bridge.capabilityPackMatte.mockResolvedValue({
      ok: true,
      artifact: {
        key: fresh,
        files: [{ name: 'matte.mkv', sha256: 'd'.repeat(64) }],
        width: 1920,
        height: 1080,
        coverage: { sourceStart: 0, sourceEnd: 8 },
        packId: 'smart-mask',
        packVersion: '1.0.0',
        modelDigests: ['d'.repeat(64)],
      },
      summary: { verifiedFrames: 240, flaggedFrames: 0, lockedFrames: 0, selfCorrectionRounds: 0 },
      needsReview: [],
      executionProvider: 'cpu',
      cacheHit: false,
      projectRevision: 2,
    });
    let masks: readonly { id: string; artifact?: { key: string } }[] = [];
    function Rerun(): JSX.Element {
      const editor = useEditor(timelineWithMatte, { assets });
      useMatteJobCommits(editor, jobs);
      const clip = editor.state.timeline.tracks[0]!.clips[0]!;
      masks = (clip.masks ?? []) as unknown as typeof masks;
      return (
        <BackgroundRemovalRow
          editor={editor}
          clip={clip}
          store={new MaskToolStore()}
          jobs={jobs}
          developmentBuild={false}
        />
      );
    }
    render(<Rerun />);
    const button = await screen.findByRole('button', { name: 'Remove background' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(masks[0]?.artifact?.key).toBe(fresh));
    expect(masks.map((mask) => mask.id)).toEqual(['c1__mask']);
  });

  it('shows STALE right after a relink, before main’s own re-check can see the saved file (E2E.6)', async () => {
    const remedy = 'Media changed since background removal ran — run Remove background again.';
    // The relink's re-check found it stale for the file the asset now points at …
    await relinkAsset('a1', {
      bridge: {
        projectChooseRelinkFile: async () => ({ ok: true, assetId: 'a1', path: 'media/a1.mp4' }),
        matteRecheckMedia: async () => ({
          ok: true as const,
          issues: [
            {
              clipId: 'c1',
              maskId: 'c1__mask',
              artifactKey: 'a'.repeat(64),
              code: 'matte_media_changed',
              status: 'stale' as const,
              remedy,
            },
          ],
        }),
      },
      applyPatch: vi.fn(),
    });
    // … while the Inspector's re-check reads the disk, where the relink has not landed yet.
    bridge.matteRecheckMedia.mockResolvedValue({ ok: true, issues: [] });
    render(<Harness jobs={jobs} withMatte />);
    expect(await screen.findByText(remedy)).toBeTruthy();
  });

  it('drops a re-check finding about an artifact the clip no longer carries (E2E.6)', async () => {
    // Main read the saved project before the re-run's new matte was saved: it reports the OLD key.
    bridge.matteRecheckMedia.mockResolvedValue({
      ok: true,
      issues: [
        {
          clipId: 'c1',
          maskId: 'c1__mask',
          artifactKey: 'f'.repeat(64),
          code: 'matte_media_changed',
          status: 'stale',
          remedy: 'Media changed since background removal ran — run Remove background again.',
        },
      ],
    });
    render(<Harness jobs={jobs} withMatte />);
    await waitFor(() => expect(bridge.matteRecheckMedia).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByText(/Media changed since background removal ran/)).toBeNull();
  });

  it('shows the engine’s own remedy sentence for a stale matte', async () => {
    bridge.matteRecheckMedia.mockResolvedValue({
      ok: true,
      issues: [
        {
          clipId: 'c1',
          maskId: 'c1__mask',
          artifactKey: 'a'.repeat(64),
          code: 'matte_media_changed',
          status: 'stale',
          remedy: 'Media changed since background removal ran — run Remove background again.',
        },
      ],
    });
    render(<Harness jobs={jobs} withMatte />);
    expect(
      await screen.findByText(
        'Media changed since background removal ran — run Remove background again.',
      ),
    ).toBeTruthy();
  });
  it('turns the estimate into a blocking disk-space message, with a way out (BR6.8)', async () => {
    bridge.capabilityPackMatte.mockResolvedValue({
      ok: false,
      code: 'insufficient_disk',
      error: 'Not enough space.',
      retryable: true,
      requiredBytes: 4_000_000_000,
      freeBytes: 900_000_000,
    });
    render(
      <>
        <Committer jobs={jobs} />
        <Harness jobs={jobs} />
      </>,
    );
    const button = await screen.findByRole('button', { name: 'Remove background' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    const blocked = await screen.findByText(/Not enough disk space/);
    // Both numbers, so the editor knows how much to free rather than guessing.
    expect(blocked.textContent).toContain('4.0 GB');
    expect(blocked.textContent).toContain('900 MB');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );

    // Freeing space must not need a restart.
    fireEvent.click(screen.getByRole('button', { name: 'check again' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it('says the first run also prepares the models, so the wait is never unexplained', async () => {
    render(<Harness jobs={jobs} />);
    expect(
      await screen.findByText(/The first run on this computer also prepares the models/),
    ).toBeTruthy();
  });
  it('reports a failed install and offers Retry, without pretending it worked (BR6.9)', async () => {
    bridge.capabilityPackStatus.mockResolvedValue(MISSING);
    bridge.capabilityPackPropose.mockResolvedValue({ ok: true, proposal: PROPOSAL });
    bridge.capabilityPackInstall.mockResolvedValue({
      ok: false,
      error: 'The download did not match its checksum.',
    });
    render(<Harness jobs={jobs} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Install 1.1 GB' }));
    expect(await screen.findByText('The download did not match its checksum.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // Still blocked: a failed install must not unlock the tool.
    expect(
      (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says the capability could not be checked when main cannot answer (BR6.9)', async () => {
    bridge.capabilityPackStatus.mockRejectedValue(new Error('the main process is not responding'));
    render(<Harness jobs={jobs} />);

    expect(await screen.findByText('Background removal could not be checked.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the licences behind Details rather than in the first sentence (BR6.9)', async () => {
    bridge.capabilityPackStatus.mockResolvedValue(MISSING);
    render(<Harness jobs={jobs} />);

    const details = await screen.findByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/Removes backgrounds on this computer/)).toBeTruthy();
  });

  it('keeps every control reachable and labelled from the keyboard (BR6.9)', async () => {
    render(<Harness jobs={jobs} />);
    // Both choices are named controls, in the Inspector's own select pattern.
    const subject = await screen.findByRole('combobox', { name: 'background removal subject' });
    expect(subject.textContent).toContain('Auto (main subject)');
    const edges = screen.getByRole('combobox', { name: 'background removal edges' });
    expect(edges.textContent).toContain('Smooth (hair and soft edges)');
  });

  describe('mattes main found broken when the project opened (BR4.15)', () => {
    const MISSING_REMEDY = 'Background removal data is missing — run Remove background again.';
    const broken = (artifactKey = 'a'.repeat(64)): MatteValidationIssueWire => ({
      clipId: 'c1',
      maskId: 'c1__mask',
      artifactKey,
      code: 'matte_missing',
      status: 'broken',
      remedy: MISSING_REMEDY,
    });

    /** Main's re-check answers only when the test says so. */
    function pendingRecheck(): (answer: unknown) => void {
      let answer: (value: unknown) => void = () => {};
      bridge.matteRecheckMedia.mockImplementation(
        () => new Promise((resolve) => (answer = resolve)),
      );
      return (value) => answer(value);
    }

    function renderOpened(issues: readonly MatteValidationIssueWire[]): void {
      render(
        <OpenedMatteIssuesProvider issues={issues}>
          <Harness jobs={jobs} withMatte />
        </OpenedMatteIssuesProvider>,
      );
    }

    it('shows BROKEN with the remedy on the first paint, before the re-check answers', () => {
      pendingRecheck();
      renderOpened([broken()]);
      expect(screen.getByText(MISSING_REMEDY)).toBeTruthy();
      expect(bridge.matteRecheckMedia).toHaveBeenCalledWith({ assetIds: ['a1'] });
    });

    it('keeps it when the re-check cannot answer', async () => {
      const answer = pendingRecheck();
      renderOpened([broken()]);
      await act(async () =>
        answer({ ok: false, code: 'no_project', error: 'No project is open.' }),
      );
      expect(screen.getByText(MISSING_REMEDY)).toBeTruthy();
    });

    it("lets main's answer replace it", async () => {
      const answer = pendingRecheck();
      renderOpened([broken()]);
      await act(async () => answer({ ok: true, issues: [] }));
      expect(screen.queryByText(MISSING_REMEDY)).toBeNull();
    });

    it('ignores a finding about an artifact the clip no longer uses', () => {
      pendingRecheck();
      renderOpened([broken('c'.repeat(64))]);
      expect(screen.queryByText(MISSING_REMEDY)).toBeNull();
    });
  });
});

describe('subjectPrompts (BR7.5)', () => {
  it('sends the editor’s box as its own prompt ahead of the clicks, never inventing one', () => {
    const points = [{ x: 0.5, y: 0.6, label: 'include' as const, sourceTime: 1 }];
    expect(subjectPrompts(points)).toEqual([
      { kind: 'points', sourceTime: 1, points: [{ x: 0.5, y: 0.6, label: 'include' }] },
    ]);
    expect(
      subjectPrompts(points, { x: 0.2, y: 0.1, width: 0.6, height: 0.9, sourceTime: 1 }),
    ).toEqual([
      { kind: 'box', sourceTime: 1, box: { x: 0.2, y: 0.1, width: 0.6, height: 0.9 } },
      { kind: 'points', sourceTime: 1, points: [{ x: 0.5, y: 0.6, label: 'include' }] },
    ]);
  });
});
