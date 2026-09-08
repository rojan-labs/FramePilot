import { describe, expect, it } from 'vitest';
import { makeProject } from '../__fixtures__/project.js';
import { DEFAULT_ASK_ANSWER, GOLDEN_CASES, REQUIRED_CATEGORIES, goldenCase } from './golden-cases.js';
import { scoreMissionScenario } from './mission-rubric.js';

describe('golden set shape', () => {
  it('has unique case ids', () => {
    const ids = GOLDEN_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every category goal.md Phase 0 names', () => {
    const covered = new Set(GOLDEN_CASES.map((c) => c.category));
    for (const category of REQUIRED_CATEGORIES) {
      expect(covered.has(category), `no golden case for category "${category}"`).toBe(true);
    }
  });

  it('every turn has a prompt, a rubric the scorer knows, and an intent', () => {
    const project = makeProject();
    for (const c of GOLDEN_CASES) {
      expect(c.turns.length, c.id).toBeGreaterThan(0);
      expect(c.why.length, c.id).toBeGreaterThan(10);
      for (const t of c.turns) {
        expect(t.prompt.trim().length, `${c.id}: empty prompt`).toBeGreaterThan(0);
        // A rubric id the scorer does not handle would return undefined from the switch.
        const score = scoreMissionScenario(t.rubric, { before: project, after: project });
        expect(score, `${c.id}: rubric "${t.rubric}" not scorable`).toBeDefined();
        expect(score.checks.length).toBeGreaterThan(0);
      }
    }
  });

  it('a turn that must ask, decline or answer is scored on the timeline staying unchanged', () => {
    for (const c of GOLDEN_CASES) {
      for (const t of c.turns) {
        if (t.intent === 'ask' || t.intent === 'decline' || t.intent === 'answer') {
          expect(t.rubric, `${c.id}: ${t.intent} turn must use the "unchanged" rubric`).toBe('unchanged');
        }
      }
    }
  });

  it('an unchanged timeline scores 1 on the unchanged rubric and 0 on an edit rubric', () => {
    const project = makeProject();
    expect(scoreMissionScenario('unchanged', { before: project, after: project }).score).toBe(1);
    expect(
      scoreMissionScenario('trim-first-clip', { before: project, after: project, expectedFirstClipEndSeconds: 10 })
        .score,
    ).toBeLessThan(1);
  });

  it('every VU0.3 edit case is scored on a collateral-changes check', () => {
    // The facet that has bitten this repo before: a grade or a transition pass that also
    // re-cut the programme. A picture case without it would score a run for the part of the
    // request it got right and say nothing about the damage.
    const project = makeProject();
    const pictureRubrics = [
      'match-color-to-reference',
      'warmer-subtle',
      'transitions-where-they-belong',
    ] as const;
    for (const rubric of pictureRubrics) {
      const score = scoreMissionScenario(rubric, { before: project, after: project });
      expect(
        score.checks.some((c) => c.id === 'no-collateral-changes'),
        `${rubric} has no collateral check`,
      ).toBe(true);
    }
  });

  it('the question cases change nothing and are answered, not refused', () => {
    const questions = GOLDEN_CASES.filter((c) => c.category === 'question');
    expect(questions.length).toBeGreaterThan(0);
    for (const c of questions) {
      for (const t of c.turns) {
        expect(t.intent, c.id).toBe('answer');
        expect(t.rubric, c.id).toBe('unchanged');
      }
      // Their correctness is an operator judgement against the VU0.2 labels; the case has
      // to SAY so, or a later reader will assume the harness checked the answer.
      expect(c.why.toLowerCase()).toContain('operator');
    }
  });

  it('looks a case up by id', () => {
    expect(goldenCase('guard-wipe-timeline')?.category).toBe('guard');
    expect(goldenCase('nope')).toBeUndefined();
  });

  it('the default operator answer stops the run without an edit', () => {
    expect(DEFAULT_ASK_ANSWER).toMatch(/no change/i);
  });
});
