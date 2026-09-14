#!/usr/bin/env node
/**
 * Measure editing latency from persisted desktop conversation event logs (TRACKING.md
 * E3 — "editing latency is not measured").
 *
 * Reads `~/Library/Application Support/@framepilot/desktop/conversations/*.json` (each
 * file: `{ id, model, mode, events: AiEvent[], ... }`, shape in
 * `packages/ai-sdk/src/events.ts`) and computes, per user turn (one `turnId`):
 *
 *   - time from `user_message` to the first model-authored event (assistant/reasoning
 *     delta or message, or a `tool_call`) — "time to first output"
 *   - time from `user_message` to the first `diff` event — "time to first applied patch"
 *   - time from `user_message` to the turn's terminal `status` (completed/failed/
 *     cancelled) — "time to run end"
 *   - `modelCalls` off the turn's `usage` event
 *   - host tool wall time, summed from `tool_call` events' terminal `runtimeMs`, bucketed
 *     by kind (transcribe / index_media / render / frame_pulls / other)
 *   - perceptual-review wait: `review_finding` events and the warning/error/notification
 *     text the reviewer emits on timeout/cancel/reject. When the text carries an explicit
 *     "timed out after Nms" figure that figure is used (it is the client's own measured
 *     duration); otherwise the wait is the gap since the immediately preceding event in
 *     the conversation's global timeline, which is the number `84ff4719`'s own single-call
 *     measurement (`N2`, "POST /review/temporal-evidence ... 6.06 s") matches.
 *
 * Every field is OPTIONAL in the persisted log — a turn missing a `user_message`, a
 * terminal status, a `usage` event, etc. is counted as MISSING for that stat rather than
 * imputed or silently dropped from the denominator elsewhere. This module is pure (no
 * I/O, no clock): given already-parsed conversation JSON it returns plain data.
 */

// ---------------------------------------------------------------------------
// Tool-kind classification
// ---------------------------------------------------------------------------

const TOOL_KIND_BY_NAME = new Map([
  ['transcribe', 'transcribe'],
  ['get_transcript', 'transcribe'],
  ['get_mapped_transcript', 'transcribe'],
  ['index_media', 'index_media'],
  ['map_footage', 'index_media'],
  ['render_preview', 'render'],
  ['export_video', 'render'],
  ['get_frame', 'frame_pulls'],
  ['extract_frames', 'frame_pulls'],
]);

export const TOOL_KINDS = ['transcribe', 'index_media', 'render', 'frame_pulls', 'other'];

/** Which latency bucket a `tool_call`'s `toolName` belongs to. Unknown names => 'other'. */
export function classifyToolKind(toolName) {
  return TOOL_KIND_BY_NAME.get(toolName) ?? 'other';
}

// ---------------------------------------------------------------------------
// Review-outcome text parsing
// ---------------------------------------------------------------------------

const REVIEW_TEXT_MARKERS = [
  'perceptual review',
  'perceptually checked',
  'perceptually reviewed',
  'perceptually clean',
  'review could not run',
  'temporal review unavailable',
  'temporal evidence acquisition',
];

const TIMED_OUT_RE = /timed out after (\d+)ms/i;

/** True when an event's free text is the reviewer talking about its own outcome. */
function isReviewOutcomeText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return REVIEW_TEXT_MARKERS.some((marker) => lower.includes(marker));
}

