import { describe, expect, it } from 'vitest';
import { pageMetadata, faqJsonLd, articleJsonLd, softwareApplicationJsonLd } from './seo';

describe('pageMetadata', () => {
  it('builds a canonical URL and OG image for a sub-page', () => {
    const meta = pageMetadata({ title: 'Pricing', path: '/pricing' });
    expect(meta.alternates?.canonical).toMatch(/\/pricing$/);
    expect(meta.title).toBe('Pricing · FramePilot');
    const og = meta.openGraph as { images?: { url: string }[] };
    expect(og.images?.[0].url).toMatch(/og\.png$/);
  });

  it('uses the brand title on the home page', () => {
    expect(pageMetadata({ title: 'Home', path: '/' }).title).toContain('FramePilot —');
  });
});

describe('json-ld', () => {
  it('emits FAQ, Article, and SoftwareApplication schemas', () => {
    expect(faqJsonLd([{ q: 'A?', a: 'B.' }])).toMatchObject({
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'A?' }],
    });
    expect(
      articleJsonLd({
        title: 'T',
        description: 'D',
        path: '/blog/x',
        date: '2026-07-01',
        author: 'A',
      }),
    ).toMatchObject({ '@type': 'BlogPosting', headline: 'T' });
    expect(softwareApplicationJsonLd()['@type']).toBe('SoftwareApplication');
  });
});
