/**
 * Conversation export (Phase 11 M7, ADR 0033).
 *
 * Serializes a conversation to Markdown (a **complete** human-readable transcript)
 * or JSON (the exact persisted record). Pure; the drawer hands the string to the
 * existing download/clipboard path. JSON export round-trips the stored shape so an
 * exported conversation can be re-imported byte-for-byte.
 *
 * WHY the Markdown is exhaustive: the export is what a person shares when a run went
 * wrong ("here is everything the AI did"). A transcript that keeps only the two
 * message lines silently drops the parts that explain the outcome — the thinking, the
 * tool arguments and their raw results, the validated operations of every proposed
 * edit, run status transitions, cost, and the resumable checkpoint. So every event
 * type in the log is rendered, in log order, at full fidelity and without truncation.
 *
 * Streamed events (`assistant_delta`, `reasoning_delta`) and attachments
 * (`tool_result`, `ask`) are folded through {@link reduceEvents} first, so the
 * transcript shows each message/tool call ONCE in its final state instead of
 * replaying every chunk. Anything the reducer does not model as a node (usage,
 * context occupancy, DAG tasks, checkpoints, run state, status transitions) is
 * rendered inline from the raw event, and anything unexpected falls back to a raw
 * JSON dump — the export never silently loses an event.
 */
import {
  type AiEvent,
  type AskEvent,
  type PlanStep,
  type Reference,
  type ToolResultEvent,
  type ViewNode,
  reduceEvents,
} from '@framepilot/ai-sdk';
import type { Conversation } from './conversation.js';

// ---------------------------------------------------------------------------
// Formatting primitives
// ---------------------------------------------------------------------------

/** Absolute UTC timestamp — stable across machines, unlike a locale string. */
function formatTs(ts: number): string {
  return new Date(ts).toISOString();
}

/** Human duration for tool runtimes and thinking time. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A fenced JSON block, or `[]` when the value is absent. */
function jsonBlock(value: unknown): readonly string[] {
  return ['```json', JSON.stringify(value, null, 2), '```', ''];
}

/** `#### Label` followed by a fenced JSON block; `[]` when `value` is undefined. */
function jsonSection(label: string, value: unknown): readonly string[] {
  if (value === undefined) return [];
  return [`#### ${label}`, '', ...jsonBlock(value)];
}

/** A bullet list section; `[]` when the list is absent or empty. */
function listSection(label: string, items: readonly string[] | undefined): readonly string[] {
  if (!items || items.length === 0) return [];
  return [`#### ${label}`, '', ...items.map((item) => `- ${item}`), ''];
}

/** `key: value` metadata bullets, skipping undefined values. */
function metaLines(entries: readonly (readonly [string, unknown])[]): readonly string[] {
  const lines = entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `- **${key}:** ${typeof value === 'string' ? value : String(value)}`);
  return lines.length > 0 ? [...lines, ''] : [];
}

/** Multi-line free text rendered as a blockquote so it never breaks list nesting. */
function quote(text: string): readonly string[] {
  return [...text.split('\n').map((line) => `> ${line}`), ''];
}

function formatRefs(refs: readonly Reference[]): string {
  return refs.map((ref) => `\`${ref.kind}:${ref.id}\` ${ref.label}`).join(', ');
}

const PLAN_STEP_MARK: Record<PlanStep['status'], string> = {
  pending: ' ',
  running: '~',
  completed: 'x',
  failed: '!',
};

// ---------------------------------------------------------------------------
// Node renderers (one per reduced view node kind)
// ---------------------------------------------------------------------------

function renderToolResult(result: ToolResultEvent): readonly string[] {
  return [
    ...(result.summary ? ['#### Summary', '', ...quote(result.summary)] : []),
    ...jsonSection('Input', result.input),
    ...jsonSection('Result', result.result),
    ...listSection('Files', result.files),
    ...listSection('Clips', result.clips),
    ...listSection('Tracks', result.tracks),
    ...listSection('Logs', result.logs),
    ...listSection('Warnings', result.warnings),
  ];
}

function renderAsk(ask: AskEvent): readonly string[] {
  return [
    '#### Question to you',
    '',
    ...quote(ask.question),
    ...(ask.options
      ? [
          ...ask.options.map(
            (option) =>
              `- **${option.label}**${option.description ? ` — ${option.description}` : ''}`,
          ),
          '',
        ]
      : []),
  ];
}

function renderTool(node: Extract<ViewNode, { kind: 'tool' }>): readonly string[] {
  const runtime = node.runtimeMs !== undefined ? ` · ${formatDuration(node.runtimeMs)}` : '';
  return [
    `### 🛠 Tool · ${node.title ?? node.toolName} — ${node.status}${runtime}`,
    '',
    ...metaLines([
      ['Time', formatTs(node.ts)],
      ['Tool', node.toolName],
      ['Arguments', node.argsSummary ? `\`${node.argsSummary}\`` : undefined],
    ]),
    ...(node.ask ? renderAsk(node.ask) : []),
    ...(node.result ? renderToolResult(node.result) : []),
  ];
}

