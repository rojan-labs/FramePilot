#!/usr/bin/env node
/**
 * Golden evaluation runner (goal.md Phase 0; grew out of plan/system-mission P0.2/P0.3).
 *
 * Drives the real `Orchestrator.streamAgent` path — the same class the desktop main
 * process constructs — with the real configured provider and the real sidecar executor
 * against the mission fixture projects, and folds every valid diff into a working project
 * exactly as the host does. Cases come from `eval/golden-cases.ts`; outcomes are scored by
 * `eval/mission-rubric.ts` (assertions on the edit state) and `eval/golden-metrics.ts`
 * (intent, target, boundary, validity, first-pass, turns, tokens/USD, latency, undo,
 * failure quality).
 *
 * Built for a human operator who runs real media by hand:
 *   - one command per case (`--case trim-first-clip-10s`) or per category (`--category trim`);
 *   - a cost/duration estimate BEFORE the run, from the last summary of the same cases;
 *   - one result file per case+run under `reports/golden/<label>/cases/` — a re-run skips
 *     what already exists (`--force` to redo), so a fix is re-measured without re-billing
 *     unaffected cases; sidecar analysis is cached on its side;
 *   - every run's effects recorded under `recordings/` so `--replay` re-scores with zero
 *     model or host calls (`kernel/replay`);
 *   - `summary.json` (machine) + `summary.md` (human) per label, plus the merged run JSON
 *     the two older gates (`mission-score.mjs`, `mission-efficiency-gate.mjs`) still read.
 *
 * Nothing here is estimated: a number missing from the provider is reported missing.
 *
 * Usage (sidecar running with FRAMEPILOT_PROJECTS_ROOT=tests/fixtures/mission/projects):
 *   node scripts/mission-baseline.mjs --case trim-first-clip-10s
 *   node scripts/mission-baseline.mjs --category silence,captions --runs 3 --label baseline --yes
 *   node scripts/mission-baseline.mjs --estimate                 # cost + duration only, no run
 *   node scripts/mission-baseline.mjs --replay --label baseline  # re-score from recordings
 *   node scripts/mission-baseline.mjs --list
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
loadDotEnv(join(REPO, '.env'));
process.env.FRAMEPILOT_LOG_LEVEL ??= 'silent';

const sdk = await import(join(HERE, '..', 'dist', 'index.js'));
const { parseProject } = await import('@framepilot/timeline-schema');
const { applyProjectPatch } = await import('@framepilot/editor-core');
const {
  Orchestrator,
  BaselineCaptureProvider,
  MockProvider,
  createProviderFromConfig,
  resolveProviderConfig,
  resolveTierProviderConfigs,
  createSidecarExecutor,
  createVisualStatusDigester,
  createSessionContextDigester,
  createMemoryRecorder,
  createReplayEffectRuntime,
  VisualIndexClient,
  summarizeFootageMap,
  scoreMissionScenario,
  summarizeRunMetrics,
  pictureClips,
  GOLDEN_CASES,
  DEFAULT_ASK_ANSWER,
  measureGoldenTurn,
  summarizeGoldenRun,
  renderGoldenSummary,
  estimateRun,
} = sdk;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(usage());
  process.exit(0);
}
if (args.list) {
  for (const c of GOLDEN_CASES) process.stdout.write(`${c.id.padEnd(28)} ${c.category.padEnd(11)} ${c.project.padEnd(16)} ${c.turns.length} turn(s)\n`);
  process.exit(0);
}
const RUNS = Number(args.runs ?? 1);
const LABEL = String(args.label ?? 'baseline');
const REPLAY = args.replay === true;
const FORCE = args.force === true;
const RECORD = args['no-record'] !== true;
const GOLDEN_DIR = resolve(REPO, 'reports', 'golden');
const RUN_DIR = join(GOLDEN_DIR, LABEL);
const CASES_DIR = join(RUN_DIR, 'cases');
const RECORDINGS_DIR = join(RUN_DIR, 'recordings');
const OUT = resolve(REPO, String(args.out ?? join('reports', 'golden', `${LABEL}.json`)));
const DUMP_DIR = args['dump-events'] ? resolve(REPO, String(args['dump-events'] === true ? join('reports', 'golden', LABEL, 'events') : args['dump-events'])) : null;
const BASE_URL = process.env.FRAMEPILOT_PYTHON_API_URL ?? 'http://127.0.0.1:8799';
const FIXTURES = join(REPO, 'tests', 'fixtures', 'mission', 'projects');
const providerName = REPLAY ? 'replay' : (process.env.FRAMEPILOT_AI_PROVIDER ?? 'deepseek');
const modelName = REPLAY ? 'replay' : (resolveProviderConfig(providerName).model ?? 'provider default');

const selected = selectCases(args);
if (selected.length === 0) {
  process.stderr.write(`no golden case matches ${JSON.stringify({ case: args.case ?? args.only, category: args.category })}; try --list\n`);
  process.exit(1);
}

// ── Estimate first: the operator commits to a run knowing what it costs ─────────────
const prior = loadPriorSummary();
const estimate = estimateRun(prior?.summary, selected.map((c) => c.id), RUNS);
printEstimate(estimate, prior);
if (args.estimate) process.exit(0);
if (!REPLAY && !args.yes && process.stdin.isTTY) {
  const ok = await confirm('Proceed with the run? [y/N] ');
  if (!ok) process.exit(0);
}
if (!REPLAY) {
  const missing = selected.map((c) => c.project).filter((p) => !existsSync(join(FIXTURES, `${p}.fp.json`)));
  if (missing.length) {
    process.stderr.write(`fixture project(s) missing: ${[...new Set(missing)].join(', ')} — build them with scripts/mission-fixture-projects.mjs (see docs/guides/golden-eval.md)\n`);
    process.exit(1);
  }
}

function usage() {
  return `usage: mission-baseline.mjs [--case id[,id]] [--category c[,c]] [--runs N] [--label L]
       [--out file] [--force] [--yes] [--estimate] [--replay] [--dump-events [dir]] [--no-record] [--list]
  --case        one or more golden case ids (alias: --only)
  --category    one or more categories from eval/golden-cases.ts
  --runs        runs per case (default 1; use 3 to write a floor)
  --label       run label; results land in reports/golden/<label>/ (default "baseline")
  --force       redo cases whose result file already exists
  --yes         skip the cost confirmation
  --estimate    print the cost/duration estimate and exit
  --replay      re-score from reports/golden/<label>/recordings with no model/host calls
  --list        list the golden cases
`;
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function selectCases(a) {
  const ids = a.case ?? a.only;
  const cats = a.category;
  const wantIds = ids && ids !== true ? new Set(String(ids).split(',')) : null;
  const wantCats = cats && cats !== true ? new Set(String(cats).split(',')) : null;
  return GOLDEN_CASES.filter((c) => (!wantIds || wantIds.has(c.id)) && (!wantCats || wantCats.has(c.category)));
}

/** The last summary for these cases: the committed floor first, else this label's own. */
function loadPriorSummary() {
  for (const path of [join(GOLDEN_DIR, 'floor.json'), join(RUN_DIR, 'summary.json')]) {
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data?.summary?.perCase) return { path, summary: data.summary, generatedAt: data.generatedAt };
  }
  return undefined;
}

