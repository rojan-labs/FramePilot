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
    expect(digest).toContain('(2:05 total)');
    expect(digest).toContain('Overview: A quick walkthrough of the product.');
    expect(digest).toContain('0:00–0:10 Intro — Says hello');
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
    expect(digest).toContain('0:00–0:05 Intro');
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
    expect(digest.length).toBeLessThan(longSummary.length + 50);
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
