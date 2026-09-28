/**
 * The Text section: titles take the caption fonts and the caption typography. Each control is
 * one `set_effect_params`; a plain title's first typography edit starts from the stroke it was
 * drawn with, so converting it keeps its look.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { PLAIN_TITLE_TYPOGRAPHY } from '@framepilot/timeline-schema/title-templates';
import type { UseEditor } from '../../../editor/useEditor.js';
import { fontHasItalic, fontWeightsFor } from '../../FontFamilySelect.js';
import { TextOverlayInspector } from './TextSection.js';

function titleClip(params: Record<string, unknown>): Clip {
  return {
    id: 't1',
    assetId: '__text__',
    trackId: 'o',
    start: 0,
    end: 3,
    sourceStart: 0,
    sourceEnd: 3,
    effects: [{ id: 't1__text', type: 'text', params: { text: 'Hi', ...params }, keyframes: [] }],
    keyframes: [],
  };
}

function renderTitle(params: Record<string, unknown>) {
  const clip = titleClip(params);
  const timeline: Timeline = { tracks: [{ id: 'o', type: 'overlay', clips: [clip] }] };
  const applyPatch = vi.fn();
  const editor = { state: { timeline }, applyPatch } as unknown as UseEditor;
  render(<TextOverlayInspector editor={editor} clip={clip} />);
  /** The params the only patch applied so far wrote. */
  const written = (): Record<string, unknown> => {
    expect(applyPatch).toHaveBeenCalledTimes(1);
    const [op] = applyPatch.mock.calls[0]![0].operations;
    expect(op).toMatchObject({ type: 'set_effect_params', clipId: 't1', effectId: 't1__text' });
    return op.params as Record<string, unknown>;
  };
  return { applyPatch, written };
}

const choose = (combobox: string, option: RegExp): void => {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  fireEvent.click(screen.getByRole('option', { name: option }));
};

describe('TextOverlayInspector', () => {
  it('offers the bundled caption fonts and keeps the weight to one the family has', () => {
    const { written } = renderTitle({ fontFamily: 'Inter', fontWeight: 800 });
    choose('font family', /^Bebas Neue/);
    // Bebas Neue ships one face, at 400.
    expect(written()).toEqual({ fontFamily: 'Bebas Neue', fontWeight: 400 });
  });

  it('shows a stored family that is not bundled for what it is', () => {
    renderTitle({ fontFamily: 'Georgia' });
    expect(screen.getByRole('combobox', { name: 'font family' }).textContent).toContain(
      'Georgia (not bundled)',
    );
  });

  it('converts a plain title on its first typography edit, keeping its stroke', () => {
    const { written } = renderTitle({ fontFamily: 'Inter' });
    choose('text case', /UPPERCASE/);
    expect(written()).toEqual({
      typography: { ...PLAIN_TITLE_TYPOGRAPHY, textTransform: 'uppercase' },
    });
  });

  it('turns the outline off by removing it, not by zeroing it', () => {
    const { written } = renderTitle({
      fontFamily: 'Inter',
      typography: { outlineColor: '#000000', outlineWidth: 2, letterSpacing: 0.1 },
    });
    fireEvent.click(screen.getByLabelText('outline'));
    expect(written()).toEqual({ typography: { letterSpacing: 0.1 } });
  });

  it('keeps a coloured shadow colour when another preset is chosen', () => {
    const { written } = renderTitle({
      fontFamily: 'Inter',
      typography: { shadow: { color: '#3de0ffcc', blur: 0.55, offsetX: 0, offsetY: 0 } },
    });
    expect(screen.getByRole('combobox', { name: 'text shadow' }).textContent).toContain('Glow');
    choose('text shadow', /^Hard/);
    expect(written()).toEqual({
      typography: { shadow: { color: '#3de0ffcc', blur: 0, offsetX: 0.05, offsetY: 0.07 } },
    });
  });

  it('offers italic only for a family that ships one', () => {
    renderTitle({ fontFamily: 'Anton', typography: {} });
    expect(screen.queryByLabelText('italic')).toBeNull();
  });

  it('drops an italic the new family cannot draw', () => {
    const { written } = renderTitle({
      fontFamily: 'Playfair Display',
      fontWeight: 500,
      typography: { fontStyle: 'italic', lineHeight: 1.2 },
    });
    expect(screen.getByLabelText('italic')).toBeDefined();
    choose('font family', /^Anton/);
    // Anton is one static face: the weight snaps to it too.
    expect(written()).toEqual({
      fontFamily: 'Anton',
      fontWeight: 400,
      typography: { lineHeight: 1.2 },
    });
  });

  it('shapes the chip from the typography when the title has a background', () => {
    renderTitle({ fontFamily: 'Inter', background: '#ffd60a', typography: {} });
    expect(screen.getByLabelText('background corner radius')).toBeDefined();
  });
});

describe('fontWeightsFor', () => {
  it('lists a variable family in hundreds, a static one by its files', () => {
    expect(fontWeightsFor('Inter')).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(fontWeightsFor('Poppins')).toEqual([400, 700]);
    expect(fontWeightsFor('Bebas Neue')).toEqual([400]);
    expect(fontHasItalic('Lora')).toBe(true);
    expect(fontHasItalic('Anton')).toBe(false);
  });
});
