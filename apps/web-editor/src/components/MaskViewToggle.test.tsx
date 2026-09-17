import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MaskViewToggle } from './MaskViewToggle.js';
import { layersForMaskView, maskColorRgb } from '../preview/masks/mask-view.js';

describe('MaskViewToggle', () => {
  it('offers the four views as one pressed-button group', () => {
    render(<MaskViewToggle value="off" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Mask view' });
    expect(group).toBeTruthy();
    const names = screen.getAllByRole('button').map((button) => button.textContent);
    expect(names).toEqual(['Off', 'Overlay', 'Mask only', 'Checkerboard']);
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Overlay' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('reports the chosen view', () => {
    const onChange = vi.fn();
    render(<MaskViewToggle value="overlay" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Checkerboard' }));
    expect(onChange).toHaveBeenCalledWith('checkerboard');
    expect(screen.getByRole('button', { name: 'Overlay' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('mask view helpers', () => {
  it('isolates the viewed layer only for the checkerboard view', () => {
    const layers = ['base', 'viewed', 'title'];
    const isViewed = (layer: string): boolean => layer === 'viewed';
    expect(layersForMaskView('checkerboard', layers, isViewed)).toEqual({
      checkerboard: true,
      layers: ['viewed'],
    });
    expect(layersForMaskView('overlay', layers, isViewed)).toEqual({ checkerboard: false, layers });
    expect(layersForMaskView('checkerboard', layers, () => false)).toEqual({
      checkerboard: false,
      layers,
    });
  });

  it('reads the mask colour and falls back to the schema default', () => {
    expect(maskColorRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(maskColorRgb('nope')).toEqual([0x3b / 255, 0x82 / 255, 0xf6 / 255]);
  });
});
