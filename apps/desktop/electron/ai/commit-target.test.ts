import { describe, expect, it } from 'vitest';
import { decideCommitTarget } from './commit-target.js';

const pointer = (projectId: string, path = '/Projects/a.fp.json') => ({
  projectId,
  path,
  updatedAt: 1,
});

describe('decideCommitTarget', () => {
  it('allows the run and names the write path when the project is the open one', () => {
    const decision = decideCommitTarget(pointer('p1', '/Projects/reel.fp.json'), 'p1');
    expect(decision).toEqual({ ok: true, path: '/Projects/reel.fp.json' });
  });

  // The captured failure: a run started against a project the GUI was not on. Every edit it
  // proposed was doomed before its first token, and nothing said so until commit time.
  it('refuses when a different project is open, and says which way out', () => {
    const decision = decideCommitTarget(pointer('other'), 'p1');
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('different_project_active');
    expect(decision.reason).toContain('Reopen that project');
  });

  // A corrupt or missing pointer reads as `null` (see ActiveProjectStore.current). That is a
  // DIFFERENT remedy from "the wrong project is open", which is why the codes are separate.
  it('refuses with its own code when no project is open at all', () => {
    const decision = decideCommitTarget(null, 'p1');
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('no_project_open');
    expect(decision.reason).toContain('No project is open');
  });

  // Both refusals must carry prose the UI can show verbatim: the generic "the timeline
  // changed since this was worked out" line is wrong for both and sends the user into a
  // retry that cannot succeed.
  it('never returns an empty reason', () => {
    for (const active of [null, pointer('other')]) {
      const decision = decideCommitTarget(active, 'p1');
      if (decision.ok) throw new Error('unreachable');
      expect(decision.reason.length).toBeGreaterThan(20);
    }
  });
});
