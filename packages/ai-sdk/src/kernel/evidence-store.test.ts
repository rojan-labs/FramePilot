/**
 * Tests for the evidence store (plan/AGENT-TASK-MEMORY.md §3.4, ADR 0075).
 *
 * The store carries two obligations that the memo it replaces could not hold at once:
 * it must never re-execute a read it already answered, AND it must always hand the data
 * back. Most of what follows pins the second, because that is the half that was broken.
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_PREVIEW_CHARS,
  EVIDENCE_RECALL_CHARS,
  EvidenceStore,
  evidenceScopeFor,
} from './evidence-store.js';

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ word: `word${i}`, start: i, end: i + 1 }));

const put = (store: EvidenceStore, over: Partial<Parameters<EvidenceStore['put']>[0]> = {}) =>
  store.put({
    key: 'get_transcript:{}',
    source: 'get_transcript',
    descriptor: 'Reading the transcript',
    data: words(200),
    ...over,
  });

describe('evidenceScopeFor', () => {
  it('treats source material as surviving a timeline change', () => {
    expect(evidenceScopeFor('get_transcript')).toBe('revision_independent');
    expect(evidenceScopeFor('map_footage')).toBe('revision_independent');
    expect(evidenceScopeFor('analyze_silence')).toBe('revision_independent');
  });

  it('treats arrangement — and anything unknown — as timeline-dependent', () => {
    expect(evidenceScopeFor('get_timeline')).toBe('timeline_dependent');
    expect(evidenceScopeFor('get_clips')).toBe('timeline_dependent');
    expect(evidenceScopeFor('some_future_tool')).toBe('timeline_dependent');
  });
});

describe('storing and looking up', () => {
  it('files a payload under a handle and finds it by key or handle', () => {
    const store = new EvidenceStore();
    const entry = put(store);
    expect(entry.id).toBe('ev_1');
    expect(store.lookup('get_transcript:{}')).toBe(entry);
    expect(store.byHandle('ev_1')).toBe(entry);
    expect(store.size()).toBe(1);
    expect(store.entries()).toEqual([entry]);
  });

  it('returns the existing entry rather than reissuing a handle', () => {
    const store = new EvidenceStore();
    const first = put(store);
    const second = put(store, { data: words(5) });
    expect(second).toBe(first);
    expect(store.size()).toBe(1);
  });

  it('issues distinct handles for distinct calls', () => {
    const store = new EvidenceStore();
    expect(put(store).id).toBe('ev_1');
    expect(put(store, { key: 'get_timeline:{}', source: 'get_timeline' }).id).toBe('ev_2');
  });

  it('has nothing to offer for an unknown key or handle', () => {
    const store = new EvidenceStore();
    expect(store.lookup('nope')).toBeUndefined();
    expect(store.byHandle('ev_9')).toBeUndefined();
  });
});

describe('preview — what a read or a memo hit puts in the log', () => {
  it('carries real content and points at the handle when it truncates', () => {
    const store = new EvidenceStore();
    const entry = put(store);
    const preview = store.preview(entry);
    expect(preview).toContain('word0');
    expect(preview).toContain('recall_evidence');
    expect(preview).toContain('ev_1');
    expect(preview.length).toBeLessThan(EVIDENCE_PREVIEW_CHARS + 120);
  });

  it('leaves a small payload whole', () => {
    const store = new EvidenceStore();
    const entry = put(store, { data: { durationSeconds: 364 } });
    expect(store.preview(entry)).toBe('{"durationSeconds":364}');
  });

  it('renders a string payload as itself', () => {
    const store = new EvidenceStore();
    expect(store.preview(put(store, { data: 'plain text' }))).toBe('plain text');
  });

  it('falls back to String() for a payload JSON.stringify silently drops, not just throws', () => {
    // JSON.stringify(undefined) returns `undefined` (no throw) — a distinct failure
    // mode from the cyclic-reference case below, which throws. Both must still render
    // as text a model can read, never a crash or a literal empty string.
    const store = new EvidenceStore();
    expect(store.preview(put(store, { data: undefined }))).toBe('undefined');
  });

  it('survives a payload JSON cannot represent', () => {
    const store = new EvidenceStore();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(store.preview(put(store, { data: cyclic }))).toContain('object');
  });
});

describe('recall — the path back to what the run already read', () => {
  it('returns more than the preview did', () => {
    const store = new EvidenceStore();
    put(store, { data: words(2000) });
    const recalled = store.recall('ev_1')!;
    expect(recalled.length).toBeGreaterThan(EVIDENCE_PREVIEW_CHARS);
    expect(recalled.length).toBeLessThan(EVIDENCE_RECALL_CHARS + 120);
  });

  it('narrows an array payload to the entries that match', () => {
    const store = new EvidenceStore();
    put(store, { data: words(500) });
    const recalled = store.recall('ev_1', 'word37')!;
    expect(recalled).toContain('word37');
    expect(recalled).not.toContain('word480');
  });

  it('narrows a WRAPPED list payload by record, not by newline', () => {
    // `get_timeline_map` returns `{ spans, duration, revision }`. JSON.stringify emits no
    // newlines, so the line split made the whole 42-clip payload ONE part: a query either
    // matched the entire blob (handing back the same truncated head the preview already
    // showed) or matched nothing. A run trying to check clip 30's source in-point could
    // not reach it by any query.
    const spans = Array.from({ length: 42 }, (_, i) => ({
      clipId: `clip_${i}`,
      sourceStart: i * 0.6,
      sourceEnd: i * 0.6 + 0.5,
    }));
    const store = new EvidenceStore();
    put(store, { source: 'get_timeline_map', data: { spans, duration: 21.867, revision: 12 } });
    const recalled = store.recall('ev_1', 'clip_30')!;
    expect(recalled).toContain('clip_30');
    expect(recalled).not.toContain('clip_2"');
    expect(recalled.length).toBeLessThan(EVIDENCE_RECALL_CHARS);
  });

  it('filters by record even when a payload holds SEVERAL record lists', () => {
    // The old `arrays.length === 1` guard sent any two-array payload down the single-line
    // JSON path, where the only matchable part is the whole blob. That covered the two
    // reads a caption run depends on — `discover_caption_styles` (fonts + templates +
    // compositionFields) and `get_mapped_transcript` (words + runs) — so every query
    // against them reported no match at all. Flattening drops nothing: an unmatched
    // sibling list is simply not part of THIS answer.
    const store = new EvidenceStore();
    put(store, { data: { clips: [{ id: 'c1' }], tracks: [{ id: 't1' }] } });
    const recalled = store.recall('ev_1', 'c1')!;
    expect(recalled).toContain('c1');
    expect(recalled).not.toContain('t1');
    expect(store.recall('ev_1', 't1')).toContain('t1');
  });

  it('matches a keyword-bag query on ANY of its words', () => {
    // The regression that stalled the caption run: the whole query was one literal
    // needle, so `captionStyle track layer_caption_4 style` could only match if that
    // exact 45-character string sat inside a single record. It never does — the run's
    // only retrieval surface answered every correct question with "no match".
    const store = new EvidenceStore();
    put(store, {
      source: 'get_timeline',
      data: {
        tracks: [
          { id: 'layer_caption_4', captionStyle: { templateId: 'headline' } },
          { id: 'video_main', clips: [] },
        ],
        revision: 749,
      },
    });
    const recalled = store.recall('ev_1', 'captionStyle track layer_caption_4 style template')!;
    expect(recalled).toContain('headline');
    expect(recalled).not.toContain('No part of');
  });

  it('ranks a whole-phrase hit above scattered keyword hits', () => {
    const store = new EvidenceStore();
    put(store, {
      data: [{ note: 'accent lives here and gold sits far away' }, { note: 'gold accent' }],
    });
    const recalled = store.recall('ev_1', 'gold accent')!;
    // Both records match on words; only the second carries the phrase, so it leads.
    expect(recalled.indexOf('gold accent')).toBeLessThan(recalled.indexOf('far away'));
  });

  it('handles an object payload that is not a list of anything', () => {
    // `get_selected_range` and friends hold no records at all; the query must still work
    // rather than treating "no records" as "no match".
    const store = new EvidenceStore();
    put(store, { data: { start: 3.5, end: 9.25 } });
    expect(store.recall('ev_1', 'end')).toContain('9.25');
  });

  it('falls back to the line split so a query can still reach a scalar sibling field', () => {
    const store = new EvidenceStore();
    put(store, { data: { templates: [{ id: 'punchline' }], matched: 51, returned: 20 } });
    expect(store.recall('ev_1', 'matched')).toContain('51');
  });

  it('pages past the recall budget instead of re-serving the same head', () => {
    // Three recalls of the caption-style catalog returned the identical head, cut mid
    // template, because there was no argument that could reach the tail. A truncation the
    // caller cannot page past is the same deadlock as a memo that withholds its data.
    const store = new EvidenceStore();
    put(store, { data: 'x'.repeat(EVIDENCE_RECALL_CHARS * 2) });
    const head = store.recall('ev_1')!;
    expect(head).toContain(`offset ${EVIDENCE_RECALL_CHARS}`);
    const tail = store.recall('ev_1', undefined, EVIDENCE_RECALL_CHARS)!;
    expect(tail).not.toContain('truncated');
    expect(head.startsWith('x'.repeat(100))).toBe(true);
    expect(tail.length).toBe(EVIDENCE_RECALL_CHARS);
  });

  it('says so plainly when an offset is past the end', () => {
    const store = new EvidenceStore();
    put(store, { data: 'short' });
    expect(store.recall('ev_1', undefined, 9_000)).toContain('past the end');
  });

  it('pages a FILTERED result too, so a narrow query is not itself a dead end', () => {
    const store = new EvidenceStore();
    put(store, { source: 'get_clips', data: { clips: words(4000) } });
    const first = store.recall('ev_1', 'word')!;
    expect(first).toContain('truncated at');
    const second = store.recall('ev_1', 'word', EVIDENCE_RECALL_CHARS)!;
    expect(second).not.toBe(first);
  });

  it('narrows a text payload line by line, case-insensitively', () => {
    const store = new EvidenceStore();
    put(store, { data: 'The Hook lands here\nfiller\nanother line' });
    expect(store.recall('ev_1', 'hook')).toBe('The Hook lands here');
  });

  it('says plainly when nothing matches rather than inventing an answer', () => {
    const store = new EvidenceStore();
    put(store, { data: words(10) });
    expect(store.recall('ev_1', 'nothing-like-this')).toContain('No part of ev_1');
  });

  it('treats a blank query as no query', () => {
    const store = new EvidenceStore();
    put(store, { data: 'content' });
    expect(store.recall('ev_1', '   ')).toBe('content');
  });

  it('returns undefined for an unknown handle, so the caller can say so', () => {
    expect(new EvidenceStore().recall('ev_404')).toBeUndefined();
  });
});

describe('invalidation is scoped to what actually changed', () => {
  const seeded = () => {
    const store = new EvidenceStore();
    store.put({
      key: 'get_transcript:{}',
      source: 'get_transcript',
      descriptor: 'transcript',
      data: words(5),
    });
    store.put({
      key: 'map_footage:{}',
      source: 'map_footage',
      descriptor: 'footage map',
      data: { chapters: 35 },
    });
    store.put({
      key: 'get_timeline:{}',
      source: 'get_timeline',
      descriptor: 'timeline',
      data: { tracks: [] },
    });
    return store;
  };

  it('a cut drops the arrangement and keeps the source material', () => {
    const store = seeded();
    expect(store.invalidate(['ripple_delete'])).toBe(1);
    expect(store.entries().map((e) => e.source)).toEqual(['get_transcript', 'map_footage']);
  });

  it('rewriting the transcript drops transcript evidence too', () => {
    const store = seeded();
    store.invalidate(['set_transcript']);
    expect(store.entries().map((e) => e.source)).toEqual(['map_footage']);
  });

  it('frees the handle as well as the key, so a stale id cannot be recalled', () => {
    const store = seeded();
    const timeline = store.lookup('get_timeline:{}')!;
    store.invalidate(['delete_range']);
    expect(store.byHandle(timeline.id)).toBeUndefined();
    expect(store.recall(timeline.id)).toBeUndefined();
  });

  /**
   * The regression this store's classification fix was for. A beat-synced montage applies
   * one cut per beat; while `detect_beats`, `index_media` and `list_assets` were missing
   * from the old revision-independent allowlist, the FIRST cut evicted all three and the
   * run re-ran them — then re-ran them again after the next cut, for the whole montage.
   */
  describe('a beat-synced montage keeps its analysis across every cut', () => {
    const montage = () => {
      const store = new EvidenceStore();
      store.put({
        key: 'detect_beats:{}',
        source: 'detect_beats',
        descriptor: 'beat map',
        data: { bpm: 128, beats: [0.47, 0.94, 1.41] },
      });
      store.put({
        key: 'index_media:{}',
        source: 'index_media',
        descriptor: 'media index',
        data: { indexed: 24 },
      });
      store.put({
        key: 'list_assets:{}',
        source: 'list_assets',
        descriptor: 'media bin',
        data: { assets: 24 },
      });
      store.put({
        key: 'describe_footage:{}',
        source: 'describe_footage',
        descriptor: 'shot descriptions',
        data: { shots: 24 },
      });
      return store;
    };

    it('survives a cut with the beat map, media index, bin and shot descriptions intact', () => {
      const store = montage();
      expect(store.invalidate(['split_clip', 'add_clip', 'ripple_delete'])).toBe(0);
      expect(store.entries().map((e) => e.source)).toEqual([
        'detect_beats',
        'index_media',
        'list_assets',
        'describe_footage',
      ]);
    });

    it('survives thirty cuts, so the analysis is paid for exactly once', () => {
      const store = montage();
      for (let cut = 0; cut < 30; cut += 1) store.invalidate(['split_clip', 'add_transition']);
      expect(store.size()).toBe(4);
      expect(store.recall(store.lookup('detect_beats:{}')!.id)).toContain('128');
    });

    it('still drops the bin listing when an asset is actually added', () => {
      const store = montage();
      store.invalidate(['add_asset']);
      expect(store.entries().map((e) => e.source)).toEqual([
        'detect_beats',
        'index_media',
        'describe_footage',
      ]);
    });
  });

  it('reports nothing dropped when a patch touches nothing it holds', () => {
    const store = new EvidenceStore();
    store.put({
      key: 'get_transcript:{}',
      source: 'get_transcript',
      descriptor: 'transcript',
      data: words(3),
    });
    expect(store.invalidate(['delete_range'])).toBe(0);
    expect(store.size()).toBe(1);
  });
});
