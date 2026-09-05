/**
 * @framepilot/ai-sdk/catalogue-asset-id — the catalogue id a run kept its own copy of.
 *
 * A run that downloads media from a catalogue holds TWO ids for it and is given no reason
 * to think they differ. `search_music` answers with a `remoteId`; `add_music` takes that
 * `remoteId`; and the bin asset it creates is named `music_openverse_<remoteId, hyphens
 * underscored>`. Every analysis tool then wants the BIN id.
 *
 * Run `137d8fd0` is what the gap costs. Having placed the bed itself, the run called
 * `detect_beats` with `b6aa6604-0746-4048-915f-c75ed988747a` — the id it had been handed
 * and had just successfully used — and got back
 *
 *     Asset 'b6aa6604-…' not found in project. Known asset ids: asset_raw_skating, …,
 *     music_openverse_b6aa6604_0746_4048_915f_c75ed988747a, …
 *
 * The answer is IN the error, eight ids along, differing from the question by a prefix and
 * some punctuation. The run did not spot it, and the beat-synced cut the brief asked for
 * never happened.
 *
 * Listing the known ids was the previous fix and it is not enough, because the model is
 * being asked to perform a string transformation that our own code performed in the first
 * place. Reversing it is exact, not a guess: the bin id is `<prefix>_<remoteId>` with a
 * fixed alphabet, so a passed id that normalises to the tail of exactly one asset id
 * IS that asset. Ambiguity — zero matches or several — falls through untouched to the
 * existing error, which is right about everything except how findable the answer is.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:catalogue-asset-id');

/**
 * Short ids are not evidence. `ov_1` as a suffix would match anything ending `_ov_1`, and
 * a coincidence here silently analyses the wrong file — a worse outcome than the error.
 */
const MIN_MATCHABLE_LENGTH = 8;

/** The alphabet a derived asset id uses: everything else becomes `_`. */
function normalizeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

/**
 * The project asset a passed id unambiguously names, or `null` to leave it alone.
 *
 * Returns `null` — deliberately, and in every uncertain case — when the id already names
 * an asset (nothing to resolve), when it is too short to be evidence, or when it matches
 * no asset or more than one.
 */
export function resolveCatalogueAssetId(
  passedId: string,
  assets: readonly { readonly id: string }[],
): string | null {
  if (assets.some((asset) => asset.id === passedId)) return null;
  const needle = normalizeId(passedId);
  if (needle.length < MIN_MATCHABLE_LENGTH) return null;
  const matches = assets.filter((asset) => {
    const candidate = normalizeId(asset.id);
    if (candidate === needle) return true;
    // The tail must begin at a segment boundary, so `_1234` cannot match `x_91234`.
    return candidate.endsWith(`_${needle}`);
  });
  if (matches.length !== 1) return null;
  return matches[0]!.id;
}

/**
 * Rewrite a tool call's `assetId` to the bin asset it unambiguously names.
 *
 * Returns the arguments unchanged whenever there is nothing to resolve, so a caller can
 * apply it to every host call without asking whether it is relevant.
 */
export function withResolvedAssetId(
  toolName: string,
  args: Record<string, unknown>,
  assets: readonly { readonly id: string }[],
): Record<string, unknown> {
  const passed = args.assetId;
  if (typeof passed !== 'string' || passed === '') return args;
  const resolved = resolveCatalogueAssetId(passed, assets);
  if (resolved === null) return args;
  log.action('resolved a catalogue id to the bin asset it names', {
    tool: toolName,
    passed,
    resolved,
  });
  return { ...args, assetId: resolved };
}
