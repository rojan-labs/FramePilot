import { describe, expect, it } from 'vitest';
import { pageMetadata, faqJsonLd, articleJsonLd, softwareApplicationJsonLd } from './seo';

describe('pageMetadata', () => {
  it('builds a canonical URL and OG image for a sub-page', () => {
    const meta = pageMetadata({ title: 'Pricing', path: '/pricing' });
    expect(meta.alternates?.canonical).toMatch(/\/pricing$/);
    expect(meta.title).toEqual({ absolute: 'Pricing · FramePilot' });
    const og = meta.openGraph as { images?: { url: string }[] };
    expect(og.images?.[0].url).toMatch(/og\.png$/);
  });

  it('marks the title absolute so the layout template cannot double the brand', () => {
    // Without this the root layout's `%s · FramePilot` template appends the
    // brand a second time: "Pricing · FramePilot · FramePilot".
    const title = pageMetadata({ title: 'Docs', path: '/docs' }).title;
    expect(title).toHaveProperty('absolute');
    expect((title as { absolute: string }).absolute.match(/FramePilot/g)).toHaveLength(1);
  });

  it('uses the brand title on the home page', () => {
    expect(pageMetadata({ title: 'Home', path: '/' }).title).toEqual({
      absolute: 'FramePilot — Your timeline, with an agent.',
    });
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
