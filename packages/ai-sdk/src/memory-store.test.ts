/**
 * Tests for the project memory store (PRD §8.7) over `Project.aiMemory`.
 */
import { describe, expect, it } from 'vitest';
import { asId } from '@framepilot/shared-types';
import type { Patch } from '@framepilot/editor-core';
import {
  readMemory,
  recordAccepted,
  recordRejected,
  setExportPlatforms,
  setPreference,
  summarizeMemory,
  writeMemory,
} from './memory-store.js';
import { makeProject } from './__fixtures__/project.js';
import { estimateTokens } from './context-builder.js';

const patch = (id: string, reason: string): Patch => ({
  patchId: asId<'PatchId'>(id),
  createdBy: 'agent',
  reason,
  operations: [],
});

describe('memory store', () => {
  it('reads empty defaults from a fresh project', () => {
    const memory = readMemory(makeProject());
    expect(memory).toEqual({
      exportPlatforms: [],
      acceptedEdits: [],
      rejectedEdits: [],
      provenance: {},
    });
  });

  it('falls back to defaults when aiMemory is garbage (untrusted file)', () => {
    const project = makeProject({ aiMemory: { acceptedEdits: 'not-an-array' } });
    expect(readMemory(project).acceptedEdits).toEqual([]);
  });

  it('round-trips preferences and platforms', () => {
    let project = setPreference(makeProject(), 'captionStyle', 'bold yellow keywords');
    project = setPreference(project, 'preferredPacing', 'fast');
    project = setExportPlatforms(project, ['reels', 'x']);
    const memory = readMemory(project);
    expect(memory.captionStyle).toBe('bold yellow keywords');
    expect(memory.preferredPacing).toBe('fast');
    expect(memory.exportPlatforms).toEqual(['reels', 'x']);
  });

  it('records accepted and rejected edits as learning signals', () => {
    let project = recordAccepted(makeProject(), patch('p1', 'tighten intro'));
    project = recordRejected(project, patch('p2', 'aggressive zoom'));
    const memory = readMemory(project);
    expect(memory.acceptedEdits).toEqual([{ patchId: 'p1', reason: 'tighten intro' }]);
    expect(memory.rejectedEdits).toEqual([{ patchId: 'p2', reason: 'aggressive zoom' }]);
  });

  it('writeMemory replaces the whole record', () => {
    const project = writeMemory(makeProject(), {
      targetAudience: 'founders',
      brandStyle: 'clean SaaS',
      exportPlatforms: [],
      acceptedEdits: [],
      rejectedEdits: [],
    });
    expect(readMemory(project).targetAudience).toBe('founders');
  });

  it('summarizeMemory renders only the populated fields', () => {
    expect(summarizeMemory(readMemory(makeProject()))).toBe('');
    let project = setPreference(makeProject(), 'targetAudience', 'founders');
    project = setPreference(project, 'brandStyle', 'clean SaaS');
    project = setPreference(project, 'captionStyle', 'bold yellow');
    project = setPreference(project, 'preferredPacing', 'fast');
    project = setExportPlatforms(project, ['reels']);
    project = recordAccepted(project, patch('p1', 'tighten intro'));
    project = recordRejected(project, patch('p2', 'aggressive zoom'));
    const summary = summarizeMemory(readMemory(project));
    expect(summary).toContain('Target audience: founders');
    expect(summary).toContain('Brand style: clean SaaS');
    expect(summary).toContain('Caption style: bold yellow');
    expect(summary).toContain('Preferred pacing: fast');
    expect(summary).toContain('Export platforms: reels');
    expect(summary).toContain('rejected edits (avoid repeating): aggressive zoom');
    expect(summary).toContain('accepted edits: tighten intro');
  });
});

/**
 * The memory block is injected on EVERY request and persisted in `project.fp.json`, so an
 * uncapped list of reasons is a permanent, per-project, per-request tax that grows for the
 * life of the file. A `reason` is no longer a short label — `assemble.ts#assembleEdit` is
 * handed the model's full narration of the turn (~370 characters, four sentences).
 */
