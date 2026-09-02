/**
 * The failure-quality GATE — goal.md Workstream C: "Errors are prompts too. Every failure
 * returned to the model must say what was wrong and what a valid next action looks like.
 * Dead-end errors cause loops."
 *
 * ## Why a gate and not another one-off fix
 *
 * Two dead ends were found by hand, by reading one captured run (`369e8c82`), and fixed in
 * `92a0387`. Reading logs does not scale and the next one ships. This walks the surface
 * instead, so a dead end fails the build the day it is written.
 *
 * ## What it walks, and what it cannot see
 *
 * WALKED (runtime, no hand-copied list of tools anywhere):
 *
 *  1. Every `analysis`/`action` tool in the REAL `TOOL_REGISTRY` — the registry predicate
 *     the orchestrator itself dispatches on (`orchestrator.ts` ~4051: `tool.kind ===
 *     'action' || tool.kind === 'analysis'`) — driven through the real
 *     `createSidecarExecutor` under three failure conditions a run actually meets:
 *     the engine is unreachable, the engine answered nothing usable, and the run's
 *     analysis budget is spent. A tool added tomorrow is walked tomorrow.
 *  2. Every entry of the two visual-reason guidance tables, via
 *     `visualReasonGuidanceEntries()` — the producer the `map_footage` dead end lived in.
 *  3. Every terminal state of the paced index job (`interpretIndexLoop`), both `wait`
 *     modes.
 *
 * NOT WALKED — stated plainly rather than pretended away:
 *
 *  - `ToolRefusalError` messages and `buildOps` throws in `domain-tools/*.ts`. They are
 *    built at the throw site from a project the gate would have to construct per tool; a
 *    hand-built fixture per tool is the rotting list this gate exists to avoid.
 *  - Notes authored in `orchestrator.ts` (where the SECOND historical dead end lived).
 *    Another agent owns that file this session.
 *  - Host overrides supplied by the desktop app (`hostMusicSearch`, `hostAddMusic`,
 *    `hostStockSearch`, `hostAddStock`, `hostTranscribe`) — their failure text is authored
 *    in `apps/desktop`, outside this package.
 *  - Text this package forwards VERBATIM from the engine or a provider. Passing an
 *    unrecognized reason through unchanged is deliberate (`visualReasonGuidance`'s
 *    fall-through): guidance is written from evidence, never invented for a token we have
 *    not seen fail. Those paths are listed in {@link ENGINE_AUTHORED} below.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { createAnalysisBudget } from './kernel/cost/analysis-caps.js';
import { namesNextAction } from './reliability/next-action.js';
import {
  createSidecarExecutor,
  interpretIndexLoop,
  visualReasonGuidanceEntries,
} from './sidecar-executor.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import type { HostToolOutcome } from './tool-executor.js';
import type { VisualIndexLoopResult } from './visual-index-client.js';

const TOOL_NAMES: readonly string[] = TOOL_REGISTRY.map((tool) => tool.name);

/** The registry's own definition of "this call runs on the host", not a copy of the list. */
const HOST_TOOLS = TOOL_REGISTRY.filter(
  (tool) => tool.kind === 'analysis' || tool.kind === 'action',
);

const BASE_URL = 'http://127.0.0.1:8765';
const project: Project = makeProject();

/**
 * Exactly what the model reads back from one host call.
 *
 * The orchestrator builds the run's log note as `outcome.summary` followed by a digest of
 * `outcome.data` (`orchestrator.ts` ~4429), so judging the summary alone would grade a
 * string the model never sees on its own — the transport failure puts the editor's
 * sentence in `summary` and the model's instruction in `data`, and only the pair is the
 * prompt.
 */
function modelFacingText(outcome: HostToolOutcome): string {
  const data = typeof outcome.data === 'string' ? outcome.data : '';
  return data === '' ? outcome.summary : `${outcome.summary} → ${data}`;
}

/**
 * Failure text this package forwards from somewhere else, word for word.
 *
 * These are NOT excused defects — they are the deliberate pass-through the existing
 * guidance tables are built around. Writing an "instead" for a wire error we have never
 * seen fail would be inventing guidance, which is the one thing `92a0387`'s commit message
 * is explicit about not doing. Each entry names WHO authored the words.
 */
const ENGINE_AUTHORED: readonly { readonly pattern: RegExp; readonly whose: string }[] = [
  // `postAnalysis` on a non-2xx: everything after the status code is the engine's own
  // `detail` string (`engineErrorDetail`). We do not know what it says.
  { pattern: /^Analysis failed \(\d+\)/, whose: 'the engine, via its HTTP error body' },
];

function isEngineAuthored(text: string): string | null {
  return ENGINE_AUTHORED.find((entry) => entry.pattern.test(text))?.whose ?? null;
}

/** Statuses whose text the model must be able to act on. `cancelled` is the user's Stop. */
function isFailure(outcome: HostToolOutcome): boolean {
  return outcome.status === 'failed' || outcome.status === 'warning';
}

