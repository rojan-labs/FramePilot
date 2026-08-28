/**
 * @framepilot/ai-sdk/footage-map — the `FootageMap` contract (plan FI0.1).
 *
 * WHY: on unfamiliar or hours-long footage the model has no query to search
 * with. It needs a time-ordered structural digest of the media — chapters,
 * highlights, and a summary — to reason over before it can plan an edit. This
 * module is the TS side of that contract: Zod schemas mirroring the engine's
 * Pydantic `FootageMapResponse` (and `FootageChapter`/`FootageHighlight`) in
 * `service.py`. The two shapes are kept byte-identical by hand — no schema
 * change to `project.fp.json` (the map is derived, brain-only, rebuildable).
 *
 * Honest degradation (AGENTS.md invariant 6): a transport failure resolves to
 * `undefined` in the client; an `available:false` or an `available:true` with a
 * typed `reason` and empty lists is a real, typed engine response the caller
 * renders as-is — never a fabricated map. Times are TIMELINE seconds (asset
 * spans are projected the same way evidence packets are).
 */
import { z } from 'zod/v4';

/** The fields of one time-ordered chapter of the footage digest (mirrors `FootageChapter`). */
const footageChapterFields = z.object({
  /** Chapter start seconds (inclusive). Timeline seconds by default; source seconds under `assetTime`. */
  t0: z.number(),
  /** Chapter end seconds (exclusive). */
  t1: z.number(),
  /** Short human-readable chapter label. */
  title: z.string(),
  /** One-to-two sentence description of the chapter. */
  summary: z.string().default(''),
  /** Owning asset id — lets the UI group by footage and project onto the timeline when placed. */
  assetId: z.string().nullish(),
  /**
   * Chapters that LOOK the same share a group number; a chapter with nothing like it has
   * none. Cutting two chapters from one group into the same edit repeats a shot.
   *
   * Derived from the perceptual hash already stored on every span, so it costs no extra
   * analysis. Absent on chapters from a hosted generative backend, which supplies no hash.
   */
  similarGroup: z.number().nullish(),
});

/** Whitespace-normalised, for comparing two pieces of generated prose for sameness. */
const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * One time-ordered chapter, with a summary that merely repeats its title dropped.
 *
 * A still photo has one chapter, and the generative backend answers both
 * `chapter_title` and `chapter_summary` with the same generated sentence — on the 61-photo
 * map from run `accd014d`, **all 61 chapters** had `title` byte-identical to `summary`.
 * That is 10,491 of the payload's 28,264 characters: 37% of it is the same sentences,
 * twice.
 *
 * The cost is not abstract. `recall_evidence` returns
 * {@link EVIDENCE_RECALL_CHARS} (16,000) characters per call and a call is a whole model
 * turn, so 28,264 characters is a two-turn read. The run reached its last two turns, spent
 * both paging this map, and stopped with the second half in hand and no turn left to place
 * a photo with it — 14 of 61 placed, 28 seconds of the music bed over black. Deduplicated,
 * the same map is 16,939 characters, and without the `t1`/`similarGroup` fields a still
 * cannot use it is 15,372 — a **one-call read**.
 *
 * Normalised at the schema so there is one answer to "what does this chapter say" for the
 * digest, the evidence payload and the UI alike. When the two genuinely differ, both are
 * kept: that is a real title and a real description.
 */
export const footageChapterSchema = footageChapterFields.transform((chapter) =>
  normalized(chapter.summary) !== '' && normalized(chapter.summary) === normalized(chapter.title)
    ? { ...chapter, summary: '' }
    : chapter,
);

/** One salient moment worth acting on (mirrors `FootageHighlight`). */
export const footageHighlightSchema = z.object({
  /** Highlight start seconds (inclusive). */
  t0: z.number(),
  /** Highlight end seconds (exclusive). */
  t1: z.number(),
  /** Short human-readable highlight label. */
  label: z.string(),
  /** Salience score; higher is stronger. Used only to order highlights. */
  score: z.number().default(0),
  /** Owning asset id. */
  assetId: z.string().nullish(),
});

