import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { ToolSpec } from './tool-registry.js';
import {
  operationsForCall,
  sanitizeToolArgs,
  ToolInvocationError,
} from './tool-dispatch.js';

const ctx = { project: {} as Project };

const stubTool = {
  parameters: {
    type: 'object',
    properties: { durationSeconds: { type: 'number' } },
    additionalProperties: false,
  },
} as ToolSpec;

describe('strict tool intent boundary', () => {
  it('preserves unknown arguments so the registered strict schema can reject them', () => {
    const raw = { durationSeconds: 1, durationSecond: 99 };
    expect(sanitizeToolArgs(stubTool, raw)).toBe(raw);
  });

  it('rejects an unknown top-level argument instead of deleting it', () => {
    expect(() =>
      operationsForCall(
        {
          id: 'strict-extra',
          name: 'adjust_audio',
          arguments: { clipId: 'clip-1', gainDb: -3, projectId: 'invented' },
        },
        ctx,
      ),
    ).toThrow(ToolInvocationError);
  });

  it('rejects an inverted punch-in window instead of silently replacing the end time', () => {
    expect(() =>
      operationsForCall(
        {
          id: 'bad-punch',
          name: 'punch_in',
          arguments: { clipId: 'clip-1', startTime: 2, endTime: 1 },
        },
        ctx,
      ),
    ).toThrow(/endTime \(1\) must be greater than startTime \(2\)/);
  });

  it('rejects an explicit empty manage-assets plan instead of switching to by-kind', () => {
    expect(() =>
      operationsForCall(
        {
          id: 'empty-plan',
          name: 'manage_assets',
          arguments: { strategy: 'plan', folders: [], assignments: [] },
        },
        ctx,
      ),
    ).toThrow(/requires at least one folder or assignment/);
  });
});
