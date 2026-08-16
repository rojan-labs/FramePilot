/**
 * Grouping of the project transcript by the footage it is spoken over.
 *
 * WHY this exists: the project transcript is a single, flat, **timeline-time** word
 * list (`Project.transcript`, written by the reversible `set_transcript` operation) —
 * exactly the shape captions, search, and the preview overlay need. But an editor
 * thinks per clip: "what is said in THIS interview take?". This module projects each
 * word's start time back through the live timeline (`timelineToSource`) and cuts the
 * flat list into contiguous runs by owning asset, so the Transcription panel can show
 * the words per piece of footage without duplicating or re-timing anything.
 *
 * Runs are CONTIGUOUS (never merged across a gap): if footage A is cut, footage B is
 * used, then A returns, that reads as three sections in timeline order — which is what
 * the edit actually sounds like. Words that fall in a gap (no clip under them) belong to
 * a `null` group, surfaced honestly as "not on the timeline" rather than silently
 * attributed to whichever clip happens to be nearby.
 *
 * Every word keeps its **flat index**, so the active-word highlight can still be
 * computed once over the whole transcript (a single O(log n) binary search per playback
 * tick) and matched inside a group by index rather than by re-searching per section.
 */
import type { Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import { timelineToSource } from './footageProjection.js';

/** A transcript word plus its position in the flat `Project.transcript` array. */
export interface IndexedTranscriptWord {
  readonly word: TranscriptWord;
  /** Index into the flat project transcript (what `activeWordIndex` returns). */
  readonly index: number;
}

/** A contiguous run of transcript words spoken over one asset (or over nothing). */
export interface TranscriptGroup {
  /** The asset the words play over, or `null` when no clip covers them. */
  readonly assetId: string | null;
  readonly words: readonly IndexedTranscriptWord[];
  /** Timeline seconds of the run's first word — the section's seek target. */
  readonly start: number;
  /** Timeline seconds of the run's last word. */
  readonly end: number;
}

/**
 * Cut `transcript` into contiguous per-asset runs against the live `timeline`.
 * Word order is preserved; an empty transcript yields no groups.
 */
export function groupTranscriptByAsset(
  transcript: readonly TranscriptWord[],
  timeline: Timeline,
): readonly TranscriptGroup[] {
  const groups: {
    assetId: string | null;
    words: IndexedTranscriptWord[];
    start: number;
    end: number;
  }[] = [];
  transcript.forEach((word, index) => {
    const source = timelineToSource(word.start, timeline);
    const assetId = source?.assetId ?? null;
    const last = groups[groups.length - 1];
    if (last && last.assetId === assetId) {
      last.words.push({ word, index });
      last.end = Math.max(last.end, word.end);
      return;
    }
    groups.push({ assetId, words: [{ word, index }], start: word.start, end: word.end });
  });
  return groups;
}

/** Plain-text transcript for a run of words — what "Copy text" puts on the clipboard. */
export function transcriptText(words: readonly IndexedTranscriptWord[]): string {
  return words.map((entry) => entry.word.word).join(' ');
}
