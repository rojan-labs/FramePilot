/**
 * Context-management benchmark for the FramePilot AI layer.
 *
 * Measures WHAT the model is actually shown, not how good its answers are. Every figure
 * is deterministic and model-free: no network, no provider key, no judgement call. That
 * is the point — it isolates context management from model choice, prompt wording and
 * tool correctness, so a before/after comparison attributes a change to the context
 * layer alone.
 *
 * Four sections:
 *
 *   A. Fixed overhead      — what every agent turn pays before it says anything about
 *                            the user's video (system contract, agent contract, tool
 *                            schemas, skills manifest).
 *   B. Grounding coverage  — the fraction of the project's clips and spoken words that
 *                            reach the prompt at four project scales. Flat caps mean
 *                            this falls as projects grow; that fall is the metric.
 *   C. Live agent loop     — a real `streamAgent` run against a recording provider,
 *                            reporting per-turn prompt composition, cache-prefix
 *                            stability, and whether an early read survives to late turns.
 *   D. Budget safety       — the room `assembleContext` trims against vs the room the
 *                            selected model actually has.
 *
 * Usage:  node scripts/context-benchmark.mjs [--json <path>]
 * Requires `dist/` to be built (`pnpm --filter @framepilot/ai-sdk build`).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.FRAMEPILOT_LOG_LEVEL ??= 'silent';

const HERE = dirname(fileURLToPath(import.meta.url));
const sdk = await import(join(HERE, '..', 'dist', 'index.js'));
const { parseProject } = await import('@framepilot/timeline-schema');
const { classifyTool } = await import(join(HERE, '..', 'dist', 'tool-classification.js'));

const {
  Orchestrator,
  SYSTEM_PROMPT,
  BUNDLED_SKILLS,
  DEFAULT_CONTEXT_BUDGET,
  agentModeInstruction,
  assembleContext,
  budgetTokens,
  capabilitiesFor,
  estimateTokens,
  resolveContextBudget,
  summarizeSkillsManifest,
  toolDescriptors,
} = sdk;

const tok = (v) => estimateTokens(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
const out = { generatedBy: 'scripts/context-benchmark.mjs' };

// ---------------------------------------------------------------- A. fixed overhead
const allTools = toolDescriptors(() => true);
const roleOf = (spec) => (spec.mutates ? 'mutation' : classifyTool(spec.name, spec.kind).role);
const execTools = toolDescriptors((s) => {
  const r = roleOf(s);
  return r !== 'analysis' && r !== 'guidance';
});

const fixed = {
  systemContract: tok(SYSTEM_PROMPT),
  agentContractVision: tok(agentModeInstruction({ canSeeFrames: true })),
  agentContractNoVision: tok(agentModeInstruction({ canSeeFrames: false })),
  skillsManifest: tok(summarizeSkillsManifest(BUNDLED_SKILLS)),
  skillCount: BUNDLED_SKILLS.length,
  toolSchemasPlanningStages: { tools: allTools.length, tokens: tok(allTools) },
  toolSchemasExecutionStages: { tools: execTools.length, tokens: tok(execTools) },
};
fixed.totalPlanningTurnOverhead =
  fixed.systemContract +
  fixed.agentContractVision +
  fixed.skillsManifest +
  fixed.toolSchemasPlanningStages.tokens;
out.fixedOverhead = fixed;

console.log('## A. Fixed per-turn overhead (agent mode, before any project state)\n');
console.log(`  system contract          ${fixed.systemContract}`);
console.log(`  agent contract (vision)  ${fixed.agentContractVision}`);
console.log(`  skills manifest (${fixed.skillCount})     ${fixed.skillsManifest}`);
console.log(
  `  tool schemas, planning   ${fixed.toolSchemasPlanningStages.tokens}  (${fixed.toolSchemasPlanningStages.tools} tools)`,
);
console.log(
  `  tool schemas, execution  ${fixed.toolSchemasExecutionStages.tokens}  (${fixed.toolSchemasExecutionStages.tools} tools)`,
);
console.log(`  ── planning-turn total   ${fixed.totalPlanningTurnOverhead}\n`);

// ------------------------------------------------------------- B. grounding coverage
function project({ clips, words, tracks = 2 }) {
  const trackList = [];
  for (let t = 0; t < tracks; t += 1) {
    const n = t === 0 ? clips : Math.ceil(clips / 4);
    const cs = [];
    for (let i = 0; i < n; i += 1) {
      cs.push({
        id: `clip_${t}_${i}`,
        assetId: 'asset_1',
        trackId: `track_${t}`,
        start: i * 4,
        end: i * 4 + 4,
        sourceStart: 0,
        sourceEnd: 4,
        effects: [],
        keyframes: [],
      });
    }
    trackList.push({ id: `track_${t}`, type: t === 0 ? 'video' : 'audio', clips: cs });
  }
  const transcript = [];
  for (let i = 0; i < words; i += 1) {
    transcript.push({ word: `word${i}`, start: i * 0.4, end: i * 0.4 + 0.35 });
  }
  return parseProject({
    id: 'proj_bench',
    name: 'Benchmark',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: clips * 4 }],
    timeline: { tracks: trackList, revision: 1 },
    transcript,
    aiMemory: {},
    history: [],
  });
}

const SCALES = [
  { label: 'small   (1 min)', clips: 15, words: 150 },
  { label: 'medium (10 min)', clips: 150, words: 1_500 },
  { label: 'large  (60 min)', clips: 900, words: 9_000 },
  { label: 'huge    (4 h)', clips: 3_600, words: 36_000 },
];
const REQUEST = 'Cut this down to a 45 second reel of the best moments.';

/**
 * The budget a REAL agent turn assembles under, on the default model — the model's own
 * window minus its output reservation minus the tool schemas and agent contract the
 * assembler never sees (P1.2). Before P1.2 every row below was measured against one
 * hardcoded 190K; measuring against the real number is the point of the fix.
 */
