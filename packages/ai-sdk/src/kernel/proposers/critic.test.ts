/** Tests for the Critic / Verifier proposer (kernel/proposers/critic.ts, K3.3). */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../../__fixtures__/project.js';
import { critic, runCritic, buildJudgmentRequest, parseJudgment } from './critic.js';

describe('runCritic (deterministic promotion of critique)', () => {
  it('maps every critique check to a deterministic finding', () => {
    const report = runCritic({ project: makeProject() });
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.source === 'deterministic')).toBe(true);
    // Ids/severities mirror the underlying checks (e.g. missing_assets passes here).
    const missing = report.findings.find((f) => f.id === 'missing_assets');
    expect(missing?.severity).toBe('pass');
  });

  it('reports a failing verdict (ok=false) when a deterministic check fails', () => {
    // A clip referencing an unknown asset makes missing_assets fail.
    const project = makeProject({
      timeline: {
        tracks: [
          {
            id: 'v',
            type: 'video',
            clips: [
              {
                id: 'c',
                assetId: 'ghost',
                trackId: 'v',
                start: 0,
                end: 2,
                sourceStart: 0,
                sourceEnd: 2,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      } as ReturnType<typeof makeProject>['timeline'],
    });
    const report = runCritic({ project });
    expect(report.ok).toBe(false);
    expect(report.summary).toContain('failed');
  });

  it('threads critique options (goal/duration/render) through', () => {
    const report = runCritic({
      project: makeProject(),
      options: { durationTargetSeconds: 10, durationToleranceSeconds: 1 },
    });
    expect(report.findings.find((f) => f.id === 'duration_target')?.severity).toBe('pass');
  });
});

describe('critic proposer object', () => {
  it('routes to the small tier (small + deterministic, §6)', () => {
    expect(critic.tier).toBe('small');
    expect(critic.name).toBe('critic');
    expect(critic.run).toBe(runCritic);
  });
});

describe('optional LLM judgment seam', () => {
  it('builds an advisory judgment request from goal + summary', () => {
    const effect = buildJudgmentRequest({ goal: 'punchy hook', summary: '2 layers, 10s' });
    const user = effect.request.messages[1]?.content ?? '';
    expect(user).toContain('Goal: punchy hook');
    expect(user).toContain('Result: 2 layers, 10s');
  });

  it('parses judgment findings and tags them source=judgment with stable ids', () => {
    const raw = JSON.stringify({
      findings: [
        { label: 'Pacing', severity: 'warn', detail: 'feels uneven mid-clip' },
        { label: 'Hook', severity: 'pass', detail: 'strong open' },
      ],
    });
    const result = parseJudgment(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          id: 'judgment_1',
          label: 'Pacing',
          severity: 'warn',
          detail: 'feels uneven mid-clip',
          source: 'judgment',
        },
        {
          id: 'judgment_2',
          label: 'Hook',
          severity: 'pass',
          detail: 'strong open',
          source: 'judgment',
        },
      ]);
    }
  });

  it('rejects a malformed judgment reply', () => {
    expect(parseJudgment('{"findings":[{"label":"x"}]}').ok).toBe(false);
    expect(parseJudgment('not json').ok).toBe(false);
  });
});
