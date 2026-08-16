/**
 * The untrusted model boundary for patch proposals.
 *
 * A proposal arrives as free-form JSON from a model and becomes real edits to the user's
 * timeline. Every rejection below is the boundary doing its job (PRD §18.2): the failure
 * mode of a missing check is not an exception, it is a malformed or out-of-scope edit
 * being applied to a real project.
 */
import { describe, expect, it } from 'vitest';
import {
  compileAutonomousPatchProposal,
  isProjectOperation,
  parseAutonomousPatchProposal,
} from './autonomous-patch-proposal.js';
import { makeProject } from './__fixtures__/project.js';
import type { AnyOperation } from '@framepilot/editor-core';

const project = makeProject();

const trim = (over: Record<string, unknown> = {}) => ({
  tool: 'trim_clip',
  arguments: { clipId: 'clip_a', start: 1, end: 5, ...over },
});

const proposal = (over: Record<string, unknown> = {}) => ({
  scope: 'timeline',
  reason: 'tighten the intro',
  operations: [trim()],
  ...over,
});

describe('parseAutonomousPatchProposal — the boundary rejections', () => {
  it.each([
    ['a non-object', 'nope', /must be an object/],
    ['an array', [], /must be an object/],
    ['null', null, /must be an object/],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseAutonomousPatchProposal(raw)).toThrow(message);
  });

  it.each([[undefined], ['timelime'], [''], [null]])('rejects scope %j', (scope) => {
    expect(() => parseAutonomousPatchProposal(proposal({ scope }))).toThrow(/scope must be/);
  });

  it.each([[undefined], [''], ['   '], [42]])('rejects reason %j', (reason) => {
    // The reason becomes the edit's description in the history panel — a blank one leaves
    // the user with an unexplained change they cannot recognise later.
    expect(() => parseAutonomousPatchProposal(proposal({ reason }))).toThrow(/reason must be/);
  });

  it.each([[undefined], [[]], ['nope']])('rejects operations %j', (operations) => {
    // An empty proposal must fail closed (ADR 0083) rather than reporting a successful
    // edit that changed nothing.
    expect(() => parseAutonomousPatchProposal(proposal({ operations }))).toThrow(
      /operations must be a non-empty array/,
    );
  });

  it('rejects an operation that is not an object', () => {
    expect(() => parseAutonomousPatchProposal(proposal({ operations: ['nope'] }))).toThrow(
      /operation 0 must be an object/,
    );
  });

  it.each([[undefined], [''], ['  '], [7]])('rejects an operation tool name of %j', (tool) => {
    expect(() =>
      parseAutonomousPatchProposal(proposal({ operations: [{ tool, arguments: {} }] })),
    ).toThrow(/needs a tool name/);
  });

  it.each([[undefined], ['nope'], [[]]])('rejects operation arguments of %j', (args) => {
    expect(() =>
      parseAutonomousPatchProposal(
        proposal({ operations: [{ tool: 'trim_clip', arguments: args }] }),
      ),
    ).toThrow(/arguments must be an object/);
  });

  it('names the INDEX of the offending operation, not just that one was bad', () => {
    expect(() => parseAutonomousPatchProposal(proposal({ operations: [trim(), 'nope'] }))).toThrow(
      /operation 1/,
    );
  });

  it.each([['nope'], [[1, 2]], [['ok', 3]]])('rejects evidenceIds %j', (evidenceIds) => {
    expect(() => parseAutonomousPatchProposal(proposal({ evidenceIds }))).toThrow(
      /evidenceIds must be an array of strings/,
    );
  });

  it('accepts a proposal with no evidenceIds, defaulting to an empty list', () => {
    expect(parseAutonomousPatchProposal(proposal()).evidenceIds).toEqual([]);
  });

  it('de-duplicates evidenceIds while preserving order', () => {
    expect(
      parseAutonomousPatchProposal(proposal({ evidenceIds: ['a', 'b', 'a'] })).evidenceIds,
    ).toEqual(['a', 'b']);
  });

  it('trims the reason', () => {
    expect(parseAutonomousPatchProposal(proposal({ reason: '  tighten  ' })).reason).toBe(
      'tighten',
    );
  });
});

describe('isProjectOperation', () => {
  it('separates project-scoped operations from timeline ones', () => {
    expect(isProjectOperation({ type: 'add_asset' } as unknown as AnyOperation)).toBe(true);
    expect(isProjectOperation({ type: 'trim_clip' } as unknown as AnyOperation)).toBe(false);
  });
});

describe('compileAutonomousPatchProposal — the builder gate', () => {
  it('compiles a valid timeline proposal into a reversible edit', () => {
    const compiled = compileAutonomousPatchProposal(project, proposal());
    expect(compiled.scope).toBe('timeline');
    expect(compiled.patch.operations.length).toBeGreaterThan(0);
  });

  it('rejects an unknown internal builder', () => {
    expect(() =>
      compileAutonomousPatchProposal(
        project,
        proposal({ operations: [{ tool: 'no_such_tool', arguments: {} }] }),
      ),
    ).toThrow(/Unknown internal operation builder/);
  });

  it('rejects an unavailable builder rather than faking the edit', () => {
    expect(() =>
      compileAutonomousPatchProposal(
        project,
        proposal({ operations: [{ tool: 'generate_mask', arguments: {} }] }),
      ),
    ).toThrow(/is unavailable/);
  });

  it('rejects a non-mutating tool — a read cannot be part of a patch', () => {
    expect(() =>
      compileAutonomousPatchProposal(
        project,
        proposal({ operations: [{ tool: 'get_timeline', arguments: {} }] }),
      ),
    ).toThrow(/does not create edits/);
  });

  it('SCOPE: refuses a project operation inside a timeline proposal', () => {
    // Scope separation is what keeps a "tighten the intro" proposal from quietly
    // rewriting project-level state the user never put in scope.
    expect(() =>
      compileAutonomousPatchProposal(
        project,
        proposal({
          operations: [{ tool: 'add_asset', arguments: { path: 'media/b.mp4', kind: 'video' } }],
        }),
      ),
    ).toThrow(/produced project operation/);
  });

  it('SCOPE: refuses a timeline operation inside a project proposal', () => {
    expect(() => compileAutonomousPatchProposal(project, proposal({ scope: 'project' }))).toThrow(
      /produced timeline operation/,
    );
  });

  it('carries the proposal’s evidence and calls onto the compiled result', () => {
    const compiled = compileAutonomousPatchProposal(project, proposal({ evidenceIds: ['ev1'] }));
    expect(compiled.evidenceIds).toEqual(['ev1']);
    expect(compiled.calls).toHaveLength(1);
  });
});