const BENCH_PROVIDER = { name: 'anthropic', modelId: 'claude-opus-4-5' };
const benchBudget = (p) =>
  resolveContextBudget(
    { project: p, userPrompt: REQUEST },
    BENCH_PROVIDER,
    fixed.toolSchemasPlanningStages.tokens + fixed.agentContractVision,
  );

console.log('## B. Grounding coverage — how much of the project reaches the prompt\n');
console.log(
  '  scale            | clips | shown | coverage | words  | shown | coverage | state tokens',
);
console.log(
  '  -----------------|-------|-------|----------|--------|-------|----------|-------------',
);
out.grounding = [];
for (const s of SCALES) {
  const p = project({ clips: s.clips, words: s.words });
  const a = assembleContext({ project: p, userPrompt: REQUEST, budget: benchBudget(p) });
  const body = a.messages[a.messages.length - 1].content;
  const totalClips = p.timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
  const shownClips = p.timeline.tracks.reduce(
    (n, t) => n + t.clips.filter((c) => body.includes(`${c.id}[`)).length,
    0,
  );
  const shownWords = p.transcript.filter((w) => body.includes(w.word)).length;
  const stateTokens = a.sections
    .filter((x) => x.included && (x.tier === 'timeline' || x.tier === 'transcript'))
    .reduce((n, x) => n + x.tokenEstimate, 0);
  const row = {
    scale: s.label.trim(),
    totalClips,
    shownClips,
    clipCoverage: shownClips / totalClips,
    totalWords: s.words,
    shownWords,
    wordCoverage: shownWords / s.words,
    projectStateTokens: stateTokens,
    trimmedTiers: [...a.trimmed],
  };
  out.grounding.push(row);
  console.log(
    `  ${s.label.padEnd(16)} | ${String(totalClips).padStart(5)} | ${String(shownClips).padStart(5)} | ${pct(shownClips, totalClips).padStart(8)} | ${String(s.words).padStart(6)} | ${String(shownWords).padStart(5)} | ${pct(shownWords, s.words).padStart(8)} | ${stateTokens}`,
  );
}
console.log();

