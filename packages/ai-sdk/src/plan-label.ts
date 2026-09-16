/**
 * Plan-step labels as plain text.
 *
 * A drafted plan is model prose, and models write checklists in markdown:
 * `**Section A — tighten the pair** into three beats`. Every surface that shows a step
 * (the plan ledger, the approval card, the run summary's "Not done" block, the briefing
 * the model reads back) renders it as text, so the markers arrived as literal asterisks.
 * A step is a sentence, not a document: emphasis, inline code and link syntax are removed
 * and their words kept.
 *
 * Underscores are deliberately left alone. Clip and asset ids (`clip__v1_asset_raw_0`)
 * are the most precise thing a step can name, and `_x_` emphasis is indistinguishable
 * from them.
 */

// Every span pattern excludes its own opening delimiter from its body, so a failed match
// stops at the next delimiter instead of rescanning to the end of the label: linear on any
// input. Labels are model output, and `[[[[…` or `** ** **…` must not cost quadratic time.
const BOLD = /\*\*([^*]+)\*\*/g;
/** A single-asterisk span; {@link unitalic} keeps it unless it hugs non-space on both ends. */
const ITALIC = /\*([^*]+)\*/g;
const INLINE_CODE = /`([^`]+)`/g;
const LINK = /\[([^[\]]+)\]\([^()]*\)/g;
const HEADING = /^#{1,6}\s+/;
/** A step is one sentence; anything past this is a runaway response, not a label. */
const MAX_LABEL_CHARS = 1000;

/** Emphasis opens and closes on a non-space, so `2 * 3 * 4` is arithmetic, not italics. */
function unitalic(span: string, inner: string): string {
  return /^\S/.test(inner) && /\S$/.test(inner) ? inner : span;
}

/**
 * Strip inline markdown from one plan-step label, keeping its words.
 *
 * @param label - A step label as the model wrote it.
 * @returns The same label as plain text, whitespace-collapsed. Pure and idempotent.
 */
export function plainPlanLabel(label: string): string {
  return label
    .slice(0, MAX_LABEL_CHARS)
    .replace(HEADING, '')
    .replace(LINK, '$1')
    .replace(INLINE_CODE, '$1')
    .replace(BOLD, '$1')
    .replace(ITALIC, unitalic)
    .replace(/\s+/g, ' ')
    .trim();
}
