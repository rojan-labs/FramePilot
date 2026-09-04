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
 *  6. Every sentence `reliability/sourcing-notes.ts` can produce — all four sourcing tools
 *     crossed with every code of the closed union their surface reports. Both unions are
 *     exported and closed, so an error code added tomorrow is walked tomorrow.
 *  4. Every sentence `reliability/refusal-notes.ts` can produce — the unusable-payload
 *     table, the unavailable-tool note, the unknown-tool note — plus a check that every
 *     tool the table names is REGISTERED, so a rename cannot leave guidance pointing at a
 *     tool that no longer exists.
 *  5. Every fully-authored model-facing `note` in `orchestrator.ts`, read off the file
 *     itself (`ORCHESTRATOR_NOTES` below). This is the half of the surface the previous
 *     version of this header called out as unreachable: those sentences are built at
 *     return sites inside a running turn and are registered nowhere, so the gate walks the
 *     SOURCE instead of a list someone has to remember to update. A new inline dead end
 *     fails here on the day it is written.
 *
 * NOT WALKED — stated plainly rather than pretended away:
 *
 *  - `ToolRefusalError` messages and `buildOps` throws in `domain-tools/*.ts`. They are
 *    built at the throw site from a project the gate would have to construct per tool; a
 *    hand-built fixture per tool is the rotting list this gate exists to avoid.
 *  - COMPOSED notes in `orchestrator.ts` — the ~35 whose instruction is interpolated from
 *    somewhere else (`Rejected "x" — ${problems}`, `${desc} → ${recalled}`). The words are
 *    the validator's, the engine's, or another module's, and judging the template would
 *    grade a sentence nobody ever reads. Where the interpolation is only an id inside
 *    quotes the note IS judged; see {@link orchestratorNoteLiterals}.
 *  - `summary` strings in `orchestrator.ts`, which are the card's short verdict, not the
 *    instruction — the model reads the note beside them.
 *  - Host overrides supplied by the desktop app (`hostTranscribe`, `hostMusicSearch`,
 *    `hostAddMusic`, `hostStockSearch`, `hostAddStock`, and the automatic-tracking
 *    executor) — the text they author themselves lives in `apps/desktop`, outside this
 *    package, and is gated there by
 *    `apps/desktop/electron/ai/model-facing-failure.gate.test.ts`. What THIS gate now
 *    covers for them is the shared producers they call instead of writing their own
 *    sentence: `unusableHostPayload` at (4) and `sourcingFailureNote` at (6).
 *  - Text this package forwards VERBATIM from the engine or a provider. Passing an
 *    unrecognized reason through unchanged is deliberate (`visualReasonGuidance`'s
 *    fall-through): guidance is written from evidence, never invented for a token we have
 *    not seen fail. Those paths are listed in {@link ENGINE_AUTHORED} below.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { createAnalysisBudget } from './kernel/cost/analysis-caps.js';
import { namesNextAction } from './reliability/next-action.js';
import {
  hostedTranscriptionUnavailable,
  unavailableToolNote,
  unknownToolNote,
  unusableHostPayloadEntries,
} from './reliability/refusal-notes.js';
import { sourcingFailureNoteEntries } from './reliability/sourcing-notes.js';
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

/**
 * `orchestrator.ts`'s own text, so the walk below asserts what the file ACTUALLY says
 * rather than a hand-kept copy of it. Same technique `orchestrator.test.ts` already uses
 * to audit the read-digest switch, and the same reason: a list copied into a test rots the
 * day someone edits the file, which is the failure mode this whole gate exists to end.
 */
const ORCHESTRATOR_SOURCE = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');

/** One string literal: `'…'`, or a template whose `${…}` holds no nested braces. */
const STRING_LITERAL = String.raw`'(?:[^'\\\n]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.|\\$\\{[^{}]*\\})*`';

/** A whole `'a ' + 'b'` chain of them — house style wraps long sentences that way. */
const STRING_CONCAT = new RegExp(
  `^\\s*((?:${STRING_LITERAL})(?:\\s*\\+\\s*(?:${STRING_LITERAL}))*)`,
);

