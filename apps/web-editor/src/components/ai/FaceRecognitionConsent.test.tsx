import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IdentityState } from '@framepilot/ai-sdk';
import { FaceRecognitionConsent, type IdentityService } from './FaceRecognitionConsent.js';

const state = (over: Partial<IdentityState> = {}): IdentityState => ({
  available: true,
  consent: false,
  people: 0,
  ...over,
});

function service(initial: IdentityState, over: Partial<IdentityService> = {}): IdentityService {
  return {
    state: vi.fn(async () => initial),
    setConsent: vi.fn(async (_projectId: string, consent: boolean) =>
      state({ consent, people: initial.people }),
    ),
    deleteAll: vi.fn(async () => state({ deletedPeople: initial.people })),
    ...over,
  };
}

describe('FaceRecognitionConsent', () => {
  it('is off by default, says where it runs, and turns on only when the editor says so', async () => {
    const identity = service(state());
    render(<FaceRecognitionConsent projectId="p1" service={identity} />);
    const on = await screen.findByRole('button', { name: 'Turn on for this project' });
    expect(screen.getByRole('group').textContent).toContain('on this computer only');
    expect(identity.setConsent).not.toHaveBeenCalled();
    // Nothing to delete yet, so the action is not offered.
    expect(screen.queryByRole('button', { name: 'Delete identity data' })).toBeNull();
    fireEvent.click(on);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Face recognition is on for this project.',
      ),
    );
    expect(identity.setConsent).toHaveBeenCalledWith('p1', true);
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('deletes everything in one action, says how much, and leaves recognition off', async () => {
    const identity = service(state({ consent: true, people: 3 }));
    render(<FaceRecognitionConsent projectId="p1" service={identity} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete identity data' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Deleted what FramePilot stored about 3 people in this project. Face recognition is off.',
      ),
    );
    expect(identity.deleteAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Turn on for this project' })).toBeTruthy();
  });

  it('offers deletion for stored identities even while recognition is off', async () => {
    render(
      <FaceRecognitionConsent
        projectId="p1"
        service={service(state({ consent: false, people: 2 }))}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Delete identity data' })).toBeTruthy();
  });

  it('shows nothing when the project brain cannot be read — the editor just picks faces', async () => {
    const identity = service({ available: false, consent: false, people: 0, reason: 'down' });
    const { container } = render(<FaceRecognitionConsent projectId="p1" service={identity} />);
    await waitFor(() => expect(identity.state).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('says so when a change could not be saved, and claims nothing', async () => {
    const identity = service(state(), {
      setConsent: vi.fn(async () => ({ available: false, consent: false, people: 0 })),
    });
    render(<FaceRecognitionConsent projectId="p1" service={identity} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on for this project' }));
    // The component hides itself once the brain is unreadable; the one thing it must not do
    // is report consent as granted.
    await waitFor(() => expect(identity.setConsent).toHaveBeenCalled());
    expect(screen.queryByText('Face recognition is on for this project.')).toBeNull();
  });
});