describe("summarizeMemory is bounded in the project's age (Workstream E)", () => {
  const NARRATION =
    'Tightened the opening of the interview by removing the filler and the dead air before ' +
    'the first line. The result keeps the hook inside the first two seconds, which is what ' +
    'the platform rewards. I left the second beat alone because it is already carrying the ' +
    'transition. Nothing downstream moved, so the caption cues still line up.';

  const withAccepted = (reasons: readonly string[]) =>
    reasons.reduce(
      (project, reason, i) => recordAccepted(project, patch(`p${i}`, reason)),
      makeProject(),
    );

  const line = (summary: string, prefix: string): string =>
    summary.split('\n').find((l) => l.startsWith(prefix)) ?? '';

  it('renders nothing for an empty list', () => {
    expect(summarizeMemory(readMemory(makeProject()))).toBe('');
  });

  it('renders a single short reason exactly as it always did', () => {
    // No qualifier, no truncation, no ellipsis: a project with a handful of remembered
    // decisions must read byte-identically to before the cap existed.
    const summary = summarizeMemory(readMemory(withAccepted(['tighten intro'])));
    expect(summary).toBe('Previously accepted edits: tighten intro');
  });

  it('keeps the first sentence of a narration and drops the justification after it', () => {
    // The taste signal is what the edit DID; the sentences after it are justification
    // addressed to a reader who is no longer present.
    const summary = summarizeMemory(readMemory(withAccepted([NARRATION])));
    expect(summary).toBe(
      'Previously accepted edits: Tightened the opening of the interview by removing the ' +
        'filler and the dead air before the first line.',
    );
    expect(summary).not.toContain('platform rewards');
  });

  it('keeps only the newest distinct reasons once past the cap, and says it did', () => {
    const reasons = Array.from(
      { length: 30 },
      (_, i) => `Cut beat ${i}. Because the pacing dragged.`,
    );
    const rendered = line(
      summarizeMemory(readMemory(withAccepted(reasons))),
      'Previously accepted',
    );
    expect(rendered).toContain('[newest 5 of 30]');
    // Newest, oldest-first, because a later decision supersedes an earlier one.
    expect(rendered).toContain('Cut beat 25.');
    expect(rendered).toContain('Cut beat 29.');
    expect(rendered).not.toContain('Cut beat 24.');
    expect(rendered.indexOf('Cut beat 25.')).toBeLessThan(rendered.indexOf('Cut beat 29.'));
  });

  it('gives rejections more room than acceptances — a rejection is an instruction', () => {
    let project = makeProject();
    for (let i = 0; i < 20; i += 1)
      project = recordRejected(project, patch(`r${i}`, `No zoom ${i}.`));
    const rendered = line(summarizeMemory(readMemory(project)), 'Previously rejected');
    expect(rendered).toContain('[newest 8 of 20]');
    expect(rendered).toContain('No zoom 12.');
    expect(rendered).not.toContain('No zoom 11.');
  });

  it('collapses a reason the project learned repeatedly into one signal', () => {
    // A preference stated five times is not five preferences.
    const rendered = line(
      summarizeMemory(
        readMemory(withAccepted(Array.from({ length: 9 }, () => 'Punchier cold open.'))),
      ),
      'Previously accepted',
    );
    expect(rendered).toBe('Previously accepted edits [newest 1 of 9]: Punchier cold open.');
  });

  it('cuts a reason with no clause boundary at a word, and marks the cut', () => {
    const runOn = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const rendered = line(
      summarizeMemory(readMemory(withAccepted([runOn]))),
      'Previously accepted',
    );
    const reason = rendered.slice('Previously accepted edits: '.length);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(121);
    expect(reason).not.toMatch(/word\d+[a-z]/);
  });

  it('drops an empty reason rather than rendering a blank entry', () => {
    const summary = summarizeMemory(readMemory(withAccepted(['   ', 'tighten intro'])));
    expect(summary).toBe('Previously accepted edits [newest 1 of 2]: tighten intro');
  });

  it('folds a multi-line reason onto one line', () => {
    // A newline would otherwise break the block's one-entry-per-line shape and misattribute
    // the tail to whatever the context builder printed next.
    const summary = summarizeMemory(readMemory(withAccepted(['Trimmed\nthe\nintro'])));
    expect(summary).toBe('Previously accepted edits: Trimmed the intro');
  });

  it('costs a bounded number of tokens however long the project lives (gated)', () => {
    // 40 narrated turns. Uncapped this block was 40 × ~93 tokens ≈ 3,700 tokens, on every
    // request, forever. Loosen this only with a measured accuracy reason.
    let project = makeProject();
    for (let i = 0; i < 40; i += 1) {
      project = recordAccepted(project, patch(`a${i}`, `Cut beat ${i}. ${NARRATION}`));
      project = recordRejected(project, patch(`r${i}`, `No zoom ${i}. ${NARRATION}`));
    }
    expect(estimateTokens(summarizeMemory(readMemory(project)))).toBeLessThanOrEqual(260);
  });
});