// B2: the same projects, but with a selection — the focus path (K2.2/B3) engaged.
console.log('## B2. Same projects WITH a 30s selection (the focus/retrieval path)\n');
console.log(
  '  scale            | clips | shown | coverage | words  | shown | coverage | state tokens',
);
console.log(
  '  -----------------|-------|-------|----------|--------|-------|----------|-------------',
);
out.groundingFocused = [];
for (const s of SCALES) {
  const p = project({ clips: s.clips, words: s.words });
  const mid = (s.clips * 4) / 2;
  const a = assembleContext({
    project: p,
    userPrompt: REQUEST,
    selection: { start: mid, end: mid + 30 },
    budget: benchBudget(p),
  });
  const body = a.messages[a.messages.length - 1].content;
  const totalClips = p.timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
  const shownClips = p.timeline.tracks.reduce(
    (n, t) => n + t.clips.filter((c) => body.includes(`${c.id}[`)).length,
    0,
  );
  const shownWords = p.transcript.filter((w) => body.includes(w.word)).length;
  const stateTokens = a.sections
    .filter((x) => x.included && (x.tier === 'timeline' || x.tier === 'transcript'))
    .reduce((n, x) => n + x.tokenEstimate, 0);
  out.groundingFocused.push({
    scale: s.label.trim(),
    totalClips,
    shownClips,
    clipCoverage: shownClips / totalClips,
    totalWords: s.words,
    shownWords,
    wordCoverage: shownWords / s.words,
    projectStateTokens: stateTokens,
  });
  console.log(
    `  ${s.label.padEnd(16)} | ${String(totalClips).padStart(5)} | ${String(shownClips).padStart(5)} | ${pct(shownClips, totalClips).padStart(8)} | ${String(s.words).padStart(6)} | ${String(shownWords).padStart(5)} | ${pct(shownWords, s.words).padStart(8)} | ${stateTokens}`,
  );
}
console.log();

// B3: the same 60-minute project, asked two different questions (P2.2). Retrieval used to
// have ONE query — "near the playhead" — and it always narrowed, so both of these produced
// the same 11 clips and 97 words. A local request should be narrow and dense; a global one
// wide and sparse, reaching the far end of the recording.
console.log('## B3. One long project, two requests — does the ask change the retrieval?\n');
const b3Project = project({ clips: 900, words: 9_000 });
const b3Mid = (900 * 4) / 2;
const B3_CASES = [
  { label: 'local  ("tighten this")', prompt: 'tighten this' },
  {
    label: 'global ("find the best")',
    prompt: 'find the three strongest moments across the whole recording',
  },
];
console.log(
  '  request                  | clips | words | first shown | last shown | span covered | tokens',
);
console.log(
  '  -------------------------|-------|-------|-------------|------------|--------------|-------',
);
out.retrievalByRequest = [];
for (const c of B3_CASES) {
  const a = assembleContext({
    project: b3Project,
    userPrompt: c.prompt,
    selection: { start: b3Mid, end: b3Mid + 30 },
    // A budget too small for the whole project: ranking only decides what does NOT fit.
    budget: { contextWindow: 9_000, maxOutputTokens: 4_000, headroom: 0 },
  });
  const body = a.messages[a.messages.length - 1].content;
  const shown = b3Project.timeline.tracks
    .flatMap((t) => t.clips)
    .filter((clip) => body.includes(`${clip.id}[`));
  const shownWords = b3Project.transcript.filter((w) => body.includes(w.word));
  const first = shown.length > 0 ? Math.min(...shown.map((c) => c.start)) : 0;
  const last = shown.length > 0 ? Math.max(...shown.map((c) => c.end)) : 0;
  const projectSpan = 900 * 4;
  const stateTokens = a.sections
    .filter((x) => x.included && (x.tier === 'timeline' || x.tier === 'transcript'))
    .reduce((n, x) => n + x.tokenEstimate, 0);
  out.retrievalByRequest.push({
    request: c.prompt,
    clipsShown: shown.length,
    wordsShown: shownWords.length,
    firstShownSecond: first,
    lastShownSecond: last,
    spanCoverage: (last - first) / projectSpan,
    projectStateTokens: stateTokens,
  });
  console.log(
    `  ${c.label.padEnd(24)} | ${String(shown.length).padStart(5)} | ${String(shownWords.length).padStart(5)} | ${`${first.toFixed(0)}s`.padStart(11)} | ${`${last.toFixed(0)}s`.padStart(10)} | ${pct(last - first, projectSpan).padStart(12)} | ${stateTokens}`,
  );
}
console.log();

