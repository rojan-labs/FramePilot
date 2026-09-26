import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PillowTextMeasure,
  exportText,
  parsePillowMetrics,
  rotationSafe,
  textOverlayLayout,
} from './text-raster.js';

const metrics = parsePillowMetrics(
  JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../public/fonts/Aileron-Regular.pillow-metrics.json',
      ),
      'utf8',
    ),
  ),
);

describe('Pillow text metrics (values from Pillow 12.3 textbbox/getlength/getmetrics)', () => {
  it('measures a stroked title line like draw.textbbox', () => {
    const measure = new PillowTextMeasure(51, metrics, null);
    expect(measure.ascent).toBe(50);
    expect(measure.length('Hello World')).toBe(274);
    expect(measure.bbox('Hello World', 4)).toEqual([-4, 8, 278, 55]);
  });

  it('includes first-glyph overhang and last-glyph ink past the advance', () => {
    const measure = new PillowTextMeasure(33, metrics, null);
    expect(measure.bbox(';jV')).toEqual([-2, 10, 35, 39]);
    expect(measure.ascent).toBe(33);
  });

  it('wraps on integer advances', () => {
    const measure = new PillowTextMeasure(26, metrics, null);
    expect(measure.bbox('Caption text here')).toEqual([0, 7, 207, 31]);
    expect(measure.wrap('Caption text here', 207)).toEqual(['Caption text here']);
    expect(measure.wrap('Caption text here', 206)).toEqual(['Caption text', 'here']);
  });
});

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

describe('rotationSafe mirrors render/text_overlay.py rotation_safe (EL2b.4)', () => {
  it('centres the raster in a transparent square as wide as its diagonal, odd pixel right and down', () => {
    const width = 4;
    const height = 3;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const raster = {
      image: { data, width, height } as unknown as ImageData,
      width,
      height,
      layout: textOverlayLayout({}, 1280, 720),
    };
    const padded = rotationSafe(
      raster,
      (pixels, w, h) => ({ data: pixels, width: w, height: h }) as unknown as ImageData,
    );
    // ceil(hypot(4, 3)) = 5: the one spare column goes to the right (the odd pixel), and one row
    // each above and below.
    expect([padded.width, padded.height]).toEqual([5, 5]);
    const alphaAt = (x: number, y: number): number => padded.image.data[(y * 5 + x) * 4 + 3]!;
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(0, 1)).toBe(255);
    expect(alphaAt(3, 3)).toBe(255);
    expect(alphaAt(4, 3)).toBe(0);
    expect(alphaAt(2, 4)).toBe(0);
  });
});