function printEstimate(est, priorSummary) {
  const money = (v) => (v === null ? '?' : `$${v.toFixed(2)}`);
  const mins = (v) => (v === null ? '?' : `${v.toFixed(0)} min`);
  process.stdout.write(`Golden run "${LABEL}": ${selected.length} case(s) × ${RUNS} run(s) via ${providerName}${REPLAY ? '' : ` (${modelName})`}\n`);
  for (const c of est.perCase) process.stdout.write(`  ${c.caseId.padEnd(28)} ${money(c.usd).padStart(7)} ${mins(c.minutes).padStart(8)}  ${c.basis === 'prior' ? '' : '(no prior run — cost unknown)'}\n`);
  process.stdout.write(`  estimate: ${money(est.usd)} / ${mins(est.minutes)}${priorSummary ? ` (basis: ${basename(dirname(priorSummary.path))}/${basename(priorSummary.path)} from ${priorSummary.generatedAt ?? '?'})` : ' (no prior summary)'}\n`);
  if (est.unknown.length) process.stdout.write(`  no estimate for: ${est.unknown.join(', ')} — the total above is not a total\n`);
  if (REPLAY) process.stdout.write('  replay: zero model or host calls; latency figures are not meaningful\n');
}

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(question, (a) => { rl.close(); r(/^y(es)?$/i.test(a.trim())); }));
}

