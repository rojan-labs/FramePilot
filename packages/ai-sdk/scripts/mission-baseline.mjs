#!/usr/bin/env node
/**
 * Mission baseline runner (plan/system-mission P0.2/P0.3, re-run by every later phase).
 *
 * Drives the real `Orchestrator.streamAgent` path — the same class the desktop main
 * process constructs — with the real configured provider, the real sidecar executor
 * (analysis, frames, transcription against the mission fixture projects), and folds every
 * valid diff into a working project exactly as the host does. For each run it records
 * what the mission optimizes: model calls, tokens (in/out/cached) per call, context
 * composition per request (from the token manifest), tool calls and repeats, analysis
 * cache hits, wall time, cost, and the rubric score of the resulting timeline.
 *
 * Nothing here is estimated: a number missing from the provider is reported missing.
 *
 * Usage (sidecar running with FRAMEPILOT_PROJECTS_ROOT=tests/fixtures/mission/projects):
 *   node scripts/mission-baseline.mjs [--runs 3] [--only montage-30s,beat-sync] [--out reports/system-mission/baseline-orchestration.json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  createProviderFromConfig,
  resolveProviderConfig,
  createSidecarExecutor,
  scoreMissionScenario,
  summarizeRunMetrics,
  pictureClips,
} = sdk;

const args = parseArgs(process.argv.slice(2));
const RUNS = Number(args.runs ?? 3);
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const OUT = resolve(REPO, String(args.out ?? 'reports/system-mission/baseline-orchestration.json'));
const LABEL = String(args.label ?? 'baseline');
const DUMP_DIR = args['dump-events'] ? resolve(REPO, String(args['dump-events'] === true ? 'reports/system-mission/runs' : args['dump-events'])) : null;
const BASE_URL = process.env.FRAMEPILOT_PYTHON_API_URL ?? 'http://127.0.0.1:8799';
const FIXTURES = join(REPO, 'tests', 'fixtures', 'mission', 'projects');
const providerName = process.env.FRAMEPILOT_AI_PROVIDER ?? 'deepseek';

/** One scenario = one or more turns against one fixture project. Prompts are what a user types. */
const SCENARIOS = [
  {
    id: 'montage-30s',
    project: 'mission-montage',
    turns: [
      {
        prompt:
          'Create a 30-second fast-paced social montage from the raw footage on the timeline. Pick the strongest moments, vary the shot lengths, keep it vertical.',
        rubric: 'montage-30s',
      },
    ],
  },
  {
    id: 'podcast-highlight-60s',
    project: 'mission-podcast',
    turns: [
      {
        prompt: 'Pull the best 60 seconds of this recording into a highlight clip. Do not cut mid-sentence.',
        rubric: 'podcast-highlight-60s',
      },
    ],
  },
  {
    id: 'remove-dead-air',
    project: 'mission-podcast',
    turns: [{ prompt: 'Remove the dead air and long pauses from this recording.', rubric: 'remove-dead-air' }],
  },
  {
    id: 'beat-sync',
    project: 'mission-montage',
    turns: [
      {
        prompt:
          'Put the 100 BPM music track (beat-100bpm) under the footage and cut the picture to the beat. Aim for about 30 seconds.',
        rubric: 'beat-sync',
        beatPeriodSeconds: 0.6,
      },
    ],
  },
  {
    id: 'refine-tighten',
    project: 'mission-montage',
    turns: [
      { prompt: 'Create a 30-second fast-paced social montage from the raw footage on the timeline.', rubric: 'montage-30s' },
      {
        prompt: 'Tighten the middle section so it moves faster, but keep the first and last clips exactly as they are.',
        rubric: 'refine-tighten',
        keep: 'first-last',
      },
    ],
  },
  {
    id: 'memory-captions',
    project: 'mission-talk',
    turns: [
      { prompt: 'Cut this down to the best 45 seconds.', rubric: 'podcast-highlight-60s' },
      { prompt: 'Add captions in a bold, uppercase, centered style.', rubric: 'memory-captions' },
      { prompt: 'Trim the last clip by two seconds and keep the captions in the same style.', rubric: 'memory-captions' },
    ],
  },
];

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

