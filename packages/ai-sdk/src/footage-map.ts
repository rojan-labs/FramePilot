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

/** One time-ordered chapter of the footage digest (mirrors `FootageChapter`). */
export const footageChapterSchema = z.object({
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
});

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
 * How many chapters/highlights to include in the context digest before collapsing
 * (plan FI3.3). Long footage is summarized HIERARCHICALLY: the first
 * {@link MAX_DIGEST_CHAPTERS} chapters are listed in full, the remainder collapsed
 * to a "+N more" line so the map stays bounded — the model retrieves the detail it
 * needs with `describe_footage` / `search_visual`, it is never dumped.
 */
export const MAX_DIGEST_CHAPTERS = 24;
export const MAX_DIGEST_HIGHLIGHTS = 8;

/** One-line summary trimmed to keep each chapter row compact in the prompt. */
const MAX_CHAPTER_SUMMARY_CHARS = 120;

/** `m:ss` for a timeline second, so chapter spans read like a video scrubber. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Render a {@link FootageMap} into a compact, chapter-segmented digest for the model
 * context (plan FI3.3). Returns `undefined` when there is nothing worth injecting —
 * an unavailable map, an honest no-op (a `reason` with no chapters), or an empty map —
 * so the caller simply omits the block (honest-absent, never a fabricated map). The
 * digest is bounded: chapters/highlights past the caps collapse to a "+N more" line.
 */
export function summarizeFootageMap(map: FootageMap | undefined): string | undefined {
  if (!map || map.available !== true) return undefined;
  if (map.chapters.length === 0) return undefined;
  const lines: string[] = [];
  const total = map.durationSec > 0 ? ` (${clock(map.durationSec)} total)` : '';
  lines.push(`Footage map${total} — the structure of what is IN the footage, in order:`);
  if (map.summary.trim() !== '') lines.push(`Overview: ${trim(map.summary, 240)}`);
  const shown = map.chapters.slice(0, MAX_DIGEST_CHAPTERS);
  for (const c of shown) {
    const summary =
      c.summary.trim() !== '' ? ` — ${trim(c.summary, MAX_CHAPTER_SUMMARY_CHARS)}` : '';
    lines.push(`• ${clock(c.t0)}–${clock(c.t1)} ${c.title}${summary}`);
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