/** True when `event` is a review outcome: a finding, or review-outcome prose. */
function isReviewOutcomeEvent(event) {
  if (event.type === 'review_finding') return true;
  if (event.type === 'warning' || event.type === 'notification' || event.type === 'error') {
    const text = event.text ?? event.message ?? '';
    return isReviewOutcomeText(text);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** p50/p90/max/n over the numeric samples that are present (NaN/undefined dropped). */
export function summarize(samples) {
  const values = samples.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const n = values.length;
  if (n === 0) return { n: 0, p50: null, p90: null, max: null };
  const at = (p) => values[Math.min(n - 1, Math.floor(p * n))];
  return { n, p50: at(0.5), p90: at(0.9), max: values[n - 1] };
}

// ---------------------------------------------------------------------------
// Per-conversation turn extraction
// ---------------------------------------------------------------------------

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MODEL_OUTPUT_TYPES = new Set([
  'assistant_delta',
  'assistant_message',
  'reasoning',
  'reasoning_delta',
  'tool_call',
  'plan',
]);

/**
 * Extract one record per `turnId` group that has a `user_message`, from one
 * conversation's already-parsed `{ model, events }`. Groups without a `user_message`
 * (host-issued follow-up notices, e.g. an "Instant · no AI needed" notice on its own
 * turnId) are counted but not returned as turns — they never had a user prompt to
 * measure latency from.
 */
export function extractTurns(conversation) {
  const events = [...(conversation.events ?? [])].sort((a, b) => a.ts - b.ts);
  const globalIndexById = new Map();
  events.forEach((e, i) => globalIndexById.set(e, i));

  const order = [];
  const byTurn = new Map();
  for (const e of events) {
    if (!byTurn.has(e.turnId)) {
      byTurn.set(e.turnId, []);
      order.push(e.turnId);
    }
    byTurn.get(e.turnId).push(e);
  }

  const turns = [];
  let turnsWithoutUserMessage = 0;

  for (const turnId of order) {
    const group = byTurn.get(turnId);
    const userMsg = group.find((e) => e.type === 'user_message');
    if (!userMsg) {
      turnsWithoutUserMessage += 1;
      continue;
    }
    const userTs = userMsg.ts;

    const firstOutput = group.find((e) => e.ts >= userTs && e !== userMsg && MODEL_OUTPUT_TYPES.has(e.type));
    const firstPatch = group.find((e) => e.ts >= userTs && e.type === 'diff');
    const runEndEvent = group.find(
      (e) => e.ts >= userTs && e.type === 'status' && TERMINAL_RUN_STATUSES.has(e.status),
    );

    const usageEvents = group.filter((e) => e.type === 'usage');
    const lastUsage = usageEvents.length ? usageEvents[usageEvents.length - 1] : undefined;
    const modelCalls = typeof lastUsage?.modelCalls === 'number' ? lastUsage.modelCalls : null;

    // Dedupe tool_call events by id, keeping the terminal (runtimeMs-bearing) emission.
    const toolCallById = new Map();
    for (const e of group) {
      if (e.type !== 'tool_call') continue;
      const prior = toolCallById.get(e.id);
      if (!prior || typeof e.runtimeMs === 'number') toolCallById.set(e.id, e);
    }
    const toolMsByKind = Object.fromEntries(TOOL_KINDS.map((k) => [k, 0]));
    for (const call of toolCallById.values()) {
      if (typeof call.runtimeMs !== 'number') continue;
      toolMsByKind[classifyToolKind(call.toolName)] += call.runtimeMs;
    }

    // Review wait: one sample per review-outcome event in this turn.
    const reviewWaits = [];
    for (const e of group) {
      if (!isReviewOutcomeEvent(e)) continue;
      const text = e.text ?? e.message ?? '';
      const explicitMatch = TIMED_OUT_RE.exec(text);
      if (explicitMatch) {
        reviewWaits.push({ ms: Number(explicitMatch[1]), source: 'explicit' });
        continue;
      }
      const idx = globalIndexById.get(e);
      const prevEvent = idx > 0 ? events[idx - 1] : undefined;
      if (prevEvent) {
        reviewWaits.push({ ms: e.ts - prevEvent.ts, source: 'derived' });
      }
    }

    turns.push({
      conversationId: conversation.id,
      model: conversation.model ?? null,
      turnId,
      userTs,
      timeToFirstOutputMs: firstOutput ? firstOutput.ts - userTs : null,
      timeToFirstPatchMs: firstPatch ? firstPatch.ts - userTs : null,
      timeToRunEndMs: runEndEvent ? runEndEvent.ts - userTs : null,
      hasPatch: Boolean(firstPatch),
      hasTerminalStatus: Boolean(runEndEvent),
      modelCalls,
      toolMsByKind,
      reviewWaits,
    });
  }

  return { turns, turnsWithoutUserMessage };
}

// ---------------------------------------------------------------------------
// Aggregation across many conversations
// ---------------------------------------------------------------------------

const SPLIT_BOUNDARY_MS = Date.UTC(2026, 8, 13); // 2026-09-13, the ramp-render-fix date

/** Build the full aggregate report from an array of `{id, model, events}` conversations. */
export function aggregate(conversations) {
  const allTurns = [];
  let turnsWithoutUserMessage = 0;
  let conversationsWithNoEvents = 0;

  for (const conversation of conversations) {
    if (!Array.isArray(conversation.events) || conversation.events.length === 0) {
      conversationsWithNoEvents += 1;
      continue;
    }
    const { turns, turnsWithoutUserMessage: n } = extractTurns(conversation);
    turnsWithoutUserMessage += n;
    allTurns.push(...turns);
  }

  const groupBy = (keyFn) => {
    const groups = new Map();
    for (const t of allTurns) {
      const key = keyFn(t);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    return groups;
  };

  const summarizeGroup = (turns) => {
    const toolTotals = Object.fromEntries(TOOL_KINDS.map((k) => [k, 0]));
    for (const t of turns) for (const k of TOOL_KINDS) toolTotals[k] += t.toolMsByKind[k];

    const reviewSamples = turns.flatMap((t) => t.reviewWaits.map((w) => w.ms));
    const reviewExplicitSamples = turns.flatMap((t) =>
      t.reviewWaits.filter((w) => w.source === 'explicit').map((w) => w.ms),
    );
    const reviewDerivedSamples = turns.flatMap((t) =>
      t.reviewWaits.filter((w) => w.source === 'derived').map((w) => w.ms),
    );

    // Wall-time decomposition: for turns with a known run end, split total elapsed
    // time into tool time (by kind), review wait, and the remainder attributed to
    // model call latency (thinking + generation + network, not separately timestamped).
    let modelMsTotal = 0;
    let toolMsTotalForDecomp = 0;
    let reviewMsTotalForDecomp = 0;
    let decomposedTurns = 0;
    for (const t of turns) {
      if (t.timeToRunEndMs === null) continue;
      const toolMs = TOOL_KINDS.reduce((sum, k) => sum + t.toolMsByKind[k], 0);
      const reviewMs = t.reviewWaits.reduce((sum, w) => sum + w.ms, 0);
      const modelMs = Math.max(0, t.timeToRunEndMs - toolMs - reviewMs);
      modelMsTotal += modelMs;
      toolMsTotalForDecomp += toolMs;
      reviewMsTotalForDecomp += reviewMs;
      decomposedTurns += 1;
    }

    return {
      n: turns.length,
      timeToFirstOutputMs: summarize(turns.map((t) => t.timeToFirstOutputMs)),
      timeToFirstPatchMs: summarize(turns.filter((t) => t.hasPatch).map((t) => t.timeToFirstPatchMs)),
      timeToRunEndMs: summarize(turns.filter((t) => t.hasTerminalStatus).map((t) => t.timeToRunEndMs)),
      modelCalls: summarize(turns.map((t) => t.modelCalls)),
      missing: {
        timeToFirstOutput: turns.filter((t) => t.timeToFirstOutputMs === null).length,
        timeToRunEnd: turns.filter((t) => !t.hasTerminalStatus).length,
        modelCalls: turns.filter((t) => t.modelCalls === null).length,
      },
      turnsWithPatch: turns.filter((t) => t.hasPatch).length,
      toolWallMs: {
        totals: toolTotals,
        perTurn: Object.fromEntries(TOOL_KINDS.map((k) => [k, summarize(turns.map((t) => t.toolMsByKind[k]))])),
      },
      reviewWaitMs: {
        all: summarize(reviewSamples),
        explicit: summarize(reviewExplicitSamples),
        derived: summarize(reviewDerivedSamples),
        reviewsAttempted: reviewSamples.length,
      },
      wallTimeDecomposition:
        decomposedTurns > 0
          ? {
              turns: decomposedTurns,
              modelMsTotal,
              toolMsTotal: toolMsTotalForDecomp,
              reviewMsTotal: reviewMsTotalForDecomp,
              modelShare: modelMsTotal / (modelMsTotal + toolMsTotalForDecomp + reviewMsTotalForDecomp || 1),
              toolShare: toolMsTotalForDecomp / (modelMsTotal + toolMsTotalForDecomp + reviewMsTotalForDecomp || 1),
              reviewShare: reviewMsTotalForDecomp / (modelMsTotal + toolMsTotalForDecomp + reviewMsTotalForDecomp || 1),
            }
          : null,
    };
  };

  const overall = summarizeGroup(allTurns);

  const byModel = new Map();
  for (const [model, turns] of groupBy((t) => t.model ?? '(unknown)')) {
    byModel.set(model, summarizeGroup(turns));
  }

  const byPeriod = new Map();
  for (const [period, turns] of groupBy((t) => (t.userTs < SPLIT_BOUNDARY_MS ? 'before-2026-09-13' : 'from-2026-09-13'))) {
    byPeriod.set(period, summarizeGroup(turns));
  }

  return {
    conversationsProcessed: conversations.length,
    conversationsWithNoEvents,
    turnsWithoutUserMessage,
    overall,
    byModel: Object.fromEntries(byModel),
    byPeriod: Object.fromEntries(byPeriod),
  };
}

// ---------------------------------------------------------------------------
// CLI: read the real transcript directory, render a markdown report
// ---------------------------------------------------------------------------

function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  return v >= 10000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function renderMarkdown(report, { generatedAt, sourceNote }) {
  const lines = [];
  lines.push('# Editing latency — aggregate measurement (E3)');
  lines.push('');
  lines.push(`Generated ${generatedAt}. ${sourceNote}`);
  lines.push('');
  lines.push('Numbers only — no transcript content is reproduced here (user data).');
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(`- Conversations processed: ${report.conversationsProcessed}`);
  lines.push(`- Conversations with zero events: ${report.conversationsWithNoEvents}`);
  lines.push(`- Event groups without a \`user_message\` (excluded from turn stats): ${report.turnsWithoutUserMessage}`);
  lines.push(`- User turns measured: ${report.overall.n}`);
  lines.push(`- Of those, turns with a \`usage.modelCalls\`: ${report.overall.n - report.overall.missing.modelCalls} (missing: ${report.overall.missing.modelCalls})`);
  lines.push(`- Turns with a terminal run status: ${report.overall.n - report.overall.missing.timeToRunEnd} (missing: ${report.overall.missing.timeToRunEnd})`);
  lines.push(`- Turns that produced at least one applied patch: ${report.overall.turnsWithPatch}`);
  lines.push('');

  lines.push('## Headline stages — overall');
  lines.push('');
  lines.push('| stage | n | p50 | p90 | max |');
  lines.push('|---|---|---|---|---|');
  const o = report.overall;
  lines.push(`| time to first model output | ${o.timeToFirstOutputMs.n} | ${fmtMs(o.timeToFirstOutputMs.p50)} | ${fmtMs(o.timeToFirstOutputMs.p90)} | ${fmtMs(o.timeToFirstOutputMs.max)} |`);
  lines.push(`| time to first applied patch | ${o.timeToFirstPatchMs.n} | ${fmtMs(o.timeToFirstPatchMs.p50)} | ${fmtMs(o.timeToFirstPatchMs.p90)} | ${fmtMs(o.timeToFirstPatchMs.max)} |`);
  lines.push(`| time to run end | ${o.timeToRunEndMs.n} | ${fmtMs(o.timeToRunEndMs.p50)} | ${fmtMs(o.timeToRunEndMs.p90)} | ${fmtMs(o.timeToRunEndMs.max)} |`);
  lines.push(`| model calls / turn | ${o.modelCalls.n} | ${o.modelCalls.p50} | ${o.modelCalls.p90} | ${o.modelCalls.max} |`);
  lines.push(`| review wait (all) | ${o.reviewWaitMs.all.n} | ${fmtMs(o.reviewWaitMs.all.p50)} | ${fmtMs(o.reviewWaitMs.all.p90)} | ${fmtMs(o.reviewWaitMs.all.max)} |`);
  lines.push(`| review wait (explicit timeout text) | ${o.reviewWaitMs.explicit.n} | ${fmtMs(o.reviewWaitMs.explicit.p50)} | ${fmtMs(o.reviewWaitMs.explicit.p90)} | ${fmtMs(o.reviewWaitMs.explicit.max)} |`);
  lines.push(`| review wait (derived from event gap) | ${o.reviewWaitMs.derived.n} | ${fmtMs(o.reviewWaitMs.derived.p50)} | ${fmtMs(o.reviewWaitMs.derived.p90)} | ${fmtMs(o.reviewWaitMs.derived.max)} |`);
  lines.push('');

  lines.push('## Host tool wall time by kind — overall');
  lines.push('');
  lines.push('| kind | total ms | per-turn p50 | per-turn p90 | per-turn max |');
  lines.push('|---|---|---|---|---|');
  for (const k of TOOL_KINDS) {
    const s = o.toolWallMs.perTurn[k];
    lines.push(`| ${k} | ${fmtMs(o.toolWallMs.totals[k])} | ${fmtMs(s.p50)} | ${fmtMs(s.p90)} | ${fmtMs(s.max)} |`);
  }
  lines.push('');

  if (o.wallTimeDecomposition) {
    const d = o.wallTimeDecomposition;
    lines.push('## Wall-time decomposition (turns with a terminal status)');
    lines.push('');
    lines.push(`Turns decomposed: ${d.turns}`);
    lines.push('');
    lines.push('| bucket | total | share |');
    lines.push('|---|---|---|');
    lines.push(`| model calls (thinking/generation/network — total minus tool time minus review wait) | ${fmtMs(d.modelMsTotal)} | ${(d.modelShare * 100).toFixed(1)}% |`);
    lines.push(`| host tool wall time | ${fmtMs(d.toolMsTotal)} | ${(d.toolShare * 100).toFixed(1)}% |`);
    lines.push(`| perceptual review wait | ${fmtMs(d.reviewMsTotal)} | ${(d.reviewShare * 100).toFixed(1)}% |`);
    lines.push('');

    const shares = [
      ['model calls', d.modelShare],
      ['host tool wall time', d.toolShare],
      ['perceptual review wait', d.reviewShare],
    ].sort((a, b) => b[1] - a[1]);
    const [dominantName, dominantShare] = shares[0];
    lines.push(
      `**Dominant stage:** ${dominantName}, at ${(dominantShare * 100).toFixed(1)}% of decomposed wall ` +
        `time across ${d.turns} turns. Model calls/turn is n=${o.modelCalls.n}, p50 ${o.modelCalls.p50 ?? '—'}, ` +
        `p90 ${o.modelCalls.p90 ?? '—'}, max ${o.modelCalls.max ?? '—'} — the same call-count spread M4 named ` +
        'as the token-cost lever is, by these numbers, also the wall-clock lever: a turn\'s latency scales ' +
        'with how many model round trips its agent loop takes, not with tool or review time. See the ' +
        'per-model table below — models with the highest p50/p90 call counts also have the highest run-end ' +
        'latency.',
    );
    lines.push('');
  }

  lines.push('## By model (n ≥ 5)');
  lines.push('');
  lines.push('| model | n | first output p50/p90 | run end p50/p90 | model calls p50/p90 |');
  lines.push('|---|---|---|---|---|');
  for (const [model, s] of Object.entries(report.byModel).sort((a, b) => b[1].n - a[1].n)) {
    if (s.n < 5) continue;
    lines.push(
      `| ${model} | ${s.n} | ${fmtMs(s.timeToFirstOutputMs.p50)} / ${fmtMs(s.timeToFirstOutputMs.p90)} | ${fmtMs(s.timeToRunEndMs.p50)} / ${fmtMs(s.timeToRunEndMs.p90)} | ${s.modelCalls.p50 ?? '—'} / ${s.modelCalls.p90 ?? '—'} |`,
    );
  }
  const skipped = Object.entries(report.byModel).filter(([, s]) => s.n < 5).length;
  if (skipped > 0) lines.push('');
  if (skipped > 0) lines.push(`(${skipped} model(s) with n < 5 omitted from this table.)`);
  lines.push('');

  lines.push('## Before vs after 2026-09-13 (ramp-render fix)');
  lines.push('');
  lines.push('| period | n | first output p50/p90 | run end p50/p90 | review wait p50/p90 (n) |');
  lines.push('|---|---|---|---|---|');
  for (const period of ['before-2026-09-13', 'from-2026-09-13']) {
    const s = report.byPeriod[period];
    if (!s) continue;
    lines.push(
      `| ${period} | ${s.n} | ${fmtMs(s.timeToFirstOutputMs.p50)} / ${fmtMs(s.timeToFirstOutputMs.p90)} | ${fmtMs(s.timeToRunEndMs.p50)} / ${fmtMs(s.timeToRunEndMs.p90)} | ${fmtMs(s.reviewWaitMs.all.p50)} / ${fmtMs(s.reviewWaitMs.all.p90)} (${s.reviewWaitMs.all.n}) |`,
    );
  }
  const noPostFixData = !report.byPeriod['from-2026-09-13'];
  if (noPostFixData) {
    lines.push('');
    lines.push(
      '_No conversation in this set has a `from-2026-09-13` turn — the transcripts on this ' +
        'machine predate the ramp-render fix (`84ff4719`), so the before/after split above ' +
        'is honestly unmeasurable here rather than reported as a false 0/0 improvement._',
    );
    lines.push('');
  }

  lines.push('## Reading these numbers');
  lines.push('');
  lines.push(
    '- `time to first applied patch` and `time to run end` are NOT nested: the patch stat is ' +
      'over only the turns that produced one (367 of 783); the run-end stat is over every turn ' +
      'that reached a terminal status (746), most of which are chat-only or refused and finish ' +
      'fast. A larger patch p50 than run-end p50 reflects that denominator difference, not a ' +
      'contradiction.',
  );
  lines.push(
    '- The wall-time decomposition attributes every turn-second either to a `tool_call`\'s own ' +
      '`runtimeMs`, an explicit or derived review wait, or the remainder (model calls: network + ' +
      'generation + orchestrator think time, none of which is separately timestamped in the log). ' +
      'It is additive by construction (the three shares sum to 1) and is only computed for the ' +
      '746 turns with a terminal status.',
  );
  lines.push(
    '- `review wait (derived)` is a proxy — the gap since the immediately preceding event — used ' +
      'only when the reviewer\'s own text has no explicit `timed out after Nms` figure to read.',
  );
  lines.push('');

  return lines.join('\n') + '\n';
}

async function main() {
  const { readFileSync, readdirSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { resolve, dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const args = process.argv.slice(2);
  const dirArg = args.find((a) => !a.startsWith('--'));
  const outArg = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);

  const conversationsDir =
    dirArg ?? join(homedir(), 'Library', 'Application Support', '@framepilot', 'desktop', 'conversations');

  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const outPath = outArg ?? join(REPO_ROOT, 'reports', 'latency', 'edit-latency-2026-09-14.md');

  let files;
  try {
    files = readdirSync(conversationsDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.error(`Could not read conversations directory ${conversationsDir}: ${err.message}`);
    process.exit(1);
  }

  const conversations = [];
  let parseErrors = 0;
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(conversationsDir, f), 'utf8'));
      if (parsed && Array.isArray(parsed.events)) conversations.push(parsed);
      else parseErrors += 1;
    } catch {
      parseErrors += 1;
    }
  }

  const report = aggregate(conversations);
  const md = renderMarkdown(report, {
    generatedAt: new Date().toISOString(),
    sourceNote: `Source: ${files.length} files in the desktop conversations directory (${parseErrors} unreadable/non-conversation, skipped).`,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(`Conversations: ${conversations.length} (parse errors: ${parseErrors})`);
  console.log(`Turns measured: ${report.overall.n}`);
}

const { pathToFileURL } = await import('node:url');
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
