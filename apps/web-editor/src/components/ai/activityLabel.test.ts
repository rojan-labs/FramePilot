/**
 * The phrase the floating agent control shows for a streamed event.
 *
 * Covered directly rather than through the browser: the offline mock run emits its
 * tool events within a few hundred milliseconds of submit, so catching a specific
 * one from outside is a race, and what matters here is the mapping, not the timing.
 */
import { describe, expect, it } from 'vitest';
import type { AiEvent } from '@framepilot/ai-sdk';
import { activityLabelFor } from './AiSidebar.js';

const toolEvent = (toolName: string): AiEvent =>
  ({
    kind: 'tool',
    id: 't1',
    ts: 0,
    turnId: 'turn',
    toolName,
    status: 'running',
  }) as unknown as AiEvent;

describe('activityLabelFor', () => {
  it('names a tool with the SAME words the sidebar shows for it', () => {
    // Shared with `toolMeta` on purpose: the button and the panel must never
    // describe the same step differently.
    expect(activityLabelFor(toolEvent('delete_range'))).toBe('Delete range');
    expect(activityLabelFor(toolEvent('get_timeline'))).toBe('Read timeline');
  });

  it('humanises a tool it has no entry for, rather than showing a raw name', () => {
    expect(activityLabelFor(toolEvent('totally_unknown'))).toBe('Totally unknown');
  });

  it('returns null for events that are not a change of activity', () => {
    // The control renders these as a plain "Working" — a message delta is not a
    // new step, and re-announcing on every token would be noise.
    expect(
      activityLabelFor({
        kind: 'assistant_delta',
        id: 'a',
        ts: 0,
        turnId: 't',
      } as unknown as AiEvent),
    ).toBeNull();
    expect(
      activityLabelFor({ kind: 'status', id: 's', ts: 0, turnId: 't' } as unknown as AiEvent),
    ).toBeNull();
  });

  it('ignores a tool event with no usable name', () => {
    expect(
      activityLabelFor({ kind: 'tool', id: 'x', ts: 0, turnId: 't' } as unknown as AiEvent),
    ).toBeNull();
  });
});
