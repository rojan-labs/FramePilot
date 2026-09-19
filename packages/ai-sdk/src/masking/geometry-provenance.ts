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
    // `use_track` is here because reusing a track moves the mask that receives it, so it
    // needs a source like any other.
    case 'paste_masks':
    case 'set_mask_path':
    case 'apply_mask_tracking':
    case 'use_track':
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
  return [...text.matchAll(NUMBER_PATTERN)].map((match) => Number(match[0]));
}

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/gu;
/** Numbers, words, and the punctuation that binds (`=`, `:`, `×`) or separates (`,`, `.`) them. */
const TOKEN_PATTERN = /-?\d+(?:\.\d+)?|%|[a-z]+|[=:×,;.!?\n()]/gu;

/** A unit written straight after a number makes it a measurement of the picture. */
const GEOMETRY_UNITS: ReadonlySet<string> = new Set([
  '%',
  'percent',
  'pct',
  'px',
  'pixel',
  'pixels',
]);

/** A unit of time or count after a number makes it NOT geometry, whatever word precedes it. */
const NON_GEOMETRY_UNITS: ReadonlySet<string> = new Set([
  's',
  'sec',
  'secs',
  'second',
  'seconds',
  'ms',
  'min',
  'mins',
  'minute',
  'minutes',
  'h',
  'hr',
  'hrs',
  'hour',
  'hours',
  'frame',
  'frames',
  'fps',
  'times',
  'db',
  'k',
  'p',
]);

/** Words that name a shape's size, position or form. */
const GEOMETRY_WORDS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'width',
  'wide',
  'height',
  'high',
  'tall',
  'radius',
  'diameter',
  'size',
  'left',
  'right',
  'top',
  'bottom',
  'centre',
  'center',
  'middle',
  'corner',
  'edge',
  'edges',
  'offset',
  'position',
  'inset',
  'margin',
  'across',
  'down',
  'box',
  'rectangle',
  'rect',
  'square',
  'ellipse',
  'oval',
  'circle',
]);

/** Words that sit between a number and the geometry word it belongs to ("20 from the left"). */
const BINDING_FILLER: ReadonlySet<string> = new Set([
  '=',
  ':',
  'of',
  'is',
  'at',
  'to',
  'from',
  'the',
  'a',
  'an',
  'in',
  'by',
  'about',
  'around',
  'roughly',
  'approx',
  'approximately',
  'its',
  'and',
]);

/** Punctuation that ends the phrase a number belongs to. */
const CLAUSE_BREAKS: ReadonlySet<string> = new Set([',', ';', '.', '!', '?', '\n', '(', ')']);

/** Tokens between two numbers that make them one dimension pair ("200x100", "20 by 50"). */
const DIMENSION_JOINERS: ReadonlySet<string> = new Set(['x', 'by', '×']);

/** How far (in tokens) a geometry word may sit from its number. */
const BINDING_REACH = 3;

const isNumberToken = (token: string | undefined): boolean =>
  token !== undefined && /^-?\d/u.test(token);

/** The nearest word to one side of `index` that is not filler, within one clause and reach. */
function nearestWord(tokens: readonly string[], index: number, step: 1 | -1): string | undefined {
  for (let offset = 1; offset <= BINDING_REACH; offset += 1) {
    const token = tokens[index + step * offset];
    if (token === undefined || CLAUSE_BREAKS.has(token) || isNumberToken(token)) return undefined;
    if (!BINDING_FILLER.has(token)) return token;
  }
  return undefined;
}

function boundByItsWords(tokens: readonly string[], index: number): boolean {
  const next = tokens[index + 1];
  if (next !== undefined && GEOMETRY_UNITS.has(next)) return true;
  if (next !== undefined && NON_GEOMETRY_UNITS.has(next)) return false;
  // "2x speed" is a multiplier; "200x100" is a dimension, which the pair rule binds.
  if (next === 'x' && !isNumberToken(tokens[index + 2])) return false;
  const before = nearestWord(tokens, index, -1);
  const after = nearestWord(tokens, index, 1);
  return (
    (before !== undefined && GEOMETRY_WORDS.has(before)) ||
    (after !== undefined && GEOMETRY_WORDS.has(after))
  );
}

/** A listed partner ("x 20, 10") counts only when nothing else claims it ("…, 50 versions"). */
function endsPhrase(tokens: readonly string[], index: number): boolean {
  const next = tokens[index + 1];
  return (
    next === undefined ||
    CLAUSE_BREAKS.has(next) ||
    isNumberToken(next) ||
    GEOMETRY_UNITS.has(next) ||
    GEOMETRY_WORDS.has(next)
  );
}

/**
 * The numbers in ONE request that are bound to geometry (AM1.6), percentages included.
 *
 * A number counts only when the words attached to it make it a measurement of the picture:
 * a unit right after it (`20%`, `200px`, `30 pixels`), or a shape or position word within
 * the same phrase (`width 0.5`, `x = 20`, `20 from the left`, `a 50 wide box`). Two numbers
 * joined as a dimension (`200x100`, `20 by 50`) are geometry, and a number listed after a
 * bound one (`x 20, 10`) is its partner. A number followed by a time or count unit
 * (`20 seconds`, `50 frames`) never is. Everything else — "cut the 20 second intro and give
 * me 50 versions" — is coincidence, and a `userShape` built from it is refused.
 *
 * @param text - The editor's current request only; earlier messages are not a source.
 * @returns The geometry-bound numbers, in the order written.
 */
export function geometryNumbersIn(text: string): number[] {
  const tokens = [...text.toLowerCase().matchAll(TOKEN_PATTERN)].map((match) => match[0]);
  const numberIndices = tokens.flatMap((token, index) => (isNumberToken(token) ? [index] : []));
  const bound = new Set(numberIndices.filter((index) => boundByItsWords(tokens, index)));
  for (const index of numberIndices) {
    const joiner = tokens[index + 1];
    const partner = index + 2;
    if (joiner === undefined || !isNumberToken(tokens[partner])) continue;
    const timed = (at: number): boolean => NON_GEOMETRY_UNITS.has(tokens[at + 1] ?? '');
    if (DIMENSION_JOINERS.has(joiner) && !timed(index) && !timed(partner)) {
      bound.add(index);
      bound.add(partner);
    } else if (joiner === ',' && bound.has(index) && endsPhrase(tokens, partner)) {
      bound.add(partner);
    }
  }
  return numberIndices.filter((index) => bound.has(index)).map((index) => Number(tokens[index]));
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
