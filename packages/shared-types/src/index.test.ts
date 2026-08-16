/**
 * Tests for @framepilot/shared-types primitives.
 * Trivial type-level + runtime assertions to keep the suite green.
 * See plan/PLAN.md Phase 1.1.
 */
import { describe, expect, it } from 'vitest';
import { asId, err, ok, type ProjectId, type Result } from './index.js';

describe('shared-types', () => {
  it('ok() produces a successful Result', () => {
    const result: Result<number> = ok(42);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(42);
    }
  });

  it('err() produces a failed Result', () => {
    const result: Result<number, string> = err('boom');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('boom');
    }
  });

  it('asId() brands a string at the type level only', () => {
    const id: ProjectId = asId<'ProjectId'>('project_001');
    expect(id).toBe('project_001');
  });
});
