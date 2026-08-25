/**
 * Per-type AI event renderers (Phase 11 M4, ADR 0033; redesigned — "the run thread").
 *
 * One component per {@link ViewNode} kind, all hung off a single continuous **spine**:
 * a 1px thread down the activity stream with a status *bead* per step. That is the one
 * structural idea here — an agent run is a sequence, and it should scan as one thread of
 * work rather than a stack of unrelated boxes. Every step contributes exactly one row:
 *
 *   │  ● Find silence                        1.2s   ⤢ ⧉
 *   │  ○ Thought for 3s
 *   │  ▲ Trim clip                     couldn't run
 *
 * Design rules this file holds to (see `styles.css`, `.ai-event*`):
 *
 * - **The bead carries status; the row carries identity.** Only exceptional states
 *   (warning/failed/cancelled) get a glyph — a green check on all thirty rows of a long
 *   run is noise, so `completed` is a quiet filled dot. Colour comes from the design
 *   system tones (`statusTone.ts`); colours are never invented.
 * - **One leading glyph per row.** The tool's own icon occupies a single slot and swaps
 *   to a chevron on hover/expand — never chevron + status + glyph stacked up.
 * - **Chrome recedes.** Per-row actions (details/copy) fade in on hover or focus and stay
 *   in the DOM and the a11y tree the whole time.
 * - **One heavy surface: the decision card.** A proposed edit is the only thing here the
 *   editor must act on, so it is the only thing that gets a card, a state-coloured edge,
 *   and keyboard shortcuts (A/R/P while focus is inside it).
 *
 * Pure presentational components over the reduced view — the sidebar shell owns state.
 * Reasoning/tool cards are collapsible and keyboard-operable; reference chips dispatch an
 * optional reveal callback (M5 wires it to the editor).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ToolStatus } from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';
import type { AiStreamAnswerMessage } from '@framepilot/shared-types';
import type {
  AssistantNode,
  DiffNode,
  NoticeNode,
  PlanNode,
  ProgressNode,
  Reference,
  ReferenceNode,
  ReasoningNode,
  ReviewFindingNode,
  TimelineActionNode,
  ToolNode,
  UserNode,
  ViewNode,
} from '@framepilot/ai-sdk';
import { describeOperation } from '@framepilot/ai-sdk';
import { Button } from '@framepilot/ui';
import { toReviewCard } from '../../editor/ai.js';
import { DiffPreviewModal } from './DiffPreviewModal.js';
import { PackInstallInlineCard, packMissingProposal } from './PackInstallInlineCard.js';
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Film,
  Folder,
  ICON_SIZE,
  Layers,
  Maximize2,
  MessageCircleQuestion,
  Minus,
  Music,
  Sparkles,
  Type,
  X,
} from '../icons.js';
import type { LucideIcon } from '../icons.js';
import { Tooltip } from '../Tooltip.js';
import { Markdown } from './Markdown.js';
import { PlanStepMark } from './PlanStepMark.js';
import { runStatusTone, toolStatusTone } from './statusTone.js';
import { isToolAvailable, toolMeta } from './toolMeta.js';
import { useModalFocusTrap } from './useModalFocusTrap.js';

/** Human label for a tool status — shown as the tooltip on its status bead (#10). */
const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  running: 'Running…',
  completed: 'Completed',
  warning: 'No change',
  failed: 'Failed',
  cancelled: 'Stopped',
};

/**
 * One step's bead on the run's spine: the status marker that punches through the thread.
 *
 * Deliberately asymmetric. A run is mostly successes, so `completed` is the quietest
 * mark there is — a small filled dot in the success tone. Only the states that want the
 * editor's attention (`warning`, `failed`, `cancelled`) spend a glyph, which is what makes
 * them findable when you scroll a hundred rows looking for the one that went wrong.
 * `running` keeps the spinner: it is the only mark that must read as *live*.
 */
/**
 * What a step's status IS once the run around it is over.
 *
 * A card only ever leaves `running` when its own settling event arrives. A run that ends
 * without one — the editor dismissed the model's question, the transport aborted
 * mid-call, the desktop hub timed the run out — used to leave that card spinning and its
 * elapsed counter climbing forever, minutes after everything had stopped. Nothing can be
 * running when no run is: the row settles as `cancelled`, which is what actually
 * happened to it.
 */
function staleStatus(status: ToolStatus, runEnded?: boolean): ToolStatus {
  return runEnded === true && status === 'running' ? 'cancelled' : status;
}

function ToolStatusIcon({ status }: { status: ToolStatus }): JSX.Element {
  const tone = toolStatusTone(status);
  return (
    <Tooltip label={TOOL_STATUS_LABEL[status]} placement="right">
      <span className="ai-tool-status" data-tone={tone} aria-label={TOOL_STATUS_LABEL[status]}>
        {status === 'running' ? (
          <span className="ai-spinner" aria-hidden="true" />
        ) : status === 'completed' ? (
          <span className="ai-bead" aria-hidden="true" />
        ) : status === 'warning' ? (
          <AlertTriangle size={ICON_SIZE.sm} aria-hidden="true" />
        ) : status === 'cancelled' ? (
          <Ban size={ICON_SIZE.sm} aria-hidden="true" />
        ) : (
          <X size={ICON_SIZE.sm} aria-hidden="true" />
        )}
      </span>
    </Tooltip>
  );
}

/**
 * The fixed-width gutter every activity row starts with: the spine passes behind it and
 * the row's bead sits on top, so the thread reads as continuous even though each row
 * draws its own segment (a virtualised list can unmount any row at any time — a single
 * shared rail element would break the moment it recycled).
 */
function StepSlot({ children }: { children?: ReactNode }): JSX.Element {
  return <span className="ai-step-slot">{children}</span>;
}

