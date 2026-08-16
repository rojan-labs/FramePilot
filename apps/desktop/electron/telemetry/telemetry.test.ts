/**
 * Tests for local-first, opt-in telemetry (plan Phase 8).
 */
import { describe, expect, it } from 'vitest';
import { LocalTelemetry, describeCrash, telemetryEnabledFromEnv } from './telemetry.js';

describe('LocalTelemetry', () => {
  const collector = () => {
    const lines: string[] = [];
    return { lines, sink: (line: string) => lines.push(line) };
  };

  it('records nothing while disabled (opt-in)', () => {
    const { lines, sink } = collector();
    const t = new LocalTelemetry({ enabled: false, now: () => 1, sink });
    t.recordEvent('export_started');
    t.recordCrash(new Error('boom'));
    expect(lines).toEqual([]);
  });

  it('appends a serialized event with the injected timestamp when enabled', () => {
    const { lines, sink } = collector();
    const t = new LocalTelemetry({ enabled: true, now: () => 1234, sink });
    t.recordEvent('export_started', { preset: 'reels' });
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'event',
      name: 'export_started',
      at: 1234,
      data: { preset: 'reels' },
    });
  });

  it('records a crash with only name/message/stack', () => {
    const { lines, sink } = collector();
    const t = new LocalTelemetry({ enabled: true, now: () => 7, sink });
    const err = new Error('kaboom');
    t.recordCrash(err);
    const record = JSON.parse(lines[0]!);
    expect(record.type).toBe('crash');
    expect(record.data.errorName).toBe('Error');
    expect(record.data.message).toBe('kaboom');
    expect(typeof record.data.stack).toBe('string');
  });

  it('never throws when no sink is configured', () => {
    const t = new LocalTelemetry({ enabled: true, now: () => 0 });
    expect(() => t.recordEvent('x')).not.toThrow();
  });
});

describe('describeCrash', () => {
  it('reduces a non-Error to a NonError payload', () => {
    expect(describeCrash('plain string')).toEqual({
      errorName: 'NonError',
      message: 'plain string',
      stack: null,
    });
  });
});

describe('telemetryEnabledFromEnv', () => {
  it('is opt-in: only "1" or "true" enables it', () => {
    expect(telemetryEnabledFromEnv({ FRAMEPILOT_TELEMETRY: '1' })).toBe(true);
    expect(telemetryEnabledFromEnv({ FRAMEPILOT_TELEMETRY: 'true' })).toBe(true);
    expect(telemetryEnabledFromEnv({})).toBe(false);
    expect(telemetryEnabledFromEnv({ FRAMEPILOT_TELEMETRY: '0' })).toBe(false);
  });
});