/** Where a model-facing note is authored: `const note = …` and `note: …` in a returned object. */
const NOTE_ANCHOR = /\bconst note =|(?:^|[\s{,])note:/g;

/** An interpolated identifier written INSIDE quotes — the sentence's subject, not its words. */
const QUOTED_INTERPOLATION = /"\$\{[^{}]*\}"/g;

/**
 * Every note in `orchestrator.ts` whose WORDS are authored there, with its line.
 *
 * A note built by interpolating text from elsewhere (`Rejected "x" — ${problems}`,
 * `${desc} → ${recalled}`) is skipped: the instruction in it belongs to the validator, the
 * engine, or another module, and grading the template would grade a sentence no model ever
 * reads. An interpolation inside quotes does NOT make a note composed — `"${call.name}"` is
 * the call that failed and `"${asset.id}"` is an id, both subjects, and the instruction
 * around them is still written here.
 */
function orchestratorNoteLiterals(): readonly { readonly line: number; readonly text: string }[] {
  const notes: { line: number; text: string }[] = [];
  NOTE_ANCHOR.lastIndex = 0;
  let anchor: RegExpExecArray | null;
  while ((anchor = NOTE_ANCHOR.exec(ORCHESTRATOR_SOURCE)) !== null) {
    const from = anchor.index + anchor[0].length;
    const expression = STRING_CONCAT.exec(ORCHESTRATOR_SOURCE.slice(from, from + 4000));
    if (!expression) continue;
    // The expression must END here, or what matched is only the head of something larger
    // (a ternary, a call argument) whose real text is assembled elsewhere.
    const next = ORCHESTRATOR_SOURCE.slice(from + expression[0].length).replace(/^\s*/, '')[0];
    if (next !== ';' && next !== ',' && next !== ')' && next !== '}') continue;
    const pieces = expression[1].match(new RegExp(STRING_LITERAL, 'g')) ?? [];
    const text = pieces
      .map((piece) => piece.slice(1, -1))
      .join('')
      .replace(/\\(['"`\\])/g, '$1');
    if (text.trim() === '') continue; // `turnBase`'s empty default, overwritten by every caller.
    if (text.replace(QUOTED_INTERPOLATION, '"id"').includes('${')) continue; // composed
    notes.push({ line: ORCHESTRATOR_SOURCE.slice(0, anchor.index).split('\n').length, text });
  }
  return notes;
}

/**
 * Notes that name no next action AND should not.
 *
 * Not a place to park a defect. Two kinds of entry belong here and nothing else: a note on
 * an outcome that is not a failure (a success, a no-op, the editor's own Stop), and the
 * one genuine failure with no move to name. Every entry says which it is, and the walk
 * fails if an entry's text is no longer in the file — a stale excuse is how a rotting list
 * starts.
 */
const NO_NEXT_ACTION_BY_DESIGN: readonly { readonly text: string; readonly why: string }[] = [
  {
    text: 'The editor dismissed the question "${parsed.question}" and stopped the run.',
    why: 'not a failure — the editor closed the question, and the outcome settles `cancelled`, the same status this gate excludes everywhere else',
  },
  {
    text: 'Asked the editor: "${parsed.question}" → they answered: "${answerText}". Follow this answer.',
    why: 'not a failure — the editor answered, and the answer IS the result',
  },
  {
    text: 'Repair pass: proposed no change.',
    why: 'not a failure — the repair pass looked and found nothing to fix',
  },
  {
    text: 'No tool calls — agent finished.',
    why: 'not a failure — the model stopped calling tools, which is how a run ends',
  },
  {
    text: 'Idempotency hit: this planned operation already succeeded.',
    why: 'not a failure — the operation is already on the timeline, which is the outcome asked for',
  },
  {
    text: 'Run paused because its objective or committed plan could not be recovered.',
    why:
      'a real failure with no model-side move. It is returned with `done: true`, so the model ' +
      'is never called again and never reads it — the reducer files it as the failed plan ' +
      "step's detail, for the editor. There is also nothing to name: the run's own objective " +
      'and committed plan are what could not be recovered, so any tool named here would act on ' +
      'a ledger this turn just refused to trust. `describeUnrecovered` is what reaches the person.',
  },
];

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

  it('for every sentence the refusal-note producers can hand back', () => {
    // The producers `orchestrator.ts` now calls instead of writing the sentence inline.
    // Adding a tool to the unusable-payload table walks it here on the same commit.
    const entries = unusableHostPayloadEntries();
    expect(entries.length).toBeGreaterThan(0);
    const dead = new DeadEnds();
    for (const { tool, note } of entries) dead.check(`unusable payload ${tool}`, note);
    // `generate_mask` is the registry's own `available: false` entry — walked from the
    // registry, so a second unavailable tool is covered without touching this test.
    for (const tool of TOOL_REGISTRY.filter((candidate) => !candidate.available)) {
      dead.check(`unavailable ${tool.name}`, unavailableToolNote(tool.name));
    }
    dead.check('unknown tool', unknownToolNote('frobnicate'));
    // The wrapper the desktop's `hostTranscribe` puts around a provider reason it does not
    // author. Walked with a reason that is itself a dead end (the Settings sentence the
    // shared manual/agent path really returns), so the check grades the WRAPPER — if the
    // appended move were ever dropped, this fails rather than passing on a borrowed hint.
    dead.check(
      'hosted transcription unavailable',
      hostedTranscriptionUnavailable('Add a TwelveLabs API key in Settings.'),
    );
    dead.assertNone();
  });

  it('names only tools that are actually registered in the unusable-payload table', () => {
    // Guidance that names a removed or renamed tool is worse than saying nothing: the
    // model spends a turn calling it. `namesNextAction` already checks the SENTENCES
    // against the live registry; this checks the KEYS, which are the routing side.
    for (const { tool } of unusableHostPayloadEntries()) {
      expect(TOOL_NAMES, `${tool} has payload guidance but is not in the registry`).toContain(tool);
    }
  });

  it('for every note orchestrator.ts authors in its own words', () => {
    const notes = orchestratorNoteLiterals();
    // The scan is the coverage claim; assert it still reaches the file. A regex that
    // silently stopped matching would leave this test green over an unwalked surface,
    // which is precisely the failure the header used to describe.
    expect(notes.length).toBeGreaterThanOrEqual(10);
    const excused = new Map(NO_NEXT_ACTION_BY_DESIGN.map((entry) => [entry.text, entry.why]));
    const seen = new Set<string>();
    const dead = new DeadEnds();
    for (const { line, text } of notes) {
      if (excused.has(text)) {
        seen.add(text);
        continue;
      }
      dead.check(`orchestrator.ts:${String(line)}`, text);
    }
    dead.assertNone();
    // A note that no longer exists must not keep its excuse: the next author reads the
    // table as the list of what was judged, and a stale row is a claim about nothing.
    expect(
      [...excused.keys()].filter((text) => !seen.has(text)),
      'NO_NEXT_ACTION_BY_DESIGN entries no longer found in orchestrator.ts',
    ).toEqual([]);
  });

  it('for every sentence the music/stock sourcing tables can hand back', () => {
    // The desktop host overrides own the provider connection, so THEY answer these calls
    // and this package never runs them. What it owns is the words — `musicErrorMessage`
    // and `stockErrorMessage` are the panels' vocabulary and were forwarded to the model
    // verbatim; `sourcing-notes.ts` is the model's. Walking the cross product means a new
    // error code on either closed union is judged on the commit that adds it.
    const entries = sourcingFailureNoteEntries();
    expect(entries.length).toBeGreaterThanOrEqual(40);
    const dead = new DeadEnds();
    for (const { tool, code, note } of entries) dead.check(`${tool}/${code}`, note);
    dead.assertNone();
  });

  it('names only tools that are actually registered in the sourcing tables', () => {
    for (const { tool } of sourcingFailureNoteEntries()) {
      expect(TOOL_NAMES, `${tool} has sourcing guidance but is not in the registry`).toContain(
        tool,
      );
    }
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
