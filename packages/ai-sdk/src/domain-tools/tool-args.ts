/**
 * How a tool declares an argument, and the tolerances it applies at the untrusted
 * boundary.
 *
 * Split out of `tool-registry.ts` alongside the spec builders (P1.2) so a domain
 * family can declare its own tools. Each primitive moves **with its coercion**,
 * which is not incidental: an earlier attempt moved `seconds` on its own, and it
 * compiled, read identically, and silently stopped accepting the string-encoded
 * numbers several providers emit. `numeric` is not decoration on `z.number()`.
 */
import { z } from 'zod/v4';

/**
 * Coerce a JSON scalar a model emitted as a *string* back to a number when it is
 * numeric. Many models — and OpenAI-compatible providers (NVIDIA NIM) in particular —
 * serialise numeric tool arguments as strings: `{"start":"5.0"}` instead of
 * `{"start":5}`. A strict `z.number()` rejects that, failing an otherwise-correct call
 * with `expected number, received string` (the frequent add_clip/trim_clip failure).
 * We still advertise `number` in the JSON Schema (so a well-behaved model sends real
 * numbers), but accept a numeric string at the untrusted boundary. A non-numeric string
 * is left untouched so the schema still rejects genuinely bad input. Pure.
 */
export const coerceNumericString = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : value;

/** Wrap a numeric schema so a string-encoded number is accepted (see above). */
export const numeric = <S extends z.ZodType>(
  schema: S,
): z.ZodPipe<z.ZodTransform<unknown, unknown>, S> => z.preprocess(coerceNumericString, schema);

/** Coerce the common `"true"`/`"false"` string booleans some models emit. */
export const coerceBooleanString = (value: unknown): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** A boolean that also accepts the string forms `"true"`/`"false"`. */
export const boolean = (): z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodBoolean> =>
  z.preprocess(coerceBooleanString, z.boolean());

/**
 * An OPTIONAL string selector (an id, a query, a filter) as it arrives from a model.
 *
 * Models routinely fill an optional string parameter with `""` rather than omitting the
 * key — `list_assets {"kind":"video","folderId":""}` is the observed shape. Read as a
 * value, that empty string is an *active* filter for a folder whose id is the empty
 * string, which nothing in the schema can ever be: ids are non-empty by construction.
 * So the tool answered "no assets" for a full media bin, the agent believed the project
 * was empty, and it asked the user to import footage that was already imported.
 *
 * `""` is never a meaningful id, query, or category here, so a blank (or whitespace-only)
 * value means "not provided" — the same untrusted-boundary tolerance `numeric` and
 * `boolean` already apply to string-encoded numbers and booleans. The JSON Schema still
 * advertises a plain optional `string`, so a well-behaved model is unaffected.
 */
export const blankToUndefined = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** An optional string selector where a blank value means "not provided" (see above). */
export const filterString = (): z.ZodPipe<
  z.ZodTransform<unknown, unknown>,
  z.ZodOptional<z.ZodString>
> => z.preprocess(blankToUndefined, z.string().optional());

export const seconds = numeric(z.number().nonnegative());

/** Deterministic id so identical inputs yield identical effect/keyframe ids. */
export const id = (...parts: (string | number)[]): string =>
  parts.map((p) => (typeof p === 'number' ? Math.round(p * 1000) : p)).join('_');
