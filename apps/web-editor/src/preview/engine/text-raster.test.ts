import { describe, expect, it } from 'vitest';
import { exportText, textOverlayLayout } from './text-raster.js';

describe('text overlay layout mirrors render/text_overlay.py', () => {
  it('defaults to a frame-relative size, white, centred in an 80% box', () => {
    expect(textOverlayLayout({ text: 'Title' }, 1280, 720)).toEqual({
      fontSize: 51,
      color: [255, 255, 255, 255],
      align: 'center',
      boxWidth: 1024,
      centreX: 640,
      centreY: 360,
      background: null,
    });
  });

  it('honours fontSizePercent over a legacy fontSize, with the 16px floor', () => {
    expect(textOverlayLayout({ fontSizePercent: 10, fontSize: 99 }, 1280, 720).fontSize).toBe(72);
    expect(textOverlayLayout({ fontSizePercent: 1 }, 1280, 720).fontSize).toBe(16);
    expect(textOverlayLayout({ fontSize: 30.7 }, 1280, 720).fontSize).toBe(30);
  });

  it('parses colours like _color_from_param and falls back on anything malformed', () => {
    expect(textOverlayLayout({ color: '#11223380' }, 100, 100).color).toEqual([17, 34, 51, 128]);
    expect(textOverlayLayout({ color: 'red' }, 100, 100).color).toEqual([255, 255, 255, 255]);
    expect(textOverlayLayout({ background: '#000000' }, 100, 100).background).toEqual([
      0, 0, 0, 255,
    ]);
  });

  it('draws nothing for blank text', () => {
    expect(exportText({ text: '   ' })).toBeNull();
    expect(exportText({ text: 42 })).toBe('42');
  });
});
