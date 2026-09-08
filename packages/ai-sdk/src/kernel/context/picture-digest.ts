/**
 * @framepilot/ai-sdk/kernel/context/picture-digest — the PICTURE block (ADR 0175,
 * `plan/visual-understanding/03-MODEL-SURFACES.md` VU2.4, `01-ARCHITECTURE.md` §7).
 *
 * What "the agent knows this footage" looks like in 600 tokens: who is in it, where it was
 * shot, how it is framed and how much it moves, which assets are dark or oddly balanced, and
 * how much of it has actually been read. It sits beside the footage map — the map is the
 * structure of what happens IN the footage over time; this is what the footage LOOKS like.
 *
 * Three rules, and each is the reason a line exists or does not:
 *
 * 1. **Built from `AssetDigest` rows only.** Never per-shot. A 200-shot project and a
 *    20,000-shot project cost this block the same, because it reads one pre-aggregated row
 *    per asset. That is what lets it be present on every turn instead of fetched on demand.
 * 2. **Coverage is stated, always.** "Nothing has been read yet" and "the footage has
 *    nothing in it" are opposite claims, and a block that renders them the same way teaches
 *    the agent that unindexed footage is featureless. When no tier has run, this block says
 *    so in the same sentence it would otherwise put the summary.
 * 3. **Shares are shares, not counts.** An asset's mixes are normalised to their own total
 *    and weighted by that asset's shot count, so a 900-shot interview does not read as one
 *    fourteenth of the project because it happens to be one of fourteen files.
 *
 * Unlike a clip row (`shot-words.ts`, "the model reads words, the solver reads numbers")
 * this block DOES print numbers: a share and a range are the whole information content of
 * "most of this is static" and "your warmth is all over the place", and there is no word for
 * either that survives being compared across fourteen assets.
 */
import type { AssetDigest, LedgerSnapshot } from '../../ledger.js';
import { exposureWord, trimToWords } from './shot-words.js';

/**
 * Character budget for the whole block: ~600 tokens at the package's 4-chars-per-token
 * heuristic (`estimateTokens`). Lines are emitted in importance order and the first one that
 * would cross the bound ends the block, so the budget is a hard cap rather than a target.
 */
export const MAX_DIGEST_CHARS = 2_400;

/** Most entries any one mix line prints before it stops. Beyond this the tail is noise. */
const MAX_MIX_ENTRIES = 5;

/** Most people named. The digest lists entity ids most-frequent-first; the tail is a count. */
const MAX_PEOPLE = 6;

/** Most asset ids named in an exposure or quality call-out before it collapses to a count. */
const MAX_NAMED_ASSETS = 5;

/** Longest a setting/shot-size/motion label may print. Labels come from a model; cap them. */
const MAX_LABEL_CHARS = 24;

/** One weighted share of a mix, ready to print. */
interface MixShare {
  readonly label: string;
  /** 0..1 share of all shots that carry a label in this mix. */
  readonly share: number;
}

/**
 * Weighted shares across assets, largest first.
 *
 * Each asset's mix is normalised to its OWN total before weighting, which is what makes the
 * result correct whether the engine wrote counts (`{MS: 47}`) or fractions (`{MS: 0.47}`) —
 * two shapes the schema (`z.record(z.string(), z.number())`) permits and neither of which is
 * documented. Assets whose mix is empty contribute nothing rather than diluting the result:
 * an unlabelled asset has no opinion about shot size, it does not have a neutral one.
 */
function weightedMix(
  digests: readonly AssetDigest[],
  pick: (digest: AssetDigest) => Readonly<Record<string, number>>,
): MixShare[] {
  const totals = new Map<string, number>();
  let weight = 0;
  for (const digest of digests) {
    const mix = pick(digest);
    const sum = Object.values(mix).reduce((acc, value) => acc + (value > 0 ? value : 0), 0);
    if (sum <= 0) continue;
    // A digest with no shot count still says something about proportion; weight it as one
    // shot rather than zero, so its labels are not silently discarded.
    const shots = digest.shotCount > 0 ? digest.shotCount : 1;
    weight += shots;
    for (const [label, value] of Object.entries(mix)) {
      if (value <= 0) continue;
      totals.set(label, (totals.get(label) ?? 0) + (value / sum) * shots);
    }
  }
  if (weight <= 0) return [];
  return [...totals.entries()]
    .map(([label, value]) => ({ label, share: value / weight }))
    .sort((a, b) => b.share - a.share || a.label.localeCompare(b.label));
}

