/**
 * The narration boundary: harness-internal chatter must never reach the editor, and real
 * editing prose must survive untouched.
 *
 * Every "leaks" case below is a verbatim opening sentence from the captured run that
 * motivated this module — a real agent run against a real project, not invented phrasing.
 */
import { describe, expect, it } from 'vitest';
import { createNarrationFilter, stripRunNarration } from './narration.js';

/** The exact preambles the captured run put in front of the editor. */
const CAPTURED_LEAKS = [
  "I'll continue from the interpret stage. The user wants enhanced captions and appropriate effects with proper timing.",
  "I'll continue from analyze. The captions already exist on layer_caption_4 (40 cues, 0.09–19.749s) which matches the transcript well.",
  "I'll continue from where the run left off. The track style is applied; now I need to add semantic emphasis.",
  "I'll continue from the apply stage. The track style has been set multiple times.",
  "I'll continue from the plan stage. Captions are already styled and verified clean.",
] as const;

/** Prose that merely uses the same verbs about the VIDEO, and must not be touched. */
const REAL_EDITING_PROSE = [
  'I will continue the sequence with the wide shot so the cut has somewhere to land.',
  'Continuing the push-in through the second beat keeps the energy up.',
  'The interview picks up again at 0:42, so I am trimming the dead air before it.',
  'Applying the karaoke template to the caption track now.',
  'I left the last two cuts alone — they already land on the downbeat.',
] as const;

/** Feed a whole message through the streaming filter one character at a time. */
function streamOneCharAtATime(message: string): string {
  const filter = createNarrationFilter();
  let out = '';
  for (const ch of message) out += filter.push(ch);
  out += filter.flush();
  return out;
}

/** Feed a whole message through the streaming filter as a single delta. */
function streamWhole(message: string): string {
  const filter = createNarrationFilter();
  const out = filter.push(message);
  return out + filter.flush();
}

describe('stripRunNarration', () => {
  it.each(CAPTURED_LEAKS)('removes the leaked preamble from %j', (message) => {
    const cleaned = stripRunNarration(message);
    expect(cleaned).not.toMatch(/continue from/i);
    expect(cleaned).not.toBe('');
    // The real content after the preamble is preserved verbatim.
    expect(message.endsWith(cleaned)).toBe(true);
  });

  it.each(REAL_EDITING_PROSE)('leaves editing prose untouched: %j', (message) => {
    expect(stripRunNarration(message)).toBe(message);
  });

  it('removes a second preamble sentence when one follows the first', () => {
    const message =
      "I'll continue from the interpret stage. Picking up where the run left off. " +
      'The captions need tightening around 0:12.';
    expect(stripRunNarration(message)).toBe('The captions need tightening around 0:12.');
  });

  it('stops after two preamble sentences so it can never eat a whole message', () => {
    const message =
      "I'll continue from the interpret stage. Picking up where the run left off. " +
      'Resuming this run again. Real content.';
    // The third chatter sentence survives — the budget is spent — which is the honest
    // signal that the CONTRACT failed, rather than a filter quietly hiding it forever.
    expect(stripRunNarration(message)).toBe('Resuming this run again. Real content.');
  });

  it('keeps a message that is nothing but chatter rather than blanking it', () => {
    const message = "I'll continue from the interpret stage.";
    expect(stripRunNarration(message)).toBe(message);
  });

  it('treats a bare mention of run machinery as a leak on its own', () => {
    const message = 'The run state briefing says the cuts are settled.\nTrimming 0:04 now.';
    expect(stripRunNarration(message)).toBe('Trimming 0:04 now.');
  });

  it('ends a preamble at a newline when the model wrote no full stop', () => {
    expect(stripRunNarration("I'll continue from the analyze stage\nAdding captions.")).toBe(
      'Adding captions.',
    );
  });

  it('returns text with no sentence terminator unchanged', () => {
    expect(stripRunNarration('Trimming the intro')).toBe('Trimming the intro');
  });

  it('returns an empty message unchanged', () => {
    expect(stripRunNarration('')).toBe('');
  });
});