/**
 * The time-ordered structural digest of a project's footage (mirrors
 * `FootageMapResponse`). `backend` names who produced it (`twelvelabs` or the
 * built-in span/caption derivation). A `reason` with empty lists is the honest
 * no-op (no key / no Pegasus entitlement / not indexed) — never a fabricated
 * map.
 */
export const footageMapSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullish(),
  backend: z.string().nullish(),
  /**
   * Which clock every `t0`/`t1` here is measured on. `'timeline'` means the times were
   * projected onto the current edit; `'asset'` means they are the footage's own source
   * seconds.
   *
   * Defaults to `'asset'` — the conservative truth — so an older engine that omits the
   * field is never read as timeline time. A caller that sends no project document
   * cannot be given timeline time and will always see `'asset'`.
   */
  timeBase: z.enum(['timeline', 'asset']).default('asset'),
  /**
   * How much of the project this map was built from.
   *
   * The map has always been progressive — it derives from whatever spans exist, so a
   * 10%-prepared project already returns a real 10% map. Nothing said so, which left
   * every reader unable to tell a thin map from thin footage.
   */
  coverage: z.object({ prepared: z.number(), total: z.number() }).nullish(),
  /**
   * Assets in the map that are not on the timeline. Their chapters keep source seconds
   * even under `timeBase: 'timeline'`, because there is no position to project onto.
   */
  unplacedAssets: z.array(z.string()).default([]),
  /** Total footage duration in seconds. */
  durationSec: z.number().default(0),
  chapters: z.array(footageChapterSchema).default([]),
  highlights: z.array(footageHighlightSchema).default([]),
  /** Whole-footage summary, one paragraph. */
  summary: z.string().default(''),
});

/** One time-ordered chapter of the footage digest. */
export type FootageChapter = z.infer<typeof footageChapterSchema>;
/** One salient moment worth acting on. */
export type FootageHighlight = z.infer<typeof footageHighlightSchema>;
/** The time-ordered structural digest of a project's footage. */
export type FootageMap = z.infer<typeof footageMapSchema>;

/**
 * How much of the context digest the chapter list may occupy, in characters, before the
 * remainder collapses to a "+N more" line (plan FI3.3).
 *
 * ## Why a budget and not a count
 *
 * This was `MAX_DIGEST_CHAPTERS = 24`: twenty-four rows, whatever they cost and whatever
 * they left out. That number was chosen when a chapter meant a SCENE in long video, where
 * twenty-four scenes really is a good reading of an hour and the rest is detail to retrieve
 * on demand.
 *
 * On a project of stills each chapter is one photograph the editor handed over. Run
 * `accd014d` was given 61 and the digest showed 24, ending "+37 more chapters (use
 * describe_footage to read them)". So the model went and read them: `map_footage`, then
 * `recall_evidence`, then `recall_evidence` again with an offset because the payload was
 * 28,264 characters against a 16,000-character recall. Those were the last three turns of
 * the run. It placed 14 of 61 photos and left 28 of the 36-second music bed over black.
 *
 * A count cannot express "you may show the editor's whole library when the library is
 * small". A budget can, and it bounds long footage exactly as the count did — the two
 * cases stop being in tension. Measured on that same map, deduplicated
 * ({@link footageChapterSchema}), all 61 rows cost 8,077 characters — against 6,144 for
 * the 24 rows it used to print with their summaries duplicated. Showing everything costs
 * about a third more than showing 39% of it did.
 *
 * 12,000 characters is roughly 3,000 tokens. For scale, the tool definitions in that run's
 * every request were 13,814 tokens: the digest describing what the editor actually gave us
 * remains a fifth of what it costs to list the tools we might call.
 */
export const MAX_DIGEST_CHARS = 12_000;
export const MAX_DIGEST_HIGHLIGHTS = 8;

