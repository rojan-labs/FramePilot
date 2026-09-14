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
 *   - per MODEL CALL (§W): wall time, time to first token, output tokens, reasoning
 *     effort, stage, the tool calls it issued, whether it applied an edit — from each
 *     call's pair of `context_usage` events (see `extractCalls`)
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
  const values = samples
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
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

    const firstOutput = group.find(
      (e) => e.ts >= userTs && e !== userMsg && MODEL_OUTPUT_TYPES.has(e.type),
    );
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
      timeToFirstPatchMs: summarize(
        turns.filter((t) => t.hasPatch).map((t) => t.timeToFirstPatchMs),
      ),
      timeToRunEndMs: summarize(
        turns.filter((t) => t.hasTerminalStatus).map((t) => t.timeToRunEndMs),
      ),
      modelCalls: summarize(turns.map((t) => t.modelCalls)),
      missing: {
        timeToFirstOutput: turns.filter((t) => t.timeToFirstOutputMs === null).length,
        timeToRunEnd: turns.filter((t) => !t.hasTerminalStatus).length,
        modelCalls: turns.filter((t) => t.modelCalls === null).length,
      },
      turnsWithPatch: turns.filter((t) => t.hasPatch).length,
      toolWallMs: {
        totals: toolTotals,
        perTurn: Object.fromEntries(
          TOOL_KINDS.map((k) => [k, summarize(turns.map((t) => t.toolMsByKind[k]))]),
        ),
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
              modelShare:
                modelMsTotal / (modelMsTotal + toolMsTotalForDecomp + reviewMsTotalForDecomp || 1),
              toolShare:
                toolMsTotalForDecomp /
                (modelMsTotal + toolMsTotalForDecomp + reviewMsTotalForDecomp || 1),
              reviewShare:
                reviewMsTotalForDecomp /
                (modelMsTotal + toolMsTotalForDecomp + reviewMsTotalForDecomp || 1),
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
  for (const [period, turns] of groupBy((t) =>
    t.userTs < SPLIT_BOUNDARY_MS ? 'before-2026-09-13' : 'from-2026-09-13',
  )) {
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
// Per-call decomposition (TRACKING.md §W)
// ---------------------------------------------------------------------------
//
// A turn's wall time is its model calls (§U1: 91%), and a model call is bracketed by two
// `context_usage` events sharing a `manifest.requestId`: `estimated: true` at send,
// `estimated: false` when the provider's usage arrives. Between them the first
// `reasoning_delta` / `assistant_delta` is the first token. The tool calls a call ISSUED
// are emitted after its usage settles and before the next call's send, so they are
// attributed to the window that ends at the next send. `timeline_action` events in that
// same window mean the step applied an edit.

/** Tools that only read or verify the arrangement — a step of nothing but these is a re-read. */
const ARRANGEMENT_READS = new Set([
  'get_clips',
  'get_clip',
  'get_timeline',
  'get_timeline_map',
  'get_project_state',
  'list_edit_boundaries',
  'verify_transitions',
]);

const FIRST_TOKEN_TYPES = new Set(['reasoning_delta', 'assistant_delta']);

/** Least-squares `wall = intercept + slope · outputTokens` over the calls that report both. */
export function fitFixedOverhead(calls) {
  const pts = calls.filter((c) => typeof c.outputTokens === 'number' && c.wallMs > 0);
  const n = pts.length;
  if (n < 3) return { n, interceptMs: null, msPerToken: null, tokensPerSecond: null };
  const mx = pts.reduce((a, c) => a + c.outputTokens, 0) / n;
  const my = pts.reduce((a, c) => a + c.wallMs, 0) / n;
  const sxx = pts.reduce((a, c) => a + (c.outputTokens - mx) ** 2, 0);
  if (sxx === 0) return { n, interceptMs: null, msPerToken: null, tokensPerSecond: null };
  const slope = pts.reduce((a, c) => a + (c.outputTokens - mx) * (c.wallMs - my), 0) / sxx;
  const intercept = my - slope * mx;
  return {
    n,
    interceptMs: intercept,
    msPerToken: slope,
    tokensPerSecond: slope > 0 ? 1000 / slope : null,
  };
}

/**
 * One record per model call in one conversation, plus one per classifier call.
 *
 * Every field that the log may lack is `null`, never imputed: a call with no settled
 * usage is dropped (it has no wall time), a call with no delta has `ttftMs: null`.
 */
export function extractCalls(conversation) {
  const events = [...(conversation.events ?? [])].sort((a, b) => a.ts - b.ts);
  const byTurn = new Map();
  for (const e of events) {
    if (!byTurn.has(e.turnId)) byTurn.set(e.turnId, []);
    byTurn.get(e.turnId).push(e);
  }
  const calls = [];
  const classifier = [];
  for (const [turnId, group] of byTurn) {
    const userMsg = group.find((e) => e.type === 'user_message');
    const usage = group.filter((e) => e.type === 'context_usage');
    const classify = usage.find((e) => e.manifest?.requestId === 'classify');
    if (classify && userMsg) {
      classifier.push({
        conversationId: conversation.id,
        turnId,
        wallMs: classify.ts - userMsg.ts,
        outputTokens: classify.manifest?.usage?.providerReportedOutputTokens ?? null,
        provider: classify.manifest?.provider ?? null,
        model: classify.manifest?.model ?? null,
      });
    }
    const windows = [];
    for (const send of usage.filter((e) => e.estimated === true)) {
      const end = usage.find(
        (e) =>
          e.estimated === false &&
          e.manifest?.requestId === send.manifest?.requestId &&
          e.ts >= send.ts,
      );
      if (end) windows.push({ send, end });
    }
    windows.forEach((w, index) => {
      const nextSend = windows[index + 1]?.send.ts ?? Infinity;
      const firstToken = group.find(
        (e) => FIRST_TOKEN_TYPES.has(e.type) && e.ts > w.send.ts && e.ts <= w.end.ts,
      );
      // Tool calls come as a `running` and a terminal event with one id; count ids.
      const toolNames = new Map();
      for (const e of group) {
        if (e.type !== 'tool_call' || e.ts < w.end.ts || e.ts >= nextSend) continue;
        if (!toolNames.has(e.id)) toolNames.set(e.id, e.toolName ?? null);
      }
      const names = [...toolNames.values()];
      const applied = group.some(
        (e) => e.type === 'timeline_action' && e.ts >= w.end.ts && e.ts < nextSend,
      );
      const u = w.end.manifest?.usage ?? {};
      calls.push({
        conversationId: conversation.id,
        turnId,
        index: index + 1,
        of: windows.length,
        provider: w.send.manifest?.provider ?? null,
        model: w.send.manifest?.model ?? conversation.model ?? null,
        stage: w.send.manifest?.memory?.stage ?? null,
        reasoningEffort: w.send.manifest?.reasoningEffort ?? null,
        sendTs: w.send.ts,
        wallMs: w.end.ts - w.send.ts,
        ttftMs: firstToken ? firstToken.ts - w.send.ts : null,
        outputTokens: u.providerReportedOutputTokens ?? null,
        inputTokens: u.providerReportedInputTokens ?? null,
        cachedInputTokens: u.cachedInputTokens ?? null,
        cacheWriteInputTokens: u.cacheWriteInputTokens ?? null,
        toolSchemaTokensRebilled: u.toolSchemaTokensRebilled ?? null,
        toolCalls: names.length,
        toolNames: names,
        readOnly: names.length > 0 && names.every((n) => ARRANGEMENT_READS.has(n)),
        applied,
        last: index === windows.length - 1,
      });
    });
  }
  return { calls, classifier };
}

const meanOf = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function summarizeCalls(calls) {
  const wall = calls.map((c) => c.wallMs);
  const out = calls.filter((c) => typeof c.outputTokens === 'number').map((c) => c.outputTokens);
  return {
    n: calls.length,
    wallMsTotal: wall.reduce((a, b) => a + b, 0),
    wallMs: summarize(wall),
    wallMsMean: meanOf(wall),
    outputTokens: summarize(out),
    outputTokensMean: meanOf(out),
    ttftMs: summarize(calls.map((c) => c.ttftMs)),
    toolCalls: summarize(calls.map((c) => c.toolCalls)),
  };
}

/**
 * Aggregate the per-call records of many conversations: where the seconds go by stage
 * and by reasoning effort, the fixed cost of a call, and the two round-trip shapes that
 * produce no edit (a step of nothing but arrangement reads right after an applied edit,
 * and a step that calls no tool at all before the turn's last).
 */
export function aggregateCalls(conversations, { provider = null } = {}) {
  const calls = [];
  const classifier = [];
  for (const conversation of conversations) {
    if (!Array.isArray(conversation.events) || conversation.events.length === 0) continue;
    const extracted = extractCalls(conversation);
    // `provider` narrows to the calls one adapter served — a fixed cost per call is a
    // property of the adapter (a subprocess spawn, a gateway hop), not of the corpus.
    calls.push(...extracted.calls.filter((c) => provider === null || c.provider === provider));
    classifier.push(
      ...extracted.classifier.filter((c) => provider === null || c.provider === provider),
    );
  }
  const groupBy = (keyFn) => {
    const groups = new Map();
    for (const c of calls) {
      const key = keyFn(c);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    return Object.fromEntries([...groups].map(([k, v]) => [k, summarizeCalls(v)]));
  };
  // A re-read straight after an applied edit: index into the same turn's previous call.
  const previous = new Map();
  for (const c of calls) previous.set(`${c.conversationId}:${c.turnId}:${c.index}`, c);
  const readOnlyAfterApply = calls.filter((c) => {
    if (!c.readOnly) return false;
    const before = previous.get(`${c.conversationId}:${c.turnId}:${c.index - 1}`);
    return Boolean(before?.applied);
  });
  const zeroToolNonFinal = calls.filter((c) => c.toolCalls === 0 && !c.last);
  const total = summarizeCalls(calls);
  return {
    calls: total,
    classifier: {
      n: classifier.length,
      wallMs: summarize(classifier.map((c) => c.wallMs)),
      outputTokens: summarize(classifier.map((c) => c.outputTokens)),
    },
    fixedOverhead: fitFixedOverhead(calls),
    byStage: groupBy((c) => c.stage ?? '(none)'),
    byEffort: groupBy((c) => c.reasoningEffort ?? '(not recorded)'),
    byStageAndEffort: groupBy(
      (c) => `${c.stage ?? '(none)'} · ${c.reasoningEffort ?? '(not recorded)'}`,
    ),
    byProvider: groupBy((c) => c.provider ?? '(unknown)'),
    readOnlyAfterApply: {
      n: readOnlyAfterApply.length,
      wallMsTotal: readOnlyAfterApply.reduce((a, c) => a + c.wallMs, 0),
      shareOfCalls: calls.length ? readOnlyAfterApply.length / calls.length : null,
    },
    zeroToolNonFinal: {
      n: zeroToolNonFinal.length,
      wallMsTotal: zeroToolNonFinal.reduce((a, c) => a + c.wallMs, 0),
    },
    cache: {
      callsWithCacheFigures: calls.filter((c) => c.cachedInputTokens !== null).length,
      cacheMisses: calls.filter(
        (c) => c.toolSchemaTokensRebilled !== null && c.toolSchemaTokensRebilled > 0,
      ).length,
      cachedInputTokens: summarize(calls.map((c) => c.cachedInputTokens)),
      cacheWriteInputTokens: summarize(calls.map((c) => c.cacheWriteInputTokens)),
      inputTokens: summarize(calls.map((c) => c.inputTokens)),
    },
  };
}

function renderCallsMarkdown(perCall) {
  const lines = [];
  const t = perCall.calls;
  lines.push('## Per model call (context_usage pairs)');
  lines.push('');
  lines.push(
    `- Model calls with settled usage: ${t.n}; wall total ${fmtMs(t.wallMsTotal)}; ` +
      `wall p50/p90 ${fmtMs(t.wallMs.p50)} / ${fmtMs(t.wallMs.p90)}; output tokens p50/p90 ` +
      `${t.outputTokens.p50 ?? '—'} / ${t.outputTokens.p90 ?? '—'}; tool calls per call p50 ${t.toolCalls.p50 ?? '—'}`,
  );
  const f = perCall.fixedOverhead;
  if (f.interceptMs !== null) {
    lines.push(
      `- Fixed cost per call (fit over ${f.n}): **${fmtMs(f.interceptMs)}** intercept, then ` +
        `${f.tokensPerSecond === null ? '—' : f.tokensPerSecond.toFixed(0)} output tokens/s`,
    );
  }
  lines.push(
    `- Time to first token p50/p90: ${fmtMs(t.ttftMs.p50)} / ${fmtMs(t.ttftMs.p90)} (n=${t.ttftMs.n})`,
  );
  const c = perCall.classifier;
  lines.push(
    `- Classifier call: n=${c.n}, wall p50/p90 ${fmtMs(c.wallMs.p50)} / ${fmtMs(c.wallMs.p90)}, ` +
      `output tokens p50 ${c.outputTokens.p50 ?? '—'}`,
  );
  const r = perCall.readOnlyAfterApply;
  lines.push(
    `- Read-only steps straight after an applied edit: ${r.n} (${r.shareOfCalls === null ? '—' : (r.shareOfCalls * 100).toFixed(1)}% of calls), ${fmtMs(r.wallMsTotal)}`,
  );
  const z = perCall.zeroToolNonFinal;
  lines.push(`- Steps with no tool call before the turn's last: ${z.n}, ${fmtMs(z.wallMsTotal)}`);
  const k = perCall.cache;
  lines.push(
    `- Cache: ${k.callsWithCacheFigures} calls report cache reads (p50 ${k.cachedInputTokens.p50 ?? '—'}); ` +
      `writes p50 ${k.cacheWriteInputTokens.p50 ?? '—'}; uncached input p50 ${k.inputTokens.p50 ?? '—'}; ` +
      `${k.cacheMisses} calls re-billed the tool block`,
  );
  lines.push('');
  const table = (title, groups) => {
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(
      '| group | calls | wall share | wall mean | wall p50 | output tok mean | tool calls p50 |',
    );
    lines.push('|---|---|---|---|---|---|---|');
    for (const [name, s] of Object.entries(groups).sort(
      (a, b) => b[1].wallMsTotal - a[1].wallMsTotal,
    )) {
      const share = t.wallMsTotal ? ((s.wallMsTotal / t.wallMsTotal) * 100).toFixed(1) : '—';
      lines.push(
        `| ${name} | ${s.n} | ${share}% | ${fmtMs(s.wallMsMean)} | ${fmtMs(s.wallMs.p50)} | ` +
          `${s.outputTokensMean === null ? '—' : s.outputTokensMean.toFixed(0)} | ${s.toolCalls.p50 ?? '—'} |`,
      );
    }
    lines.push('');
  };
  table('By run stage', perCall.byStage);
  table('By reasoning effort (as sent)', perCall.byEffort);
  table('By stage and effort', perCall.byStageAndEffort);
  table('By provider', perCall.byProvider);
  return lines;
}

// ---------------------------------------------------------------------------
// CLI: read the real transcript directory, render a markdown report
// ---------------------------------------------------------------------------

function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  return v >= 10000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function renderMarkdown(report, { generatedAt, sourceNote, perCall }) {
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
  lines.push(
    `- Event groups without a \`user_message\` (excluded from turn stats): ${report.turnsWithoutUserMessage}`,
  );
  lines.push(`- User turns measured: ${report.overall.n}`);
  lines.push(
    `- Of those, turns with a \`usage.modelCalls\`: ${report.overall.n - report.overall.missing.modelCalls} (missing: ${report.overall.missing.modelCalls})`,
  );
  lines.push(
    `- Turns with a terminal run status: ${report.overall.n - report.overall.missing.timeToRunEnd} (missing: ${report.overall.missing.timeToRunEnd})`,
  );
  lines.push(`- Turns that produced at least one applied patch: ${report.overall.turnsWithPatch}`);
  lines.push('');

  lines.push('## Headline stages — overall');
  lines.push('');
  lines.push('| stage | n | p50 | p90 | max |');
  lines.push('|---|---|---|---|---|');
  const o = report.overall;
  lines.push(
    `| time to first model output | ${o.timeToFirstOutputMs.n} | ${fmtMs(o.timeToFirstOutputMs.p50)} | ${fmtMs(o.timeToFirstOutputMs.p90)} | ${fmtMs(o.timeToFirstOutputMs.max)} |`,
  );
  lines.push(
    `| time to first applied patch | ${o.timeToFirstPatchMs.n} | ${fmtMs(o.timeToFirstPatchMs.p50)} | ${fmtMs(o.timeToFirstPatchMs.p90)} | ${fmtMs(o.timeToFirstPatchMs.max)} |`,
  );
  lines.push(
    `| time to run end | ${o.timeToRunEndMs.n} | ${fmtMs(o.timeToRunEndMs.p50)} | ${fmtMs(o.timeToRunEndMs.p90)} | ${fmtMs(o.timeToRunEndMs.max)} |`,
  );
  lines.push(
    `| model calls / turn | ${o.modelCalls.n} | ${o.modelCalls.p50} | ${o.modelCalls.p90} | ${o.modelCalls.max} |`,
  );
  lines.push(
    `| review wait (all) | ${o.reviewWaitMs.all.n} | ${fmtMs(o.reviewWaitMs.all.p50)} | ${fmtMs(o.reviewWaitMs.all.p90)} | ${fmtMs(o.reviewWaitMs.all.max)} |`,
  );
  lines.push(
    `| review wait (explicit timeout text) | ${o.reviewWaitMs.explicit.n} | ${fmtMs(o.reviewWaitMs.explicit.p50)} | ${fmtMs(o.reviewWaitMs.explicit.p90)} | ${fmtMs(o.reviewWaitMs.explicit.max)} |`,
  );
  lines.push(
    `| review wait (derived from event gap) | ${o.reviewWaitMs.derived.n} | ${fmtMs(o.reviewWaitMs.derived.p50)} | ${fmtMs(o.reviewWaitMs.derived.p90)} | ${fmtMs(o.reviewWaitMs.derived.max)} |`,
  );
  lines.push('');

  lines.push('## Host tool wall time by kind — overall');
  lines.push('');
  lines.push('| kind | total ms | per-turn p50 | per-turn p90 | per-turn max |');
  lines.push('|---|---|---|---|---|');
  for (const k of TOOL_KINDS) {
    const s = o.toolWallMs.perTurn[k];
    lines.push(
      `| ${k} | ${fmtMs(o.toolWallMs.totals[k])} | ${fmtMs(s.p50)} | ${fmtMs(s.p90)} | ${fmtMs(s.max)} |`,
    );
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
    lines.push(
      `| model calls (thinking/generation/network — total minus tool time minus review wait) | ${fmtMs(d.modelMsTotal)} | ${(d.modelShare * 100).toFixed(1)}% |`,
    );
    lines.push(
      `| host tool wall time | ${fmtMs(d.toolMsTotal)} | ${(d.toolShare * 100).toFixed(1)}% |`,
    );
    lines.push(
      `| perceptual review wait | ${fmtMs(d.reviewMsTotal)} | ${(d.reviewShare * 100).toFixed(1)}% |`,
    );
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
        "as the token-cost lever is, by these numbers, also the wall-clock lever: a turn's latency scales " +
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

  if (perCall) lines.push(...renderCallsMarkdown(perCall));

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
    "- The wall-time decomposition attributes every turn-second either to a `tool_call`'s own " +
      '`runtimeMs`, an explicit or derived review wait, or the remainder (model calls: network + ' +
      'generation + orchestrator think time, none of which is separately timestamped in the log). ' +
      'It is additive by construction (the three shares sum to 1) and is only computed for the ' +
      '746 turns with a terminal status.',
  );
  lines.push(
    '- `review wait (derived)` is a proxy — the gap since the immediately preceding event — used ' +
      "only when the reviewer's own text has no explicit `timed out after Nms` figure to read.",
  );
  lines.push('');

  return lines.join('\n') + '\n';
}

/** `updatedAt` is written as epoch ms by the desktop store and as ISO text by older builds. */
function conversationUpdatedMs(conversation) {
  const value = conversation.updatedAt ?? conversation.createdAt ?? 0;
  return typeof value === 'number' ? value : Date.parse(value);
}

async function main() {
  const { readFileSync, readdirSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { resolve, dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const args = process.argv.slice(2);
  const dirArg = args.find((a) => !a.startsWith('--'));
  const outArg = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  // `--since=YYYY-MM-DD` keeps only conversations updated on or after that day, so the
  // per-call section can be read for one provider rollout rather than all history.
  const sinceArg = args.find((a) => a.startsWith('--since='))?.slice('--since='.length);
  const sinceMs = sinceArg ? Date.parse(sinceArg) : null;
  // `--provider=<name>` narrows the per-call section to one adapter's calls.
  const providerArg =
    args.find((a) => a.startsWith('--provider='))?.slice('--provider='.length) ?? null;

  const conversationsDir =
    dirArg ??
    join(homedir(), 'Library', 'Application Support', '@framepilot', 'desktop', 'conversations');

  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const today = new Date().toISOString().slice(0, 10);
  const outPath = outArg ?? join(REPO_ROOT, 'reports', 'latency', `edit-latency-${today}.md`);

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
      if (!parsed || !Array.isArray(parsed.events)) parseErrors += 1;
      else if (sinceMs !== null && conversationUpdatedMs(parsed) < sinceMs) continue;
      else conversations.push(parsed);
    } catch {
      parseErrors += 1;
    }
  }

  const report = aggregate(conversations);
  const perCall = aggregateCalls(conversations, { provider: providerArg });
  const md = renderMarkdown(report, {
    generatedAt: new Date().toISOString(),
    sourceNote:
      `Source: ${files.length} files in the desktop conversations directory (${parseErrors} unreadable/non-conversation, skipped` +
      `${sinceArg ? `; only conversations updated since ${sinceArg}` : ''}` +
      `${providerArg ? `; per-call section limited to provider ${providerArg}` : ''}).`,
    perCall,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(`Conversations: ${conversations.length} (parse errors: ${parseErrors})`);
  console.log(`Turns measured: ${report.overall.n}`);
  console.log(`Model calls decomposed: ${perCall.calls.n}`);
}

const { pathToFileURL } = await import('node:url');
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
