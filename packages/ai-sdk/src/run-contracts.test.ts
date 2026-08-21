/**
 * Tests for the durable orchestration protocol v1 schemas (run-contracts.ts) — the
 * trust boundary every persisted command/event/snapshot is parsed through before use.
 */
import { describe, expect, it } from 'vitest';
import {
  DURABLE_RUN_MODES,
  JsonValueSchema,
  RUN_PROTOCOL_SCHEMA_VERSION,
  RunCommandEnvelopeSchema,
  RunEventEnvelopeSchema,
  RunSnapshotSchema,
  parseRunCommand,
  parseRunEvent,
  parseRunSnapshot,
} from './run-contracts.js';

const base = {
  schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
  commandId: 'cmd_1',
  runId: 'run_1',
  projectId: 'proj_1',
  issuedAt: 1_700_000_000_000,
};

describe('JsonValueSchema', () => {
  it('accepts every JSON primitive, arrays, and nested objects', () => {
    for (const value of [null, true, false, 0, 1.5, 'text', [1, 'a', null], { a: { b: [1] } }]) {
      expect(JsonValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects a value with no JSON representation', () => {
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(JsonValueSchema.safeParse(() => {}).success).toBe(false);
  });
});

describe('parseRunCommand', () => {
  it('parses a valid start command with defaults applied', () => {
    const cmd = parseRunCommand({
      ...base,
      kind: 'start',
      payload: { userPrompt: 'trim the intro', mode: 'agent' },
    });
    expect(cmd.kind).toBe('start');
    if (cmd.kind === 'start') {
      expect(cmd.payload.contextHandles).toEqual([]);
      expect(cmd.payload.patchPolicy).toBe('review');
    }
  });

  it('still parses a pre-ADR-0126 planned-edit start command, normalized to agent', () => {
    // Persisted `start` commands are re-parsed from the durable event log during recovery
    // (`run-coordinator-base.ts#commandFromEvent`). A run that was in flight when the user
    // upgraded past the `planned_edit` retirement must still replay, so the retired mode is
    // accepted on READ and mapped to the runtime that absorbed it — never rejected, which
    // would make that run unrecoverable, and never left as-is, which would name a route
    // that no longer exists.
    const command = parseRunCommand({
      ...base,
      kind: 'start',
      payload: { userPrompt: 'continue the edit', mode: 'planned-edit' },
    });
    expect(command).toMatchObject({ kind: 'start', payload: { mode: 'agent' } });
  });

  it('rejects a start command naming a mode that never existed', () => {
    expect(() =>
      parseRunCommand({
        ...base,
        kind: 'start',
        payload: { userPrompt: 'go', mode: 'teleport' },
      }),
    ).toThrow();
  });

  it.each(DURABLE_RUN_MODES)('accepts the live %s run mode unchanged', (mode) => {
    expect(
      parseRunCommand({ ...base, kind: 'start', payload: { userPrompt: 'go', mode } }),
    ).toMatchObject({ kind: 'start', payload: { mode } });
  });

  it.each([
    ['approve_plan', { planId: 'plan_1' }],
    ['reject_plan', { planId: 'plan_1', reason: 'not this' }],
    ['answer', { toolCallId: 'call_1', answer: 'yes' }],
    ['steer', { message: 'go faster' }],
    ['cancel', { source: 'user_stop', reason: 'Stopped by the editor.' }],
    ['cancel', { source: 'question_dismissed', reason: 'Question dismissed by the editor.' }],
    ['resume', {}],
    ['resume', { fromSequence: 3 }],
    ['accept_patch', { patchId: 'patch_1' }],
    ['reject_patch', { patchId: 'patch_1', reason: 'wrong clip' }],
  ] as const)('parses a valid %s command', (kind, payload) => {
    const cmd = parseRunCommand({ ...base, kind, payload });
    expect(cmd.kind).toBe(kind);
  });

  it('rejects an unknown command kind', () => {
    expect(() => parseRunCommand({ ...base, kind: 'teleport', payload: {} })).toThrow();
  });

  it('rejects cancellation without a traceable authorized source and reason', () => {
    expect(() => parseRunCommand({ ...base, kind: 'cancel', payload: {} })).toThrow();
    expect(() =>
      parseRunCommand({
        ...base,
        kind: 'cancel',
        payload: { source: 'component_cleanup', reason: 'unmounted' },
      }),
    ).toThrow();
  });

  it('rejects a payload with an extra field (strict)', () => {
    expect(() =>
      parseRunCommand({
        ...base,
        kind: 'steer',
        payload: { message: 'go faster', bogus: true },
      }),
    ).toThrow();
  });

  it('rejects a start payload missing a required field', () => {
    expect(() => parseRunCommand({ ...base, kind: 'start', payload: { mode: 'agent' } })).toThrow();
  });

  it('rejects a command whose schemaVersion does not match the protocol', () => {
    expect(() =>
      parseRunCommand({ ...base, schemaVersion: 2, kind: 'steer', payload: { message: 'hi' } }),
    ).toThrow();
  });

  it('RunCommandEnvelopeSchema.safeParse mirrors parseRunCommand', () => {
    const result = RunCommandEnvelopeSchema.safeParse({
      ...base,
      kind: 'answer',
      payload: { toolCallId: 'call_1', answer: 'ok' },
    });
    expect(result.success).toBe(true);
  });
});

describe('parseRunEvent', () => {
  const event = {
    schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
    eventId: 'evt_1',
    runId: 'run_1',
    projectId: 'proj_1',
    sequence: 0,
    occurredAt: 1_700_000_000_000,
    kind: 'status',
    payload: { status: 'thinking' },
  };

  it('parses a valid event', () => {
    expect(parseRunEvent(event).kind).toBe('status');
  });

  it('parses a valid event with optional causation/revision fields', () => {
    const parsed = parseRunEvent({
      ...event,
      causedByCommandId: 'cmd_1',
      causedByEffectId: 'eff_1',
      projectRevision: 4,
    });
    expect(parsed.causedByCommandId).toBe('cmd_1');
  });

  it('rejects an event missing a required field', () => {
    const { sequence: _sequence, ...withoutSequence } = event;
    expect(() => parseRunEvent(withoutSequence)).toThrow();
  });

  it('RunEventEnvelopeSchema.safeParse rejects extra fields (strict)', () => {
    expect(RunEventEnvelopeSchema.safeParse({ ...event, bogus: true }).success).toBe(false);
  });
});

describe('parseRunSnapshot', () => {
  const snapshot = {
    schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
    runId: 'run_1',
    projectId: 'proj_1',
    status: 'thinking' as const,
    baseProjectRevision: 1,
    currentProjectRevision: 1,
    lastSequence: 0,
    graphVersion: 1,
    tasks: [],
    effects: [],
    patchDecisions: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  it('parses a valid non-terminal snapshot with defaults applied', () => {
    const parsed = parseRunSnapshot(snapshot);
    expect(parsed.budgets).toEqual({});
    expect(parsed.contextHandles).toEqual([]);
    expect(parsed.patchPolicy).toBe('review');
  });

  it('parses a valid terminal snapshot carrying an outcome', () => {
    const parsed = parseRunSnapshot({
      ...snapshot,
      status: 'completed',
      outcome: { kind: 'completed_with_changes', changed: true },
    });
    expect(parsed.outcome?.kind).toBe('completed_with_changes');
    expect(parsed.outcome?.warnings).toEqual([]);
  });

  it('keeps interruption and timeout distinct from user cancellation', () => {
    for (const [kind, source] of [
      ['interrupted', 'process_restart'],
      ['timed_out', 'timeout'],
    ] as const) {
      const parsed = parseRunSnapshot({
        ...snapshot,
        status: 'failed',
        outcome: { kind, source, reason: `${kind} reason`, changed: false },
      });
      expect(parsed.outcome).toMatchObject({ kind, source });
    }
  });

  it('rejects a terminal snapshot with no outcome', () => {
    const result = RunSnapshotSchema.safeParse({ ...snapshot, status: 'completed' });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues[0]!.path).toEqual(['outcome']);
  });

  it('rejects a non-terminal snapshot that carries an outcome', () => {
    const result = RunSnapshotSchema.safeParse({
      ...snapshot,
      outcome: { kind: 'cancelled', changed: false },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a current revision that precedes the base revision', () => {
    const result = RunSnapshotSchema.safeParse({
      ...snapshot,
      baseProjectRevision: 5,
      currentProjectRevision: 2,
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues[0]!.path).toEqual(['currentProjectRevision']);
  });

  it('parses tasks, effects, and pending-gate sub-snapshots', () => {
    const parsed = parseRunSnapshot({
      ...snapshot,
      tasks: [{ taskId: 't1', state: 'running', attempt: 0 }],
      effects: [
        {
          effectId: 'e1',
          taskId: 't1',
          kind: 'host_tool',
          state: 'running',
          attempt: 0,
          idempotencyKey: 'k1',
        },
      ],
      patchDecisions: [{ patchId: 'p1', state: 'pending' }],
      pendingGate: {
        gateId: 'g1',
        kind: 'plan_approval',
        requestedAt: 1_700_000_000_000,
        payload: { plan: 'x' },
      },
    });
    expect(parsed.tasks[0]!.taskId).toBe('t1');
    expect(parsed.pendingGate?.kind).toBe('plan_approval');
  });

  it('loads a legacy snapshot whose idempotency key breached the 256-character cap', () => {
    // The exact startup failure this guards: a run persisted before producers were
    // bounded carried `effects.6.idempotencyKey` over the cap, so the snapshot could
    // not parse — and a snapshot that cannot parse cannot be CLOSED either, so
    // reconciliation skipped the run and it failed again on every launch, forever.
    const oversized = `host_tool:add_clip:${JSON.stringify(
      Array.from({ length: 30 }, (_, index) => ({ start: index, end: index + 1 })),
    )}`;
    expect(oversized.length).toBeGreaterThan(256);

    const parsed = parseRunSnapshot({
      ...snapshot,
      effects: [
        {
          effectId: 'e1',
          taskId: 't1',
          kind: 'host_tool',
          state: 'running',
          attempt: 0,
          idempotencyKey: oversized,
        },
      ],
    });
    const key = parsed.effects[0]!.idempotencyKey;
    expect(key.length).toBeLessThanOrEqual(256);
    // Identity survives, and the bounding is idempotent: re-parsing a snapshot must
    // not keep re-truncating the key, or its identity would change on every read.
    expect(
      parseRunSnapshot({ ...snapshot, effects: [{ ...parsed.effects[0]! }] }).effects[0]!
        .idempotencyKey,
    ).toBe(key);
    const different = parseRunSnapshot({
      ...snapshot,
      effects: [
        {
          effectId: 'e1',
          taskId: 't1',
          kind: 'host_tool',
          state: 'running',
          attempt: 0,
          idempotencyKey: `${oversized}x`,
        },
      ],
    }).effects[0]!.idempotencyKey;
    expect(different).not.toBe(key);
  });

  it('accepts a budget within its limit and rejects one that exceeds it', () => {
    const ok = parseRunSnapshot({
      ...snapshot,
      budgets: { tokens: { limit: 100, consumed: 50, unit: 'tokens' } },
    });
    expect(ok.budgets.tokens?.consumed).toBe(50);

    const result = RunSnapshotSchema.safeParse({
      ...snapshot,
      budgets: { tokens: { limit: 100, consumed: 150, unit: 'tokens' } },
    });
    expect(result.success).toBe(false);
  });
});