/** One-line summary trimmed to keep each chapter row compact in the prompt. */
const MAX_CHAPTER_SUMMARY_CHARS = 120;

/**
 * `m:ss.d` for a second, so chapter spans read like a video scrubber AND land inside a
 * frame.
 *
 * ## Why tenths
 *
 * This digest is the model's default reading of the footage — it is present in every
 * run, before any tool is called. Rounding it to whole seconds quantized every in-point
 * the model could propose to ±0.5s, which at 24-30fps is 12-15 frames of slop on a cut
 * planned straight from the map. One extra character per row buys that back.
 */
function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * One chapter row.
 *
 * A point span (`t0 === t1`) is a still photo: it occupies an instant, not a range, so
 * `0:12.5–0:12.5` would be noise. It reads `at 0:12.5` instead.
 */
function chapterLine(c: FootageChapter): string {
  const when = c.t1 > c.t0 ? `${clock(c.t0)}–${clock(c.t1)}` : `at ${clock(c.t0)}`;
  const summary = c.summary.trim() !== '' ? ` — ${trim(c.summary, MAX_CHAPTER_SUMMARY_CHARS)}` : '';
  // Four characters that stop a montage repeating itself: rows sharing a mark are the
  // same picture, so the model picks one of them rather than cutting both.
  const similar = typeof c.similarGroup === 'number' ? ` [~${c.similarGroup}]` : '';
  return `• ${when} ${trim(c.title, MAX_CHAPTER_SUMMARY_CHARS)}${similar}${summary}`;
}

/**
 * The longest run of chapters, from the first, whose rendered rows fit {@link MAX_DIGEST_CHARS}.
 *
 * Counts what is actually EMITTED, not just the rows: when several assets appear, each
 * one's first chapter also costs an `[assetId]` header line, and on a project of stills
 * that header is as long as the row it introduces. A budget that ignored them would
 * overshoot by roughly double on exactly the projects this exists to serve.
 */
function chaptersWithinBudget(chapters: readonly FootageChapter[]): readonly FootageChapter[] {
  const multiAsset = assetOrder(chapters).length > 1;
  const headed = new Set<string>();
  let spent = 0;
  let taken = 0;
  for (const chapter of chapters) {
    const assetId = chapter.assetId ?? '';
    const header = multiAsset && assetId !== '' && !headed.has(assetId) ? assetId.length + 3 : 0;
    const cost = header + chapterLine(chapter).length + 1;
    if (taken > 0 && spent + cost > MAX_DIGEST_CHARS) break;
    if (header > 0) headed.add(assetId);
    spent += cost;
    taken += 1;
  }
  // At least one row, always: a single chapter longer than the whole budget is still a
  // better answer than an empty map with a "+1 more" line under it.
  return chapters.slice(0, Math.max(1, taken));
}