function loadProject(id) {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${id}.fp.json`), 'utf8'));
  const { schemaVersion: _v, ...project } = raw;
  return parseProject(project);
}

/**
 * Compose the case's project: the fixture, plus (for `brollFrom`) another fixture's b-roll
 * assets added to the bin. Done in memory so no fixture is written; asset paths are relative
 * to the sidecar's projects root, which both fixtures share.
 *
 * A fixture may instead ship its own un-placed video (`mission-overlay`, whose bin b-roll is
 * part of the shape being measured). Then THAT is the b-roll the rubric scores, so it is
 * resolved from the project rather than requiring a donor.
 */
function composeProject(goldenCase) {
  const base = loadProject(goldenCase.project);
  let assets = base.assets;
  let brollAssetIds = [];
  if (goldenCase.brollFrom) {
    const donor = loadProject(goldenCase.brollFrom);
    const broll = donor.assets.filter((a) => a.kind === 'video' && /\/b\d-/.test(a.path));
    const added = broll.map((a, i) => ({ ...a, id: `broll_${String(i + 1).padStart(2, '0')}` }));
    brollAssetIds = added.map((a) => a.id);
    assets = [...assets, ...added];
  } else {
    const placed = new Set(base.timeline.tracks.flatMap((t) => t.clips).map((c) => c.assetId));
    brollAssetIds = assets.filter((a) => a.kind === 'video' && !placed.has(a.id)).map((a) => a.id);
  }
  const musicAssetId = goldenCase.musicAssetName ? assets.find((a) => basename(a.path) === goldenCase.musicAssetName)?.id : undefined;
  const project = parseProject({ ...base, assets });
  return { project, brollAssetIds, musicAssetId };
}

function sectionTotals(manifest) {
  const byType = {};
  for (const s of manifest?.sections ?? []) {
    if (!s.included) continue;
    byType[s.type] = (byType[s.type] ?? 0) + s.tokenEstimate;
  }
  return byType;
}

function recordingPath(scenarioId, run, turnIndex) {
  return join(RECORDINGS_DIR, `${scenarioId}-r${run}-t${turnIndex + 1}.json`);
}

async function runTurn({ project, turn, history, scenarioId, run, turnIndex, carriedForward }) {
  const recordingFile = recordingPath(scenarioId, run, turnIndex);
  let recording = null;
  let provider;
  let orchestratorOptions;
  if (REPLAY) {
    if (!existsSync(recordingFile)) throw new Error(`no recording at ${recordingFile}; run the case live first`);
    const recorded = JSON.parse(readFileSync(recordingFile, 'utf8'));
    provider = new MockProvider();
    orchestratorOptions = { replayRuntime: () => createReplayEffectRuntime(recorded) };
  } else {
    provider = createProviderFromConfig(resolveProviderConfig(providerName));
    orchestratorOptions = {
      executor: createSidecarExecutor({ baseUrl: BASE_URL }),
      ...(RECORD ? { recordEffects: true, onRecording: (r) => { recording = r; } } : {}),
    };
  }
  const capture = new BaselineCaptureProvider(provider);
  // Per-tier providers (goal.md Workstream E). Each gets its OWN capture wrapper: a tier
  // exists to be priced separately, so folding its calls into the base capture would hide
  // the very saving the tier was configured to produce. Absent unless FRAMEPILOT_TIER_* is
  // set, so an unconfigured baseline run is unchanged.
  const tierCaptures = {};
  if (!REPLAY) {
    for (const [tier, config] of Object.entries(resolveTierProviderConfigs(providerName))) {
      tierCaptures[tier] = new BaselineCaptureProvider(createProviderFromConfig(config));
    }
    if (Object.keys(tierCaptures).length > 0) orchestratorOptions.tierProviders = tierCaptures;
  }
  const orchestrator = new Orchestrator(capture, orchestratorOptions);
  // Same context inputs the desktop host injects (apps/desktop/electron/main.ts hub
  // options): visual-index status, cached footage map, session narrative — so the
  // harness measures the desktop path, not a poorer one. Skipped on replay: the recorded
  // model chunks are what they are regardless of the prompt.
  let visualStatus;
  let footageMap;
  let sessionContext;
  if (!REPLAY) {
    const visualIndex = new VisualIndexClient({ baseUrl: BASE_URL });
    [visualStatus, footageMap, sessionContext] = await Promise.all([
      createVisualStatusDigester({ baseUrl: BASE_URL })(project.id, orchestrator.canSeeFrames()).catch(() => undefined),
      visualIndex.footageMap({ projectId: project.id, project, cachedOnly: true }).then(summarizeFootageMap).catch(() => undefined),
      createSessionContextDigester({ baseUrl: BASE_URL })(project.id).catch(() => undefined),
    ]);
  }
  const rememberDecision = REPLAY
    ? () => {}
    : (note) => {
        void createMemoryRecorder({ baseUrl: BASE_URL })({ projectId: project.id, tier: 'decisions', title: note.title, body: note.body }).catch(() => undefined);
      };
  // The scripted operator: records every question and answers from the case, or with the
  // default that ends the turn without an edit. Never silently absent — an absent control
  // makes the model "use its best judgement", which is the opposite of what the guard and
  // clarify cases measure.
  const asked = [];
  const askUser = {
    requestAnswer: async (_toolCallId, question, options) => {
      asked.push({ question, options: options?.map((o) => o.label) ?? [] });
      return { kind: 'answered', answer: turn.answer ?? DEFAULT_ASK_ANSWER };
    },
  };
  const started = Date.now();
  const events = [];
  const controller = new AbortController();
  // Recorded, not just acted on. A turn the HARNESS stopped reached the model and did
  // partial work, so scoring it says where the timer landed rather than what the agent
  // would have done — see `GoldenTurnMetrics.harnessTimedOut`. Session 3 lost five turns
  // of thirty-six this way while the provider answered at 123-660 seconds per call.
  let harnessTimedOut = false;
  const timeout = setTimeout(() => {
    harnessTimedOut = true;
    controller.abort();
  }, Number(process.env.MISSION_TURN_TIMEOUT_MS ?? 20 * 60_000));
  let working = project;
  let assistantText = '';
  let lastWorking;
  const appliedPatches = [];
  try {
    for await (const event of orchestrator.streamAgent(
      {
        project,
        userPrompt: turn.prompt,
        history,
        ...(visualStatus ? { visualStatus } : {}),
        ...(footageMap ? { footageMap } : {}),
        ...(sessionContext ? { sessionContext } : {}),
      },
      { conversationId: `mission-${scenarioId}`, turnId: `mission-${scenarioId}-t${turnIndex}`, signal: controller.signal },
      // The desktop hands the previous run's working state to the next request
      // (`AgentOptions.carriedForward`, context-management P5.1); mirrored here so a
      // second turn does not re-learn the footage in the harness either.
      carriedForward === undefined ? {} : { carriedForward },
      { rememberDecision, askUser },
    )) {
      events.push(event);
      if (event.type === 'run_state' && event.working) lastWorking = event.working;
      if (event.type === 'diff' && event.edit.validation.valid) {
        const before = event.scope === 'turn' ? working : project;
        working = applyProjectPatch(before, event.edit.patch);
        appliedPatches.push(event.edit.patch);
      }
      if (event.type === 'assistant_message') assistantText = event.text ?? assistantText;
    }
  } finally {
    clearTimeout(timeout);
  }
  const wallMs = Date.now() - started;
  // Tier calls are real model calls: they belong in the run's call count and token totals,
  // and `tierCalls` says how the total split so a cheap-routing run is legible at a glance.
  const tierCalls = { small: 0, mid: 0, large: 0 };
  const tierTurns = [];
  for (const [tier, tierCapture] of Object.entries(tierCaptures)) {
    const captured = tierCapture.captured();
    tierCalls[tier] = captured.length;
    tierTurns.push(...captured);
  }
  const baseTurns = capture.captured();
  const turns = [...baseTurns, ...tierTurns];
  // On replay the provider is never called, so the capture is empty; the recording knows
  // how many model calls the live run made. Tokens, USD and latency are not reproduced —
  // they belong to the live run's case file.
  const replayedModelCalls = REPLAY ? JSON.parse(readFileSync(recordingFile, 'utf8')).effects.filter((e) => e.kind === 'model' || e.kind === 'model_stream').length : null;
  // A tool call emits one `running` row and one terminal row; count the terminal one.
  const toolCalls = events.filter((e) => e.type === 'tool_call' && e.status !== 'running');
  // Identity = tool name + the actual input the tool ran with (tool_result carries it);
  // argsSummary is a display label and is constant for some tools ("Reframing").
  const inputById = new Map(events.filter((e) => e.type === 'tool_result').map((e) => [e.toolCallId, JSON.stringify(e.input ?? null)]));
  const toolKey = (e) => `${e.toolName}|${inputById.get(e.id) ?? inputById.get(e.toolCallId) ?? e.argsSummary ?? ''}`;
  const seen = new Map();
  for (const t of toolCalls) seen.set(toolKey(t), (seen.get(toolKey(t)) ?? 0) + 1);
  const repeatedToolCalls = [...seen.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0);
  const manifests = events.filter((e) => e.type === 'context_usage' && e.manifest).map((e) => e.manifest);
  const usage = events.filter((e) => e.type === 'usage').at(-1);
  const diffs = events.filter((e) => e.type === 'diff');
  const validDiffs = diffs.filter((e) => e.edit.validation.valid);
  const ops = validDiffs.reduce((s, e) => s + e.edit.patch.operations.length, 0);
  const errors = events.filter((e) => e.type === 'error').map((e) => e.message ?? e.error ?? '').slice(0, 5);
  const status = events.filter((e) => e.type === 'status').at(-1);
  if (recording && RECORD) {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
    writeFileSync(recordingFile, JSON.stringify(recording));
  }
  return {
    working,
    lastWorking,
    assistantText,
    asked,
    appliedPatches,
    events,
    startedAt: started,
    harnessTimedOut,
    recordingFile: recording || REPLAY ? recordingFile : null,
    metrics: {
      wallMs,
      modelCalls: replayedModelCalls ?? turns.length,
      /** How the run's model calls split across tiers; all zero unless tiers are configured. */
      tierCalls,
      tokens: {
        /** input + cacheRead: the whole prompt the provider processed. */
        prompt: sum(turns, 'inputTokens') + sum(turns, 'cacheReadInputTokens'),
        input: sum(turns, 'inputTokens'),
        output: sum(turns, 'outputTokens'),
        cacheRead: turns.some((t) => t.cacheReadInputTokens !== undefined) ? sum(turns, 'cacheReadInputTokens') : null,
        cacheCreate: turns.some((t) => t.cacheCreationInputTokens !== undefined) ? sum(turns, 'cacheCreationInputTokens') : null,
      },
      perCall: turns.map((t) => ({
        ttftMs: t.ttftMs,
        wallMs: t.wallMs,
        input: t.inputTokens,
        output: t.outputTokens,
        cacheRead: t.cacheReadInputTokens ?? null,
      })),
      summary: turns.length ? summarizeRunMetrics(turns) : null,
      usd: usage?.usd ?? null,
      usageTokens: usage?.tokens ?? null,
      toolCalls: toolCalls.length,
      toolCallsByName: countBy(toolCalls, (e) => e.toolName),
      repeatedToolCalls,
      analysisFromCache: toolCalls.filter((e) => e.fromCache === true).length,
      contextRequests: manifests.length,
      contextByType: manifests.map(sectionTotals),
      contextUsedTokens: manifests.map((m) => m.usage?.providerReportedInputTokens ?? m.usage?.estimatedInputTokensBeforeSend ?? null),
      contextCachedTokens: manifests.map((m) => m.usage?.cachedInputTokens ?? null),
      diffs: diffs.length,
      validDiffs: validDiffs.length,
      operations: ops,
      errors,
      finalStatus: status?.status ?? null,
    },
  };
}

/**
 * The subscription bridge answers 429 after a few dollars of calls in a window. A run that
 * records 1 call / 0 tokens is not a measurement, so on a rate-limited turn (every model
 * call failed with 429) wait and try the same turn again, up to MISSION_429_RETRIES times.
 */
const RATE_LIMIT_WAIT_MS = Number(process.env.MISSION_429_WAIT_MS ?? 10 * 60_000);
const RATE_LIMIT_RETRIES = Number(process.env.MISSION_429_RETRIES ?? 12);
async function runTurnWithBackoff(input) {
  for (let attempt = 0; ; attempt++) {
    const outcome = await runTurn(input);
    const limited = !REPLAY && outcome.metrics.errors.some((e) => /429|rate limit/i.test(String(e))) && outcome.metrics.tokens.prompt === 0;
    if (!limited || attempt >= RATE_LIMIT_RETRIES) return outcome;
    process.stdout.write(`   rate-limited (429); waiting ${Math.round(RATE_LIMIT_WAIT_MS / 60000)} min before retrying this turn (${attempt + 1}/${RATE_LIMIT_RETRIES})\n`);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
  }
}

function sum(arr, key) {
  return arr.reduce((s, t) => s + (t[key] ?? 0), 0);
}
function countBy(arr, f) {
  const out = {};
  for (const x of arr) out[f(x)] = (out[f(x)] ?? 0) + 1;
  return out;
}

function compactEvents(events) {
  return events.map((e) => {
    const { type } = e;
    if (type === 'assistant_delta' || type === 'reasoning_delta') return null;
    const c = { ...e };
    if (c.manifest) c.manifest = { sections: c.manifest.sections.filter((x) => x.included).map((x) => ({ type: x.type, label: x.label, tokens: x.tokenEstimate })), usage: c.manifest.usage };
    if (c.edit) c.edit = { valid: c.edit.validation?.valid, ops: c.edit.patch?.operations?.map((o) => o.type), text: String(c.edit.text ?? '').slice(0, 300) };
    if (c.result !== undefined) c.result = String(JSON.stringify(c.result)).slice(0, 400);
    if (c.input !== undefined) c.input = String(JSON.stringify(c.input)).slice(0, 300);
    return c;
  }).filter(Boolean);
}

function caseResultPath(scenarioId, run) {
  return join(CASES_DIR, `${scenarioId}-r${run}.json`);
}


/**
 * The onsets the engine detects in a fixture's music, in source seconds — the grid the
 * runtime itself snaps cuts to (`kernel/beat-grid/beat-alignment.ts`).
 *
 * Scoring beat cases against the case's NOMINAL period instead was worth 45 points: the
 * detector reads `beat-100bpm.wav` as 99.4 BPM and returns onsets that mostly do not sit on
 * an ideal 0.6s grid, so a run that snapped every cut correctly scored 45-54%. Fetched once
 * per case and cached by the sidecar; a failure returns undefined and the check falls back
 * to the nominal grid rather than the run failing over an analysis it only needed to score.
 *
 * @param {object} project - The composed fixture project.
 * @param {string|undefined} assetId - The music asset the case named.
 * @returns {Promise<number[]|undefined>} Detected onset times, or undefined.
 */
async function detectedBeatTimes(project, assetId) {
  if (!assetId) return undefined;
  try {
    const res = await fetch(`${BASE_URL}/detect-beats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, asset_id: assetId }),
    });
    if (!res.ok) return undefined;
    const body = await res.json();
    const times = (body.beats ?? [])
      .map((b) => (typeof b === 'number' ? b : b?.time))
      .filter((t) => typeof t === 'number' && Number.isFinite(t));
    return times.length > 0 ? times : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Forget what earlier RUNS of this case decided, so three runs are three samples.
 *
 * The agent's Memory Store lives beside the project — `.framepilot-derived/<id>/memory/` —
 * and the runner records every answered question into it as a standing decision. The
 * fixture project ids are fixed, so run 1's decisions were still there for run 2, and run
 * 1's and 2's for run 3.
 *
 * That is not a subtle contamination. On `refine-tighten` the scripted operator's default
 * ("No answer — stop here and make no change") was written as "Follow this on later turns
 * unless they change it", and run 3 opened by refusing to edit at all: "the editor has now
 * been asked three separate times … and each time chose not to answer". The agent was
 * reading its notes correctly. `podcast-highlight-60s` failed the same way — two of three
 * runs declined, citing a decision the editor had never made in that run.
 *
 * Memory WITHIN a run is left alone: `memory-captions` exists to measure exactly that, and
 * every turn of a case shares one project directory by design. Only the boundary between
 * runs is cleared, which is the boundary that is supposed to be a fresh start.
 *
 * @param {string} projectId - The fixture project the case runs against.
 */
