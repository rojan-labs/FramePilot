/**
 * Pure helpers behind the caption panel's "Transparency and glass" controls
 * (schema v24, ADR 0185): which kind of box a style has, the box a kind switch
 * produces, and hex-alpha arithmetic for the box's tint.
 *
 * WHY hex: the export's rasterizer reads `#rrggbb[aa]` only
 * (`render/captions.py#_hex_to_rgba`), so every colour these controls write is
 * hex. A colour the panel cannot read as hex (a hand-written CSS colour) is
 * treated as opaque and replaced on the first tint change.
 */
import type { CaptionStyle } from '@framepilot/timeline-schema';

export type CaptionBackground = NonNullable<CaptionStyle['background']>;

/** The three boxes the panel offers. */
export type CaptionBoxKind = 'none' | 'solid' | 'frosted';

/** Light frosted glass — the `glass` template's chip. */
export const DEFAULT_FROSTED_BOX: CaptionBackground = {
  color: '#ffffff29',
  radius: 0.45,
  paddingX: 0.55,
  paddingY: 0.26,
  blur: 0.35,
  borderColor: '#ffffff73',
  borderWidth: 1,
};

/** A dark translucent chip — the `boxed` template's family. */
export const DEFAULT_SOLID_BOX: CaptionBackground = {
  color: '#0b0b0fcc',
  radius: 0.18,
  paddingX: 0.45,
  paddingY: 0.26,
};

/** What "no box" is written as: a fully transparent chip overrides a template's. */
export const NO_BOX: CaptionBackground = { color: '#00000000' };

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

/** Alpha of a `#rrggbb[aa]` colour, 0–1; 1 for anything that is not hex. */
export function hexAlpha(color: string): number {
  const match = HEX.exec(color);
  if (match === null || match[2] === undefined) return 1;
  return parseInt(match[2], 16) / 255;
}

/** The `#rrggbb` part of a colour; white for anything that is not hex. */
export function hexRgb(color: string): string {
  const match = HEX.exec(color);
  return match === null ? '#ffffff' : `#${match[1]!.toLowerCase()}`;
}

/** `color`'s rgb with `alpha` (0–1) as a `#rrggbbaa` string. */
export function withHexAlpha(color: string, alpha: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hexRgb(color)}${byte.toString(16).padStart(2, '0')}`;
}

/** Which box `background` draws: none (absent or invisible), frosted glass, or a flat chip. */
export function boxKind(background: CaptionBackground | undefined): CaptionBoxKind {
  if (background === undefined) return 'none';
  if ((background.blur ?? 0) > 0) return 'frosted';
  const visible = hexAlpha(background.color) > 0 || (background.borderWidth ?? 0) > 0;
  return visible ? 'solid' : 'none';
}

/**
 * The box a kind switch writes, keeping what the current box already says
 * where it still applies (its shape and padding, and its tint when that tint
 * is visible), so switching Solid ⇄ Frosted does not throw away a tuned box.
 */
export function boxForKind(
  kind: CaptionBoxKind,
  current: CaptionBackground | undefined,
): CaptionBackground {
  if (kind === 'none') return NO_BOX;
  const base = kind === 'frosted' ? DEFAULT_FROSTED_BOX : DEFAULT_SOLID_BOX;
  const shape =
    current !== undefined && boxKind(current) !== 'none'
      ? {
          ...(current.radius !== undefined ? { radius: current.radius } : {}),
          ...(current.paddingX !== undefined ? { paddingX: current.paddingX } : {}),
          ...(current.paddingY !== undefined ? { paddingY: current.paddingY } : {}),
        }
      : {};
  if (kind === 'frosted') {
    return {
      ...base,
      ...shape,
      // A tinted chip becomes tinted glass; an opaque one would hide the frost.
      ...(current !== undefined && hexAlpha(current.color) > 0 && hexAlpha(current.color) < 0.6
        ? { color: current.color }
        : {}),
    };
  }
  const { blur: _blur, ...solid } = { ...base, ...shape };
  return solid;
}
