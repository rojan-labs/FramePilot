/**
 * What a font change means for a title, shared by the Text panel's Fonts tab and the Inspector.
 *
 * Only bundled caption families are offered (`caption-fonts.ts`), and a title only asks a family
 * for what it ships: neither renderer fakes a weight or an italic, so a request for one the
 * family lacks would show one thing in the panel and export another.
 */
import { getCaptionFont } from '@framepilot/timeline-schema/caption-fonts';
import type { TextOverlayParams } from './patch-builders.js';

/**
 * The weights a family really has, in hundreds: a static family draws its regular face below 600
 * and its bold file at 600 and up, so offering 300 or 900 there would promise a face neither
 * renderer draws.
 */
export function fontWeightsFor(family: string): readonly number[] {
  const font = getCaptionFont(family);
  if (font === undefined) return [400, 600, 700, 800];
  if (!font.variable) {
    return font.boldFile !== undefined ? [font.minWeight, 700] : [font.minWeight];
  }
  const weights: number[] = [];
  for (let weight = 100; weight <= 900; weight += 100) {
    if (weight >= font.minWeight && weight <= font.maxWeight) weights.push(weight);
  }
  return weights;
}

/** Whether the family ships an italic face (neither renderer fakes one). */
export function fontHasItalic(family: string): boolean {
  return getCaptionFont(family)?.italicFile !== undefined;
}

/** The weight nearest `weight` that `family` has. */
export function nearestFontWeight(family: string, weight: number): number {
  return fontWeightsFor(family).reduce((best, w) =>
    Math.abs(w - weight) < Math.abs(best - weight) ? w : best,
  );
}

/**
 * The params that set a title in `family`: the family, the nearest weight it ships, and, when
 * the title asked for an italic this family cannot draw, its typography without the italic.
 */
export function titleFontParams(
  params: Pick<TextOverlayParams, 'fontWeight' | 'typography'>,
  family: string,
): Partial<TextOverlayParams> {
  const next: Partial<TextOverlayParams> = {
    fontFamily: family,
    fontWeight: nearestFontWeight(family, params.fontWeight),
  };
  const typography = params.typography;
  if (typography?.fontStyle === 'italic' && !fontHasItalic(family)) {
    const { fontStyle: _italic, ...rest } = typography;
    return { ...next, typography: rest };
  }
  return next;
}