function forgetPriorRunMemory(projectId) {
  if (REPLAY) return;
  const dir = join(FIXTURES, '.framepilot-derived', projectId, 'memory');
  // The whole tier directory: `decisions.md` is what carried across, but a session note or
  // any tier added later would carry the same way, and an allowlist would silently miss it.
  // Everything here is derived and rebuilt on demand; the analysis caches live elsewhere
  // (`sidecars/`, `brain.sqlite`) and are deliberately untouched, so this costs no re-billing.
  rmSync(dir, { recursive: true, force: true });
}

async function runCase(goldenCase, run) {
  forgetPriorRunMemory(goldenCase.project);
  const { project: base, brollAssetIds, musicAssetId } = REPLAY ? composeProjectForReplay(goldenCase) : composeProject(goldenCase);
  // Only the beat scenarios need it, and only they pay for the analysis.
  const beatTimes = goldenCase.turns.some((t) => t.beatPeriodSeconds !== undefined)
    ? await detectedBeatTimes(base, musicAssetId)
    : undefined;
  let project = base;
  let history = [];
  let carriedForward;
  const turnRecords = [];
  for (const [turnIndex, turn] of goldenCase.turns.entries()) {
    const t0 = Date.now();
    let keepClipIds;
    if (turn.keep === 'first-last') {
      const clips = pictureClips(project);
      keepClipIds = clips.length ? [clips[0].id, clips.at(-1).id] : [];
    }
    let outcome;
    try {
      outcome = await runTurnWithBackoff({ project, turn, history, scenarioId: goldenCase.id, run, turnIndex, carriedForward });
    } catch (error) {
      turnRecords.push({ turnIndex, prompt: turn.prompt, rubric: turn.rubric, expectedIntent: turn.intent, crashed: String(error), wallMs: Date.now() - t0 });
      process.stdout.write(`   turn ${turnIndex + 1}: CRASH ${String(error).slice(0, 200)}\n`);
      break;
    }
    if (DUMP_DIR) {
      mkdirSync(DUMP_DIR, { recursive: true });
      writeFileSync(join(DUMP_DIR, `${LABEL}-${goldenCase.id}-r${run}-t${turnIndex + 1}.json`), JSON.stringify(compactEvents(outcome.events), null, 1));
    }
    const score = scoreMissionScenario(turn.rubric, {
      before: project,
      after: outcome.working,
      beatPeriodSeconds: turn.beatPeriodSeconds,
      beatTimes,
      keepClipIds,
      expectedFirstClipEndSeconds: turn.expectedFirstClipEndSeconds,
      durationTargetSeconds: turn.durationTargetSeconds,
      brollAssetIds,
      cutawayWindowSeconds: turn.cutawayWindowSeconds,
      musicAssetId,
      expectedHeadTrimSeconds: turn.expectedHeadTrimSeconds,
      captionStyle: turn.captionStyle,
    });
    const golden = measureGoldenTurn({
      events: outcome.events,
      startedAt: outcome.startedAt,
      wallMs: outcome.metrics.wallMs,
      harnessTimedOut: outcome.harnessTimedOut,
      before: project,
      appliedPatches: outcome.appliedPatches,
      rubric: score,
      expectedIntent: turn.intent,
      modelCalls: outcome.metrics.modelCalls,
      toolCalls: outcome.metrics.toolCalls,
      tokens: { prompt: outcome.metrics.tokens.prompt, output: outcome.metrics.tokens.output },
      usd: outcome.metrics.usd,
    });
    turnRecords.push({
      turnIndex,
      prompt: turn.prompt,
      rubric: turn.rubric,
      expectedIntent: turn.intent,
      score: score.score,
      checks: score.checks,
      golden,
      asked: outcome.asked,
      assistantText: outcome.assistantText.slice(0, 600),
      recording: outcome.recordingFile ? outcome.recordingFile.slice(REPO.length + 1) : null,
      metrics: outcome.metrics,
      timelineAfter: {
        durationSeconds: sdk.projectDuration(outcome.working),
        pictureClips: pictureClips(outcome.working).length,
        tracks: outcome.working.timeline.tracks.map((t) => ({ id: t.id, type: t.type, clips: t.clips.length })),
      },
    });
    const m = outcome.metrics;
    process.stdout.write(
      `   turn ${turnIndex + 1}: intent=${golden.intent.observed}${golden.intent.ok ? '' : ' (expected ' + turn.intent + ')'} calls=${m.modelCalls} prompt=${m.tokens.prompt} out=${m.tokens.output} tools=${m.toolCalls} ops=${m.operations} wall=${(m.wallMs / 1000).toFixed(0)}s usd=${m.usd ?? '?'} score=${score.score.toFixed(2)} first-pass=${golden.firstPass ? 'yes' : 'no'} undo=${golden.reversibility.ok === null ? 'n/a' : golden.reversibility.ok ? 'ok' : 'FAIL'}${golden.silentSuccess ? ' SILENT-SUCCESS' : ''}\n`,
    );
    for (const c of score.checks.filter((x) => !x.ok)) process.stdout.write(`      ✗ ${c.id}: ${c.detail}\n`);
    // `ok: null` is "not checkable from this evidence" — printing it as ✗ would be the very
    // collapse of unknown into failure the metric exists to prevent.
    if (golden.reversibility.ok === false) process.stdout.write(`      ✗ undo: ${golden.reversibility.detail}\n`);
    history = [...history, { role: 'user', content: turn.prompt }, { role: 'assistant', content: outcome.assistantText || '(edit applied)' }];
    project = outcome.working;
    carriedForward = outcome.lastWorking;
  }
  return { scenario: goldenCase.id, category: goldenCase.category, project: goldenCase.project, run, replayed: REPLAY, turns: turnRecords };
}

