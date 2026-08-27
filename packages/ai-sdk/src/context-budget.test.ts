/**
 * Context-management P1.2 — the room the trimmer actually decides against.
 *
 * Two bugs, one fix. No production caller ever set `budget`, so every request in the app
 * trimmed against `DEFAULT_CONTEXT_BUDGET`'s 183,904 tokens whatever model was selected —
 * 159,328 more room than `ollama/qwen2.5-coder` has, and 799,136 less than Gemini's.
 * `contextWindowFor` already resolved the real window, but only for the manifest the UI
 * reads, never for the trimmer. And `assembleContext` cannot see the tool schemas the
 * caller attaches afterwards (~17,500 tokens on a planning turn), so "fits the budget"
 * was a statement about roughly a fifth of the prompt.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { assembleContext, budgetTokens, type ContextInput } from './context-builder.js';
import {
  AGENT_LOG_CLEAR_THRESHOLD_TOKENS,
  compactAgentLog,
  findingsBudgetTokens,
  resolveContextBudget,
} from './orchestrator.js';
import type { AiProvider } from './providers/types.js';
import { makeProject } from './__fixtures__/project.js';

/** A provider identity is all `capabilitiesFor` reads; the transport is irrelevant here. */
const at = (name: string, modelId: string): AiProvider =>
  ({ name, modelId }) as unknown as AiProvider;

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten this' };

/** A project big enough that the budgeter has something to drop. */
function wordyProject(words: number): Project {
  const transcript = Array.from({ length: words }, (_, i) => ({
    word: `word${i}`,
    start: i * 0.4,
    end: i * 0.4 + 0.35,
  }));
  return parseProject({ ...(makeProject() as unknown as Record<string, unknown>), transcript });
}

describe('resolveContextBudget', () => {
  it('reads the window and the reservation off the model actually selected', () => {
    const big = resolveContextBudget(input, at('anthropic', 'claude-opus-4-5'), 0);
    const small = resolveContextBudget(input, at('ollama', 'qwen2.5-coder'), 0);
    expect(big.contextWindow).toBeGreaterThan(small.contextWindow);
    // The bug in one line: these used to be the same number for every model.
    expect(budgetTokens(small)).toBeLessThan(budgetTokens(big));
  });

  it('never leaves the trimmer more room than the model has (the phase exit criterion)', () => {
    for (const [provider, modelId] of [
      ['anthropic', 'claude-opus-4-5'],
      ['openai', 'gpt-4o'],
      ['groq', 'llama-3.3-70b-versatile'],
      ['ollama', 'llama3.2'],
      ['ollama', 'qwen2.5-coder'],
      ['google', 'gemini-2.5-pro'],
      ['openrouter', 'a-model-nobody-has-heard-of'],
    ] as const) {
      const budget = resolveContextBudget(input, at(provider, modelId), 17_500);
      const realRoom = budget.contextWindow - budget.maxOutputTokens;
      expect(budgetTokens(budget)).toBeLessThanOrEqual(realRoom);
    }
  });

  it('falls back to the provider floor when no model is known, never to 190K', () => {
    const unknown = resolveContextBudget(input, undefined, 0);
    expect(unknown.contextWindow).toBeGreaterThan(0);
    expect(budgetTokens(unknown)).toBeLessThanOrEqual(
      unknown.contextWindow - unknown.maxOutputTokens,
    );
  });

  it('subtracts the prompt cost the assembler never sees', () => {
    const provider = at('anthropic', 'claude-opus-4-5');
    const withoutTools = budgetTokens(resolveContextBudget(input, provider, 0));
    const withTools = budgetTokens(resolveContextBudget(input, provider, 17_490));
    expect(withoutTools - withTools).toBe(17_490);
  });

  it('lets an explicitly supplied budget win, field by field', () => {
    const explicit = resolveContextBudget(
      { ...input, budget: { contextWindow: 8_000, maxOutputTokens: 1_000, headroom: 100 } },
      at('anthropic', 'claude-opus-4-5'),
      5_000,
    );
    expect(explicit.contextWindow).toBe(8_000);
    expect(explicit.maxOutputTokens).toBe(1_000);
    expect(explicit.headroom).toBe(100);
    // The caller constrained the window; it did not thereby claim the tool schemas are
    // free, so the route's real figure still applies.
    expect(explicit.reservedPromptTokens).toBe(5_000);
    expect(budgetTokens(explicit)).toBe(8_000 - 1_000 - 100 - 5_000);
  });

  it('honours an explicit reservation of zero rather than treating it as unset', () => {
    const budget = resolveContextBudget(
      {
        ...input,
        budget: {
          contextWindow: 8_000,
          maxOutputTokens: 1_000,
          headroom: 0,
          reservedPromptTokens: 0,
        },
      },
      at('anthropic', 'claude-opus-4-5'),
      17_490,
    );
    expect(budgetTokens(budget)).toBe(7_000);
  });

  it('floors at zero rather than going negative on a window smaller than its reservation', () => {
    const budget = resolveContextBudget(
      { ...input, budget: { contextWindow: 4_000, maxOutputTokens: 1_000, headroom: 100 } },
      undefined,
      99_000,
    );
    expect(budgetTokens(budget)).toBe(0);
  });
});

