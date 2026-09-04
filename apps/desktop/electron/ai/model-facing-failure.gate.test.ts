/**
 * The DESKTOP failure-quality GATE — goal.md Workstream C: "Errors are prompts too. Every
 * failure returned to the model must say what was wrong and what a valid next action looks
 * like. Dead-end errors cause loops."
 *
 * ## Why a second gate, in this package
 *
 * `packages/ai-sdk/src/model-facing-failure.gate.test.ts` walks the SDK and says so in its
 * own header: the desktop host overrides are outside it, because their words are authored
 * here. That exemption is exactly where the last defect of this class was found. Commit
 * `d95ec25` discovered — by accident, while fixing something else — that `hostTranscribe`
 * in `electron/main.ts` carried a verbatim copy of a dead-ended sentence the SDK had
 * already fixed. The override REPLACES the SDK path on desktop, so the product's primary
 * surface shipped the worse message while the browser shipped the better one, and no test
 * anywhere could see it.
 *
 * The other overrides had never been examined. This walks them.
 *
 * ## What it walks
 *
 *  1. `createStockHost` at RUNTIME, through every refusal it can produce: an unresolvable
 *     id, a placement conflict (whose sentence comes from `editor-core` and is shared with
 *     the orchestrator's post-download refusal), and a failed download for EVERY code of
 *     the closed `STOCK_ERROR_CODES` union. A new code is walked on the commit that adds it.
 *  2. The real `StockService.unresolvableReason`, which is where an id from a previous
 *     session is refused.
 *  3. Every sentence the automatic-tracking executor's `failed()` funnel can produce, via
 *     `trackingFailureNoteEntries()` — each authored code, plus an unrecognized worker code
 *     in both retryability arms.
 *  4. `main.ts`'s host overrides, read off the SOURCE, because `main.ts` needs an Electron
 *     runtime and can never be imported here. The scan does not hold a list of overrides:
 *     it FOLLOWS THE REGISTRATION — it finds the `createSidecarExecutor({ … })` call, takes
 *     the `hostX` property names it is actually given, resolves each to its `const <name> =`
 *     in the same file, and judges every fully-literal `summary:` inside a `status:
 *     'failed'` / `'warning'` object in that closure. An override added tomorrow, or
 *     renamed, is walked tomorrow; one deleted from the registration stops being walked
 *     without anyone editing this file.
 *
 * Everything is judged with `namesNextAction` from `@framepilot/ai-sdk` — the same
 * predicate, not a copy of it. A second implementation of the property would be the exact
 * duplicated-string defect this gate exists to catch.
 *
 * ## What it CANNOT see, stated plainly
 *
 *  - Failure summaries in `main.ts` that are produced by a shared SDK producer
 *    (`sourcingFailureNote`, `unusableHostPayload`, `hostedTranscriptionUnavailable`) or by
 *    another module (`localMusicAssetRefusal`). They are not literals, so the source scan
 *    skips them — deliberately: those sentences are walked by the SDK's own gate, which is
 *    the whole point of sharing a producer.
 *  - Summaries in `main.ts` COMPOSED from an interpolation that is not a quoted id
 *    (`Transcribed ${n} timed words`). The scan cannot know what the interpolation says.
 *    In practice these are the success paths; the failure paths in these closures are
 *    literal or delegated.
 *  - Text `main.ts` forwards verbatim from the engine, a provider, or a thrown error.
 *    Passing an unrecognized reason through unchanged is the established default; the
 *    desktop now WRAPS those (`hostedTranscriptionUnavailable`) so the pass-through keeps
 *    the evidence and still names a move.
 *  - The renderer, the IPC handlers, and the panels. Their audience is the editor, not the
 *    model, and `reliability/plain-failure.ts` is the property that applies to them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  STOCK_ERROR_CODES,
  TOOL_REGISTRY,
  namesNextAction,
  type StockErrorCode,
} from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { StockDownloadResult } from '../ipc/contract.js';
import { StockService } from '../media/stock-service.js';
import { createStockHost, type StockHostIO } from './stock-host.js';
import { trackingFailureNoteEntries } from './automatic-tracking-executor.js';

const TOOL_NAMES: readonly string[] = TOOL_REGISTRY.map((tool) => tool.name);

/**
 * Collects EVERY dead end in a sweep before failing. Same reasoning as the SDK gate's copy:
 * a gate that reports one defect per run turns a batch of sibling failures into a batch of
 * runs, and the sibling is usually the same fix.
 */
class DeadEnds {
  private readonly found: string[] = [];

