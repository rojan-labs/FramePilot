import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

/**
 * Customer-facing changelog content model. Entries are authored markdown in
 * `content/changelog/*.mdx` and rendered at build time through the same
 * remark→rehype pipeline as the blog/docs (see `lib/markdown.ts`) — no runtime
 * MDX, which keeps the static export lean.
 *
 * IMPORTANT: this changelog is written for CUSTOMERS, not engineers. Entries
 * describe what changed for the person using FramePilot ("Captions now match
 * your video's language automatically"), never internal/code detail (module
 * names, test counts, schema notes). The developer-facing history lives in the
 * repo's root `CHANGELOG.md`; the two are intentionally separate audiences.
 */

const CHANGELOG_DIR = join(process.cwd(), 'content', 'changelog');

/** The kind of change, used for the coloured chip on each item. */
export const CHANGE_TAGS = ['New', 'Improved', 'Fixed'] as const;
export type ChangeTag = (typeof CHANGE_TAGS)[number];

export interface ChangelogFrontmatter {
  /** Human release name/version shown as the entry title, e.g. "1.1 — Faster exports". */
  title: string;
  /** One-line customer summary shown under the title and in listings/SEO. */
  summary: string;
  /** ISO date (YYYY-MM-DD) the update shipped. */
  date: string;
  /** Optional product version, e.g. "1.1.0". */
  version?: string;
  /** The kinds of change in this release (drives the chips). */
  tags?: ChangeTag[];
  draft?: boolean;
}

export interface ChangelogEntryMeta extends ChangelogFrontmatter {
  slug: string;
}

export interface ChangelogEntry extends ChangelogEntryMeta {
  content: string;
}

function parse(slug: string): ChangelogEntry {
  const raw = readFileSync(join(CHANGELOG_DIR, `${slug}.mdx`), 'utf8');
  const { data, content } = matter(raw);
  const fm = data as ChangelogFrontmatter;
  return {
    ...fm,
    slug,
    tags: fm.tags ?? [],
    content,
  };
}

/** All published changelog entries, newest first. */
export function getChangelogEntries(): ChangelogEntry[] {
  let files: string[] = [];
  try {
    files = readdirSync(CHANGELOG_DIR).filter((f) => f.endsWith('.mdx'));
  } catch {
    return [];
  }
  return files
    .map((f) => parse(f.replace(/\.mdx$/, '')))
    .filter((e) => !e.draft)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Human-friendly date, e.g. "July 4, 2026". */
export function formatChangelogDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