function renderDiff(node: Extract<ViewNode, { kind: 'diff' }>): readonly string[] {
  const { edit } = node;
  return [
    `### 📝 Proposed edit · ${edit.patch.operations.length} operation(s)`,
    '',
    ...metaLines([
      ['Time', formatTs(node.ts)],
      ['Summary', edit.text],
      ['Patch id', edit.patch.patchId],
      ['Created by', edit.patch.createdBy],
      ['Reason', edit.patch.reason],
      ['Scope', node.scope],
      ['Turn index', node.turnIndex],
      ['Run id', node.runId],
      ['Plan step', node.planStepId],
      ['Verification', node.verification],
      ['Valid', edit.validation.valid],
    ]),
    ...(edit.validation.issues.length > 0
      ? listSection(
          'Validation issues',
          edit.validation.issues.map(
            (issue) => `\`${issue.severity}\` \`${issue.code}\` — ${issue.message}`,
          ),
        )
      : []),
    ...jsonSection('Operations', edit.patch.operations),
    // The diff carries whole before/after timelines; its summary is the reviewable
    // part, and dumping two full timelines per edit would bury the transcript.
    ...listSection('Timeline changes', edit.diff?.summary),
    ...jsonSection('Commit', node.commit),
    ...jsonSection('Variants', node.variants),
  ];
}