/** Copy-to-clipboard icon button that flips to a check for a beat after a copy. */
function CopyButton({
  text,
  label = 'Copy',
}: {
  /**
   * What to put on the clipboard — as a **thunk** when producing it is expensive.
   *
   * WHY the thunk: this button sits on every tool row, and its text is the row's whole
   * recap including `JSON.stringify` of the tool's payload. Passing that as a value
   * built it on every render of every row — during a live run, once per streamed frame
   * batch, for results that are megabytes on a feature-length project (a project
   * document echo, waveform peaks, a full timeline read). Nobody had asked for a single
   * one of those strings. Deferring to the click makes the cost proportional to use.
   */
  text: string | (() => string);
  label?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  const onCopy = useCallback(() => {
    const value = typeof text === 'function' ? text() : text;
    void navigator.clipboard?.writeText(value).then(() => setCopied(true));
  }, [text]);
  return (
    <>
      <Tooltip label={copied ? 'Copied' : label}>
        <button type="button" className="ai-icon-action" aria-label={label} onClick={onCopy}>
          {copied ? (
            <Check size={ICON_SIZE.sm} aria-hidden="true" />
          ) : (
            <Copy size={ICON_SIZE.sm} aria-hidden="true" />
          )}
        </button>
      </Tooltip>
      {/* The icon flip is invisible to a screen reader; announce the result instead.
          Kept OUTSIDE the button so it never joins the button's accessible name. */}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}

/** Callback to reveal a referenced clip/track/asset in the editor (M5 wires it). */
export type RevealHandler = (reference: Reference) => void;

/** Sends the editor's reply to the model's pending question (P12). */
export type AnswerHandler = (answer: AiStreamAnswerMessage) => void;

/** 1 Hz clock that only ticks while `active` — drives the live elapsed readout (U4). */
function useTicker(active: boolean): number {
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowTs(Date.now());
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return nowTs;
}

/** Human runtime for editors, not engineers: quick sub-second calls read as
 *  "instant"; longer ones round to whole/one-decimal seconds (no raw `ms`). */
function formatRuntime(ms: number): string {
  if (ms < 1000) return 'instant';
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/**
 * The user's turn — where a long thread visibly restarts.
 *
 * Cursor's move, and the right one: not an accent-filled chat bubble, but a quiet card
 * with an accent tick down its leading edge. In a run that produces fifty activity rows,
 * that tick is the only thing you scroll to when you want "where did I ask for this".
 */
function UserMessage({ node }: { node: UserNode }): JSX.Element {
  return (
    <div className="ai-event ai-event--user" role="listitem">
      <div className="ai-bubble ai-bubble--user">{node.text}</div>
    </div>
  );
}

function AssistantMessage({ node }: { node: AssistantNode }): JSX.Element {
  return (
    <div className="ai-event ai-event--assistant" role="listitem">
      <span className="ai-avatar" aria-hidden="true">
        <Sparkles size={ICON_SIZE.sm} />
      </span>
      <div className="ai-bubble ai-bubble--assistant">
        {node.streaming ? (
          <div className="ai-streaming-text">{node.text}</div>
        ) : (
          <Markdown text={node.text} />
        )}
        {node.streaming && <span className="ai-caret" aria-hidden="true" />}
      </div>
    </div>
  );
}

/** "Thought for Ns" header from the node's real elapsed thinking time (U3). */
function thoughtLabel(thoughtMs: number): string {
  if (thoughtMs < 1000) return 'Thought for <1s';
  const seconds = Math.round(thoughtMs / 1000);
  if (seconds < 60) return `Thought for ${seconds}s`;
  return `Thought for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function Reasoning({
  node,
  runEnded,
}: {
  node: ReasoningNode;
  /** The run is over — a still-streaming thought is stale, not live (see `staleStatus`). */
  runEnded?: boolean;
}): JSX.Element | null {
  // Auto-expand while the model is still thinking so its streamed rationale is
  // visible live; auto-collapse to a summary line the moment it settles (product
  // ask #1). The reviewer can still open it afterwards — and once they've toggled
  // it by hand we stop auto-collapsing so we never fight their choice.
  const done = node.done || runEnded === true;
  const [open, setOpen] = useState(!done);
  const userToggledRef = useRef(false);
  const wasDoneRef = useRef(done);
  useEffect(() => {
    if (!wasDoneRef.current && done && !userToggledRef.current) setOpen(false);
    wasDoneRef.current = done;
  }, [done]);
  const toggle = useCallback(() => {
    userToggledRef.current = true;
    setOpen((v) => !v);
  }, []);
  // Reasoning's bead is hollow, never a status: thinking is not a step that can pass or
  // fail, and giving it a tone would make it compete with the tool rows around it.
  const bead = (
    <StepSlot>
      <span className="ai-step-node" data-live={!done} aria-hidden="true" />
    </StepSlot>
  );
  // A settled node with no captured rationale has nothing to open, so it renders
  // nothing at all — not a "Thought for Ns" row you can click forever with no result.
  // The duration alone is not thinking: it is how long the model took, and a model that
  // returned no thinking (it wasn't asked, it doesn't support it, or the request was
  // degraded) must not be presented as having shown its work. While still thinking the
  // row stays regardless — the shimmer signals live activity, which IS true.
  if (done && node.summaries.every((summary) => summary.trim() === '')) return null;
  const settledLabel = node.thoughtMs !== undefined ? thoughtLabel(node.thoughtMs) : 'Reasoning';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="ai-event ai-event--reasoning" role="listitem" data-expanded={open}>
      {bead}
      <div className="ai-step-body">
        <button type="button" className="ai-reasoning-toggle" aria-expanded={open} onClick={toggle}>
          <span className={!done ? 'ai-shimmer-text' : undefined}>
            {done ? settledLabel : 'Thinking…'}
          </span>
          <Chevron size={ICON_SIZE.sm} aria-hidden="true" className="ai-reveal-chevron" />
        </button>
        <div className="ai-accordion" data-open={open} aria-hidden={!open}>
          <div className="ai-accordion-inner">
            {node.summaries.length > 0 && (
              <div className="ai-reasoning-list">
                {node.summaries.map((summary, i) => (
                  <div key={i} className="ai-reasoning-line">
                    {done ? (
                      <Markdown text={summary} />
                    ) : (
                      <div className="ai-streaming-text">{summary}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The live plan checklist.
 *
 * A plan is the run's table of contents, so unlike a tool row it keeps a *check* on every
 * done step — here the ticks are the point (they show how far through the work is), and
 * there are five of them, not fifty. It rides the same spine with no bead of its own: the
 * checklist is the whole turn, not one step in it.
 */
/** What a step's own edit did, joined by `DiffEvent.planStepId`. */
export interface StepOutcome {
  readonly operationCount: number;
  /** Where on the timeline the change begins, when the edit names a position. */
  readonly jumpSeconds?: number;
}

/**
 * The run's plan, where each step also carries what it actually did.
 *
 * A step and its edit are the same event described twice, so they are one row. When the
 * edit was its own card the sidebar told the story in two parallel narratives — a checklist
 * saying "Remove them" and, further down, a card saying "9 changes" — and the reader had to
 * join them by eye. With no decision left to make, the edit has no reason to hold a surface
 * of its own.
 */
function PlanChecklist({
  node,
  outcomes,
  onSeek,
}: {
  node: PlanNode;
  outcomes?: ReadonlyMap<string, StepOutcome>;
  onSeek?: (seconds: number) => void;
}): JSX.Element {
  const doneCount = node.steps.filter((step) => step.status === 'completed').length;
  return (
    <div className="ai-event ai-event--plan" role="listitem">
      <StepSlot />
      <div className="ai-step-body">
        <div className="ai-plan-head">
          <span className="ai-plan-title">Plan</span>
          <span className="ai-plan-progress tabular">
            {doneCount}/{node.steps.length}
          </span>
        </div>
        <ul className="ai-plan">
          {node.steps.map((step) => {
            const outcome = outcomes?.get(step.id);
            return (
              <li key={step.id} className="ai-plan-step" data-status={step.status}>
                <PlanStepMark step={step} />
                <span className={step.status === 'running' ? 'ai-shimmer-text' : undefined}>
                  {step.label}
                </span>
                {step.status === 'running' && step.detail && step.detail !== step.label ? (
                  // U2: a planned (ledger) step shows the turn's ACTUAL activity as a
                  // muted suffix while it runs — plan text stays the row's identity.
                  <span className="ai-plan-detail">{step.detail}</span>
                ) : null}
                {outcome && (
                  <span className="ai-plan-outcome tabular">
                    {outcome.operationCount} change{outcome.operationCount === 1 ? '' : 's'}
                  </span>
                )}
                {outcome?.jumpSeconds !== undefined && onSeek && (
                  <button
                    type="button"
                    className="ai-plan-jump"
                    aria-label={`Jump to what step ${step.label} changed`}
                    onClick={() => onSeek(outcome.jumpSeconds!)}
                  >
                    <ArrowUpRight size={ICON_SIZE.sm} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Render a labeled row of clickable reference chips for affected ids. */
function AffectedRow({
  label,
  ids,
  kind,
  onReveal,
}: {
  label: string;
  ids: readonly string[];
  kind: Reference['kind'];
  onReveal?: RevealHandler;
}): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <ReferenceChips
          refs={ids.map((id) => ({ kind, id, label: id }))}
          {...(onReveal ? { onReveal } : {})}
        />
      </dd>
    </>
  );
}

/** The detail attached to a tool call once its result arrives (non-optional form). */
type ToolResult = NonNullable<ToolNode['result']>;

/** Roughly one row's worth of text in the sidebar. A summary at or under this length
 *  with no line break reads as a single line, so there is nothing to expand for (#1). */
const ONE_LINE_SUMMARY_MAX = 80;

/** True when a summary can't fit on one row — the only reason to make a row with no
 *  structured output expandable (a trivial one-liner stays a quiet status line). */
function summaryExceedsOneLine(summary: string | undefined): boolean {
  if (summary === undefined) return false;
  return summary.includes('\n') || summary.length > ONE_LINE_SUMMARY_MAX;
}

/**
 * A tool's ACTUAL output (`result.result`) as display/copy text: strings verbatim,
 * everything else pretty-printed as 2-space JSON. Returns `undefined` when the call
 * reported no structured output, so callers can fall back to the summary.
 */
function formatToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    // Non-serializable payload (cycles, BigInt, …) — a best-effort string beats
    // crashing the whole sidebar over one tool's odd return value.
    return String(output);
  }
}

/** Recap of what a step did, for the copy button and details modal: the plain-language
 *  summary + affected ids, then the tool's real output and logs so the clipboard
 *  reflects what actually came back — not only the friendly label. */
function formatToolDetails(node: ToolNode, title: string): string {
  const r = node.result;
  const parts: string[] = [title];
  if (node.runtimeMs !== undefined) parts.push(`Took ${formatRuntime(node.runtimeMs)}`);
  if (r?.summary) parts.push(`\n${r.summary}`);
  if (r?.clips?.length) parts.push(`\nClips: ${r.clips.join(', ')}`);
  if (r?.tracks?.length) parts.push(`\nTracks: ${r.tracks.join(', ')}`);
  if (r?.files?.length) parts.push(`\nFiles: ${r.files.join(', ')}`);
  const output = formatToolOutput(r?.result);
  if (output) parts.push(`\nOutput:\n${output}`);
  if (r?.logs?.length) parts.push(`\nLogs:\n${r.logs.join('\n')}`);
  if (r?.warnings?.length) parts.push(`\nHeads up:\n${r.warnings.join('\n')}`);
  return parts.join('\n');
}

/** Output this small reads at a glance, so hiding it behind a second click is worse than
 *  showing it. Anything larger folds away (see {@link ToolOutputBlock}). */
const INLINE_OUTPUT_MAX_LINES = 8;
const INLINE_OUTPUT_MAX_CHARS = 600;

/** Lines rendered when the fold is open. A tool can return tens of thousands (a project
 *  document, an index dump); putting all of them in the DOM stalls the sidebar, and nobody
 *  reads line 4,000 in a 320px-tall box. Copy/Details give the untruncated text. */
const OPEN_OUTPUT_MAX_LINES = 200;

/** "1,284 lines · 48 KB" — enough to judge whether opening it is worth it. */
function describeOutput(text: string): string {
  const lines = text.split('\n').length;
  const kb = Math.round(text.length / 1024);
  const size = kb >= 1 ? `${kb.toLocaleString()} KB` : `${text.length.toLocaleString()} chars`;
  return `${lines.toLocaleString()} line${lines === 1 ? '' : 's'} · ${size}`;
}

/** The first {@link OPEN_OUTPUT_MAX_LINES} lines plus, when it was cut, a line saying how
 *  much is missing and where to get it — never a silent truncation. */
function boundedOutput(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= OPEN_OUTPUT_MAX_LINES) return text;
  const hidden = lines.length - OPEN_OUTPUT_MAX_LINES;
  return `${lines.slice(0, OPEN_OUTPUT_MAX_LINES).join('\n')}\n\n… ${hidden.toLocaleString()} more lines — Copy for the full output`;
}

/**
 * A tool's structured output. Small results render inline as before; a large one collapses
 * to a single measured line ("Output · 1,284 lines · 48 KB") that opens on demand.
 *
 * WHY: a step's raw result is reference material, not the answer — the summary above it is
 * the answer. Rendered in full it buried every other step in the run under a wall of JSON
 * (one failing analysis echoed the whole project document, waveform peaks included), and
 * put tens of thousands of DOM-heavy characters in a scroll box nobody reads to the end of.
 */
function ToolOutputBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const small =
    text.length <= INLINE_OUTPUT_MAX_CHARS && text.split('\n').length <= INLINE_OUTPUT_MAX_LINES;
  if (small) return <pre className="ai-tool-output-body">{text}</pre>;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="ai-tool-output-fold">
      <button
        type="button"
        className="ai-tool-output-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <Chevron size={ICON_SIZE.sm} aria-hidden="true" className="ai-reveal-chevron" />
        <span>Output · {describeOutput(text)}</span>
        <span className="ai-tool-output-hint">{open ? 'Hide' : 'Show all'}</span>
      </button>
      <div className="ai-accordion" data-open={open} aria-hidden={!open}>
        <div className="ai-accordion-inner">
          <pre className="ai-tool-output-body">{boundedOutput(text)}</pre>
        </div>
      </div>
    </div>
  );
}

/**
 * A tool's real output rendered readably — what a reviewer expands the row (or opens the
 * modal) to see. A string shows verbatim with whitespace preserved; a structured value is
 * pretty JSON in a scroll-contained `<pre>` so a wide object never pushes the sidebar
 * sideways; anything long folds behind {@link ToolOutputBlock}. Any `logs` follow below,
 * on the same rule. With no structured output we fall back to the full (untruncated)
 * summary so the expanded body is never empty.
 */
function ToolOutput({ result }: { result: ToolResult }): JSX.Element {
  const output = formatToolOutput(result.result);
  const logs = result.logs && result.logs.length > 0 ? result.logs.join('\n') : undefined;
  return (
    <div className="ai-tool-output">
      {output !== undefined ? (
        <ToolOutputBlock text={output} />
      ) : result.summary ? (
        <p className="ai-tool-output-summary">{result.summary}</p>
      ) : (
        <p className="ai-tool-empty">Nothing to report for this step.</p>
      )}
      {logs !== undefined && <pre className="ai-tool-output-logs">{boundedOutput(logs)}</pre>}
    </div>
  );
}

/** The full-detail modal for a tool call (#9) — input/summary/result/logs/warnings. */
function ToolDetailsModal({
  node,
  title,
  onClose,
  onReveal,
}: {
  node: ToolNode;
  title: string;
  onClose: () => void;
  onReveal?: RevealHandler;
}): JSX.Element {
  const result = node.result;
  const outputText = result ? formatToolOutput(result.result) : undefined;
  // Close on Escape, matching the app's other dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // D3b: trap focus inside the modal (Tab/Shift+Tab wrap, no escape to the page
  // behind it), move focus in on open, and return it to the trigger on close.
  const modalRef = useModalFocusTrap<HTMLDivElement>();
  return createPortal(
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={modalRef}
        className="ai-tool-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} details`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ai-tool-modal-head">
          <ToolStatusIcon status={node.status} />
          <span className="ai-tool-modal-title">{title}</span>
          {node.runtimeMs !== undefined && (
            <span className="ai-tool-time tabular">{formatRuntime(node.runtimeMs)}</span>
          )}
          <CopyButton text={() => formatToolDetails(node, title)} label="Copy summary" />
          <Tooltip label="Close" shortcut="Esc">
            <button type="button" className="ai-icon-action" aria-label="Close" onClick={onClose}>
              <X size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </Tooltip>
        </header>
        {/* A plain-language recap up top (what happened + what it touched), then the
            tool's ACTUAL output and logs below — so the modal reflects what really came
            back, not only the friendly label. The output is the untruncated form of what
            the inline row shows when expanded. */}
        <div className="ai-tool-modal-body">
          {result ? (
            <dl className="ai-tool-detail">
              {result.summary && (
                <>
                  <dt>What happened</dt>
                  <dd>{result.summary}</dd>
                </>
              )}
              {outputText !== undefined && (
                <>
                  <dt>Output</dt>
                  <dd>
                    <pre className="ai-tool-output-body">{outputText}</pre>
                  </dd>
                </>
              )}
              {result.clips && result.clips.length > 0 && (
                <AffectedRow
                  label="Clips"
                  ids={result.clips}
                  kind="clip"
                  {...(onReveal ? { onReveal } : {})}
                />
              )}
              {result.tracks && result.tracks.length > 0 && (
                <AffectedRow
                  label="Tracks"
                  ids={result.tracks}
                  kind="track"
                  {...(onReveal ? { onReveal } : {})}
                />
              )}
              {result.files && result.files.length > 0 && (
                <AffectedRow
                  label="Files"
                  ids={result.files}
                  kind="file"
                  {...(onReveal ? { onReveal } : {})}
                />
              )}
              {result.logs && result.logs.length > 0 && (
                <>
                  <dt>Logs</dt>
                  <dd>
                    <pre className="ai-tool-output-logs">{result.logs.join('\n')}</pre>
                  </dd>
                </>
              )}
              {result.warnings && result.warnings.length > 0 && (
                <>
                  <dt>Heads up</dt>
                  <dd className="ai-tool-warn">{result.warnings.join('\n')}</dd>
                </>
              )}
              {!result.summary &&
                outputText === undefined &&
                !result.logs?.length &&
                !result.clips?.length &&
                !result.tracks?.length &&
                !result.files?.length &&
                !result.warnings?.length && (
                  <dd className="ai-tool-empty">Nothing to report for this step.</dd>
                )}
            </dl>
          ) : (
            <p className="ai-tool-empty">Nothing to report for this step.</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The model's question, rendered where it was asked (P12).
 *
 * Everything shown is the model's own words — we contribute layout, not wording, so a
 * question nobody anticipated renders as well as one we designed for. Options are real
 * buttons because picking is the common case; the free-text field appears when the model
 * offered no options, or alongside them when none of the choices fit — a model can only
 * guess at the options, and the editor should never be trapped inside its guesses.
 *
 * The layout is a proper decision card (the same grammar as the plan-approval card): the
 * question is the heading, each choice is a full-width row with a radio mark, hover
 * highlight and its own consequence line, and the footer separates the two things that
 * are NOT the same gesture — sending an answer, and dismissing the question, which stops
 * the run rather than feeding the model a reply the editor never gave.
 *
 * Picking a choice answers immediately (one click, as before). The mark fills on the way
 * out so the card visibly says which one you hit before it settles into its receipt.
 */
function AskPrompt({
  node,
  onAnswer,
  runEnded,
}: {
  node: ToolNode;
  onAnswer: AnswerHandler;
  /** The run this question belongs to is over — nothing can be answered any more. */
  runEnded?: boolean;
}): JSX.Element | null {
  const ask = node.ask;
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  // The run is stopped until this is answered, so the answer field takes focus the moment
  // the question appears — the editor should never have to hunt for where to reply.
  const inputRef = useRef<HTMLInputElement>(null);
  // Once the call settles, the exchange is over: the answer is the node's result, and a
  // live prompt would invite answering a question that is no longer being asked. A node
  // still marked `running` after the RUN ended is the same thing — the gate it would
  // resolve died with the run (see `runEnded`).
  const pending = Boolean(ask) && node.status === 'running' && runEnded !== true;
  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending]);
  if (!ask || !pending) return null;
  const answerWith = (value: string): void => {
    const answer = value.trim();
    if (!answer) return;
    setChosen(answer);
    onAnswer({ toolCallId: ask.toolCallId, kind: 'answered', answer });
  };
  const options = ask.options ?? [];
  return (
    <div className="ai-ask" role="group" aria-label="A question from FramePilot">
      <div className="ai-ask-head">
        <span className="ai-ask-badge" aria-hidden="true">
          <MessageCircleQuestion size={13} />
        </span>
        <p className="ai-ask-question">{ask.question}</p>
      </div>
      {options.length > 0 && (
        <div className="ai-ask-options">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              className="ai-ask-option"
              aria-pressed={chosen === option.label.trim()}
              onClick={() => answerWith(option.label)}
            >
              <span className="ai-ask-mark" aria-hidden="true" />
              <span className="ai-ask-option-text">
                <span className="ai-ask-option-label">{option.label}</span>
                {option.description && (
                  <span className="ai-ask-option-detail">{option.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="ai-ask-free">
        <input
          ref={inputRef}
          type="text"
          className="ai-ask-input"
          value={text}
          placeholder={options.length > 0 ? 'Or tell it something else…' : 'Type your answer…'}
          aria-label="Your answer"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              answerWith(text);
            }
          }}
        />
      </div>
      <div className="ai-ask-footer">
        <button
          type="button"
          className="ai-ask-dismiss"
          onClick={() => onAnswer({ toolCallId: ask.toolCallId, kind: 'cancelled' })}
        >
          Dismiss and stop
        </button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => answerWith(text)}
          disabled={text.trim() === ''}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

/**
 * What the exchange settled to, always visible (product ask: "I have to expand blocks to
 * see my own answers").
 *
 * A question and the answer given to it are the two things in a run the editor is most
 * likely to scroll back for — they are decisions they made, not machine output. So they
 * are NOT behind the accordion, and never rendered as the raw `{ question, answer }`
 * payload the details view used to show: the question in the model's words, the answer in
 * the editor's, on the row where it happened.
 */
function AskReceipt({
  node,
  runEnded,
  reply,
}: {
  node: ToolNode;
  runEnded?: boolean;
  /**
   * What the editor did here, remembered locally.
   *
   * Normally the settled call carries it (`node.result.summary` IS the answer). It does
   * not when the run died around the question — dismissing is exactly that case, since
   * dismissing STOPS the run — so without this the row would report "never answered" for
   * a question the editor had just this second answered or dismissed.
   */
  reply?: AiStreamAnswerMessage | null;
}): JSX.Element | null {
  const ask = node.ask;
  if (!ask) return null;
  // Still live — `AskPrompt` owns this node until it settles.
  if (node.status === 'running' && runEnded !== true) return null;
  const state: 'answered' | 'dismissed' | 'unanswered' =
    node.status === 'completed' || (node.status === 'running' && reply?.kind === 'answered')
      ? 'answered'
      : node.status === 'cancelled' || reply?.kind === 'cancelled'
        ? 'dismissed'
        : 'unanswered';
  const answer =
    node.result?.summary?.trim() ||
    (reply?.kind === 'answered' ? reply.answer.trim() : undefined) ||
    undefined;
  return (
    <div className="ai-ask-receipt" data-state={state}>
      <p className="ai-ask-receipt-question">{ask.question}</p>
      <p className="ai-ask-receipt-answer">
        <span className="ai-ask-receipt-mark" aria-hidden="true">
          {state === 'answered' ? (
            <Check size={12} />
          ) : state === 'dismissed' ? (
            <Ban size={12} />
          ) : (
            <Minus size={12} />
          )}
        </span>
        <span className="ai-ask-receipt-text">
          {state === 'answered'
            ? (answer ?? 'Answered')
            : state === 'dismissed'
              ? 'You dismissed this and stopped the run.'
              : (answer ?? 'The run ended before this was answered.')}
        </span>
      </p>
    </div>
  );
}

function ToolCard({
  node,
  onReveal,
  onAnswer,
  runEnded,
  expanded: controlledOpen,
  onToggleExpanded,
}: {
  node: ToolNode;
  onReveal?: RevealHandler;
  /** Answers the model's question when this call is an `ask_user` (P12). */
  onAnswer?: AnswerHandler;
  /** The run is over. A card still marked `running` is stale — see {@link staleStatus}. */
  runEnded?: boolean;
  /** Controlled expansion (the sidebar remembers it for the whole run); falls back to local state. */
  expanded?: boolean;
  onToggleExpanded?: (nodeId: string, open: boolean) => void;
}): JSX.Element {
  const result = node.result;
  const summary = result?.summary;
  // The card is an accordion, COLLAPSED by default so a long run reads as a quiet
  // status list; the whole header is a toggle. Expansion is remembered by the
  // sidebar per node id, so a virtualization unmount/remount keeps the state.
  //
  // Expandable only when there's something worth opening for: real tool output
  // (`result.result`), or a summary too long to fit on the one-line row. A trivial
  // one-line summary with no output stays a quiet status row — no chevron (#1).
  const hasOutput = result?.result !== undefined && result?.result !== null;
  // A question is never an accordion: `AskReceipt` shows the question and the answer in
  // full, in plain words, so the only thing opening the row could add is the raw
  // `{ question, answer }` payload — which is what made an editor expand two boxes to
  // read back their own answers.
  const isAsk = Boolean(node.ask);
  const canExpand = !isAsk && (hasOutput || summaryExceedsOneLine(summary));
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean): void => {
    if (onToggleExpanded) onToggleExpanded(node.id, next);
    else setLocalOpen(next);
  };
  const [detailsOpen, setDetailsOpen] = useState(false);
  // A question's reply, kept here as well as sent: dismissing STOPS the run, so the card
  // it belongs to is often never settled by an event. See {@link AskReceipt.reply}.
  const [askReply, setAskReply] = useState<AiStreamAnswerMessage | null>(null);
  const answerAndRemember = useCallback(
    (reply: AiStreamAnswerMessage): void => {
      setAskReply(reply);
      onAnswer?.(reply);
    },
    [onAnswer],
  );
  const meta = toolMeta(node.toolName);
  const Icon = meta.Icon;
  const gated = !isToolAvailable(node.toolName);
  const status = staleStatus(node.status, runEnded);
  // The row says what the exchange IS now, not what the model called: "Asking you: <the
  // first 40 characters of the question>" was a truncated copy of a question shown in
  // full three lines below it. The status label is the one thing the collapsed row can
  // add that the card itself does not.
  const askTitle = !isAsk
    ? undefined
    : status === 'running'
      ? 'Waiting for your answer'
      : status === 'cancelled'
        ? 'You dismissed the question'
        : 'You answered';
  const title = askTitle ?? node.title ?? meta.label;
  const hasDetails = Boolean(result) && !isAsk;
  // A failed pack-backed tool carries the exact signed install proposal. The
  // model cannot install anything; this card is the human's path to fix it.
  const missingPackProposal = useMemo(() => {
    if (status !== 'failed') return null;
    return packMissingProposal(result?.result);
  }, [status, result]);
  const expanded = open && canExpand;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  // Live elapsed while the call runs (from the running event's timestamp);
  // frozen to the reported runtime once it settles (U4). Whole seconds only —
  // a decimal that repaints every tick reads as jitter, not progress.
  const running = status === 'running' && !gated;
  const nowTs = useTicker(running);
  const elapsedMs = running ? Math.max(0, nowTs - node.ts) : undefined;
  return (
    <div className="ai-event ai-event--tool" role="listitem" data-gated={gated}>
      <StepSlot>
        {gated ? (
          <Tooltip label="Coming soon" placement="right">
            <span className="ai-tool-status" data-tone="idle" aria-label="Coming soon">
              <span className="ai-bead" data-hollow="true" aria-hidden="true" />
            </span>
          </Tooltip>
        ) : (
          <ToolStatusIcon status={status} />
        )}
      </StepSlot>
      <div className="ai-step-body">
        <div className="ai-tool-head">
          <button
            type="button"
            className="ai-tool-toggle"
            aria-expanded={expanded}
            disabled={!canExpand}
            onClick={() => setOpen(!open)}
          >
            {/* ONE leading glyph. The tool's own icon identifies the step at rest and
                swaps to a chevron on hover/expand, so an expandable row advertises
                itself without spending a second slot on a permanent chevron. */}
            <span className="ai-tool-glyphs" aria-hidden="true">
              <Icon size={ICON_SIZE.sm} className="ai-tool-glyph" />
              {canExpand && <Chevron size={ICON_SIZE.sm} className="ai-tool-chevron" />}
            </span>
            {/* The friendly title already says what the step did (e.g. "Trimming
                Intro"); the raw `argsSummary` line (ids/params) is deliberately NOT
                rendered — it reads as debugger output to a video editor (product ask #2).
                `title` restores the full text for a name the row had to truncate. */}
            <span className="ai-tool-name" title={title}>
              {title}
            </span>
          </button>
          {node.runtimeMs !== undefined ? (
            <span className="ai-tool-time tabular">{formatRuntime(node.runtimeMs)}</span>
          ) : elapsedMs !== undefined && elapsedMs >= 1000 ? (
            <span className="ai-tool-time tabular">{Math.floor(elapsedMs / 1000)}s</span>
          ) : null}
          {hasDetails && (
            // Chrome recedes (Notion): these fade in on row hover / keyboard focus, but
            // they are always mounted and always reachable by Tab.
            <span className="ai-row-actions">
              <Tooltip label="View details">
                <button
                  type="button"
                  className="ai-icon-action"
                  aria-label="View details"
                  onClick={() => setDetailsOpen(true)}
                >
                  <Maximize2 size={ICON_SIZE.sm} aria-hidden="true" />
                </button>
              </Tooltip>
              <CopyButton text={() => formatToolDetails(node, title)} />
            </span>
          )}
        </div>
        {/* Collapsed, the row is a single status line (header only) so a long run reads as a
            quiet list, not a wall of open boxes. Expanding reveals the tool's ACTUAL output
            (`result.result`) — the thing you open the row to see — never a re-clamped copy
            of the one-line summary. Rendered only while open so a long run doesn't keep
            dozens of large payloads mounted. Hidden while a question is pending: the prompt
            below is the only thing worth reading then. */}
        {expanded && result && !isAsk && <ToolOutput result={result} />}
        {missingPackProposal !== null && <PackInstallInlineCard proposal={missingPackProposal} />}
        {isAsk && <AskReceipt node={node} reply={askReply} {...(runEnded ? { runEnded } : {})} />}
        {onAnswer && (
          <AskPrompt node={node} onAnswer={answerAndRemember} {...(runEnded ? { runEnded } : {})} />
        )}
      </div>
      {detailsOpen && (
        <ToolDetailsModal
          node={node}
          title={title}
          onClose={() => setDetailsOpen(false)}
          {...(onReveal ? { onReveal } : {})}
        />
      )}
    </div>
  );
}

/** Per-kind chip glyph. `data-kind` was already on the chip but rendered identically for
 *  every kind — a clip and an output file looked the same. The glyph makes the chip say
 *  what it points at before you read the id. */
const REFERENCE_ICON: Record<Reference['kind'], LucideIcon> = {
  clip: Film,
  track: Layers,
  file: Folder,
  asset: Music,
  transition: Sparkles,
  caption: Type,
};

function ReferenceChips({
  refs,
  onReveal,
  onPreview,
}: {
  refs: readonly Reference[];
  onReveal?: RevealHandler;
  /** When set, clicking a chip opens the before/after preview for it instead of
   *  revealing it on the timeline (product ask #11). Falls back to `onReveal`. */
  onPreview?: (reference: Reference) => void;
}): JSX.Element {
  return (
    <span className="ai-chips">
      {refs.map((reference) => {
        const Glyph = REFERENCE_ICON[reference.kind] ?? Film;
        return (
          <button
            key={`${reference.kind}:${reference.id}`}
            type="button"
            className="ai-chip"
            data-kind={reference.kind}
            {...(onPreview ? { title: 'Preview this change' } : {})}
            onClick={() => (onPreview ? onPreview(reference) : onReveal?.(reference))}
          >
            <Glyph size={12} aria-hidden="true" className="ai-chip-glyph" />
            {reference.label}
          </button>
        );
      })}
    </span>
  );
}

function TimelineAction({
  node,
  onReveal,
}: {
  node: TimelineActionNode;
  onReveal?: RevealHandler;
}): JSX.Element {
  return (
    <div className="ai-event ai-event--action" role="listitem">
      <StepSlot>
        <span className="ai-step-node" data-solid="true" aria-hidden="true" />
      </StepSlot>
      <div className="ai-step-body ai-action-body">
        <span className="ai-action-label">{node.action}</span>
        {node.detail && <span className="ai-action-detail">{node.detail}</span>}
        {node.refs && node.refs.length > 0 && (
          <ReferenceChips refs={node.refs} {...(onReveal ? { onReveal } : {})} />
        )}
      </div>
    </div>
  );
}

/** True when a keystroke should be treated as a card shortcut rather than typing. */
function isPlainKeystroke(e: ReactKeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const target = e.target as HTMLElement | null;
  if (!target) return true;
  const tag = target.tagName;
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !target.isContentEditable;
}

/**
 * The receipt for one edit that has already been applied to the timeline.
 *
 * It used to be the one thing here the editor had to *decide* on, and carried the weight
 * to match — Accept/Reject, keyboard shortcuts, a state-coloured edge. Edits now apply as
 * they land, so this card's job is narrower and quieter: say what changed and let the user
 * go look at it. The only state that still earns attention is an edit that could not be
 * applied at all.
 *
 * Accept/Reject/Preview bind to A/R/P while focus is anywhere inside the card. Card-scoped
 * rather than global on purpose: the editor already owns most single letters as timeline
 * shortcuts, and a decision this consequential should not fire from across the app. The
 * `<kbd>` hints in the buttons are how the binding is discovered — they carry `aria-hidden`
 * so the buttons' accessible names stay exactly "Accept" / "Reject".
 */
function DiffCard({
  node,
  onReveal,
  onSeek,
  applyFailed,
  expanded: controlledOpen,
  onToggleExpanded,
  project,
  fps,
}: {
  node: DiffNode;
  onReveal?: RevealHandler;
  /** Move the editor playhead (Jump to timeline seeks to where the change is). */
  onSeek?: (seconds: number) => void;
  /** The edit could not be written (stale against the current timeline). */
  applyFailed?: boolean;
  /** Controlled expansion (the sidebar remembers it for the whole run); falls back to local state. */
  expanded?: boolean;
  onToggleExpanded?: (nodeId: string, open: boolean) => void;
  /** The current project — the read-only before/after popup renders against it. */
  project?: Project;
  fps: number;
}): JSX.Element {
  // Variations / A-B compare (H1.5, AGENT-NATIVE-COMPLETION-PLAN.md P13.1): `node.variants`
  // is present only for an opt-in, genuinely model-driven multi-candidate run (never a
  // agent diff — those never carry it, see `DiffEvent.variants`). The
  // user flips between candidates by re-pointing ONE `AiReviewPlayer`/review card at
  // whichever index is selected — not N simultaneous instances.
  const variants = node.variants && node.variants.length > 1 ? node.variants : undefined;
  const [selectedVariant, setSelectedVariant] = useState(0);
  const activeEdit = variants?.[selectedVariant] ?? node.edit;
  const card = toReviewCard(activeEdit);
  const actions = activeEdit.patch.operations.map((op) => describeOperation(op));
  const firstRef = actions.flatMap((a) => a.refs)[0];
  // The timeline position of the first change — where "Jump to timeline" seeks and
  // where preview should start (product ask: begin ON the change, not at 0:00).
  const region = card.changedRegions[0];
  const jumpTarget = region?.afterRange?.start ?? region?.beforeRange?.start;
  // The card is a RECEIPT, not a decision: the edit is already on the timeline by the
  // time this renders. Collapsed by default — the header's summary is enough for an edit
  // the user can simply look at — and expanded when something went wrong.
  const [localOpen, setLocalOpen] = useState(!card.valid);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean): void => {
    if (onToggleExpanded) onToggleExpanded(node.id, next);
    else setLocalOpen(next);
  };
  const Chevron = open ? ChevronDown : ChevronRight;
  // `DiffEvent.variants` guarantees `edit` mirrors `variants[0]`, so Take A is the one
  // that actually landed. The tabs preview the alternatives; they no longer choose between
  // them, because there is no decision step left in which to choose. Saying which take is
  // on the timeline is the difference between a preview and a lie.
  const variantLabel = (index: number): string => `Take ${String.fromCharCode(65 + index)}`;
  const appliedVariant = 0;
  // "Show preview" opens the review POPUP (product ask #3), which re-assembles a
  // before/after against the live project — so it's available whenever we have the
  // project and a valid edit to preview, not tied to the inline card's own timelines.
  const canPreview = project !== undefined && card.valid;
  const [previewOpen, setPreviewOpen] = useState(false);
  // Clicking a clip/caption/image chip opens a read-only before/after popup for
  // THAT change (product ask #11). Holds the op index to seek to, or null.
  const [comparePreview, setComparePreview] = useState<number | null>(null);
  const onCardKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!isPlainKeystroke(e)) return;
    if (e.key.toLowerCase() === 'p' && canPreview) {
      e.preventDefault();
      setPreviewOpen(true);
    }
  };
  // Roving arrow keys across the take tabs, as a real tablist should have.
  const onTabsKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!variants) return;
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedVariant((i) => (i + delta + variants.length) % variants.length);
  };
  return (
    <div
      className="ai-event ai-event--diff"
      role="listitem"
      data-applied={card.valid && !applyFailed}
      data-valid={card.valid}
      onKeyDown={onCardKeyDown}
    >
      <button
        type="button"
        className="ai-diff-head ai-diff-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron size={ICON_SIZE.sm} aria-hidden="true" className="ai-diff-chevron" />
        {/* Past tense: this already happened. The old "Suggested edit" belonged to a
            world where the card was asking permission. */}
        <span
          className="ai-diff-verdict"
          data-tone={card.valid && !applyFailed ? 'completed' : 'failed'}
        >
          {!card.valid
            ? 'Can’t apply this edit'
            : applyFailed
              ? 'Couldn’t apply this edit'
              : 'Edited'}
        </span>
        {node.scope === 'turn' && node.turnIndex !== undefined && (
          <span className="ai-diff-step tabular">Step {node.turnIndex}</span>
        )}
        <span className="ai-diff-count tabular">
          {card.operationCount} change{card.operationCount === 1 ? '' : 's'}
        </span>
        {variants && <span className="ai-diff-variant-badge">{variants.length} alternatives</span>}
      </button>
      {variants && (
        <div
          className="ai-diff-variants"
          role="tablist"
          aria-label="Alternative takes"
          onKeyDown={onTabsKeyDown}
        >
          {variants.map((_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={selectedVariant === i}
              tabIndex={selectedVariant === i ? 0 : -1}
              className="ai-diff-variant-tab"
              data-selected={selectedVariant === i}
              onClick={() => setSelectedVariant(i)}
            >
              {variantLabel(i)}
              {i === appliedVariant && <span className="ai-diff-variant-applied"> · applied</span>}
            </button>
          ))}
        </div>
      )}
      <div className="ai-accordion" data-open={open} aria-hidden={!open}>
        <div className="ai-accordion-inner">
          {card.reason && <p className="ai-diff-reason">{card.reason}</p>}
          {actions.length > 0 && (
            <ul className="ai-diff-actions">
              {actions.map((action, i) => (
                <li key={i} className="ai-diff-action">
                  <span className="ai-action-label">{action.action}</span>
                  {action.detail && <span className="ai-action-detail">{action.detail}</span>}
                  {action.refs.length > 0 && (
                    <ReferenceChips
                      refs={action.refs}
                      {...(onReveal ? { onReveal } : {})}
                      {...(canPreview ? { onPreview: () => setComparePreview(i) } : {})}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {card.changes.length > 0 && (
            <ul className="ai-diff-changes">
              {card.changes.map((change, i) => (
                <li key={i}>{change}</li>
              ))}
            </ul>
          )}
          {!card.valid && card.problems.length > 0 && (
            <ul className="ai-diff-problems">
              {card.problems.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {applyFailed && (
        <p className="ai-diff-decided" role="alert">
          <span className="ai-decision-pill" data-decision="failed">
            <AlertTriangle size={ICON_SIZE.sm} aria-hidden="true" /> Couldn’t apply
          </span>
          <span className="ai-decision-note">
            The timeline changed since this was worked out — ask again for a fresh edit.
          </span>
        </p>
      )}
      {card.valid && !applyFailed && (
        // Inspect actions only. Jump comes first: the edit is already on the timeline, so
        // going and looking at it is the useful thing to do, not deciding about it.
        <div className="ai-diff-buttons">
          <div className="ai-diff-inspect">
            {(firstRef || jumpTarget !== undefined) && (
              <button
                type="button"
                className="ai-btn ai-btn--quiet"
                onClick={() => {
                  if (firstRef) onReveal?.(firstRef);
                  if (jumpTarget !== undefined) onSeek?.(jumpTarget);
                }}
              >
                Jump to timeline
              </button>
            )}
            {canPreview ? (
              <button
                type="button"
                className="ai-btn ai-btn--quiet"
                onClick={() => setPreviewOpen(true)}
              >
                Show preview
                <kbd className="ai-kbd" aria-hidden="true">
                  P
                </kbd>
              </button>
            ) : (
              // A bare `title` on a disabled button is effectively invisible: Firefox and
              // Safari never fire hover/focus on a natively-disabled element, so the only
              // channel for "why can't I click this" disappears there.
              <Tooltip label="Preview renders through the engine — coming to this surface">
                <span tabIndex={0}>
                  <button type="button" className="ai-btn ai-btn--quiet" disabled>
                    Preview
                  </button>
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      )}
      {previewOpen && project && (
        <DiffPreviewModal
          node={{ ...node, edit: activeEdit }}
          project={project}
          fps={fps}
          onClose={() => setPreviewOpen(false)}
          {...(onReveal ? { onReveal } : {})}
          {...(onSeek ? { onSeek } : {})}
        />
      )}
      {comparePreview !== null && project && (
        <DiffPreviewModal
          variant="compare"
          initialSelected={comparePreview}
          node={{ ...node, edit: activeEdit }}
          project={project}
          fps={fps}
          onClose={() => setComparePreview(null)}
          {...(onReveal ? { onReveal } : {})}
          {...(onSeek ? { onSeek } : {})}
        />
      )}
    </div>
  );
}

/**
 * Indeterminate progress, on the spine.
 *
 * AI work has no measurable percentage (#5), so this is a hairline sweep aligned to the
 * thread rather than the 6px filled track it used to be — that read like a download, and
 * a download implies a percentage we cannot honestly give.
 */
function ProgressBar({ node }: { node: ProgressNode }): JSX.Element | null {
  // A settled bar (value >= 1) renders nothing — never a number.
  if (node.value >= 1) return null;
  return (
    <div className="ai-event ai-event--progress" role="listitem">
      <StepSlot>
        <span className="ai-step-node" data-live="true" aria-hidden="true" />
      </StepSlot>
      <div className="ai-step-body">
        <div className="ai-progress-label">
          <span className="ai-shimmer-text">{node.label}</span>
        </div>
        <div
          className="ai-progress-track ai-progress-track--indeterminate"
          role="progressbar"
          aria-label={node.label}
        >
          <div className="ai-progress-fill" />
        </div>
      </div>
    </div>
  );
}

/**
 * A notice: something went wrong, or is worth knowing.
 *
 * The old treatment washed the whole row in `--danger-subtle`, which shouted louder than
 * the proposed edits it sat between. Now the tone lives in a 2px leading rule and the
 * icon — enough to find it while scrolling, quiet enough to sit next to a decision.
 */
function Notice({
  node,
  onRetry,
  retryDisabled,
}: {
  node: NoticeNode;
  /**
   * Re-run the last turn — the exact same action the sidebar's action bar offers
   * for a failed/cancelled run (D1). Passed down from `AiSidebar` rather than
   * duplicated here, so there is only ever one retry implementation. Omitted by
   * read-only/preview surfaces that render notices without a live run to retry.
   */
  onRetry?: () => void;
  /** Disable the inline Retry while a run is already in flight. */
  retryDisabled?: boolean;
}): JSX.Element {
  const tone = node.level === 'error' ? 'failed' : node.level === 'warning' ? 'warning' : 'idle';
  // Progressive disclosure (the audience is video editors, not programmers, per
  // the 2026-07-12 "de-programmered UI" pass): the raw detail text starts hidden
  // behind a "Show details" toggle instead of always rendering a <pre> dump.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showRetry = Boolean(node.retryable && onRetry);
  return (
    <div className="ai-event ai-event--notice" role="listitem" data-level={node.level}>
      {node.level !== 'info' && (
        <AlertTriangle
          size={ICON_SIZE.sm}
          aria-hidden="true"
          className="ai-tone-icon"
          data-tone={tone}
        />
      )}
      <div className="ai-notice-body">
        <span className="ai-notice-text">{node.text}</span>
        {(showRetry || node.detail) && (
          <div className="ai-notice-actions">
            {showRetry &&
              (retryDisabled ? (
                // Same reasoning as DiffCard's disabled Preview button: a bare `disabled`
                // attribute with no explanation is a dead end, and native `title` doesn't
                // reach keyboard users or Firefox/Safari. Tooltip does.
                <Tooltip label="Wait for the current run to finish first.">
                  <span tabIndex={0}>
                    <button type="button" className="ai-btn ai-btn--quiet" disabled>
                      Retry
                    </button>
                  </span>
                </Tooltip>
              ) : (
                <button type="button" className="ai-btn ai-btn--quiet" onClick={onRetry}>
                  Retry
                </button>
              ))}
            {node.detail && (
              <>
                <button
                  type="button"
                  className="ai-btn ai-btn--quiet"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  {detailsOpen ? 'Hide details' : 'Show details'}
                </button>
                <CopyButton text={node.detail} label="Copy details" />
              </>
            )}
          </div>
        )}
        {node.detail && detailsOpen && <pre className="ai-notice-detail">{node.detail}</pre>}
      </div>
    </div>
  );
}

/** Seconds → `m:ss`, for naming where in the programme a finding sits. */
function atLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * One perceptual-review observation about an edit that has already been applied.
 *
 * The two states carry deliberately different weight. A finding the agent went on to fix is
 * narrative — the run says what it checked and moved on, so it renders as one quiet line and
 * must not read as an alert about a problem the user still has. A finding still unresolved is
 * the loudest thing in the stream: with edits applying automatically, it is the only class of
 * problem the run could not solve on the user's behalf, so it states what is wrong and offers
 * the one useful action, which is to go and look at it.
 */
function ReviewFinding({
  node,
  onSeek,
}: {
  node: ReviewFindingNode;
  onSeek?: (seconds: number) => void;
}): JSX.Element {
  const where = node.atSeconds !== undefined ? ` at ${atLabel(node.atSeconds)}` : '';
  if (node.resolved) {
    return (
      <div className="ai-event ai-event--finding" role="listitem" data-resolved="true">
        <StepSlot>
          <Check size={ICON_SIZE.sm} aria-hidden="true" className="ai-finding-mark" />
        </StepSlot>
        <div className="ai-step-body ai-finding-body">
          <span className="ai-finding-detail">
            Checked{where} — {node.detail}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div
      className="ai-event ai-event--finding"
      role="listitem"
      data-resolved="false"
      // An unresolved finding is the one thing in an auto-applying run the user must act
      // on, so it is announced rather than left for them to scroll back and discover.
      aria-live="polite"
    >
      <StepSlot>
        <AlertTriangle size={ICON_SIZE.sm} aria-hidden="true" className="ai-finding-mark" />
      </StepSlot>
      <div className="ai-step-body ai-finding-body">
        <span className="ai-finding-label">Review found{where}</span>
        <span className="ai-finding-detail">{node.detail}</span>
        {node.atSeconds !== undefined && onSeek && (
          <button
            type="button"
            className="ai-btn ai-btn--quiet"
            onClick={() => onSeek(node.atSeconds!)}
          >
            Jump to timeline
          </button>
        )}
      </div>
    </div>
  );
}

/** Render one reduced view node by kind. */
export const EventNode = memo(function EventNode({
  node,
  onReveal,
  onAnswer,
  onSeek,
  runEnded,
  applyFailed,
  stepOutcomes,
  expanded,
  onToggleExpanded,
  project,
  fps,
  onRetryNotice,
  retryDisabled,
}: {
  node: ViewNode;
  onReveal?: RevealHandler;
  /** Answers the model's question (P12) — only a `tool` node can carry one. */
  onAnswer?: AnswerHandler;
  /** Move the editor playhead (diff "Jump to timeline" / preview seek). */
  onSeek?: (seconds: number) => void;
  /**
   * No run is in flight. Any node still marked live belongs to a run that ended without
   * settling it, so it renders as stopped instead of spinning forever — and a pending
   * question stops offering a reply nothing is listening for.
   */
  runEnded?: boolean;
  /** The edit could not be written (stale against the current timeline). */
  applyFailed?: boolean;
  /** What each plan step's own edit did, keyed by step id — see {@link StepOutcome}. */
  stepOutcomes?: ReadonlyMap<string, StepOutcome>;
  /** Controlled accordion state for tool/diff cards (remembered by the sidebar). */
  expanded?: boolean;
  onToggleExpanded?: (nodeId: string, open: boolean) => void;
  /** The current project — threaded to a `diff` node's before/after preview popup. */
  project?: Project;
  fps?: number;
  /** D1: re-run the last turn from a retryable error notice's inline Retry button —
   *  the SAME action the sidebar's action bar exposes for a failed/cancelled run. */
  onRetryNotice?: () => void;
  /** Disable a notice's inline Retry while a run is already in flight. */
  retryDisabled?: boolean;
}): JSX.Element {
  switch (node.kind) {
    case 'user':
      return <UserMessage node={node} />;
    case 'assistant':
      return <AssistantMessage node={node} />;
    case 'reasoning':
      return <Reasoning node={node} {...(runEnded ? { runEnded } : {})} />;
    case 'plan':
      return (
        <PlanChecklist
          node={node}
          {...(stepOutcomes ? { outcomes: stepOutcomes } : {})}
          {...(onSeek ? { onSeek } : {})}
        />
      );
    case 'tool':
      return (
        <ToolCard
          node={node}
          {...(onReveal ? { onReveal } : {})}
          {...(onAnswer ? { onAnswer } : {})}
          {...(runEnded ? { runEnded } : {})}
          {...(expanded !== undefined ? { expanded } : {})}
          {...(onToggleExpanded ? { onToggleExpanded } : {})}
        />
      );
    case 'timeline_action':
      return <TimelineAction node={node} {...(onReveal ? { onReveal } : {})} />;
    case 'diff':
      return (
        <DiffCard
          node={node}
          fps={fps ?? 30}
          {...(project ? { project } : {})}
          {...(onReveal ? { onReveal } : {})}
          {...(onSeek ? { onSeek } : {})}
          {...(applyFailed ? { applyFailed } : {})}
          {...(expanded !== undefined ? { expanded } : {})}
          {...(onToggleExpanded ? { onToggleExpanded } : {})}
        />
      );
    case 'review_finding':
      return <ReviewFinding node={node} {...(onSeek ? { onSeek } : {})} />;
    case 'progress':
      return <ProgressBar node={node} />;
    case 'reference':
      return (
        <div className="ai-event ai-event--reference" role="listitem">
          <ReferenceChips refs={(node as ReferenceNode).refs} {...(onReveal ? { onReveal } : {})} />
        </div>
      );
    case 'notice':
      return (
        <Notice
          node={node}
          {...(onRetryNotice ? { onRetry: onRetryNotice } : {})}
          {...(retryDisabled !== undefined ? { retryDisabled } : {})}
        />
      );
  }
});

export { runStatusTone };