/** `MS 47% · WS 35%`, capped, with the tail collapsed rather than dropped silently. */
function mixLine(prefix: string, shares: readonly MixShare[]): string {
  if (shares.length === 0) return '';
  const shown = shares.slice(0, MAX_MIX_ENTRIES);
  const parts = shown.map(
    (entry) =>
      `${trimToWords(entry.label, MAX_LABEL_CHARS)} ${String(Math.round(entry.share * 100))}%`,
  );
  const rest = shares.length - shown.length;
  if (rest > 0) parts.push(`+${String(rest)} more`);
  return `${prefix}: ${parts.join(' · ')}`;
}

/** `a_7f3, a_812 and 3 more` — names a few, counts the rest. */
function nameAssets(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_NAMED_ASSETS);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ');
}

/** A number as a signed two-decimal string, so a warmth range reads as a range. */
function signed(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

/**
 * How many ASSETS carry each tier at all.
 *
 * Per asset rather than per shot because the sentence is "coverage measured 14/14 assets":
 * the question the agent asks of this line is "is there footage I know nothing about", and
 * an asset with one described shot out of nine hundred is not that asset.
 */
function assetCoverage(digests: readonly AssetDigest[]): {
  measured: number;
  labelled: number;
  described: number;
} {
  let measured = 0;
  let labelled = 0;
  let described = 0;
  for (const digest of digests) {
    if (digest.coverage.measured > 0) measured += 1;
    if (digest.coverage.labelled > 0) labelled += 1;
    if (digest.coverage.described > 0) described += 1;
  }
  return { measured, labelled, described };
}

/** The middle of the per-asset medians — "typical", stated as such, never as a true median. */
function typicalShotSeconds(digests: readonly AssetDigest[]): number | null {
  const medians = digests
    .map((digest) => digest.medianShotS)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (medians.length === 0) return null;
  const mid = Math.floor(medians.length / 2);
  return medians.length % 2 === 1
    ? (medians[mid] as number)
    : ((medians[mid - 1] as number) + (medians[mid] as number)) / 2;
}

/** `person_01 (in 6 assets), person_02 (2)` — ids as the ledger stores them, no invention. */
function peopleLine(digests: readonly AssetDigest[]): string {
  const assetsPerPerson = new Map<string, number>();
  for (const digest of digests) {
    for (const person of new Set(digest.people)) {
      assetsPerPerson.set(person, (assetsPerPerson.get(person) ?? 0) + 1);
    }
  }
  if (assetsPerPerson.size === 0) return '';
  const ranked = [...assetsPerPerson.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const shown = ranked.slice(0, MAX_PEOPLE);
  const parts = shown.map(
    ([person, count], index) =>
      `${person} (${index === 0 ? `in ${String(count)} asset${count === 1 ? '' : 's'}` : String(count)})`,
  );
  const rest = ranked.length - shown.length;
  if (rest > 0) parts.push(`+${String(rest)} more`);
  return `People: ${parts.join(', ')}`;
}

/**
 * Assets whose exposure is worth naming, and the warmth spread across the project.
 *
 * An asset is called dim only when its BRIGHTEST end is still dim (and bright only when its
 * darkest end is bright): a range that straddles the threshold is a normally exposed shoot
 * with a dark corner in it, and telling the agent to fix that produces a grade nobody asked
 * for. The words come from `shot-words.ts`, so this block and a clip row can never disagree
 * about what "dim" means.
 */
function exposureLine(digests: readonly AssetDigest[]): string {
  const flagged = new Map<string, string[]>();
  let warmthLo = Number.POSITIVE_INFINITY;
  let warmthHi = Number.NEGATIVE_INFINITY;
  for (const digest of digests) {
    const range = digest.exposureRange;
    if (range) {
      // `[lo, hi]` is the asset's luma-mean range across its shots.
      const [lo, hi] = range;
      // The TOP of the range decides "dim": if even the brightest shot reads dim, the asset
      // is. The BOTTOM decides "bright", symmetrically. Reading a bright word off the top
      // (or a dim one off the bottom) would flag every normally exposed shoot that has one
      // dark corner and one window in it — which is most of them.
      const top = exposureWord(hi);
      const bottom = exposureWord(lo);
      const dim = top === 'dark' || top === 'dim' ? top : '';
      const bright = bottom === 'bright' || bottom === 'very bright' ? bottom : '';
      const word = dim || bright;
      if (word !== '') {
        const bucket = flagged.get(word) ?? [];
        bucket.push(digest.assetId);
        flagged.set(word, bucket);
      }
    }
    const warmth = digest.warmthRange;
    if (warmth) {
      warmthLo = Math.min(warmthLo, warmth[0]);
      warmthHi = Math.max(warmthHi, warmth[1]);
    }
  }
  const parts: string[] = [];
  for (const [word, ids] of [...flagged.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(
      `${String(ids.length)} asset${ids.length === 1 ? '' : 's'} ${word} (${nameAssets(ids)})`,
    );
  }
  if (Number.isFinite(warmthLo) && Number.isFinite(warmthHi)) {
    parts.push(`warmth ${signed(warmthLo)}…${signed(warmthHi)} across assets`);
  }
  return parts.length === 0 ? '' : `Exposure: ${parts.join('; ')}`;
}

/**
 * Shots the measured tier flagged soft, black or frozen.
 *
 * The digest stores indices, not reasons, so this counts and names the assets and stops
 * there. Saying "7 shots soft" from a list that also contains black frames would be an
 * invented distinction, and an editor acts differently on the two.
 */
function lowQualityLine(digests: readonly AssetDigest[]): string {
  const assets: string[] = [];
  let shots = 0;
  for (const digest of digests) {
    if (digest.lowQualityShots.length === 0) continue;
    shots += digest.lowQualityShots.length;
    assets.push(digest.assetId);
  }
  if (shots === 0) return '';
  return (
    `Low quality: ${String(shots)} shot${shots === 1 ? '' : 's'} flagged soft, black or ` +
    `frozen on ${nameAssets(assets)} — check before using`
  );
}

/**
 * Render the PICTURE digest block, or `undefined` when there is nothing to inject.
 *
 * `undefined` means exactly one thing: the ledger carries no asset digests at all (no
 * sidecar, no brain, a project whose assets were never seen). A ledger that HAS digests but
 * no analysed shots renders a one-line block saying so — the honest half of rule 2, because
 * silence there would let the agent conclude the footage is featureless rather than unread.
 *
 * @param ledger - The run's ledger snapshot (`ledger-client.ts`), or `null` when there is none.
 * @param maxChars - Block budget; defaults to {@link MAX_DIGEST_CHARS}.
 */
export function summarizePictureDigest(
  ledger: LedgerSnapshot | null | undefined,
  maxChars: number = MAX_DIGEST_CHARS,
): string | undefined {
  const digests = ledger?.digests ?? [];
  if (digests.length === 0) return undefined;

  const assets = digests.length;
  const shotCount = digests.reduce((sum, digest) => sum + digest.shotCount, 0);
  const covered = assetCoverage(digests);
  const analysed = covered.measured + covered.labelled + covered.described;
  const assetsWord = `${String(assets)} asset${assets === 1 ? '' : 's'}`;

  if (shotCount === 0 || analysed === 0) {
    return (
      `PICTURE — ${assetsWord} on this project, none of it read yet (no shots analysed). ` +
      'This says nothing about what the footage contains: do not treat it as featureless, ' +
      'and do not claim to know what is on screen.'
    );
  }

  const typical = typicalShotSeconds(digests);
  const lines: string[] = [
    `PICTURE — ${assetsWord} · ${String(shotCount)} shots` +
      (typical === null ? '' : ` · typical shot ${(Math.round(typical * 10) / 10).toString()}s`) +
      ` · coverage: measured ${String(covered.measured)}/${String(assets)} assets, ` +
      `labelled ${String(covered.labelled)}/${String(assets)}, ` +
      `described ${String(covered.described)}/${String(assets)}`,
  ];
  if (covered.labelled === 0 && covered.described === 0) {
    // Measured-only is the keyless default install: say what that means so the agent does
    // not read the absence of people and settings as an absence of people and settings.
    lines.push(
      'Only the measured tier has run: brightness, warmth and motion are known; who and ' +
        'what is on screen is not.',
    );
  }

  for (const line of [
    peopleLine(digests),
    mixLine(
      'Settings',
      weightedMix(digests, (digest) => digest.settingMix),
    ),
    mixLine(
      'Shot sizes',
      weightedMix(digests, (digest) => digest.shotSizeMix),
    ),
    mixLine(
      'Motion',
      weightedMix(digests, (digest) => digest.motionMix),
    ),
    exposureLine(digests),
    lowQualityLine(digests),
  ]) {
    if (line === '') continue;
    // Importance order, hard cap: the first line that would cross the budget ends the block.
    // A truncated middle would be worse than a shorter one — every line here is independent.
    if (lines.join('\n').length + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  return lines.join('\n');
}
