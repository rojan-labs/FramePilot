/**
 * Progressive markdown renderer for assistant messages (Phase 11 M4, ADR 0033,
 * Approval A4 — markdown library).
 *
 * Uses `react-markdown` (MIT) with `remark-gfm` (MIT): it parses the current
 * (possibly partial, still-streaming) markdown string on every render and emits
 * React elements — no raw HTML is ever injected (react-markdown does not render
 * embedded HTML by default), so an AI-authored message cannot inject script.
 * `remark-gfm` adds GitHub-flavored tables, strikethrough, and task lists — the
 * AI regularly answers with pipe tables (media-bin contents, highlight lists),
 * and without it react-markdown renders that syntax as literal `| a | b |` text
 * instead of a table. Links are forced to open safely. Kept as a thin wrapper so
 * the dependency is swappable in one place.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/** Render links in a new tab with no opener access. */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/** Render a markdown string (tolerant of partial input while streaming). */
export function Markdown({ text }: { readonly text: string }): JSX.Element {
  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
