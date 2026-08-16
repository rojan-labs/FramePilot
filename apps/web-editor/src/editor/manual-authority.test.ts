import { describe, expect, it } from 'vitest';
import { demoProject } from './demo.js';
import { manualAuthorityAfterCommit } from './manual-authority.js';

describe('manual authoritative rebase synchronization', () => {
  it('does not parse or retain routine non-rebased commit Projects', () => {
    const result = manualAuthorityAfterCommit(demoProject.id, null, {
      ok: true,
      project: 'compact-path-does-not-need-parsing',
      revision: 2,
      rebased: false,
    });
    expect(result).toBeNull();
  });

  it('retains a rebased authoritative Project and refreshes it through later queued commits', () => {
    const rebasedProject = { ...demoProject, name: 'Concurrent authoritative edit' };
    const first = manualAuthorityAfterCommit(demoProject.id, null, {
      ok: true,
      project: rebasedProject,
      revision: 4,
      rebased: true,
      conflictKind: 'disjoint_rebaseable',
    });
    expect(first?.project.name).toBe('Concurrent authoritative edit');
    expect(first?.revision).toBe(4);

    const finalProject = { ...rebasedProject, name: 'Concurrent edit plus queued local patch' };
    const final = manualAuthorityAfterCommit(demoProject.id, first, {
      ok: true,
      project: finalProject,
      revision: 5,
      rebased: false,
    });
    expect(final?.project.name).toBe('Concurrent edit plus queued local patch');
    expect(final?.revision).toBe(5);
  });

  it('rejects a malformed or wrong-project authoritative response after a rebase', () => {
    expect(() =>
      manualAuthorityAfterCommit(demoProject.id, null, {
        ok: true,
        project: { ...demoProject, id: 'different-project' },
        revision: 3,
        rebased: true,
        conflictKind: 'disjoint_rebaseable',
      }),
    ).toThrow('invalid authoritative Project');
  });
});
