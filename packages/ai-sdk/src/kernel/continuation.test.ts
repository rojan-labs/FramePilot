/**
 * A run must not lose its goal because the editor typed "continue".
 *
 * The failure this guards: a whole conversation turn whose message was "contine" recorded
 * that word as the objective, the acceptance criterion, the committed decision and the
 * criterion verification reported against — so the run forgot what it was doing AND could
 * only report itself inconclusive.
 */
import { describe, expect, it } from 'vitest';
import { deriveObjectiveText, isBareContinuation } from './continuation.js';

const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });

describe('isBareContinuation — a nudge names no work of its own', () => {
  it.each([
    'continue',
    'Continue.',
    'contine',
    'continu',
    'go on',
    'keep going',
    'carry on',
    'proceed',
    'go ahead',
    'please continue',
    'ok continue',
    'finish it',
    'next',
    'resume',
  ])('treats %j as a nudge', (text) => {
    expect(isBareContinuation(text)).toBe(true);
  });

  it.each([
    'can you use a different caption style',
    'continue but make it shorter',
    'keep the captions gold and add a hook',
    'finish the export at 1080p',
    'ok',
    'yes',
    '',
    '   ',
  ])('treats %j as a request of its own', (text) => {
    expect(isBareContinuation(text)).toBe(false);
  });

  it('does not mistake a real word for a typo of a continuation word', () => {
    // Distance 1 from "more" is a long list of ordinary words; only tokens long enough to
    // spell-check at all are fuzzed, and "mode"/"core" are shorter than that threshold.
    expect(isBareContinuation('mode')).toBe(false);
    expect(isBareContinuation('core')).toBe(false);
  });
});

describe('deriveObjectiveText — a nudge resolves to the request underneath it', () => {
  it('carries the previous request forward', () => {
    expect(
      deriveObjectiveText('contine', [
        user('can you use differnt caption style and emphasize the captions as well'),
        assistant('I read the timeline.'),
      ]),
    ).toBe('can you use differnt caption style and emphasize the captions as well');
  });

  it('skips earlier nudges to reach the real request', () => {
    expect(
      deriveObjectiveText('keep going', [
        user('remove the silence'),
        assistant('done'),
        user('continue'),
        assistant('still working'),
      ]),
    ).toBe('remove the silence');
  });

  it('never reads an assistant message as the objective', () => {
    expect(deriveObjectiveText('continue', [assistant('I could restyle the captions.')])).toBe(
      'continue',
    );
  });

  it('leaves a substantive request exactly as typed', () => {
    const prompt = 'continue but switch to the hormozi template';
    expect(deriveObjectiveText(prompt, [user('add captions')])).toBe(prompt);
  });

  it('falls back to the nudge when nothing resolvable precedes it', () => {
    // An empty objective is worse: the stage guards treat it as a broken run.
    expect(deriveObjectiveText('continue', [])).toBe('continue');
    expect(deriveObjectiveText('continue')).toBe('continue');
  });

  it('trims, so the recorded objective is not padded by the composer', () => {
    expect(deriveObjectiveText('  add captions  ')).toBe('add captions');
  });
});
