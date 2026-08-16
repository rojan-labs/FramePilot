import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import {
  compileAutonomousPatchProposal,
  MIN_AUTONOMOUS_PLAYBACK_SPEED,
  parseAutonomousPatchProposal,
} from './autonomous-patch-proposal.js';

describe('autonomous patch proposal', () => {
  it('compiles timeline calls through existing validated builders', () => {
    const compiled = compileAutonomousPatchProposal(makeProject(), {
      scope: 'timeline',
      reason: 'Tighten the opening',
      evidenceIds: ['evidence-1', 'evidence-1'],
      operations: [
        {
          tool: 'trim_clip',
          arguments: { clipId: 'clip_a', start: 0, end: 5 },
        },
      ],
    });

    expect(compiled.validation.valid).toBe(true);
    expect(compiled.patch.operations).toEqual([
      { type: 'trim_clip', clipId: 'clip_a', start: 0, end: 5 },
    ]);
    expect(compiled.scope).toBe('timeline');
    expect(compiled.evidenceIds).toEqual(['evidence-1']);
  });

  it('compiles project calls without exposing raw project operations', () => {
    const compiled = compileAutonomousPatchProposal(makeProject(), {
      scope: 'project',
      reason: 'Organize the media bin',
      evidenceIds: [],
      operations: [{ tool: 'manage_assets', arguments: { strategy: 'by-kind' } }],
    });

    expect(compiled.validation.valid).toBe(true);
    expect(compiled.patch.operations.map((operation) => operation.type)).toEqual([
      'create_folder',
      'move_asset',
    ]);
    expect(compiled.scope).toBe('project');
  });

  it('rejects project operations in the timeline proposal surface', () => {
    expect(() =>
      compileAutonomousPatchProposal(makeProject(), {
        scope: 'timeline',
        reason: 'Wrong surface',
        evidenceIds: [],
        operations: [{ tool: 'manage_assets', arguments: { strategy: 'by-kind' } }],
      }),
    ).toThrow('in a timeline proposal');
  });

  it('rejects timeline operations in the project proposal surface', () => {
    expect(() =>
      compileAutonomousPatchProposal(makeProject(), {
        scope: 'project',
        reason: 'Wrong surface',
        evidenceIds: [],
        operations: [
          {
            tool: 'trim_clip',
            arguments: { clipId: 'clip_a', start: 0, end: 5 },
          },
        ],
      }),
    ).toThrow('in a project proposal');
  });

  it('rejects read tools and malformed proposal envelopes', () => {
    expect(() =>
      compileAutonomousPatchProposal(makeProject(), {
        scope: 'timeline',
        reason: 'Do not treat reads as edits',
        evidenceIds: [],
        operations: [{ tool: 'get_timeline', arguments: {} }],
      }),
    ).toThrow('does not create edits');

    expect(() =>
      parseAutonomousPatchProposal({ scope: 'timeline', reason: '', operations: [] }),
    ).toThrow('reason must be a non-empty string');
  });

  describe('set_clip_playback_mode speed floor (DoS reopening)', () => {
    // set_clip_playback_mode is a virtual builder that emits set_clip_speed directly,
    // bypassing assertSafeAutonomousArguments (which only inspects calls literally named
    // "set_clip_speed"). A near-zero magnitude here divides the source span by almost
    // nothing and produces an enormous clip -- the exact hole MIN_AUTONOMOUS_PLAYBACK_SPEED
    // exists to close for the direct set_clip_speed tool.
    const call = (mode: string, speed?: number) => ({
      tool: 'set_clip_playback_mode',
      arguments: { clipId: 'clip_a', mode, ...(speed === undefined ? {} : { speed }) },
    });

    // A lone clip with room to grow, so slowing it down at the floor doesn't collide with
    // a neighbour and obscure the assertion under an unrelated overlap-validation failure.
    const soloClipProject = () =>
      makeProject({
        timeline: {
          tracks: [
            {
              id: 'video_1',
              type: 'video',
              clips: [
                {
                  id: 'clip_a',
                  assetId: 'asset_1',
                  trackId: 'video_1',
                  start: 0,
                  end: 6,
                  sourceStart: 0,
                  sourceEnd: 6,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
            { id: 'audio_1', type: 'audio', clips: [] },
          ],
        },
      });

    it('rejects a near-zero speed magnitude for mode "normal"', () => {
      expect(() =>
        compileAutonomousPatchProposal(makeProject(), {
          scope: 'timeline',
          reason: 'Slow way down',
          evidenceIds: [],
          operations: [call('normal', 0.0001)],
        }),
      ).toThrow(new RegExp(`speed magnitude must be >= ${String(MIN_AUTONOMOUS_PLAYBACK_SPEED)}x`));
    });

    it('rejects a near-zero speed magnitude for mode "reverse"', () => {
      expect(() =>
        compileAutonomousPatchProposal(makeProject(), {
          scope: 'timeline',
          reason: 'Slow reverse',
          evidenceIds: [],
          operations: [call('reverse', 0.0001)],
        }),
      ).toThrow(new RegExp(`speed magnitude must be >= ${String(MIN_AUTONOMOUS_PLAYBACK_SPEED)}x`));
    });

    it('accepts a speed magnitude at exactly the floor', () => {
      const compiled = compileAutonomousPatchProposal(soloClipProject(), {
        scope: 'timeline',
        reason: 'Slow down to the floor',
        evidenceIds: [],
        operations: [call('normal', MIN_AUTONOMOUS_PLAYBACK_SPEED)],
      });
      expect(compiled.validation.valid).toBe(true);
      expect(compiled.patch.operations).toEqual([
        { type: 'set_clip_speed', clipId: 'clip_a', speed: MIN_AUTONOMOUS_PLAYBACK_SPEED },
      ]);
    });

    it('does not floor mode "freeze", whose speed is always exactly 0', () => {
      const compiled = compileAutonomousPatchProposal(soloClipProject(), {
        scope: 'timeline',
        reason: 'Freeze frame',
        evidenceIds: [],
        // A caller could still (pointlessly) pass a tiny speed alongside freeze; it must
        // not throw, since freeze's resulting operation speed is unconditionally 0.
        operations: [call('freeze', 0.0001)],
      });
      expect(compiled.validation.valid).toBe(true);
      expect(compiled.patch.operations).toEqual([
        { type: 'set_clip_speed', clipId: 'clip_a', speed: 0 },
      ]);
    });
  });
});
