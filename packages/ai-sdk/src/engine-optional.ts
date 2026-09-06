/**
 * @framepilot/ai-sdk/engine-optional — reading an OPTIONAL field off a FastAPI response.
 *
 * The engine declares an optional field as `X | None = None`, and FastAPI serialises a
 * route's `response_model` with `exclude_none` OFF by default. So every field the engine
 * did not set arrives as an explicit `null`, not as an absent key:
 *
 * ```json
 * { "kind": "image", "video": null, "image": { … } }
 * ```
 *
 * Zod's `.optional()` accepts `undefined` and REFUSES `null`. The two look
 * interchangeable in TypeScript and are not interchangeable on the wire, and the failure
 * is always the same shape — a whole payload rejected over a field nothing was going to
 * read.
 *
 * It has now cost two incidents in the same week, both in run `137d8fd0`:
 *
 *  - `/review/temporal-evidence` — one null in an array of `.strict()` unions rejected
 *    the entire batch, so all seven perceptual reviews failed closed and the editor was
 *    told their edits "were not perceptually checked" (`09dd6d8`).
 *  - `/references/analyze` — an IMAGE has no `video`, so `video: null` rejected the whole
 *    profile and attaching a photo failed with a raw Zod dump on the chip.
 *
 * Both survived their test suites for the same reason: every fixture was written in
 * TypeScript, with `undefined` where the engine sends `null`. A fixture cannot catch this
 * unless it came off the wire — which is what the `*.engine-shape.test.ts` files are for.
 *
 * Use this for any field read from an engine response that the engine may leave unset.
 * The parsed type is unchanged (`T | undefined`): null is normalised away, so no consumer
 * has to learn a third state.
 */
import { z } from 'zod/v4';

export const fromEngine = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());