describe('createNarrationFilter', () => {
  it.each(CAPTURED_LEAKS)('never surfaces the preamble while streaming %j', (message) => {
    for (const streamed of [streamOneCharAtATime(message), streamWhole(message)]) {
      expect(streamed).not.toMatch(/continue from/i);
      expect(message.endsWith(streamed)).toBe(true);
      expect(streamed).not.toBe('');
    }
  });

  it.each(REAL_EDITING_PROSE)('streams editing prose through unchanged: %j', (message) => {
    expect(streamOneCharAtATime(message)).toBe(message);
    expect(streamWhole(message)).toBe(message);
  });

  it('holds nothing back once the preamble question is settled', () => {
    const filter = createNarrationFilter();
    // The first sentence is real prose, so the filter releases it and opens up.
    expect(filter.push('Trimming the intro. ')).toBe('Trimming the intro. ');
    // Chatter arriving LATER is not a preamble and is not silently rewritten.
    expect(filter.push("I'll continue from the apply stage.")).toBe(
      "I'll continue from the apply stage.",
    );
    expect(filter.flush()).toBe('');
  });

  it('releases a very long first sentence rather than stalling the stream', () => {
    const long = `${'a'.repeat(500)}. tail`;
    expect(streamWhole(long)).toBe(long);
  });

  it('gives up holding once the preamble budget is spent with no terminator in sight', () => {
    // A model writing one 600-character sentence must not be held hostage by a filter
    // waiting for a full stop that is still 300 characters away. Fed in small chunks so the
    // budget is crossed mid-stream, which is where the release actually has to happen.
    const filter = createNarrationFilter();
    const unterminated = 'b'.repeat(600);
    let out = '';
    let releasedBeforeEnd = false;
    for (let i = 0; i < unterminated.length; i += 10) {
      const surfaced = filter.push(unterminated.slice(i, i + 10));
      out += surfaced;
      if (surfaced !== '' && i + 10 < unterminated.length) releasedBeforeEnd = true;
    }
    out += filter.flush();
    expect(releasedBeforeEnd).toBe(true);
    expect(out).toBe(unterminated);
  });

  it('stops filtering after two stripped sentences', () => {
    const message =
      "I'll continue from the interpret stage. Picking up where the run left off. " +
      'Resuming this run again. Real content.';
    expect(streamWhole(message)).toBe('Resuming this run again. Real content.');
  });

  it('surfaces nothing when the entire streamed message was chatter', () => {
    // Deliberately different from `stripRunNarration`: a live stream cannot un-render text
    // it already showed, so the filter refuses the sentence when its terminator proves what
    // it was, and the caller falls back to its own default reason.
    expect(streamWhole("I'll continue from the interpret stage.")).toBe('');
  });

  it('releases an unterminated tail that is not itself chatter', () => {
    expect(streamWhole("I'll continue from the interpret stage. Trimming 0:04")).toBe(
      'Trimming 0:04',
    );
  });

  it('refuses an unterminated tail that is more chatter', () => {
    expect(streamWhole("I'll continue from the interpret stage. Resuming this run")).toBe('');
  });

  it('flushes an unterminated first sentence when nothing was stripped', () => {
    expect(streamWhole('Trimming the intro')).toBe('Trimming the intro');
  });

  it('is a pass-through after flush', () => {
    const filter = createNarrationFilter();
    expect(filter.flush()).toBe('');
    expect(filter.push('anything')).toBe('anything');
    expect(filter.flush()).toBe('');
  });
});

describe('the filter never rewrites a character it passes through', () => {
  /** Feed `text` through the filter split at `size`-character boundaries. */
  const stream = (text: string, size: number): string => {
    const filter = createNarrationFilter();
    let out = '';
    for (let index = 0; index < text.length; index += size) {
      out += filter.push(text.slice(index, index + size));
    }
    return out + filter.flush();
  };

  /**
   * Two captured runs showed single characters inserted and dropped in the assistant's
   * own prose — "stop-sscrolling", "white-bacck", "proof-of-caim", "poppng". This is the
   * only place in the pipeline that holds text back and re-emits it, so it is the only
   * place that COULD do that. These pin that it does not, at every chunk boundary,
   * including inside the words that were corrupted.
   */
  const MESSAGES = [
    'The talk is a tight, well-scripted pitch — founders stop-scrolling, white-back boxed captions that punch the key single words, proof-of-claim b-roll.',
    'the emphasis is white-boxed and popping',
    'Trimming the head.',
    'One sentence. Then another. And a third!',
    'No terminator at all',
    '',
    'a',
    '\n\nLeading blank lines survive.\n',
  ];

  for (const message of MESSAGES) {
    it(`reproduces ${JSON.stringify(message.slice(0, 40))} at every chunk size`, () => {
      // Every split of the message, one character at a time up to the whole thing at once.
      for (let size = 1; size <= Math.max(1, message.length); size += 1) {
        expect(stream(message, size)).toBe(message);
      }
    });
  }

  it('reproduces a long message split at every single-character boundary', () => {
    // The shape a real stream has: many tiny deltas, one of which lands mid-word.
    const long = MESSAGES[0] as string;
    for (let cut = 0; cut <= long.length; cut += 1) {
      const filter = createNarrationFilter();
      const out = filter.push(long.slice(0, cut)) + filter.push(long.slice(cut)) + filter.flush();
      expect(out).toBe(long);
    }
  });

  it('drops a preamble WHOLE, never part of one', () => {
    // The one case where output legitimately differs from input: the stripped sentence
    // goes entirely, and what survives is byte-identical to its tail.
    const message = 'I’ll continue from the interpret stage. Trimming the head.';
    for (let size = 1; size <= message.length; size += 1) {
      expect(stream(message, size)).toBe('Trimming the head.');
    }
  });
});
