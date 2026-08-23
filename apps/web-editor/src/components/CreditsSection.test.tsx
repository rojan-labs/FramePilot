import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Asset } from '@framepilot/timeline-schema';
import { CreditsSection, creditsText } from './CreditsSection.js';

function assetWithSource(id: string, source: NonNullable<Asset['source']>): Asset {
  return { id, path: `media/${id}.mp3`, kind: 'audio', source };
}

const ccBy = assetWithSource('bed', {
  provider: 'openverse',
  remoteId: 'ov-1',
  license: 'cc-by',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attributionRequired: true,
  attribution: '"Calm Lofi Bed" by Ada Lovelace is licensed under CC BY 4.0.',
  creator: 'Ada Lovelace',
  fetchedAt: '2026-08-23T12:00:00.000Z',
});

const cc0 = assetWithSource('sting', {
  provider: 'openverse',
  remoteId: 'ov-2',
  license: 'cc0',
  attributionRequired: false,
  fetchedAt: '2026-08-23T12:00:00.000Z',
});

const imported: Asset = { id: 'cam', path: 'media/cam.mp4', kind: 'video' };

/** Install a clipboard stub and hand back the spy that captures what was written. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

describe('CreditsSection', () => {
  it('confirms there is nothing to credit rather than showing a blank panel', () => {
    // "Nothing to do" is information. A blank section would send the user off to
    // check their licences by hand, which is the work this view exists to remove.
    render(<CreditsSection assets={[cc0, imported]} />);
    expect(screen.getByText('No tracks in this project require credit.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Copy all credits' })).toBeNull();
  });

  it('lists the credit line and licence for an attribution-required asset', () => {
    render(<CreditsSection assets={[ccBy, cc0, imported]} />);
    expect(
      screen.getByText('"Calm Lofi Bed" by Ada Lovelace is licensed under CC BY 4.0.'),
    ).toBeDefined();
    const license = screen.getByRole('link', { name: 'cc-by' });
    expect(license.getAttribute('href')).toBe('https://creativecommons.org/licenses/by/4.0/');
    // Opening a licence page must not be able to reach back into the editor window.
    expect(license.getAttribute('rel')).toContain('noopener');
  });

  it('omits CC0 and user-imported assets — absent means nothing owed, not unknown', () => {
    render(<CreditsSection assets={[ccBy, cc0, imported]} />);
    expect(screen.getByText(/1 track in this project requires credit/)).toBeDefined();
    expect(screen.queryByText('cc0')).toBeNull();
  });

  it('copies every credit as one plain-text block and confirms it', async () => {
    const writeText = stubClipboard();
    const second = assetWithSource('theme', {
      provider: 'openverse',
      remoteId: 'ov-3',
      license: 'cc-by-sa',
      attributionRequired: true,
      attribution: '"Theme" by Grace Hopper is licensed under CC BY-SA 4.0.',
      creator: 'Grace Hopper',
      fetchedAt: '2026-08-23T12:00:00.000Z',
    });

    render(<CreditsSection assets={[ccBy, cc0, second]} />);
    expect(screen.getByText(/2 tracks in this project require credit/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Copy all credits' }));
    expect(writeText).toHaveBeenCalledWith(
      '"Calm Lofi Bed" by Ada Lovelace is licensed under CC BY 4.0.\n' +
        '"Theme" by Grace Hopper is licensed under CC BY-SA 4.0.',
    );
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined();
  });

  it('assembles a usable line when the provider supplied no attribution string', () => {
    // An incomplete credit the user can finish beats no credit at all, so the
    // fallback degrades a field at a time rather than dropping the whole line.
    const noLine = assetWithSource('mystery', {
      provider: 'openverse',
      remoteId: 'ov-4',
      license: 'cc-by',
      attributionRequired: true,
      fetchedAt: '2026-08-23T12:00:00.000Z',
    });
    expect(creditsText([noLine])).toBe('"mystery.mp3" by Unknown creator — cc-by');
  });
});
