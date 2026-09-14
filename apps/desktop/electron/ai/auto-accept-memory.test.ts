import { describe, expect, it } from 'vitest';
import { asId } from '@framepilot/shared-types';
import type { Patch } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { recordAutoAcceptedMemory } from './auto-accept-memory.js';

const project = (aiMemory: Record<string, unknown> = {}): Project =>
  parseProject({
    id: 'project_1',
    name: 'Test project',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [],
    timeline: { tracks: [] },
    transcript: [],
    aiMemory,
    history: [],
  });

const patch = (id: string, reason: string): Patch => ({
  patchId: asId<'PatchId'>(id),
  createdBy: 'agent',
  reason,
  operations: [],
});

describe('recordAutoAcceptedMemory', () => {
  // D10: this is the ONLY place desktop's durable auto-commit records anything into
  // `aiMemory.acceptedEdits` — the renderer's own `recordAccepted` call is unreachable on
  // desktop because `AiSidebar`'s auto-apply effect stands down whenever a desktop bridge
  // is present.
  it('records the patch as accepted, labelled auto_applied', () => {
    const committed = project();
    const next = recordAutoAcceptedMemory(committed, patch('p1', 'tighten intro'));
    expect(next.aiMemory).toMatchObject({
      acceptedEdits: [{ patchId: 'p1', reason: 'tighten intro', origin: 'auto_applied' }],
    });
  });

  it('never touches rejectedEdits', () => {
    const committed = project();
    const next = recordAutoAcceptedMemory(committed, patch('p1', 'tighten intro'));
    expect(next.aiMemory).toMatchObject({ rejectedEdits: [] });
  });

  it('appends to, rather than replaces, prior accepted edits', () => {
    let current = project();
    current = recordAutoAcceptedMemory(current, patch('p1', 'first cut'));
    current = recordAutoAcceptedMemory(current, patch('p2', 'second cut'));
    expect(current.aiMemory).toMatchObject({
      acceptedEdits: [
        { patchId: 'p1', reason: 'first cut', origin: 'auto_applied' },
        { patchId: 'p2', reason: 'second cut', origin: 'auto_applied' },
      ],
    });
  });

  it('is pure — it does not mutate the project it is handed', () => {
    const committed = project();
    recordAutoAcceptedMemory(committed, patch('p1', 'tighten intro'));
    expect(committed.aiMemory).toEqual({});
  });
});
