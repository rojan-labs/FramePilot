import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';

// The verifiers have their own suites (`verify.test.ts`); this one is about what the
// note says with a given verdict, so the verdict is supplied.
const verifyTransitions = vi.fn();
const verifyCaptions = vi.fn();
vi.mock('../verify.js', () => ({
  DEFAULT_CAPTION_TOLERANCE_SECONDS: 0.084,
  verifyTransitions: (...args: unknown[]) => verifyTransitions(...args),
  verifyCaptions: (...args: unknown[]) => verifyCaptions(...args),
}));

const { VERIFICATION_NOTE_MAX_ISSUES, verificationNote } = await import('./verification-note.js');

const project = { timeline: { tracks: [] } } as unknown as Project;

beforeEach(() => {
  verifyTransitions.mockReset();
  verifyCaptions.mockReset();
});

describe('verificationNote', () => {
  it('carries a passing transition check with its count', () => {
    verifyTransitions.mockReturnValue({
      ok: true,
      issues: [],
      transitionCount: 3,
      boundaryCount: 9,
    });
    expect(verificationNote('add_transition', project)).toBe(
      ' · verified: all good, 3 transition(s)',
    );
    expect(verifyTransitions).toHaveBeenCalledWith(project);
  });

  it('names the problems a failing check found, capped, with the rest counted', () => {
    const issues = Array.from({ length: VERIFICATION_NOTE_MAX_ISSUES + 2 }, (_, i) => ({
      code: 'transition_not_at_cut',
      detail: `problem ${String(i)}`,
    }));
    verifyTransitions.mockReturnValue({ ok: false, issues, transitionCount: 5, boundaryCount: 5 });
    expect(verificationNote('add_transitions', project)).toBe(
      ' · verified: 5 problems: problem 0; problem 1; problem 2; …and 2 more',
    );
  });

  it('checks captions after every caption tool, with the default tolerance', () => {
    verifyCaptions.mockReturnValue({
      ok: true,
      issues: [],
      cueCount: 21,
      speechCoverage: 1,
      revision: 4,
    });
    for (const tool of [
      'caption_the_edit',
      'add_caption_layer',
      'auto_emphasize_captions',
      'set_track_caption_style',
      'set_caption_style',
    ]) {
      expect(verificationNote(tool, project)).toBe(' · verified: in sync, 21 cue(s)');
    }
    expect(verifyCaptions).toHaveBeenCalledWith(project, 0.084);
  });

  it('says "1 problem" in the singular', () => {
    verifyCaptions.mockReturnValue({
      ok: false,
      issues: [{ code: 'caption_too_short', detail: 'cue at 4.2s lasts 3 frames' }],
      cueCount: 1,
      speechCoverage: 1,
      revision: 1,
    });
    expect(verificationNote('caption_the_edit', project)).toBe(
      ' · verified: 1 problem: cue at 4.2s lasts 3 frames',
    );
  });

  it('costs a log line, never the edit, when a verifier throws', () => {
    verifyCaptions.mockImplementation(() => {
      throw new Error('cue_1 has no source asset');
    });
    expect(verificationNote('caption_the_edit', project)).toBe('');
  });

  it('runs no verifier for a tool neither check is about', () => {
    expect(verificationNote('trim_clip', project)).toBe('');
    expect(verificationNote('apply_effect', project)).toBe('');
    expect(verifyTransitions).not.toHaveBeenCalled();
    expect(verifyCaptions).not.toHaveBeenCalled();
  });
});
