import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

/**
 * Documentation content model. Docs are authored markdown in `content/docs/*.mdx`
 * and rendered at build time through the same remark→rehype pipeline as the blog
 * (see `lib/markdown.ts`) — no runtime MDX, which keeps the static export lean and
 * avoids the multiple-React-copy problem in a pnpm monorepo. Ordering and grouping
 * for the sidebar come from frontmatter, so adding a page is drop-in.
 */

const DOCS_DIR = join(process.cwd(), 'content', 'docs');

/** Sidebar section order. Pages are grouped under these, in this order. */
export const DOC_CATEGORIES = ['Getting started', 'Guides', 'Reference'] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export interface DocFrontmatter {
  title: string;
  description: string;
  /** Sidebar group. */
  category: DocCategory;
  /** Sort order within the category (ascending). */
  order: number;
  draft?: boolean;
}

export interface DocMeta extends DocFrontmatter {
  slug: string;
}

export interface Doc extends DocMeta {
  content: string;
}

function parse(slug: string): Doc {
  const raw = readFileSync(join(DOCS_DIR, `${slug}.mdx`), 'utf8');
  const { data, content } = matter(raw);
  const fm = data as DocFrontmatter;
  return { ...fm, slug, content };
}

/** All published docs, sorted by category then order. */
export function getAllDocs(): DocMeta[] {
  let files: string[] = [];
  try {
    files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.mdx'));
  } catch {
    return [];
  }
  return files
    .map((f) => parse(f.replace(/\.mdx$/, '')))
    .filter((d) => !d.draft)
    .sort(byCategoryThenOrder)
    .map(({ content: _content, ...meta }) => meta);
}

function byCategoryThenOrder(a: DocMeta, b: DocMeta): number {
  const ca = DOC_CATEGORIES.indexOf(a.category);
  const cb = DOC_CATEGORIES.indexOf(b.category);
  if (ca !== cb) return ca - cb;
  return a.order - b.order;
}

export function getDocSlugs(): string[] {
  return getAllDocs().map((d) => d.slug);
}

export function getDoc(slug: string): Doc | null {
  try {
    const doc = parse(slug);
    return doc.draft ? null : doc;
  } catch {
    return null;
  }
}

/** The sidebar nav: docs grouped into their categories, both in order. */
export interface DocNavGroup {
  category: DocCategory;
  items: DocMeta[];
}
export function getDocNav(): DocNavGroup[] {
  const all = getAllDocs();
  return DOC_CATEGORIES.map((category) => ({
    category,
    items: all.filter((d) => d.category === category),
  })).filter((g) => g.items.length > 0);
}

/** Previous / next doc in the flattened reading order (for page footers). */
export function getDocNeighbors(slug: string): { prev: DocMeta | null; next: DocMeta | null } {
  const all = getAllDocs();
  const i = all.findIndex((d) => d.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? all[i - 1] : null,
    next: i < all.length - 1 ? all[i + 1] : null,
  };
}
