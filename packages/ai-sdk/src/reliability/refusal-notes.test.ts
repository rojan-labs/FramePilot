/**
 * `reliability/refusal-notes.ts` — the shape of the sentences, and the one thing the
 * gate cannot assert: that a caller reaching for a sentence nobody wrote fails loudly.
 *
 * Whether these sentences NAME a next action is asserted in
 * `model-facing-failure.gate.test.ts`, against the live tool registry. Repeating that
 * judgement here with a hand-copied tool list is how the two would drift.
 */
import { describe, expect, it } from 'vitest';
import {
  unavailableToolNote,
  unknownToolNote,
  unusableHostPayload,
  unusableHostPayloadEntries,
} from './refusal-notes.js';

describe('unusableHostPayload', () => {
  it('opens with the refusal envelope the executor and the model both read', () => {
    expect(unusableHostPayload('add_music')).toMatch(/^Rejected "add_music" — /);
  });

  it('says the arguments are not the cause, so the model does not tune them', () => {
    // The whole loop this ends: a caller that cannot tell a broken host from a bad
    // argument has exactly one move, which is to send the call again with new arguments.
    for (const { note } of unusableHostPayloadEntries()) {
      expect(note).toContain('not about your arguments');
    }
  });

  it('throws rather than inventing a sentence for a tool nobody wrote one for', () => {
    // A generic fallback here is how the dead end comes back: it would read as guidance
    // and say nothing, on a path no one is watching.
    expect(() => unusableHostPayload('trim_clip')).toThrow(/add an entry/);
  });

  it('enumerates every entry for the gate, with the note each key produces', () => {
    const entries = unusableHostPayloadEntries();
    expect(entries.map((entry) => entry.tool)).toEqual([
      'transcribe',
      'remove_silences',
      'add_music',
      'add_stock',
      'track_subject_automatically',
    ]);
    for (const { tool, note } of entries) expect(note).toBe(unusableHostPayload(tool));
  });

  it('is stable — the desktop and the orchestrator must answer in the same words', () => {
    // `apps/desktop`'s `hostTranscribe` override returns this exact string, and the
    // orchestrator's `transcribe` branch returns it too. Byte equality is the point.
    expect(unusableHostPayload('transcribe')).toBe(unusableHostPayload('transcribe'));
    expect(unusableHostPayload('transcribe')).toContain('get_transcript');
  });
});

describe('unavailableToolNote', () => {
  it('says the answer will not change later in the run, and closes the call off', () => {
    const note = unavailableToolNote('generate_mask');
    expect(note).toMatch(/^Skipped "generate_mask" — /);
    // The old sentence was "not available yet" and nothing else — the bare "yet" read as
    // "wait and try later", which is the one thing that cannot work. The note now says
    // for how long the answer holds, and closes the call off.
    expect(note).toContain('the same way for the rest of this run');
    expect(note).toContain('Do not call it again');
  });
});

describe('unknownToolNote', () => {
  it('says the name does not exist, not merely that the call was refused', () => {
    const note = unknownToolNote('frobnicate');
    expect(note).toContain('There is no tool called "frobnicate"');
    expect(note).toContain('Do not call that name again');
  });
});
