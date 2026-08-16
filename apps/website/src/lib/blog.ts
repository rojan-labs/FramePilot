import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import readingTime from 'reading-time';

const BLOG_DIR = join(process.cwd(), 'content', 'blog');

export interface PostFrontmatter {
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  author: string;
  tags?: string[];
  keywords?: string[];
  /** Root-relative cover/OG image (optional). */
  cover?: string;
  draft?: boolean;
}

export interface PostMeta extends PostFrontmatter {
  slug: string;
  readingMinutes: number;
}

export interface Post extends PostMeta {
  content: string;
}

function parse(slug: string): Post {
  const raw = readFileSync(join(BLOG_DIR, `${slug}.mdx`), 'utf8');
  const { data, content } = matter(raw);
  const fm = data as PostFrontmatter;
  return {
    ...fm,
    slug,
    tags: fm.tags ?? [],
    keywords: fm.keywords ?? [],
    readingMinutes: Math.max(1, Math.round(readingTime(content).minutes)),
    content,
  };
}

/** All published posts, newest first. */
export function getAllPosts(): PostMeta[] {
  let files: string[] = [];
  try {
    files = readdirSync(BLOG_DIR).filter((f) => f.endsWith('.mdx'));
  } catch {
    return [];
  }
  return files
    .map((f) => parse(f.replace(/\.mdx$/, '')))
    .filter((p) => !p.draft)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(({ content: _content, ...meta }) => meta);
}

export function getPostSlugs(): string[] {
  return getAllPosts().map((p) => p.slug);
}

export function getPost(slug: string): Post | null {
  try {
    const post = parse(slug);
    return post.draft ? null : post;
  } catch {
    return null;
  }
}

/** Human-friendly date, e.g. "July 3, 2026". */
export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
