/**
 * @framepilot/ai-sdk/footage-map.test — plan FI0.1/FI3.3.
 *
 * Exercises `summarizeFootageMap`'s honest-absent cases and the bounded,
 * chapter-segmented digest rendering (caps, singular/plural "+N more", highlights).
 */
import { describe, expect, it } from 'vitest';
import { footageMapSchema, summarizeFootageMap, type FootageMap } from './footage-map.js';

function chapter(
  t0: number,
  t1: number,
  title: string,
  summary = '',
): FootageMap['chapters'][number] {
  return { t0, t1, title, summary };
}

describe('summarizeFootageMap', () => {
  it('returns undefined for an undefined map', () => {
    expect(summarizeFootageMap(undefined)).toBeUndefined();
  });

  it('returns undefined when the map is unavailable', () => {
    const map = footageMapSchema.parse({ available: false, reason: 'not indexed' });
    expect(summarizeFootageMap(map)).toBeUndefined();
  });

  it('returns undefined when available but there are no chapters (honest no-op)', () => {
    const map = footageMapSchema.parse({ available: true, chapters: [] });
    expect(summarizeFootageMap(map)).toBeUndefined();
  });

  it('renders the total duration, overview, and chapters', () => {
    const map = footageMapSchema.parse({
      available: true,
      durationSec: 125,
      summary: 'A quick walkthrough of the product.',
      chapters: [chapter(0, 10, 'Intro', 'Says hello')],
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('(2:05.0 total)');
    expect(digest).toContain('Overview: A quick walkthrough of the product.');
    expect(digest).toContain('0:00.0–0:10.0 Intro — Says hello');
  });

  it('omits the total-duration parenthetical when durationSec is 0', () => {
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).not.toContain('total)');
  });

  it('omits the Overview line when summary is blank', () => {
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).not.toContain('Overview:');
  });

  it('renders a chapter with no summary without a trailing dash', () => {
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('0:00.0–0:05.0 Intro');
    expect(digest).not.toContain('Intro —');
  });

  it('trims an overlong chapter summary', () => {
    const longSummary = 'x'.repeat(200);
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro', longSummary)],
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('…');
    // The summary is capped at MAX_CHAPTER_SUMMARY_CHARS; the slack covers the map's
    // fixed header lines (title + the time-base statement), not an untrimmed summary.
    expect(digest.length).toBeLessThan(longSummary.length + 160);
  });

  it('collapses chapters past the cap into a plural "+N more" line', () => {
    const chapters = Array.from({ length: 26 }, (_, i) => chapter(i * 10, i * 10 + 5, `Ch ${i}`));
    const map = footageMapSchema.parse({ available: true, chapters });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('+2 more chapters (use describe_footage to read them)');
  });

  it('uses the singular "+1 more chapter" when exactly one remains', () => {
    const chapters = Array.from({ length: 25 }, (_, i) => chapter(i * 10, i * 10 + 5, `Ch ${i}`));
    const map = footageMapSchema.parse({ available: true, chapters });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('+1 more chapter (use describe_footage to read them)');
  });

  it('omits the "+N more" line when chapters are within the cap', () => {
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).not.toContain('more chapter');
  });

  it('renders highlights (capped) when present', () => {
    const highlights = Array.from({ length: 10 }, (_, i) => ({
      t0: i,
      t1: i + 1,
      label: `Highlight ${i}`,
      score: 0,
    }));
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
      highlights,
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('Highlights:');
    expect(digest.match(/Highlight \d+/g)).toHaveLength(8); // MAX_DIGEST_HIGHLIGHTS
  });

  it('omits the Highlights section when there are none', () => {
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).not.toContain('Highlights:');
  });
});

