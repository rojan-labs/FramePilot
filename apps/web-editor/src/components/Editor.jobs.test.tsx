/**
 * BR6.12: the Jobs panel is mounted in the editor layout, as a right-rail tab.
 *
 * Desktop only: jobs are pack jobs the desktop host schedules, so a browser build has no tab
 * (and a stored "jobs" rail preference falls back to the default instead of opening a panel
 * whose tab is missing). Driven through the real Editor with a fake desktop bridge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { CapabilityPackJobWire } from '@framepilot/shared-types';
import { Editor } from './Editor.js';
import { demoProject } from '../editor/demo.js';

const compositorFlag = vi.hoisted(() => ({ layers: true }));
vi.mock('../preview/compositor-flag.js', () => ({
  layerCompositorEnabled: () => compositorFlag.layers,
  previewCompositor: () => (compositorFlag.layers ? 'layers' : 'legacy'),
}));

const firstClip = demoProject.timeline.tracks.flatMap((track) => track.clips)[0]!;

const job = (overrides: Partial<CapabilityPackJobWire> = {}): CapabilityPackJobWire => ({
  id: 'job-1',
  kind: 'matte',
  label: 'Remove background',
  clipId: firstClip.id,
  priority: 'focused',
  state: 'running',
  progress: { phase: 'segment', completed: 3, total: 10 },
  resumed: false,
  ...overrides,
});

interface FakeBridge {
  capabilityPackJobs: () => Promise<readonly CapabilityPackJobWire[]>;
  onCapabilityPackJobsChanged: (
    listener: (jobs: readonly CapabilityPackJobWire[]) => void,
  ) => () => void;
  capabilityPackJobAction: ReturnType<typeof vi.fn>;
  push: (jobs: readonly CapabilityPackJobWire[]) => void;
}

function installBridge(initial: readonly CapabilityPackJobWire[]): FakeBridge {
  let listener: ((jobs: readonly CapabilityPackJobWire[]) => void) | undefined;
  const bridge: FakeBridge = {
    capabilityPackJobs: async () => initial,
    onCapabilityPackJobsChanged: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    capabilityPackJobAction: vi.fn(async () => true),
    push: (jobs) => listener?.(jobs),
  };
  (window as unknown as { framepilot?: unknown }).framepilot = bridge;
  return bridge;
}

afterEach(() => {
  delete (window as unknown as { framepilot?: unknown }).framepilot;
  window.localStorage.clear();
});

describe('Editor Jobs tab (BR6.12)', () => {
  it('has no Jobs tab in the browser build', () => {
    render(<Editor project={demoProject} />);
    const tabs = screen.getByRole('tablist', { name: 'rail tabs' });
    expect(within(tabs).queryByRole('tab', { name: 'Jobs' })).toBeNull();
    expect(within(tabs).getByRole('tab', { name: 'Inspector' })).toBeTruthy();
  });

  it('mounts the live job list on desktop and wires the actions to the host', async () => {
    const bridge = installBridge([job()]);
    render(<Editor project={demoProject} />);
    const tab = within(screen.getByRole('tablist', { name: 'rail tabs' })).getByRole('tab', {
      name: 'Jobs',
    });
    fireEvent.click(tab);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const heading = await screen.findByRole('heading', { name: 'Jobs' });
    const panel = heading.closest('section')!;
    // The clip is named by its media file, not its id.
    const assetName = demoProject.assets
      .find((asset) => asset.id === firstClip.assetId)!
      .path.split('/')
      .pop()!;
    expect(within(panel).getByText(assetName)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause Remove background' }));
    expect(bridge.capabilityPackJobAction).toHaveBeenCalledWith({
      jobId: 'job-1',
      action: 'pause',
    });
    act(() => bridge.push([job({ state: 'paused' })]));
    expect(screen.getByRole('button', { name: 'Resume Remove background' })).toBeTruthy();
  });

  it('is reachable from the keyboard: the tab is a focusable button that opens on Enter', async () => {
    installBridge([]);
    render(<Editor project={demoProject} />);
    const tab = within(screen.getByRole('tablist', { name: 'rail tabs' })).getByRole('tab', {
      name: 'Jobs',
    });
    expect(tab.tagName).toBe('BUTTON');
    expect(tab.getAttribute('tabindex')).not.toBe('-1');
    tab.focus();
    expect(document.activeElement).toBe(tab);
    // A native button activates on Enter/Space with a click event.
    fireEvent.click(tab);
    expect(await screen.findByText('No background jobs.')).toBeTruthy();
  });

  it('Show clip selects the clip, moves the playhead to it and opens the Inspector', async () => {
    installBridge([job()]);
    render(<Editor project={demoProject} />);
    fireEvent.click(
      within(screen.getByRole('tablist', { name: 'rail tabs' })).getByRole('tab', { name: 'Jobs' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show clip for Remove background' }));
    const inspectorTab = within(screen.getByRole('tablist', { name: 'rail tabs' })).getByRole(
      'tab',
      {
        name: 'Inspector',
      },
    );
    expect(inspectorTab.getAttribute('aria-selected')).toBe('true');
    expect(Number((screen.getByLabelText('playhead') as HTMLInputElement).value)).toBeCloseTo(
      firstClip.start,
    );
  });
});
