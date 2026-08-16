import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { getAllPosts } from '@/lib/blog';
import { getDocSlugs } from '@/lib/docs';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = [
    '',
    '/pricing',
    '/download',
    '/blog',
    '/docs',
    '/changelog',
    '/legal/privacy',
    '/legal/terms',
  ].map((path) => ({
    url: `${SITE_URL}${path}/`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: path === '' ? 1 : 0.7,
  }));

  const posts = getAllPosts().map((post) => ({
    url: `${SITE_URL}/blog/${post.slug}/`,
    lastModified: new Date(`${post.date}T00:00:00Z`),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  const docs = getDocSlugs().map((slug) => ({
    url: `${SITE_URL}/docs/${slug}/`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  return [...staticRoutes, ...posts, ...docs];
}
