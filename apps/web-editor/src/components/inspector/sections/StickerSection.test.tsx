/** The Inspector's Sticker section (plan/elements EL6a.5): its name, its credit, and Replace…. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Asset, Clip } from '@framepilot/timeline-schema';
import { StickerInspector, stickerName } from './StickerSection.js';

const asset = {
  id: 'element_fluent3d_thumbs_up',
  path: 'media/p/elements/fluent3d/thumbs_up.webp',
  kind: 'image',
  source: {
    provider: 'fluent-emoji',
    remoteId: 'thumbs_up',
    license: 'mit',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
} as Asset;
const clip = { id: 'c1' } as Clip;

describe('StickerInspector', () => {
  it('names the sticker, credits it, and opens Replace for this clip', () => {
    const onReplace = vi.fn();
    render(<StickerInspector clip={clip} asset={asset} onReplace={onReplace} />);
    expect(screen.getByText('Thumbs up')).toBeDefined();
    expect(screen.getByText('Fluent Emoji by Microsoft (MIT)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    expect(onReplace).toHaveBeenCalledWith('c1', 'Thumbs up');
  });

  it('offers no Replace where there is no panel to replace from', () => {
    render(<StickerInspector clip={clip} asset={asset} />);
    expect(screen.queryByRole('button', { name: 'Replace…' })).toBeNull();
    expect(stickerName(undefined)).toBe('Sticker');
  });
});