/** On replay the fixture may be absent; the recorded run's project is what the recording assumes. */
function composeProjectForReplay(goldenCase) {
  if (existsSync(join(FIXTURES, `${goldenCase.project}.fp.json`))) return composeProject(goldenCase);
  throw new Error(`replay of ${goldenCase.id} needs the fixture project ${goldenCase.project}.fp.json (the replay reproduces the model's answers; the project is still the input)`);
}

// ── Main loop: per-case result files are the resume unit ─────────────────────────────
const results = [];
mkdirSync(CASES_DIR, { recursive: true });
for (const goldenCase of selected) {
  for (let run = 1; run <= RUNS; run++) {
    const file = caseResultPath(goldenCase.id, run);
    if (!FORCE && !REPLAY && existsSync(file)) {
      results.push(JSON.parse(readFileSync(file, 'utf8')));
      process.stdout.write(`▶ ${goldenCase.id} run ${run}/${RUNS}: cached (${file.slice(REPO.length + 1)}; --force to redo)\n`);
      continue;
    }
    process.stdout.write(`▶ ${goldenCase.id} run ${run}/${RUNS}${REPLAY ? ' (replay)' : ''}\n`);
    const result = await runCase(goldenCase, run);
    // Stamp WHO produced this case. Results are resumable across invocations, so a summary
    // rebuilt later must report the provider that answered these turns rather than whatever
    // is configured now — a rebuild with no env set was labelling a Sonnet run `mock`.
    result.provider = providerName;
    result.model = modelName;
    results.push(result);
    writeFileSync(file, JSON.stringify(result, null, 2));
    writeOutputs();
  }
}
writeOutputs();
process.stdout.write(`wrote ${OUT.slice(REPO.length + 1)}, ${join(RUN_DIR, 'summary.json').slice(REPO.length + 1)}, ${join(RUN_DIR, 'summary.md').slice(REPO.length + 1)}\n`);

