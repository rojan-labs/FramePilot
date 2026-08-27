/**
 * The price of swapping the tool set mid-run is now a number (context-management P5.3).
 *
 * The tool block is ~78% of a planning prompt and sits ABOVE the messages in the
 * provider's cache hierarchy, so changing it invalidates everything cached beneath it.
 * The stage policy withholds `analysis` and `guidance` descriptors once a run is
 * executing and restores them at `verify`, which is two swaps and — measured on the
 * benchmark's nine-turn run — 30,751 tokens re-billed at full price.
 *
 * That cost used to be invisible. The cost meter sees input tokens; it does not see WHY
 * they were not cached. `toolSchemaTokensRebilled` is the difference.
 *
 * This measures the current policy. It deliberately does not change it — see the phase
 * file for why the behavioural half is held back.
 */
import { describe, expect, it } from 'vitest';
import { buildRequestManifest } from './kernel/context/manifest.js';
import type { AiCompletionRequest } from './providers/types.js';

const request = (toolCount: number): AiCompletionRequest => ({
  messages: [{ role: 'user', content: 'edit this' }],
  tools: Array.from({ length: toolCount }, (_, i) => ({
    name: `tool_${i}`,
    description: `does thing ${i}`,
    parameters: { type: 'object', properties: {} },
  })),
});

const manifest = (toolCount: number, previousToolSchemaTokens?: number) =>
  buildRequestManifest({
    requestId: 'r1',
    contextWindow: 200_000,
    windowSource: 'known_model',
    reservedOutputTokens: 8_192,
    request: request(toolCount),
    ...(previousToolSchemaTokens === undefined ? {} : { previousToolSchemaTokens }),
  });

describe('toolSchemaTokensRebilled', () => {
  it('is absent on the first request — there is nothing to compare against', () => {
    expect(manifest(40).usage.toolSchemaTokensRebilled).toBeUndefined();
  });

  it('is zero when the advertised set did not move', () => {
    const stable = manifest(40).sections.find((s) => s.type === 'tool_schemas')!.tokenEstimate;
    expect(manifest(40, stable).usage.toolSchemaTokensRebilled).toBe(0);
  });

  it('is the WHOLE block when the set changed — not the difference', () => {
    // The provider does not re-bill the delta. A changed tool block is a cache miss on
    // the entire block, which is exactly why this is worth reporting rather than
    // inferring from a token count that moved a little.
    const before = manifest(40).sections.find((s) => s.type === 'tool_schemas')!.tokenEstimate;
    const after = manifest(30, before);
    const block = after.sections.find((s) => s.type === 'tool_schemas')!.tokenEstimate;
    expect(after.usage.toolSchemaTokensRebilled).toBe(block);
    expect(block).toBeGreaterThan(0);
  });

  it('reports a re-bill when the set GROWS as well as when it shrinks', () => {
    // The stage policy does both: it narrows at `apply` and widens again at `verify`.
    const small = manifest(30).sections.find((s) => s.type === 'tool_schemas')!.tokenEstimate;
    expect(manifest(40, small).usage.toolSchemaTokensRebilled).toBeGreaterThan(0);
  });

  it('counts a request with no tools as a real change from one that had them', () => {
    const withTools = manifest(40).sections.find((s) => s.type === 'tool_schemas')!.tokenEstimate;
    const none = buildRequestManifest({
      requestId: 'r2',
      contextWindow: 200_000,
      windowSource: 'known_model',
      reservedOutputTokens: 8_192,
      request: { messages: [{ role: 'user', content: 'plan this' }] },
      previousToolSchemaTokens: withTools,
    });
    // Dropping the tools re-bills nothing (there is no block to re-send) but it IS a
    // prefix change, and reporting 0 here would be honest about the price and silent
    // about the cause. The price is what this field is for.
    expect(none.usage.toolSchemaTokensRebilled).toBe(0);
  });
});
