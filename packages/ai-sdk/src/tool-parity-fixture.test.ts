/**
 * Staleness guard for the TS↔Python tool-parity fixture.
 *
 * WHY: `engine/python/tests/fixtures/ts_tool_registry.json` is generated from
 * TOOL_REGISTRY and consumed by `test_tool_registry_schema_parity.py`. The
 * Python suite cannot execute TypeScript, so it trusts the committed fixture —
 * which means a stale fixture would let the Python mirror drift from the real
 * TS registry while the parity test still reported green. That is worse than no
 * check at all: a silent false negative on the tool security boundary.
 *
 * This mirrors the guard already in place for generated skills: rebuild the
 * artifact in-memory from the live source and fail if the committed file
 * differs. Same rule, same reason.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs generator, intentionally not part of the TS build.
import {
  buildFixture,
  serializeFixture,
  FIXTURE_PATH,
} from '../scripts/generate-tool-parity-fixture.mjs';
import { TOOL_REGISTRY } from './tool-registry.js';

describe('tool-parity fixture', () => {
  it('is not stale — regenerate with `pnpm --filter @framepilot/ai-sdk generate:tool-parity`', () => {
    const rebuilt = serializeFixture(buildFixture(TOOL_REGISTRY));
    const committed = readFileSync(FIXTURE_PATH as string, 'utf8');
    expect(committed).toBe(rebuilt);
  });

  it('covers every registered tool', () => {
    const fixture = buildFixture(TOOL_REGISTRY) as {
      toolCount: number;
      tools: Record<string, { kind: string; hostUiOnly: boolean }>;
    };
    expect(fixture.toolCount).toBe(TOOL_REGISTRY.length);
    // Would silently pass an empty comparison otherwise.
    expect(fixture.toolCount).toBeGreaterThan(30);
    expect(fixture.tools.trim_clip?.kind).toBe('mutate');
  });

  it('keeps the exact host-only allowlist', () => {
    const fixture = buildFixture(TOOL_REGISTRY) as {
      tools: Record<string, { kind: string; hostUiOnly: boolean }>;
    };
    const hostUiOnly = Object.entries(fixture.tools)
      .filter(([, spec]) => spec.hostUiOnly)
      .map(([name]) => name);
    expect(hostUiOnly.sort()).toEqual(
      [
        // Needs a human looking at the app.
        'ask_user',
        // Need live editor interaction state (selection, playhead, source monitor).
        'measure_color',
        'professional_color',
        'professional_audio',
        'professional_edit',
        'professional_motion',
        'professional_tracking_mask',
        // Need the Electron MAIN process: the provider network and the project
        // media directory live there, and there is no sidecar route to fall back
        // to — the sidecar has no business holding a provider connection (ADR 0139).
        // Desktop Agent mode is unaffected; this gates the standalone MCP surface.
        'search_music',
        'add_music',

        'remove_silences',
        'search_stock',
        'add_stock',
        // Pack-worker tools execute in the isolated Capability Pack worker process,
        // which the standalone MCP server also has no route to (ADR 0114).
        'detect_subjects',
        'track_subject_automatically',
        // Not UI-dependent — flagged so the Python sidecar does not mirror it.
        // Where a caption cue breaks must have exactly one authority
        // (`segmentCaptions`, ADR 0071), and a second segmenter in Python would
        // disagree with it word by word. MCP still serves this one; see
        // `UI_INDEPENDENT_HOST_TOOLS` in packages/mcp-server.
        'caption_the_edit',
        // Progressive tool disclosure (`tool-domains.ts`). The ledger this call writes to
        // is a TS orchestrator RUN's, and it decides what that run's next request
        // advertises. Neither the sidecar (no ledger, does not assemble the request) nor
        // an external MCP client (brings its own agent and its own tool selection) can
        // honour it, so unlike `caption_the_edit` this one is NOT in
        // `UI_INDEPENDENT_HOST_TOOLS` either.
        'load_tools',
      ].sort(),
    );
  });
});