function renderNode(node: ViewNode): readonly string[] {
  switch (node.kind) {
    case 'user':
      return [`### 👤 You · ${formatTs(node.ts)}`, '', node.text, ''];
    case 'assistant':
      return [
        `### 💬 FramePilot · ${formatTs(node.ts)}${node.streaming ? ' (streaming)' : ''}`,
        '',
        node.text,
        '',
      ];
    case 'reasoning':
      return [
        `### 🧠 Thinking${node.thoughtMs !== undefined ? ` · ${formatDuration(node.thoughtMs)}` : ''} · ${formatTs(node.ts)}`,
        '',
        ...node.summaries.flatMap((summary) => quote(summary)),
        ...(node.done ? [] : ['_(still thinking when the log ended)_', '']),
      ];
    case 'plan':
      return [
        `### 📋 Plan · ${formatTs(node.ts)}`,
        '',
        ...node.steps.map(
          (step) =>
            `- [${PLAN_STEP_MARK[step.status]}] ${step.label} — ${step.status}${step.detail ? ` · ${step.detail}` : ''}`,
        ),
        '',
      ];
    case 'tool':
      return renderTool(node);
    case 'timeline_action':
      return [
        `### ✏️ ${node.action} · ${formatTs(node.ts)}`,
        '',
        node.detail,
        '',
        ...(node.refs ? [`References: ${formatRefs(node.refs)}`, ''] : []),
      ];
    case 'diff':
      return renderDiff(node);
    case 'review_finding':
      return [
        `### 🔍 Review finding (turn ${node.turnIndex}) · ${formatTs(node.ts)}`,
        '',
        ...quote(node.detail),
        ...metaLines([
          ['Resolved', node.resolved],
          ['At', node.atSeconds !== undefined ? `${node.atSeconds}s` : undefined],
          ['Plan step', node.planStepId],
          ['Lineage', node.lineage?.join(', ')],
        ]),
      ];
    case 'progress':
      return [`- ⏳ ${node.label} — ${Math.round(node.value * 100)}% · ${formatTs(node.ts)}`, ''];
    case 'reference':
      return [`- 🔗 References: ${formatRefs(node.refs)} · ${formatTs(node.ts)}`, ''];
    case 'notice':
      return [
        `### ${node.level === 'error' ? '⚠️ Error' : node.level === 'warning' ? '⚠️ Warning' : 'ℹ️ Notice'} · ${formatTs(node.ts)}`,
        '',
        ...quote(node.text),
        ...metaLines([
          ['Detail', node.detail],
          ['Reason', node.reason],
          ['Retryable', node.retryable],
        ]),
      ];
    /* v8 ignore next 2 -- exhaustive over ViewNode; unreachable for a well-typed log */
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Raw (non-node) event renderers
// ---------------------------------------------------------------------------

/** Events the reducer folds into a {@link ViewNode}; rendered from the node instead. */
function renderRawEvent(event: AiEvent): readonly string[] {
  switch (event.type) {
    case 'status':
      return [`_Run status: **${event.status}** · ${formatTs(event.ts)}_`, ''];
    case 'usage':
      return [
        `### 💰 Usage · ${formatTs(event.ts)}`,
        '',
        ...metaLines([
          ['Tokens', event.tokens],
          ['Cost (USD)', event.usd],
          ['Model calls', event.modelCalls],
        ]),
      ];
    case 'context_usage':
      return [
        `### 📦 Context · ${formatTs(event.ts)}`,
        '',
        ...metaLines([
          ['Used tokens', event.usedTokens],
          ['Context window', event.contextWindow],
          ['Estimated', event.estimated],
        ]),
        ...jsonSection('Context manifest', event.manifest),
      ];
    case 'checkpoint':
      return [
        `### 🚩 Checkpoint · ${formatTs(event.ts)}`,
        '',
        ...metaLines([
          ['Goal', event.goal],
          ['Steps completed', event.stepsCompleted],
        ]),
        ...listSection('Action log', event.log),
        ...jsonSection('Applied operations', event.ops),
        ...jsonSection('Working state', event.working),
      ];
    case 'run_state':
      return [`### 🧾 Run state · ${formatTs(event.ts)}`, '', ...jsonBlock(event.working)];
    case 'task_started':
      return [
        `- ▶️ Task started: ${event.label} (\`${event.taskId}\`${event.resourceClass ? `, ${event.resourceClass}` : ''}) · ${formatTs(event.ts)}`,
        '',
      ];
    case 'task_finished':
      return [
        `- ⏹ Task ${event.status}: \`${event.taskId}\`${event.runtimeMs !== undefined ? ` · ${formatDuration(event.runtimeMs)}` : ''} · ${formatTs(event.ts)}`,
        '',
      ];
    case 'effect_progress':
      return [
        `- ⏳ ${event.label} — ${Math.round(event.value * 100)}% (\`${event.taskId}\`) · ${formatTs(event.ts)}`,
        '',
      ];
    default:
      // Never lose an event: anything not modelled above is dumped verbatim.
      return [`### ❔ ${event.type} · ${formatTs(event.ts)}`, '', ...jsonBlock(event)];
  }
}

// ---------------------------------------------------------------------------
// Log walk
// ---------------------------------------------------------------------------

/**
 * The node id an event folds into, or `null` when the event has no node.
 *
 * `assistant_delta`/`reasoning_delta` fold into their parent; `tool_result`/`ask`
 * hang off the tool call they belong to.
 */
function foldedNodeId(event: AiEvent): string | null {
  switch (event.type) {
    case 'assistant_delta':
    case 'reasoning_delta':
      return event.parentId;
    case 'tool_result':
    case 'ask':
      return event.toolCallId;
    case 'user_message':
    case 'assistant_message':
    case 'reasoning':
    case 'plan':
    case 'tool_call':
    case 'timeline_action':
    case 'diff':
    case 'review_finding':
    case 'progress':
    case 'reference':
    case 'notification':
    case 'warning':
    case 'error':
      return event.id;
    default:
      return null;
  }
}

/**
 * Reasoning blocks that reuse one producer id are FORKED by the reducer into
 * `id`, `id#2`, `id#3`… (see `openReasoning` in the SDK). Queue every node that
 * belongs to a producer so the walk emits each block once, in order.
 */
function reasoningForks(nodes: readonly ViewNode[], producerId: string): readonly string[] {
  return nodes
    .filter((node) => node.kind === 'reasoning' && node.id.startsWith(`${producerId}#`))
    .map((node) => node.id);
}

/** Render the event log in order, each folded node exactly once, nothing dropped. */
function renderLog(events: readonly AiEvent[]): readonly string[] {
  const { nodes } = reduceEvents(events);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const emitted = new Set<string>();
  const lines: string[] = [];
  let turnId: string | null = null;
  let turnCount = 0;

  for (const event of events) {
    if (event.turnId !== turnId) {
      turnId = event.turnId;
      turnCount += 1;
      lines.push('---', '', `## Turn ${turnCount} · ${formatTs(event.ts)}`, '');
    }

    const id = foldedNodeId(event);
    if (id === null) {
      lines.push(...renderRawEvent(event));
      continue;
    }

    // A reasoning block may have been forked by the reducer; emit the next unemitted
    // fork of this producer rather than repeating the first one.
    const candidates =
      event.type === 'reasoning' || event.type === 'reasoning_delta'
        ? [id, ...reasoningForks(nodes, id)]
        : [id];
    const nextId = candidates.find((candidate) => !emitted.has(candidate));
    const node = nextId === undefined ? undefined : nodeById.get(nextId);

    if (node === undefined) {
      // Either already rendered (a delta/status update/attachment), or an event the
      // reducer deliberately drops (a zero-operation diff, an orphan tool result).
      // Only the latter still needs a record, and only once per event id.
      if (candidates.some((candidate) => emitted.has(candidate)) || emitted.has(event.id)) continue;
      emitted.add(event.id);
      lines.push(...renderRawEvent(event));
      continue;
    }

    emitted.add(node.id);
    lines.push(...renderNode(node));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export a conversation as a complete Markdown transcript — every message, thought,
 * tool call with its arguments and raw result, proposed edit with its operations,
 * status change, cost, and checkpoint in the log.
 */
export function toMarkdown(conversation: Conversation): string {
  const view = reduceEvents(conversation.events);
  return [
    `# ${conversation.title}`,
    '',
    ...metaLines([
      ['Conversation', conversation.id],
      ['Project', conversation.projectId],
      ['Model', conversation.model],
      ['Mode', conversation.mode],
      ['Created', formatTs(conversation.createdAt)],
      ['Updated', formatTs(conversation.updatedAt)],
      ['Final status', view.status],
      ['Events', conversation.events.length],
    ]),
    ...renderLog(conversation.events),
  ].join('\n');
}

/** Export a conversation as its exact JSON record (re-importable). */
export function toJson(conversation: Conversation): string {
  return JSON.stringify(conversation, null, 2);
}