describe('summarizeFootageMap — which clock the times are on', () => {
  it('says the times are timeline seconds when they were projected', () => {
    const map = footageMapSchema.parse({
      available: true,
      timeBase: 'timeline',
      chapters: [chapter(30, 35, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).toContain('Times are TIMELINE seconds');
  });

  it("says the times are the asset's own seconds when nothing could be projected", () => {
    // The per-run context read sends no project document, so this is the case that was
    // silently mislabelled as timeline time on every multi-asset project.
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('OWN source seconds');
    expect(digest).not.toContain('TIMELINE');
  });

  it('defaults to asset time when the engine omits timeBase entirely', () => {
    // An older engine must never be read as having returned timeline seconds.
    expect(footageMapSchema.parse({ available: true }).timeBase).toBe('asset');
  });

  it('names an asset that is in the map but not on the timeline', () => {
    const map = footageMapSchema.parse({
      available: true,
      timeBase: 'timeline',
      unplacedAssets: ['asset_b'],
      chapters: [
        { ...chapter(0, 5, 'On the timeline'), assetId: 'asset_a' },
        { ...chapter(0, 2, 'Still in the bin'), assetId: 'asset_b' },
      ],
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('[asset_b — not on the timeline');
    expect(digest).toContain('[asset_a]');
  });
});

describe('summarizeFootageMap — telling one piece of footage from another', () => {
  it('groups rows by asset when the map spans more than one', () => {
    const map = footageMapSchema.parse({
      available: true,
      timeBase: 'timeline',
      chapters: [
        { ...chapter(0, 5, 'A one'), assetId: 'a' },
        { ...chapter(5, 9, 'B one'), assetId: 'b' },
        { ...chapter(9, 12, 'A two'), assetId: 'a' },
      ],
    });
    const lines = summarizeFootageMap(map)!.split('\n');
    expect(lines.indexOf('[a]')).toBeLessThan(lines.indexOf('[b]'));
    // Both of a's rows sit under a's header, not interleaved with b's.
    expect(lines.filter((l) => l.includes('A one') || l.includes('A two')).length).toBe(2);
    expect(lines.indexOf('[b]')).toBeGreaterThan(lines.findIndex((l) => l.includes('A two')));
  });

  it('does not add an asset header to a single-asset map', () => {
    const map = footageMapSchema.parse({
      available: true,
      chapters: [{ ...chapter(0, 5, 'Only'), assetId: 'a' }],
    });
    expect(summarizeFootageMap(map)!).not.toContain('[a]');
  });

  it('renders a still as an instant, not a zero-length range', () => {
    // A photo occupies a moment. `0:12.5–0:12.5` is noise; on a 61-photo project every
    // row read `0:00–0:00` and the model could not tell them apart.
    const map = footageMapSchema.parse({
      available: true,
      timeBase: 'timeline',
      chapters: [{ ...chapter(12.5, 12.5, 'Hikers on a ridge'), assetId: 'photo1' }],
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('at 0:12.5 Hikers on a ridge');
    expect(digest).not.toContain('0:12.5–0:12.5');
  });

  it('keeps sub-second precision so a cut can land inside a frame', () => {
    const map = footageMapSchema.parse({
      available: true,
      timeBase: 'timeline',
      chapters: [chapter(74.3, 78.9, 'The claim')],
    });
    expect(summarizeFootageMap(map)!).toContain('1:14.3–1:18.9');
  });
});

describe('summarizeFootageMap — not cutting the same picture twice', () => {
  it('marks chapters that look the same and says what the mark means', () => {
    const map = footageMapSchema.parse({
      available: true,
      timeBase: 'timeline',
      chapters: [
        { ...chapter(0, 5, 'Ridge'), assetId: 'p1', similarGroup: 1 },
        { ...chapter(5, 9, 'Summit'), assetId: 'p2' },
        { ...chapter(9, 12, 'Ridge again'), assetId: 'p3', similarGroup: 1 },
      ],
    });
    const digest = summarizeFootageMap(map)!;
    expect(digest).toContain('Rows sharing a [~n] mark look the same');
    expect(digest).toContain('Ridge [~1]');
    expect(digest).toContain('Ridge again [~1]');
    // The one with nothing like it carries no mark — a number that appears once is noise.
    expect(digest.split('\n').find((l) => l.includes('Summit'))).not.toContain('[~');
  });

  it('says nothing about similarity when no chapter has a twin', () => {
    const map = footageMapSchema.parse({
      available: true,
      chapters: [chapter(0, 5, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).not.toContain('[~n]');
  });
});

describe('summarizeFootageMap — a partial map is not thin footage', () => {
  it('says how much of the project the map was built from while preparation runs', () => {
    const map = footageMapSchema.parse({
      available: true,
      timeBase: 'timeline',
      coverage: { prepared: 12, total: 61 },
      chapters: [chapter(0, 5, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).toContain('Built from 12 of 61 assets prepared so far');
  });

  it('stays quiet once everything is prepared', () => {
    const map = footageMapSchema.parse({
      available: true,
      coverage: { prepared: 61, total: 61 },
      chapters: [chapter(0, 5, 'Intro')],
    });
    expect(summarizeFootageMap(map)!).not.toContain('prepared so far');
  });

  it('stays quiet when the engine reports no coverage at all', () => {
    const map = footageMapSchema.parse({ available: true, chapters: [chapter(0, 5, 'Intro')] });
    expect(summarizeFootageMap(map)!).not.toContain('prepared so far');
  });
});