function writeOutputs() {
  const generatedAt = new Date().toISOString();
  const rows = results.flatMap((r) => r.turns.filter((t) => t.golden).map((t) => ({ caseId: r.scenario, category: r.category, turnIndex: t.turnIndex, run: r.run, metrics: t.golden })));
  const summary = summarizeGoldenRun(rows);
  const crashed = results.flatMap((r) => r.turns.filter((t) => t.crashed).map((t) => `${r.scenario} r${r.run} t${t.turnIndex + 1}: ${t.crashed.slice(0, 200)}`));
  // Read the provider off the RESULTS, not off this process: cached cases may have been
  // produced by another invocation, and a header naming the wrong model is worse than none.
  // A run assembled from more than one is named as the mixture it is — which is also how a
  // half-re-run baseline stops passing itself off as coherent.
  const stamps = [...new Set(results.map((r) => `${r.provider ?? '?'} / ${r.model ?? '?'}`))].sort();
  const unstamped = results.some((r) => r.provider === undefined);
  const [provider, model] =
    stamps.length === 1 && !unstamped
      ? [results[0].provider, results[0].model]
      : [`mixed (${stamps.join('; ')})`, 'see provider'];
  const meta = { label: LABEL, generatedAt, provider, model, runsPerScenario: RUNS, replayed: REPLAY };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ ...meta, results, golden: summary }, null, 2));
  writeFileSync(join(RUN_DIR, 'summary.json'), JSON.stringify({ ...meta, cases: selected.map((c) => c.id), crashed, summary }, null, 2));
  const md = renderGoldenSummary(summary, meta) + (crashed.length ? `\nCrashed turns:\n${crashed.map((c) => `- ${c}`).join('\n')}\n` : '');
  writeFileSync(join(RUN_DIR, 'summary.md'), md);
}