  public check(label: string, text: string): void {
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

/** A project whose only video layer holds one clip at the head, so a conflict is reachable. */
function projectWithClipAtHead(): Project {
  return parseProject({
    id: 'gate_project',
    name: 'Gate fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [{ id: 'base', path: 'media/base.mp4', kind: 'video', durationSeconds: 7.767 }],
    timeline: {
      revision: 1,
      tracks: [
        {
          id: 'layer_video_1',
          type: 'video',
          clips: [
            {
              id: 'base_clip',
              assetId: 'base',
              trackId: 'layer_video_1',
              start: 0,
              end: 7.767,
              sourceStart: 0,
              sourceEnd: 7.767,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function stockIo(overrides: Partial<StockHostIO> = {}): StockHostIO {
  return {
    unresolvableReason: () => null,
    knownItem: () => ({ durationSeconds: 13 }),
    download: vi.fn(async () => ({ ok: true }) as unknown as StockDownloadResult),
    ...overrides,
  } as StockHostIO;
}

describe('every desktop host override names a next action', () => {
  it('for every refusal createStockHost can produce', async () => {
    const dead = new DeadEnds();
    const project = projectWithClipAtHead();

    // The empty-id and stale-id refusals, from the service that owns the id table.
    const service = new StockService({ resolveApiKey: () => 'k' } as never);
    for (const id of ['', 'pexels|9999']) {
      const reason = service.unresolvableReason(id);
      expect(reason, `unresolvableReason("${id}") should refuse`).not.toBeNull();
      dead.check(`unresolvableReason("${id}")`, reason ?? '');
    }

    // The placement conflict, refused BEFORE the download is spent.
    const conflicted = await createStockHost(stockIo())(project, {
      remoteId: 'r1',
      kind: 'video',
      atSeconds: 0,
    });
    expect(conflicted.status).toBe('failed');
    dead.check('add_stock placement conflict', conflicted.summary);

    // Every code the download can fail with. The union is closed and exported, so this
    // walk grows on its own rather than by someone remembering to edit a list here.
    for (const code of STOCK_ERROR_CODES) {
      const host = createStockHost(
        stockIo({
          download: vi.fn(
            async () => ({ ok: false, error: code }) as unknown as StockDownloadResult,
          ),
        }),
      );
      const outcome = await host(project, { remoteId: 'r1', kind: 'video' });
      expect(outcome.status).toBe('failed');
      dead.check(`add_stock download ${code}`, outcome.summary);
    }
    dead.assertNone();
  });

  it('walks every stock error code (the sweep is not vacuously green)', () => {
    const codes: readonly StockErrorCode[] = STOCK_ERROR_CODES;
    expect(codes.length).toBeGreaterThanOrEqual(10);
  });

  it('for every sentence the automatic-tracking executor can hand back', () => {
    const entries = trackingFailureNoteEntries();
    expect(entries.length).toBeGreaterThanOrEqual(8);
    const dead = new DeadEnds();
    for (const { tool, code, note } of entries) dead.check(`${tool}/${code}`, note);
    dead.assertNone();
  });

  it('names only tools that are actually registered', () => {
    // Guidance naming a removed or renamed tool is worse than saying nothing: the model
    // spends a turn calling it. `namesNextAction` checks the sentences; this checks that
    // the executor's own tool keys are real.
    for (const { tool } of trackingFailureNoteEntries()) {
      expect(TOOL_NAMES, `${tool} is not in the registry`).toContain(tool);
    }
  });
});

// ---------------------------------------------------------------------------
// main.ts, read off the source — see (4) in the header.
// ---------------------------------------------------------------------------

const MAIN_SOURCE = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

/** One string literal: `'…'`, or a template whose `${…}` holds no nested braces. */
const STRING_LITERAL = String.raw`'(?:[^'\\\n]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.|\\$\\{[^{}]*\\})*`';

/** A whole `'a ' + 'b'` chain of them — house style wraps long sentences that way. */
const STRING_CONCAT = new RegExp(
  `^\\s*((?:${STRING_LITERAL})(?:\\s*\\+\\s*(?:${STRING_LITERAL}))*)`,
);

/** An interpolated identifier written INSIDE quotes — the sentence's subject, not its words. */
const QUOTED_INTERPOLATION = /"\$\{[^{}]*\}"/g;

/**
 * The `hostX` overrides `main.ts` actually hands the executor, read off the registration.
 *
 * Following the wiring rather than the naming is the point: `hostTranscribe` was found by
 * accident because nothing connected "this name looks like an override" to "this is what
 * the orchestrator runs". This reads the call site, so the list cannot drift from it.
 */
function registeredHostOverrides(): readonly string[] {
  const call = /createSidecarExecutor\(\{([\s\S]*?)\n\s*\}\)/.exec(MAIN_SOURCE);
  if (!call) return [];
  return [...(call[1] ?? '').matchAll(/^\s*(host[A-Z][A-Za-z0-9]*)\s*[,:]/gm)].map(
    (match) => match[1] as string,
  );
}

/**
 * The source span of `const <name> = …`: the arrow function's body, or the whole statement
 * when the override is an assignment rather than a closure.
 *
 * The scan is depth-aware because these signatures declare inline object types
 * (`args: { readonly remoteId: string; readonly atSeconds?: number }`). A naive
 * brace-match stops at the end of that TYPE and silently reads a 178-character "body" with
 * no sentences in it — a gate that walks nothing and passes.
 */
function closureBodyOf(name: string): string | null {
  const start = MAIN_SOURCE.indexOf(`const ${name} = `);
  if (start === -1) return null;
  const OPEN = new Set(['(', '{', '[']);
  const CLOSE = new Set([')', '}', ']']);
  let depth = 0;
  for (let i = start; i < MAIN_SOURCE.length; i += 1) {
    const ch = MAIN_SOURCE[i] as string;
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth -= 1;
    else if (depth === 0 && ch === ';') {
      // `const hostAddStock = createStockHost(...)` — a call, not a closure. It authors no
      // sentences of its own; the module it names is runtime-walked above.
      return MAIN_SOURCE.slice(start, i + 1);
    } else if (depth === 0 && ch === '=' && MAIN_SOURCE[i + 1] === '>') {
      return braceBlockAt(MAIN_SOURCE.indexOf('{', i));
    }
  }
  return null;
}

/** The `{ … }` block starting at `open`, brace-matched. */
function braceBlockAt(open: number): string | null {
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < MAIN_SOURCE.length; i += 1) {
    if (MAIN_SOURCE[i] === '{') depth += 1;
    else if (MAIN_SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return MAIN_SOURCE.slice(open, i + 1);
    }
  }
  return null;
}

/** Every fully-literal `summary:` inside a failed/warning object in `body`. */
function failureSummaryLiterals(body: string): readonly { readonly text: string }[] {
  const found: { text: string }[] = [];
  for (const status of body.matchAll(/status:\s*'(?:failed|warning)'/g)) {
    const from = body.indexOf('summary:', status.index);
    // 2000 chars is comfortably past the comments house style puts between the two; a
    // `summary` further away than that belongs to a different object.
    if (from === -1 || from - status.index > 2000) continue;
    const after = from + 'summary:'.length;
    const expression = STRING_CONCAT.exec(body.slice(after, after + 4000));
    if (!expression) continue; // delegated to a producer, or composed — see the header.
    const next = body.slice(after + expression[0].length).replace(/^\s*/, '')[0];
    if (next !== ',' && next !== '}' && next !== ';') continue;
    const pieces = expression[1]?.match(new RegExp(STRING_LITERAL, 'g')) ?? [];
    const text = pieces
      .map((piece) => piece.slice(1, -1))
      .join('')
      .replace(/\\(['"`\\])/g, '$1');
    if (text.replace(QUOTED_INTERPOLATION, '"id"').includes('${')) continue; // composed
    found.push({ text });
  }
  return found;
}

/**
 * Literal failure summaries in `main.ts` that name no next action AND should not.
 *
 * Not a place to park a defect. An entry belongs here only when the sentence is not a
 * failure the model can act on at all, and it must say which. The walk fails if an entry's
 * text is no longer in the file — a stale excuse is how a rotting list starts.
 */
const NO_NEXT_ACTION_BY_DESIGN: readonly { readonly text: string; readonly why: string }[] = [];

describe('main.ts host overrides, read off the source', () => {
  it('finds the overrides by following the registration, not by name', () => {
    const overrides = registeredHostOverrides();
    // If the registration is ever refactored out of this shape the scan goes blind, and
    // this says so instead of passing over an unwalked surface.
    expect(overrides.length).toBeGreaterThanOrEqual(5);
    for (const name of overrides) {
      expect(
        closureBodyOf(name),
        `${name} is registered but not declared in main.ts`,
      ).not.toBeNull();
    }
  });

  it('judges every literal failure summary they author', () => {
    const excused = new Map(NO_NEXT_ACTION_BY_DESIGN.map((entry) => [entry.text, entry.why]));
    const seen = new Set<string>();
    const dead = new DeadEnds();
    let judged = 0;
    for (const name of registeredHostOverrides()) {
      const body = closureBodyOf(name);
      if (body === null) continue;
      for (const { text } of failureSummaryLiterals(body)) {
        if (excused.has(text)) {
          seen.add(text);
          continue;
        }
        judged += 1;
        dead.check(`main.ts ${name}`, text);
      }
    }
    // The scan IS the coverage claim, so assert it still reaches real sentences. A regex
    // that silently stopped matching would leave this green over nothing.
    expect(judged).toBeGreaterThanOrEqual(8);
    dead.assertNone();
    expect(
      [...excused.keys()].filter((text) => !seen.has(text)),
      'NO_NEXT_ACTION_BY_DESIGN entries no longer found in main.ts',
    ).toEqual([]);
  });
});
