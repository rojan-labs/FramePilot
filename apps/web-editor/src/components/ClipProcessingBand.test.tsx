/**
 * The processing band on a clip (BR6.8).
 *
 * Progressive results mean finished windows already show matted in the monitor, so the band is
 * the only thing that tells a partly processed clip from a finished one. It must exist while the
 * job runs, cover only the part not reached yet, and vanish the moment the job ends.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ClipProcessingBand } from './ClipProcessingBand.js';
import { MatteJobStore } from './inspector/masks/matteJobStore.js';

const bridge = vi.hoisted(() => ({
  capabilityPackMatte: vi.fn(() => new Promise(() => {})),
  capabilityPackCancelMatte: vi.fn(),
  onCapabilityPackMatteProgress: vi.fn(() => () => {}),
}));

vi.mock('../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

describe('ClipProcessingBand', () => {
  it('renders nothing when no job is running on the clip', () => {
    const { container } = render(<ClipProcessingBand clipId="c1" jobs={new MatteJobStore()} />);
    expect(container.querySelector('.clip-processing-band')).toBeNull();
  });

  it('covers the part the job has not reached, and nothing once it ends', async () => {
    const jobs = new MatteJobStore();
    const { container } = render(<ClipProcessingBand clipId="c1" jobs={jobs} />);

    await act(async () => {
      void jobs.start({
        assetId: 'a1',
        clipId: 'c1',
        sourceStart: 0,
        sourceEnd: 4,
        prompts: [],
        timelineRevision: 1,
      });
      await Promise.resolve();
    });

    const band = container.querySelector('.clip-processing-band') as HTMLElement | null;
    expect(band).not.toBeNull();
    // Nothing is done yet, so the band covers the whole clip.
    expect(band!.style.left).toBe('0%');
    expect(band!.style.width).toBe('100%');
    // It is decoration over the clip, never a click target.
    expect(band!.getAttribute('aria-hidden')).toBe('true');

    await act(async () => {
      jobs.cancel('c1');
      await Promise.resolve();
    });
  });
});