function loadProject(id) {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${id}.fp.json`), 'utf8'));
  const { schemaVersion: _v, ...project } = raw;
  return parseProject(project);
}

function sectionTotals(manifest) {
  const byType = {};
  for (const s of manifest?.sections ?? []) {
    if (!s.included) continue;
    byType[s.type] = (byType[s.type] ?? 0) + s.tokenEstimate;
  }
  return byType;
}

async function runTurn({ project, prompt, history, scenarioId, turnIndex }) {
  const provider = createProviderFromConfig(resolveProviderConfig(providerName));
  const capture = new BaselineCaptureProvider(provider);
  const executor = createSidecarExecutor({ baseUrl: BASE_URL });
  const orchestrator = new Orchestrator(capture, { executor });
  const started = Date.now();
  const events = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MISSION_TURN_TIMEOUT_MS ?? 20 * 60_000));
  let working = project;
  let assistantText = '';
  try {
    for await (const event of orchestrator.streamAgent(
      { project, userPrompt: prompt, history },
      { conversationId: `mission-${scenarioId}`, turnId: `mission-${scenarioId}-t${turnIndex}`, signal: controller.signal },
      {},
    )) {
      events.push(event);
      if (event.type === 'diff' && event.edit.validation.valid) {
        const before = event.scope === 'turn' ? working : project;
        working = applyProjectPatch(before, event.edit.patch);
      }
      if (event.type === 'assistant_message') assistantText = event.text ?? assistantText;
    }
  } finally {
    clearTimeout(timeout);
  }
  const wallMs = Date.now() - started;
  const turns = capture.captured();
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
  return {
    working,
    assistantText,
    metrics: {
      wallMs,
      modelCalls: turns.length,
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
      summary: summarizeRunMetrics(turns),
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
    events,
  };
}

function sum(arr, key) {
  return arr.reduce((s, t) => s + (t[key] ?? 0), 0);
}
function countBy(arr, f) {
  const out = {};
  for (const x of arr) out[f(x)] = (out[f(x)] ?? 0) + 1;
  return out;
}

const results = [];
for (const scenario of SCENARIOS) {
  if (ONLY && !ONLY.has(scenario.id)) continue;
  for (let run = 1; run <= RUNS; run++) {
    const base = loadProject(scenario.project);
    let project = base;
    let history = [];
    const turnRecords = [];
    process.stdout.write(`▶ ${scenario.id} run ${run}/${RUNS}\n`);
    for (const [turnIndex, turn] of scenario.turns.entries()) {
      const t0 = Date.now();
      let keepClipIds;
      if (turn.keep === 'first-last') {
        const clips = pictureClips(project);
        keepClipIds = clips.length ? [clips[0].id, clips.at(-1).id] : [];
      }
      let outcome;
      try {
        outcome = await runTurn({ project, prompt: turn.prompt, history, scenarioId: scenario.id, turnIndex });
      } catch (error) {
        turnRecords.push({ turnIndex, prompt: turn.prompt, crashed: String(error), wallMs: Date.now() - t0 });
        process.stdout.write(`   turn ${turnIndex + 1}: CRASH ${String(error).slice(0, 200)}\n`);
        break;
      }
      if (DUMP_DIR) {
        mkdirSync(DUMP_DIR, { recursive: true });
        const compact = outcome.events.map((e) => {
          const { type } = e;
          if (type === 'assistant_delta' || type === 'reasoning_delta') return null;
          const c = { ...e };
          if (c.manifest) c.manifest = { sections: c.manifest.sections.filter((x) => x.included).map((x) => ({ type: x.type, label: x.label, tokens: x.tokenEstimate })), usage: c.manifest.usage };
          if (c.edit) c.edit = { valid: c.edit.validation?.valid, ops: c.edit.patch?.operations?.map((o) => o.type), text: String(c.edit.text ?? '').slice(0, 300) };
          if (c.result !== undefined) c.result = String(JSON.stringify(c.result)).slice(0, 400);
          if (c.input !== undefined) c.input = String(JSON.stringify(c.input)).slice(0, 300);
          return c;
        }).filter(Boolean);
        writeFileSync(join(DUMP_DIR, `${LABEL}-${scenario.id}-r${run}-t${turnIndex + 1}.json`), JSON.stringify(compact, null, 1));
      }
      const score = scoreMissionScenario(turn.rubric, {
        before: project,
        after: outcome.working,
        beatPeriodSeconds: turn.beatPeriodSeconds,
        keepClipIds,
      });
      turnRecords.push({
        turnIndex,
        prompt: turn.prompt,
        rubric: turn.rubric,
        score: score.score,
        checks: score.checks,
        metrics: outcome.metrics,
        timelineAfter: {
          durationSeconds: sdk.projectDuration(outcome.working),
          pictureClips: pictureClips(outcome.working).length,
          tracks: outcome.working.timeline.tracks.map((t) => ({ id: t.id, type: t.type, clips: t.clips.length })),
        },
      });
      process.stdout.write(
        `   turn ${turnIndex + 1}: calls=${outcome.metrics.modelCalls} prompt=${outcome.metrics.tokens.prompt} out=${outcome.metrics.tokens.output} tools=${outcome.metrics.toolCalls} (repeat ${outcome.metrics.repeatedToolCalls}) ops=${outcome.metrics.operations} wall=${(outcome.metrics.wallMs / 1000).toFixed(0)}s usd=${outcome.metrics.usd ?? '?'} score=${score.score.toFixed(2)}\n`,
      );
      history = [...history, { role: 'user', content: turn.prompt }, { role: 'assistant', content: outcome.assistantText || '(edit applied)' }];
      project = outcome.working;
    }
    results.push({ scenario: scenario.id, project: scenario.project, run, turns: turnRecords });
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        { label: LABEL, generatedAt: new Date().toISOString(), provider: providerName, model: resolveProviderConfig(providerName).model, runsPerScenario: RUNS, results },
        null,
        2,
      ),
    );
  }
}
process.stdout.write(`wrote ${OUT}\n`);
