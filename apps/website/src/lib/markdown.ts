import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeStringify from 'rehype-stringify';

/**
 * Render blog markdown to an HTML string at build time. Blog content is plain
 * markdown (no JSX), so a direct remark→rehype pipeline is simpler and avoids the
 * multiple-React-copy problem of runtime MDX in a pnpm monorepo. Output is styled
 * by the `.prose-fp` class and injected via dangerouslySetInnerHTML — safe because
 * the input is our own authored, build-time content.
 */
export async function renderMarkdown(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: 'wrap' })
    .use(rehypePrettyCode, { theme: 'github-dark-default', keepBackground: false })
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}

export interface TocEntry {
  /** Heading text. */
  text: string;
  /** Anchor id (matches rehype-slug output). */
  id: string;
  /** Heading level (2 or 3). */
  depth: 2 | 3;
}

/**
 * Slugify a heading the same way `rehype-slug` (github-slugger) does for our
 * authored content: lowercase, strip anything that isn't a word char/space/hyphen,
 * then spaces → hyphens. Kept in-house so we don't add a dependency just to build
 * an on-page table of contents.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * Extract an on-page table of contents (h2/h3) from markdown source. Skips
 * headings inside fenced code blocks so a `## ` in a snippet isn't picked up.
 */
export function extractToc(markdown: string): TocEntry[] {
  const toc: TocEntry[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const depth = match[1].length as 2 | 3;
    const text = match[2].replace(/[*_`]/g, '').trim();
    toc.push({ text, id: slugifyHeading(text), depth });
  }
  return toc;
}
