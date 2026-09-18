/**
 * The AI never invents mask geometry (AM1.4; plan 11 rule 1, gate "Fabricated geometry: 0").
 *
 * Every vertex, box and track an agent patch carries must trace to one of four sources: a
 * resolved candidate, a pack measurement, the picture frame itself (a preset placed on the
 * frame), or a number the editor typed. The builders that derive geometry from such a source
 * ATTEST the operations they produce; the dispatch boundary then refuses any geometry-bearing
 * mask operation nobody attested. So a new tool that hands model-supplied coordinates to
 * `add_mask` fails closed without anyone remembering to add it to a list.
 *
 * The attestation is keyed on the operation OBJECT (a `WeakMap`), not on its content: a second
 * operation with identical numbers built somewhere else is still unattested, which is the point —
 * provenance is a fact about how a shape was produced, not about what it looks like.
 */
import type { AnyOperation } from '@framepilot/editor-core';

/** Where a mask's geometry came from. */
export type MaskGeometrySource =
  | { readonly kind: 'candidate'; readonly candidateId: string }
  | { readonly kind: 'measurement'; readonly engine: string }
  | { readonly kind: 'frame'; readonly preset: string }
  | { readonly kind: 'user_numbers' };

const ATTESTED = new WeakMap<object, MaskGeometrySource>();

/** Mask kinds whose `add_mask` carries no coordinates: a layer reference, a colour qualifier. */
const COORDINATE_FREE_MASK_KINDS: ReadonlySet<string> = new Set(['layer', 'key']);

/** `update_mask` / keyframe properties that move or reshape a mask. */
const GEOMETRY_PROPERTIES: ReadonlySet<string> = new Set([
  'cx',
  'cy',
  'width',
  'height',
  'rx',
  'ry',
  'rotation',
  'roundness',
  'originX',
  'originY',
  'angle',
  'widthPx',
  'startX',
  'startY',
  'endX',
  'endY',
]);

/** The one sentence every refusal carries: no varying magnitude, so it is one guard key. */
export const UNSOURCED_MASK_GEOMETRY =
  'This mask shape has no measured source, so it was not applied. A mask must come from a ' +
  'find_mask_targets candidate, a pack measurement, or numbers the editor typed. Call ' +
  'find_mask_targets for the clip and pass its candidateId to create_mask.';

/** The refusal for `userShape` numbers the editor never typed. */
export const USER_NUMBERS_NOT_TYPED =
  'userShape is only for numbers the editor typed, and these are not in their request, so ' +
  'nothing was applied. Call find_mask_targets and pass a candidateId instead, or ask the ' +
  'editor for the exact numbers.';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Does this operation place, move or reshape a mask? */
export function carriesMaskGeometry(operation: AnyOperation): boolean {
  const op = operation as unknown as Record<string, unknown>;
  switch (op.type) {
    case 'add_mask':
    case 'add_effect_layer_mask': {
      const kind = record(op.mask)?.kind;
      return typeof kind !== 'string' || !COORDINATE_FREE_MASK_KINDS.has(kind);
    }
    case 'paste_masks':
    case 'set_mask_path':
    case 'apply_mask_tracking':
      return true;
    case 'update_mask':
      return Object.keys(record(op.changes) ?? {}).some((key) => GEOMETRY_PROPERTIES.has(key));
    case 'add_mask_keyframe': {
      const property = record(op.keyframe)?.property;
      return typeof property === 'string' && GEOMETRY_PROPERTIES.has(property);
    }
    default:
      return false;
  }
}

/**
 * Record where these operations' geometry came from.
 *
 * @param operations - Operations a deterministic builder just produced from `source`.
 * @param source - The candidate, measurement, frame preset or user numbers they derive from.
 * @returns The same operations, for chaining.
 */
export function attestMaskGeometry<T extends AnyOperation>(
  operations: readonly T[],
  source: MaskGeometrySource,
): T[] {
  for (const operation of operations) {
    if (carriesMaskGeometry(operation)) ATTESTED.set(operation, source);
  }
  return [...operations];
}

/** The attested source of one operation, if any. */
export function maskGeometrySourceOf(operation: AnyOperation): MaskGeometrySource | undefined {
  return ATTESTED.get(operation);
}

/** Geometry-bearing mask operations nobody attested. Empty ⇒ the batch may proceed. */
export function unsourcedMaskGeometry(operations: readonly AnyOperation[]): AnyOperation[] {
  return operations.filter(
    (operation) => carriesMaskGeometry(operation) && !ATTESTED.has(operation),
  );
}

/** Thrown at the dispatch boundary; a plain `Error` subclass so callers keep one catch path. */
export class UnsourcedMaskGeometryError extends Error {
  public constructor() {
    super(UNSOURCED_MASK_GEOMETRY);
    this.name = 'UnsourcedMaskGeometryError';
  }
}

/** Refuse a batch that carries unattested mask geometry. */
export function assertMaskGeometrySourced(operations: readonly AnyOperation[]): void {
  if (unsourcedMaskGeometry(operations).length > 0) throw new UnsourcedMaskGeometryError();
}

/** Every number written in a piece of text, percentages included ("20%" → 20). */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
}

/** Two numbers agree when they are the same value to four places (a typed "0.333"). */
const NUMBER_MATCH_TOLERANCE = 1e-4;
/** A fraction the model sends may be a percentage the editor typed. */
const PERCENT_PER_UNIT = 100;

/**
 * Did the editor type every one of these numbers?
 *
 * A value matches when it appears in the request as written or as a percentage of it, because
 * "a box 20% from the left" reaches the tool as `0.2`.
 */
export function numbersWereTyped(values: readonly number[], typed: readonly number[]): boolean {
  const matches = (value: number, candidate: number): boolean =>
    Math.abs(value - candidate) <= NUMBER_MATCH_TOLERANCE;
  return values.every((value) =>
    typed.some(
      (candidate) => matches(value, candidate) || matches(value * PERCENT_PER_UNIT, candidate),
    ),
  );
}