// ------------------------------------------------------------------ C. live agent loop
class RecordingProvider {
  name = 'mock';
  modelId = 'claude-opus-4-5';
  #i = 0;
  constructor(script, sink) {
    this.script = script;
    this.sink = sink;
  }
  async complete(request) {
    this.sink.push({
      messages: request.messages.map((m) => ({
        role: m.role,
        tokens: tok(m.content),
        cacheBoundary: !!m.cacheBoundary,
        content: m.content,
      })),
      toolTokens: tok(request.tools ?? []),
      toolCount: (request.tools ?? []).length,
    });
    const r = this.script[Math.min(this.#i, this.script.length - 1)];
    this.#i += 1;
    return r;
  }
}

const call = (id, name, args) => ({ id, name, arguments: args });
const SCRIPT = [
  { text: 'Reading the timeline.', toolCalls: [call('c1', 'get_timeline_summary', {})] },
  { text: 'Reading the transcript.', toolCalls: [call('c2', 'get_transcript', {})] },
  { text: 'Listing assets.', toolCalls: [call('c3', 'list_assets', {})] },
  {
    text: 'Trimming the top.',
    toolCalls: [call('c4', 'delete_range', { trackId: 'track_0', start: 0, end: 4 })],
  },
  {
    text: 'Trimming again.',
    toolCalls: [call('c5', 'delete_range', { trackId: 'track_0', start: 12, end: 16 })],
  },
  {
    text: 'And again.',
    toolCalls: [call('c6', 'delete_range', { trackId: 'track_0', start: 40, end: 44 })],
  },
  {
    text: 'And once more.',
    toolCalls: [call('c7', 'delete_range', { trackId: 'track_0', start: 60, end: 64 })],
  },
  { text: 'Done.', toolCalls: [] },
];

const requests = [];
const orch = new Orchestrator(new RecordingProvider(SCRIPT, requests));
const benchProject = project({ clips: 300, words: 4_000 });
for await (const event of orch.streamAgent(
  { project: benchProject, userPrompt: REQUEST },
  { conversationId: 'conv_bench', turnId: 'turn_bench', now: () => 1000 },
  {},
)) {
  void event;
}

console.log('## C. Live agent run — per-turn prompt composition (300 clips / 4000 words)\n');
console.log('  turn | msgs | msg tok | tool tok | TOTAL | stable prefix | cached prefix share');
console.log('  -----|------|---------|----------|-------|---------------|--------------------');
out.agentRun = { turns: [] };
let previous = null;
for (const [i, r] of requests.entries()) {
  const msgTokens = r.messages.reduce((n, m) => n + m.tokens, 0);
  const total = msgTokens + r.toolTokens;
  // Bytes of the message prefix identical to the previous request's, message by message.
  let stablePrefixTokens = 0;
  if (previous) {
    for (let j = 0; j < Math.min(previous.messages.length, r.messages.length); j += 1) {
      if (previous.messages[j].content === r.messages[j].content)
        stablePrefixTokens += r.messages[j].tokens;
      else break;
    }
  }
  // What Anthropic would actually cache: everything up to and including the last
  // cacheBoundary message, plus the tool schemas (which sit above messages in the
  // cache hierarchy) — but only the part that is byte-identical to last turn.
  const boundary = r.messages.reduce((last, m, idx) => (m.cacheBoundary ? idx : last), -1);
  const boundaryTokens =
    boundary < 0 ? 0 : r.messages.slice(0, boundary + 1).reduce((n, m) => n + m.tokens, 0);
  const cacheable = previous ? Math.min(stablePrefixTokens, boundaryTokens) + r.toolTokens : 0;
  const row = {
    turn: i,
    messages: r.messages.length,
    messageTokens: msgTokens,
    toolTokens: r.toolTokens,
    toolCount: r.toolCount,
    totalTokens: total,
    stablePrefixTokens,
    cacheablePrefixTokens: cacheable,
    cacheableShare: total === 0 ? 0 : cacheable / total,
  };
  out.agentRun.turns.push(row);
  console.log(
    `  ${String(i).padStart(4)} | ${String(r.messages.length).padStart(4)} | ${String(msgTokens).padStart(7)} | ${String(r.toolTokens).padStart(8)} | ${String(total).padStart(5)} | ${String(stablePrefixTokens).padStart(13)} | ${pct(cacheable, total).padStart(19)}`,
  );
  previous = r;
}

// Tool-set churn: the tool block sits ABOVE the messages in the provider's cache
// hierarchy, so any change to it invalidates the whole cached prefix for that turn.
let churn = 0;
let rebilled = 0;
for (let i = 1; i < requests.length; i += 1) {
  if (requests[i].toolTokens !== requests[i - 1].toolTokens) {
    churn += 1;
    rebilled += requests[i].toolTokens;
  }
}
out.agentRun.toolSetChurn = {
  changes: churn,
  tokensRebilledAtFullPrice: rebilled,
  turns: requests.length,
};
console.log(
  `\n  tool-set changes during the run: ${churn} (stage policy swaps the descriptor set)`,
);
console.log(`  tokens re-billed at full price by those swaps: ${rebilled}`);

// Retention: does the FIRST read's payload still appear in the LAST request?
const last = requests[requests.length - 1];
const lastBody = last.messages.map((m) => m.content).join('\n');
const cleared = (lastBody.match(/old result cleared/g) ?? []).length;
const summarizedAway = /earlier steps? summarized for brevity/.test(lastBody);
out.agentRun.retention = {
  clearedPayloadsInFinalPrompt: cleared,
  earlierStepsCollapsed: summarizedAway,
  finalPromptTokens: last.messages.reduce((n, m) => n + m.tokens, 0) + last.toolTokens,
  firstTurnPromptTokens:
    requests[0].messages.reduce((n, m) => n + m.tokens, 0) + requests[0].toolTokens,
};
console.log(`\n  payloads cleared in final prompt: ${cleared}`);
console.log(`  earlier steps collapsed to a digest line: ${summarizedAway}`);
console.log(
  `  prompt growth over the run: ${out.agentRun.retention.firstTurnPromptTokens} → ${out.agentRun.retention.finalPromptTokens} tokens\n`,
);

// --------------------------------------------------------------- D. budget safety
// The room the trimmer decides against, per model, INCLUDING the prompt cost the
// assembler does not build (tool schemas + the agent contract). Before P1.2 this was one
// hardcoded number for every model — `DEFAULT_CONTEXT_BUDGET`'s 183,904 — which is kept
// in the `legacyAssumedRoom` column so the delta the fix closed stays visible.
const legacyAssumedRoom =
  DEFAULT_CONTEXT_BUDGET.contextWindow -
  DEFAULT_CONTEXT_BUDGET.maxOutputTokens -
  DEFAULT_CONTEXT_BUDGET.headroom;
const agentTurnFixedCost = fixed.toolSchemasPlanningStages.tokens + fixed.agentContractVision;
const PROBES = [
  ['anthropic', 'claude-opus-4-5'],
  ['openai', 'gpt-4o'],
  ['groq', 'llama-3.3-70b-versatile'],
  ['ollama', 'llama3.2'],
  ['ollama', 'qwen2.5-coder'],
  ['google', 'gemini-2.5-pro'],
  ['openrouter', 'a-model-not-in-the-catalog'],
];
console.log('## D. Budget safety — what the trimmer assumes vs what the model has\n');
console.log(
  `  an agent turn also pays ${agentTurnFixedCost} tokens the assembler never sees ` +
    '(tool schemas + agent contract)',
);
console.log(`  before P1.2 every model trimmed against ${legacyAssumedRoom} tokens\n`);
console.log(
  '  provider/model                        | real room | trimmer room | over-assumption | risk',
);
console.log(
  '  --------------------------------------|-----------|--------------|-----------------|----------------',
);
out.budgetSafety = { legacyAssumedRoom, agentTurnFixedCost, models: [] };
for (const [p, id] of PROBES) {
  const c = capabilitiesFor(p, id);
  const realRoom = c.contextWindow - c.maxOutputTokens;
  const budget = resolveContextBudget(
    { project: project({ clips: 4, words: 8 }), userPrompt: REQUEST },
    { name: p, modelId: id },
    agentTurnFixedCost,
  );
  const trimmerRoom = budgetTokens(budget);
  // Positive means the trimmer believes it has room the model does not have — the
  // condition P1.2 exists to make impossible. The exit criterion is ≤ 0 everywhere.
  const overAssumption = trimmerRoom - realRoom;
  const risk = overAssumption > 0 ? 'OVERFLOWS' : 'safe';
  out.budgetSafety.models.push({
    provider: p,
    model: id,
    contextWindow: c.contextWindow,
    maxOutputTokens: c.maxOutputTokens,
    realRoom,
    trimmerRoom,
    overAssumption,
    legacyOverAssumption: legacyAssumedRoom - realRoom,
    source: c.source,
    risk,
  });
  console.log(
    `  ${`${p}/${id}`.padEnd(37)} | ${String(realRoom).padStart(9)} | ${String(trimmerRoom).padStart(12)} | ${String(overAssumption).padStart(15)} | ${risk}`,
  );
}
console.log();

// ------------------------------------------------------- E. read-digest fidelity
// What a READ tool actually hands back to the model. `summarizeReadResult` has a
// hand-written digest per tool that preserves whole records; tools with no case fall
// through to `previewJson(value, 1200)` — a character slice of the raw JSON.
const { summarizeReadResult } = await import(join(HERE, '..', 'dist', 'orchestrator.js'));

const transcript1500 = [];
for (let i = 0; i < 1_500; i += 1)
  transcript1500.push({ word: `word${i}`, start: i * 0.4, end: i * 0.4 + 0.35 });
const signals60 = [];
for (let i = 0; i < 60; i += 1) {
  signals60.push({
    kind: 'highlight',
    t0: i * 10,
    t1: i * 10 + 6,
    observation: `signal${i} a distinct beat worth cutting on`,
    from: 'measured',
  });
}
const assets40 = [];
for (let i = 0; i < 40; i += 1)
  assets40.push({
    id: `asset_${i}`,
    path: `media/clip_${i}.mp4`,
    kind: 'video',
    durationSeconds: 42,
  });

const READ_PROBES = [
  { tool: 'get_transcript', payload: transcript1500, records: 1_500, idPattern: /word\d+/g },
  {
    // `readEditSignals` returns a BARE ARRAY of signals — the earlier `{ signals }`
    // wrapper here was a probe artefact, and it measured the JSON preview rather than
    // what the tool actually hands back.
    tool: 'read_edit_signals',
    payload: signals60,
    records: 60,
    idPattern: /signal\d+/g,
  },
  { tool: 'list_assets', payload: { assets: assets40 }, records: 40, idPattern: /asset_\d+/g },
];

console.log('## E. Read-digest fidelity — what a read tool hands back to the model\n');
console.log(
  '  tool               | records in | surfaced | fidelity | digest tokens | has "N more" tail',
);
console.log(
  '  -------------------|------------|----------|----------|---------------|------------------',
);
out.readDigests = [];
for (const probe of READ_PROBES) {
  const digest = summarizeReadResult(probe.tool, probe.payload);
  const surfaced = new Set(digest.match(probe.idPattern) ?? []).size;
  const hasTail = /more .* not shown|\(… \d+ more/.test(digest);
  out.readDigests.push({
    tool: probe.tool,
    recordsIn: probe.records,
    surfaced,
    fidelity: surfaced / probe.records,
    digestTokens: tok(digest),
    hasMoreTail: hasTail,
  });
  console.log(
    `  ${probe.tool.padEnd(18)} | ${String(probe.records).padStart(10)} | ${String(surfaced).padStart(8)} | ${pct(surfaced, probe.records).padStart(8)} | ${String(tok(digest)).padStart(13)} | ${hasTail}`,
  );
}
console.log();

// ------------------------------------------- E2. declared, recoverable omissions (P2.3)
// Every bounded read must end with a count AND the call that returns the rest — either a
// narrowing argument or an evidence handle. A marker that offers a re-read with no address
// to read from is an apology, not an instruction (see `clearedWithHandle`).
const OMISSION_PROBES = [
  { tool: 'get_transcript', payload: transcript1500.concat(transcript1500).concat(transcript1500) },
  { tool: 'read_edit_signals', payload: signals60 },
  { tool: 'map_footage', payload: { chapters: [], highlights: [], reason: 'not_indexed' } },
  { tool: 'transcribe', payload: { assetId: 'asset_1', words: transcript1500 } },
  { tool: 'index_media', payload: { indexed: 40, total: 11, cursor: 4 } },
  {
    tool: 'measure_color',
    payload: {
      clipId: 'clip_1',
      startFrame: 0,
      endFrame: 300,
      occlusionFree: true,
      samples: [{ frame: 0, channel: 'luma', min: 0, max: 1 }],
    },
  },
  { tool: 'get_selected_range', payload: null },
  { tool: 'get_frame', payload: { timeSeconds: 2, requestedTimeSeconds: 2, clamped: false } },
  {
    tool: 'track_subject_automatically',
    payload: {
      plan: { clipId: 'c1', maskEffectId: 'm1', fps: 30, startSeconds: 0 },
      engine: 'tracking-lite',
      backend: 'csrt',
      samples: [{ frame: 0 }],
    },
  },
];
// An omission is DECLARED when the digest says records were dropped; it is RECOVERABLE
// when it also names how to get them. A digest that ends in a bare `…` is neither, and is
// exactly what the nine fall-through reads used to hand back.
const DECLARES_OMISSION = /\(… \d+ more|not shown|not repeated here|not printed|not\s+listed here/;
const NAMES_RECOVERY =
  /(narrow \w+ to|get_transcript|get_clips|recall_evidence|call index_media again|read them with|professional_color match_reference|tracked patch)/;
console.log('## E2. Declared, recoverable omissions — the nine former fall-through reads\n');
console.log('  tool                       | declares an omission | names how to get it back');
console.log('  ---------------------------|----------------------|--------------------------');
out.omissionHandles = [];
let honest = 0;
for (const probe of OMISSION_PROBES) {
  const digest = summarizeReadResult(probe.tool, probe.payload);
  const declares = DECLARES_OMISSION.test(digest);
  const recovers = NAMES_RECOVERY.test(digest);
  // Honest = it withheld nothing, or it said what and how to get it. And never a bare `…`.
  const ok = (!declares || recovers) && !/…\s*$/.test(digest);
  if (ok) honest += 1;
  out.omissionHandles.push({
    tool: probe.tool,
    declaresOmission: declares,
    namesRecovery: recovers,
    honest: ok,
    digestTokens: tok(digest),
  });
  console.log(
    `  ${probe.tool.padEnd(26)} | ${String(declares).padStart(20)} | ${String(recovers).padStart(24)}${ok ? '' : '   <-- DISHONEST'}`,
  );
}
console.log(`\n  honest digests: ${honest}/${OMISSION_PROBES.length}\n`);

// ------------------------------------------------------------------------ headline
const planningTurnAtScale = fixed.totalPlanningTurnOverhead + out.grounding[2].projectStateTokens;
const opus = capabilitiesFor('anthropic', 'claude-opus-4-5');
out.headline = {
  fixedOverheadTokens: fixed.totalPlanningTurnOverhead,
  projectStateTokensAt60Min: out.grounding[2].projectStateTokens,
  projectStateShareOfPrompt: out.grounding[2].projectStateTokens / planningTurnAtScale,
  clipCoverageAt60Min: out.grounding[2].clipCoverage,
  wordCoverageAt60Min: out.grounding[2].wordCoverage,
  unusedRoomOnOpus: opus.contextWindow - opus.maxOutputTokens - planningTurnAtScale,
  // Unused room only means "wasted" while there is more of the project to show. Once
  // coverage is 100% the remainder is genuinely spare, and padding the prompt to consume
  // it would be a worse edit for more money.
  moreProjectLeftToShowAt60Min:
    out.grounding[2].shownClips < out.grounding[2].totalClips ||
    out.grounding[2].shownWords < out.grounding[2].totalWords,
};
console.log('## Headline\n');
console.log(`  On a 60-minute project, one planning turn costs ~${planningTurnAtScale} tokens.`);
console.log(
  `  Of that, ${out.grounding[2].projectStateTokens} tokens (${pct(out.grounding[2].projectStateTokens, planningTurnAtScale)}) describe the user's video.`,
);
console.log(
  `  The model sees ${pct(out.grounding[2].shownClips, out.grounding[2].totalClips)} of its clips and ${pct(out.grounding[2].shownWords, out.grounding[2].totalWords)} of its dialogue,`,
);
console.log(
  `  with ~${out.headline.unusedRoomOnOpus} tokens of the window left unused` +
    `${out.headline.moreProjectLeftToShowAt60Min ? ' AND more of the project still unshown.' : ' — and nothing left to show it.'}\n`,
);

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  writeFileSync(process.argv[jsonFlag + 1], `${JSON.stringify(out, null, 2)}\n`);
  console.log(`baseline written to ${process.argv[jsonFlag + 1]}`);
}
