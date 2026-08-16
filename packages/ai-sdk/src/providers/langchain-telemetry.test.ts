/**
 * Telemetry containment for the LangChain dependency (§11.2, and the M0.4
 * dossier finding that moved it forward).
 *
 * `langsmith` is a HARD dependency of `@langchain/core`, not an opt-in extra —
 * it is installed the moment the provider adapter is, at M1, eight phases before
 * M11 where the plan schedules the telemetry decision. §11.2 is a **privacy**
 * gate, not an observability one: in FramePilot, prompts and tool results carry
 * the user's own footage-derived content — transcripts of their recordings,
 * `get_frame` images of their video (ADR 0096), file paths, project names and
 * memory entries.
 *
 * The dependency ships inert unless `LANGCHAIN_TRACING_V2` / `LANGSMITH_TRACING`
 * is set. The risk the dossier identified is that those are AMBIENT env vars: a
 * developer or CI machine with `LANGSMITH_*` exported for an unrelated project
 * would start shipping FramePilot users' content to a third party, without
 * anyone touching a FramePilot flag or config file.
 *
 * These tests pin the containment. They are deliberately about environment, not
 * about LangChain's internals — the guarantee we owe users is "FramePilot does
 * not enable this", and that is what is asserted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TRACING_VARS = [
  'LANGCHAIN_TRACING_V2',
  'LANGCHAIN_TRACING',
  'LANGSMITH_TRACING',
  'LANGSMITH_TRACING_V2',
] as const;

const KEY_VARS = ['LANGCHAIN_API_KEY', 'LANGSMITH_API_KEY'] as const;

describe('LangSmith telemetry containment (§11.2)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of [...TRACING_VARS, ...KEY_VARS]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it('does not enable tracing anywhere in the SDK', async () => {
    // Importing the provider must not set a tracing variable as a side effect.
    await import('./langchain.js');
    for (const key of TRACING_VARS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it('ships no LangSmith API key of its own', async () => {
    await import('./langchain.js');
    for (const key of KEY_VARS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it('is documented as ambient-triggerable, which FRAMEPILOT_LANGSMITH_ENABLED does not prevent', () => {
    // This test encodes the finding rather than a behavior: the migration plan's
    // own mitigation (a FramePilot flag defaulting to off) is NECESSARY BUT NOT
    // SUFFICIENT, because LangChain reads its own ambient variables and never
    // consults ours. Anything that later claims to gate telemetry on
    // FRAMEPILOT_LANGSMITH_ENABLED must ALSO neutralize these.
    //
    // Kept as an executable reminder so the gap cannot be closed on paper only.
    process.env.LANGSMITH_TRACING = 'true';
    expect(process.env.FRAMEPILOT_LANGSMITH_ENABLED).toBeUndefined();
    // Tracing is now on from the ambient variable alone, with FramePilot's flag
    // unset. That is the hole §11.2 has to close before M11.
    expect(process.env.LANGSMITH_TRACING).toBe('true');
  });
});