describe('assembleContext under a reservation', () => {
  it('trims for the cost it will actually pay, and reports which tier went', () => {
    // The failure this prevents: the assembled tiers "fit", the caller then attaches the
    // tool schemas, and the request overflows as a provider error rather than as a trim.
    const project = wordyProject(4_000);
    const base = { project, userPrompt: 'tighten this' } as const;
    const roomy = assembleContext({
      ...base,
      budget: { contextWindow: 8_000, maxOutputTokens: 1_000, headroom: 0 },
    });
    const squeezed = assembleContext({
      ...base,
      budget: {
        contextWindow: 8_000,
        maxOutputTokens: 1_000,
        headroom: 0,
        reservedPromptTokens: 6_000,
      },
    });
    expect(roomy.trimmed).not.toContain('transcript');
    expect(squeezed.trimmed).toContain('transcript');
    expect(squeezed.droppedTokenEstimate).toBeGreaterThan(0);
  });

  it('leaves behaviour unchanged when no reservation is given', () => {
    const project = wordyProject(4_000);
    const base = { project, userPrompt: 'tighten this' } as const;
    const budget = { contextWindow: 8_000, maxOutputTokens: 1_000, headroom: 0 } as const;
    const without = assembleContext({ ...base, budget });
    const withZero = assembleContext({ ...base, budget: { ...budget, reservedPromptTokens: 0 } });
    expect(withZero.messages).toEqual(without.messages);
    expect(withZero.trimmed).toEqual(without.trimmed);
  });
});

describe('findingsBudgetTokens (05 — the findings budget scales with real capacity)', () => {
  it('falls back to the floor when capacity cannot be measured', () => {
    // The repair pass and the legacy loop measure nothing; they must behave as before.
    expect(findingsBudgetTokens(undefined)).toBe(AGENT_LOG_CLEAR_THRESHOLD_TOKENS);
    expect(findingsBudgetTokens(Number.NaN)).toBe(AGENT_LOG_CLEAR_THRESHOLD_TOKENS);
    expect(findingsBudgetTokens(Number.POSITIVE_INFINITY)).toBe(AGENT_LOG_CLEAR_THRESHOLD_TOKENS);
  });

  it('never drops below the floor, however little room is left', () => {
    // A model with a small window keeps today's clearing behaviour by arithmetic.
    expect(findingsBudgetTokens(0)).toBe(AGENT_LOG_CLEAR_THRESHOLD_TOKENS);
    expect(findingsBudgetTokens(-50_000)).toBe(AGENT_LOG_CLEAR_THRESHOLD_TOKENS);
    expect(findingsBudgetTokens(1_000)).toBe(AGENT_LOG_CLEAR_THRESHOLD_TOKENS);
  });

  it('spends a share of measured capacity once there is real room', () => {
    // The captured run reported ~97,000 tokens of remaining capacity on every single call
    // while clearing its search payloads at 1,000. That is the whole defect.
    const budget = findingsBudgetTokens(97_000);
    expect(budget).toBeGreaterThan(AGENT_LOG_CLEAR_THRESHOLD_TOKENS * 10);
    expect(budget).toBeLessThanOrEqual(24_000);
  });

  it('is capped, so a huge window cannot bury the request in stale payloads', () => {
    expect(findingsBudgetTokens(1_000_000)).toBe(24_000);
  });

  it('grows monotonically with capacity', () => {
    const points = [0, 5_000, 20_000, 60_000, 97_000, 500_000].map(findingsBudgetTokens);
    expect(points).toEqual([...points].sort((a, b) => a - b));
  });
});

describe('compactAgentLog honours the budget it is given', () => {
  const bulky = (n: number): string[] =>
    Array.from(
      { length: n },
      (_, i) => `Searching stock for q${String(i)} → ${'x'.repeat(400)} [ev_${String(i)}]`,
    );

  it('clears payloads when the log exceeds the budget', () => {
    const out = compactAgentLog(bulky(20), 20, AGENT_LOG_CLEAR_THRESHOLD_TOKENS).join('\n');
    expect(out).toContain('old result cleared');
  });

  it('keeps every payload when the budget accommodates them', () => {
    // The behaviour change: the same log that used to be gutted at 1,000 tokens now rides
    // whole, so the run holds the remoteIds it needs instead of recalling for them.
    const log = bulky(20);
    const out = compactAgentLog(log, 20, findingsBudgetTokens(97_000));
    expect(out).toEqual(log);
    expect(out.join('\n')).not.toContain('old result cleared');
  });

  it('still applies the rolling window independently of the payload budget', () => {
    const out = compactAgentLog(bulky(20), 6, findingsBudgetTokens(97_000));
    expect(out).toHaveLength(7);
    expect(out[0]).toContain('earlier steps summarized');
  });
});