/** Stable order of the assets appearing in a chapter list, first-seen first. */
function assetOrder(chapters: readonly FootageChapter[]): string[] {
  const seen: string[] = [];
  for (const c of chapters) {
    const id = c.assetId ?? '';
    if (id !== '' && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

/**
 * Render a {@link FootageMap} into a compact, chapter-segmented digest for the model
 * context (plan FI3.3). Returns `undefined` when there is nothing worth injecting —
 * an unavailable map, an honest no-op (a `reason` with no chapters), or an empty map —
 * so the caller simply omits the block (honest-absent, never a fabricated map). The
 * digest is bounded: chapters/highlights past the caps collapse to a "+N more" line.
 *
 * ## What changed and why
 *
 * The block used to say only "in order" and print `m:ss`. It named neither the clock its
 * times were on nor the asset each row belonged to. Both were load-bearing omissions:
 * the per-run read sends no project document, so those times were the footage's own
 * source seconds while `map_footage` documented timeline seconds — and on a 61-photo
 * project every row rendered as an indistinguishable `0:00–0:00 Scene 1`.
 */
/**
 * A chapter as the MODEL should read it: the fields that say something, and no others.
 *
 * A JSON payload is not a wire record with a reader attached — every character in it is
 * paid for twice, once in the response the model must read and again in the run's action
 * log. `summary: ""` and `similarGroup: null` are two ways of writing "there is nothing
 * here", and on the 61-photo map from run `accd014d` they cost 1,933 characters — the
 * difference between a payload `recall_evidence` returns in one call and one it splits
 * across two, where each call is a whole model turn.
 *
 * `t0`/`t1` are kept even when equal: an instant is a real answer about a still, and
 * {@link summarizeFootageMap} already renders that case as `at 0:12.5` rather than a span.
 */
export function compactFootageChapters(
  chapters: readonly FootageChapter[],
): readonly Record<string, unknown>[] {
  return chapters.map((chapter) =>
    Object.fromEntries(
      Object.entries(chapter).filter(
        ([, value]) => value !== null && value !== undefined && value !== '',
      ),
    ),
  );
}

export function summarizeFootageMap(map: FootageMap | undefined): string | undefined {
  if (!map || map.available !== true) return undefined;
  if (map.chapters.length === 0) return undefined;
  const lines: string[] = [];
  const total = map.durationSec > 0 ? ` (${clock(map.durationSec)} total)` : '';
  lines.push(`Footage map${total} — the structure of what is IN the footage, in order.`);
  lines.push(
    map.timeBase === 'timeline'
      ? 'Times are TIMELINE seconds — act on them directly.'
      : "Times are each asset's OWN source seconds, not timeline positions.",
  );
  const coverage = map.coverage;
  if (coverage && coverage.total > 0 && coverage.prepared < coverage.total) {
    // Without this the model reads a partial map as the whole of the footage and
    // concludes there is nothing else to cut to.
    lines.push(
      `Built from ${coverage.prepared} of ${coverage.total} assets prepared so far — the rest is still being read, not absent.`,
    );
  }
  if (map.summary.trim() !== '') lines.push(`Overview: ${trim(map.summary, 240)}`);
  if (map.chapters.some((c) => typeof c.similarGroup === 'number')) {
    lines.push('Rows sharing a [~n] mark look the same — use one, not both.');
  }

  const shown = chaptersWithinBudget(map.chapters);
  const assets = assetOrder(shown);
  const unplaced = new Set(map.unplacedAssets);
  if (assets.length > 1) {
    // Grouped by footage: without this the model cannot tell one asset's rows from
    // another's, which is exactly the failure mode on a project of similar photos.
    for (const assetId of assets) {
      const note =
        map.timeBase === 'timeline' && unplaced.has(assetId)
          ? ' — not on the timeline; its times are its own source seconds'
          : '';
      lines.push(`[${assetId}${note}]`);
      for (const c of shown.filter((chapter) => chapter.assetId === assetId)) {
        lines.push(chapterLine(c));
      }
    }
    const ungrouped = shown.filter((c) => (c.assetId ?? '') === '');
    for (const c of ungrouped) lines.push(chapterLine(c));
  } else {
    for (const c of shown) lines.push(chapterLine(c));
    const only = assets[0];
    if (only !== undefined && map.timeBase === 'timeline' && unplaced.has(only)) {
      lines.push(`(${only} is not on the timeline; its times are its own source seconds.)`);
    }
  }

  const remaining = map.chapters.length - shown.length;
  if (remaining > 0) {
    lines.push(
      `• …+${remaining} more chapter${remaining === 1 ? '' : 's'} (use describe_footage to read them)`,
    );
  }
  if (map.highlights.length > 0) {
    const tops = map.highlights.slice(0, MAX_DIGEST_HIGHLIGHTS);
    lines.push('Highlights:');
    for (const h of tops) {
      lines.push(`• ${clock(h.t0)}–${clock(h.t1)} ${trim(h.label, MAX_CHAPTER_SUMMARY_CHARS)}`);
    }
  }
  return lines.join('\n');
}
