import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Asset } from '@framepilot/timeline-schema';
import {
  CreditsSection,
  creditRows,
  creditsText,
  suggestedCreditRows,
  suggestedCreditsText,
} from './CreditsSection.js';

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
    expect(screen.getByText('Nothing in this project requires credit.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Copy required credits' })).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: 'Copy required credits' }));
    expect(writeText).toHaveBeenCalledWith(
      '"Calm Lofi Bed" by Ada Lovelace is licensed under CC BY 4.0.\n' +
        '"Theme" by Grace Hopper is licensed under CC BY-SA 4.0.',
    );
    // The visible label flips; the accessible name deliberately does not. A
    // button that renames itself mid-interaction is disorienting to anyone
    // navigating by name, so the result is announced in the live region instead.
    expect(await screen.findByText('Copied')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy required credits' })).toBeDefined();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Credits copied');
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

  // ---------------------------------------------------------------------------
  // Suggested credits — a courtesy, kept distinct from an obligation
  // ---------------------------------------------------------------------------

  describe('suggested credits', () => {
    const pexelsPhoto = {
      id: 'stock_pexels_2014422',
      path: 'media/p/rocks.jpg',
      kind: 'image' as const,
      source: {
        provider: 'pexels',
        remoteId: '2014422',
        license: 'pexels',
        licenseUrl: 'https://www.pexels.com/license/',
        attributionRequired: false,
        attribution: 'Photo by Joey Farina on Pexels',
        creator: 'Joey Farina',
        fetchedAt: '2026-08-24T12:00:00.000Z',
      },
    } as unknown as Asset;

    it('lists a Pexels item as suggested, never as required', () => {
      render(<CreditsSection assets={[pexelsPhoto]} />);
      expect(screen.getByText('Suggested credits')).toBeTruthy();
      expect(screen.getByText('Photo by Joey Farina on Pexels')).toBeTruthy();
      // Still answered out loud: "do I owe anyone a credit?" has an answer even
      // when the answer is no.
      expect(screen.getByText('Nothing in this project requires credit.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Copy required credits' })).toBeNull();
    });

    it('separates the two groups when a project has both', () => {
      const ccTrack = {
        id: 'music_openverse_1',
        path: 'media/p/bed.mp3',
        kind: 'audio' as const,
        source: {
          provider: 'openverse',
          remoteId: '1',
          license: 'by',
          attributionRequired: true,
          attribution: '"Calm Bed" by Ada is licensed under CC BY 4.0.',
          fetchedAt: '2026-08-24T12:00:00.000Z',
        },
      } as unknown as Asset;

      render(<CreditsSection assets={[ccTrack, pexelsPhoto]} />);
      // A licence term and a courtesy are different obligations on different
      // parties; flattening them is what makes the real badge ignorable.
      expect(screen.getByRole('button', { name: 'Copy required credits' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy suggested credits' })).toBeTruthy();
      expect(creditRows([ccTrack, pexelsPhoto])).toHaveLength(1);
      expect(suggestedCreditRows([ccTrack, pexelsPhoto])).toHaveLength(1);
    });

    it('omits an item with nobody to credit', () => {
      const anonymous = {
        ...pexelsPhoto,
        id: 'anon',
        source: {
          ...(pexelsPhoto as { source: object }).source,
          attribution: undefined,
          creator: undefined,
        },
      } as unknown as Asset;
      // A suggested credit with no name in it is a blank line the user would
      // paste into their description.
      expect(suggestedCreditRows([anonymous])).toHaveLength(0);
    });

    it('ignores user-imported files entirely', () => {
      const imported = { id: 'own', path: 'media/p/screen.mov', kind: 'video' } as unknown as Asset;
      expect(suggestedCreditRows([imported])).toHaveLength(0);
      expect(creditRows([imported])).toHaveLength(0);
    });

    it('copies only its own group', () => {
      expect(suggestedCreditsText([pexelsPhoto])).toBe('Photo by Joey Farina on Pexels');
      expect(creditsText([pexelsPhoto])).toBe('');
    });
  });
});