/**
 * Collects EVERY dead end in a sweep before failing, rather than stopping at the first.
 * A gate that reports one defect per run turns a batch of sibling failures into a batch of
 * runs, and the sibling is usually the same fix.
 */
class DeadEnds {
  private readonly found: string[] = [];

  public check(label: string, text: string): void {
    if (isEngineAuthored(text) !== null) return;
    const verdict = namesNextAction(text, TOOL_NAMES);
    if (verdict.ok) return;
    this.found.push(`  ${label}\n    ${verdict.why}\n    text: ${text}`);
  }

  public assertNone(): void {
    expect(
      this.found,
      `${String(this.found.length)} model-facing failure(s) name no next action:\n${this.found.join('\n')}`,
    ).toEqual([]);
  }
}

/** A fetch that always rejects the way a refused socket does. */
const unreachableFetch = (async () => {
  const error = new TypeError('fetch failed');
  (error as unknown as { cause: unknown }).cause = { code: 'ECONNREFUSED' };
  throw error;
}) as unknown as typeof fetch;

/** A fetch that answers 200 with a body carrying nothing the settle functions can use. */
const emptyBodyFetch = (async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '{}',
  }) as Response) as typeof fetch;

async function runAll(
  fetchFn: typeof fetch,
  ctx: { project: Project; analysisBudget?: ReturnType<typeof createAnalysisBudget> },
): Promise<{ name: string; outcome: HostToolOutcome }[]> {
  const executor = createSidecarExecutor({ baseUrl: BASE_URL, fetchFn, timeoutMs: 50 });
  const settled: { name: string; outcome: HostToolOutcome }[] = [];
  for (const tool of HOST_TOOLS) {
    const outcome = await executor.run({ id: 'c1', name: tool.name, arguments: {} }, ctx);
    settled.push({ name: tool.name, outcome });
  }
  return settled;
}

describe('every model-facing failure names a next action', () => {
  it('walks a non-trivial share of the registry (the gate is not vacuously green)', () => {
    // If a refactor ever makes the walk empty or tiny, this says so instead of passing.
    expect(HOST_TOOLS.length).toBeGreaterThanOrEqual(20);
  });

  it('when the media engine is unreachable', async () => {
    const settled = await runAll(unreachableFetch, { project });
    const failures = settled.filter(({ outcome }) => isFailure(outcome));
    // Every host tool fails when there is no engine and no host override — a sweep that
    // silently stopped exercising the surface would otherwise still pass.
    expect(failures.length).toBe(HOST_TOOLS.length);
    const dead = new DeadEnds();
    for (const { name, outcome } of failures) {
      dead.check(`${name} (engine unreachable)`, modelFacingText(outcome));
    }
    dead.assertNone();
  }, 20_000);

  it('when the engine answers with nothing usable', async () => {
    const settled = await runAll(emptyBodyFetch, { project });
    const failures = settled.filter(({ outcome }) => isFailure(outcome));
    expect(failures.length).toBeGreaterThan(0);
    const dead = new DeadEnds();
    for (const { name, outcome } of failures) {
      dead.check(`${name} (empty engine response)`, modelFacingText(outcome));
    }
    dead.assertNone();
  }, 20_000);

  it("when the run's analysis budget is spent", async () => {
    const spent = createAnalysisBudget({ maxFfmpegSeconds: 0, maxTranscriptionMinutes: 0 });
    const settled = await runAll(unreachableFetch, { project, analysisBudget: spent });
    const refused = settled.filter(({ outcome }) => outcome.summary.includes('was not run'));
    // The capped tools are `analysis-caps.ts`'s own list; assert the sweep reached some.
    expect(refused.length).toBeGreaterThan(0);
    const dead = new DeadEnds();
    for (const { name, outcome } of refused) {
      dead.check(`${name} (budget spent)`, modelFacingText(outcome));
    }
    dead.assertNone();
  }, 20_000);

  it('for every sentence the visual-reason guidance tables can produce', () => {
    const entries = visualReasonGuidanceEntries();
    expect(entries.length).toBeGreaterThan(0);
    const dead = new DeadEnds();
    for (const { reason, toolName, guidance } of entries) {
      dead.check(`guidance ${toolName ?? 'shared'}/${reason}`, guidance);
    }
    dead.assertNone();
  });

  it('for every terminal state of the paced index job', () => {
    const statuses: readonly VisualIndexLoopResult['status'][] = [
      'done',
      'no-key',
      'unavailable',
      'unreachable',
      'cancelled',
      'keys-failing',
      'exhausted-slices',
    ];
    const dead = new DeadEnds();
    for (const status of statuses) {
      for (const wait of [true, false]) {
        const outcome = interpretIndexLoop({ status } as VisualIndexLoopResult, wait);
        if (!isFailure(outcome)) continue;
        dead.check(`index_media ${status} (wait=${String(wait)})`, modelFacingText(outcome));
      }
    }
    dead.assertNone();
  });
});
