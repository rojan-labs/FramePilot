/**
 * The Inspector's background-removal row (BR6.1).
 *
 * What is asserted is the promise the row makes to an editor who does not have the pack: the
 * capability is visible, it is disabled with a reason attached to the button, installing is one
 * approved click, and the row believes the install happened only because main said so — including
 * when the install came from somewhere else entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import type {
  CapabilityPackInstalledEventWire,
  CapabilityPackStatusWire,
} from '@framepilot/shared-types';
import { useEditor } from '../../../editor/useEditor.js';
import { BackgroundRemovalRow } from './BackgroundRemovalRow.js';
import { MatteJobStore } from './matteJobStore.js';
import { MaskToolStore } from './useMaskTools.js';

const bridge = vi.hoisted(() => ({
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

function Harness({ jobs }: { readonly jobs: MatteJobStore }): JSX.Element {
  const editor = useEditor(timeline, { assets });
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
    fireEvent.click(await screen.findByLabelText('Click to pick'));
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
});