describe('memory provenance and TTL (UC-09)', () => {
  it('a contradicting instruction supersedes the earlier one rather than merging', () => {
    // Turn 2 states a caption style; turn 3 contradicts it. Turn 5 must read turn 3's,
    // and must not see turn 2's at all — a superseded decision is dropped, not offered
    // alongside its replacement for the model to pick between.
    let project = setPreference(makeProject(), 'captionStyle', 'bold yellow keywords', {
      source: 'user',
      turn: 2,
    });
    project = setPreference(project, 'captionStyle', 'small white subtitles', {
      source: 'user',
      turn: 3,
    });

    const atTurnFive = readMemory(project, 5);
    expect(atTurnFive.captionStyle).toBe('small white subtitles');
    expect(atTurnFive.provenance['captionStyle']).toEqual({ source: 'user', turn: 3 });
    expect(summarizeMemory(atTurnFive)).not.toContain('bold yellow');
  });

  it('a preference with no contradiction survives to a later turn', () => {
    const project = setPreference(makeProject(), 'captionStyle', 'bold yellow keywords', {
      source: 'user',
      turn: 2,
    });
    expect(readMemory(project, 5).captionStyle).toBe('bold yellow keywords');
  });

  it('an expiring preference is filtered out once its TTL has passed', () => {
    const project = setPreference(makeProject(), 'preferredPacing', 'fast', {
      source: 'inferred',
      turn: 2,
      expiresAfterTurns: 2,
    });

    expect(readMemory(project, 4).preferredPacing).toBe('fast');
    expect(readMemory(project, 5).preferredPacing).toBeUndefined();
    // Expiry is a read-side filter, so the file still holds it — reading without a
    // turn (a fresh session with no conversation clock) shows it again.
    expect(readMemory(project).preferredPacing).toBe('fast');
  });

  it('drops the expired entry\u2019s provenance with it', () => {
    const project = setPreference(makeProject(), 'brandStyle', 'muted', {
      source: 'reference',
      turn: 1,
      expiresAfterTurns: 1,
    });
    expect(readMemory(project, 9).provenance['brandStyle']).toBeUndefined();
  });

  it('a preference written before provenance existed never expires', () => {
    // The shape every project file on disk already has: values, no provenance.
    const project = makeProject({ aiMemory: { captionStyle: 'bold yellow keywords' } });
    expect(readMemory(project, 9_999).captionStyle).toBe('bold yellow keywords');
  });

  it('names a non-user source in the prompt block, and stays silent about the user', () => {
    let project = setPreference(makeProject(), 'captionStyle', 'bold yellow', {
      source: 'user',
      turn: 1,
    });
    project = setPreference(project, 'brandStyle', 'muted teal', {
      source: 'reference',
      turn: 1,
    });

    const block = summarizeMemory(readMemory(project, 1));
    expect(block).toContain('Caption style: bold yellow');
    expect(block).not.toContain('(user)');
    expect(block).toContain('Brand style: muted teal (reference)');
  });

  it('rewriting a preference without provenance clears the stale attribution', () => {
    // Otherwise the block would credit a reference for a value the reference never set.
    let project = setPreference(makeProject(), 'brandStyle', 'muted teal', {
      source: 'reference',
      turn: 1,
    });
    project = setPreference(project, 'brandStyle', 'high contrast');
    expect(readMemory(project).provenance['brandStyle']).toBeUndefined();
  });
});
