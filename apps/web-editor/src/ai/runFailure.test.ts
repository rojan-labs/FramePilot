import { describe, expect, it } from 'vitest';
import { explainRunFailure } from './runFailure.js';

describe('explainRunFailure (P8.2 "failed")', () => {
  it('names the action for a rejected key and keeps the provider text as evidence', () => {
    const result = explainRunFailure(
      'AI request failed: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    );
    expect(result.text).toContain('Settings → AI');
    expect(result.detail).toContain('authentication_error');
  });

  it('tells the user to wait on a rate limit rather than showing the 429 body', () => {
    const result = explainRunFailure('429 Too Many Requests — rate_limit_error');
    expect(result.text).toContain('Wait a moment');
    expect(result.text).not.toContain('429');
    expect(result.detail).toContain('429');
  });

  it('recognises a run that hit its time limit', () => {
    expect(explainRunFailure('Run timed out after 900000ms').text).toContain('time limit');
  });

  it('recognises an unreachable provider', () => {
    expect(explainRunFailure('fetch failed: ECONNREFUSED 127.0.0.1:8317').text).toContain(
      'could not reach',
    );
  });

  it('recognises a media-engine failure', () => {
    expect(explainRunFailure('sidecar exited with code 1').text).toContain('media engine');
  });

  // The important general rule: an unrecognised failure keeps its own words. A
  // guessed-at friendly phrase would trade a true technical sentence for a vague
  // false one.
  it('leaves a short unrecognised message exactly as it is, with nothing behind the fold', () => {
    const result = explainRunFailure('Track not found: ghost');
    expect(result).toEqual({ text: 'Track not found: ghost' });
  });

  it('folds a multi-line failure to its first line and keeps the whole text as detail', () => {
    const result = explainRunFailure(
      'Patch rejected\n  op: delete_range\n  cause: Track not found',
    );
    expect(result.text).toBe('Patch rejected');
    expect(result.detail).toContain('delete_range');
  });

  it('truncates a single very long line rather than filling the panel with it', () => {
    const long = `Model returned an unusable response ${'x'.repeat(400)}`;
    const result = explainRunFailure(long);
    expect(result.text.length).toBeLessThanOrEqual(141);
    expect(result.text.endsWith('…')).toBe(true);
    expect(result.detail).toBe(long);
  });

  it('has something to say when the throw carried no message at all', () => {
    expect(explainRunFailure('   ').text).toContain('without saying why');
  });
});
