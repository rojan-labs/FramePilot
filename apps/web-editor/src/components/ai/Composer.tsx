/**
 * The AI composer (Phase 11 M8, ADR 0033): a workspace input, not a chat box.
 *
 * Adds a **slash-command palette** (FramePilot task commands), **quick actions**
 * (one-tap prompt prefills), an **included-context panel** (removable chips derived
 * from the project + selection + pinned entities), an **"@" pin-context picker**
 * (H1.5, P8.7 narrow slice — search timeline clips/`project.assets` and pin one as
 * extra context), and **attachment chips** with a paste handler. Voice/mic is
 * intentionally absent (Approval A5). Pure presentational state lives here; the
 * parent owns the conversation + run.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RunStatus } from '@framepilot/ai-sdk';
import type { Attachment, ContextItem } from '../../ai/conversation.js';
import {
  QUICK_ACTIONS,
  type PinnedEntity,
  filterAtEntities,
  filterSlashCommands,
  isAtQuery,
  isSlashQuery,
  removeAtQuery,
} from '../../ai/composerActions.js';
import { ICON_SIZE, Paperclip, Send, Square, X } from '../icons.js';
import {
  ContextWindowIndicator,
  type ContextPhase,
  type ContextWindowState,
} from './ContextWindowIndicator.js';
import type { ContextDebugInfo } from './ContextDebugger.js';
import { runStatusLabel } from './statusTone.js';

/** Max composer height (px) before it scrolls internally — keep in sync with CSS. */
const MAX_COMPOSER_HEIGHT = 200;

/** BeautifulUI's Drive loader timing, adapted to a real FramePilot run indicator. */
const ACTIVITY_PIXEL_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/**
 * Live run duration beside the activity label. The timer is presentation-only: the
 * durable run/event timestamps remain authoritative everywhere else in the app.
 */
function useElapsedRunTime(active: boolean): string {
  const [deciseconds, setDeciseconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setDeciseconds(0);
      return;
    }

    setDeciseconds(0);
    const timer = window.setInterval(() => setDeciseconds((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, [active]);

  const seconds = deciseconds / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly running: boolean;
  /** Current durable run phase, rendered as compact activity above the writing row. */
  readonly runStatus?: RunStatus;
  /** Most recent model call's prompt occupancy (per call, not cumulative cost). */
  readonly contextWindow: ContextWindowState;
  /**
   * What the current request is doing — assembling context, generating, or idle. Named
   * states rather than one spinner: they are different waits and read differently.
   */
  readonly contextPhase: ContextPhase;
  /** Dev-only context inspector data; absent in production builds. */
  readonly contextDebug?: ContextDebugInfo;
  /** Included-context chips (already filtered by the parent's removals). */
  readonly contextItems: readonly ContextItem[];
  readonly onRemoveContext: (id: string) => void;
  readonly attachments: readonly Attachment[];
  readonly onAddAttachment: (attachment: Attachment) => void;
  readonly onRemoveAttachment: (id: string) => void;
  /**
   * Attach reference videos/images from a file picker (plan/system-mission P3.1). The
   * sidebar imports and analyzes them; the composer only collects the files.
   */
  readonly onAttachFiles?: (files: readonly File[]) => void;
  /**
   * Every clip/asset the "@" picker can pin (P8.7 narrow slice) — the parent
   * derives this from the project via `pinnableEntities`. Typing `@query` filters
   * this list into a dropdown; picking one calls {@link onPinEntity} and removes
   * the `@query` token from the composer text.
   */
  readonly atEntities: readonly PinnedEntity[];
  readonly onPinEntity: (entity: PinnedEntity) => void;
}

export function Composer(props: ComposerProps): JSX.Element {
  const { value, onChange, onSubmit, onStop, running } = props;
  const [showQuick, setShowQuick] = useState(false);
  const slashMatches = useMemo(() => filterSlashCommands(value), [value]);
  const atMatches = useMemo(
    () => filterAtEntities(value, props.atEntities),
    [value, props.atEntities],
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const elapsed = useElapsedRunTime(running);

  // Auto-grow the textarea to fit its content (#6) so a multi-line message expands
  // the box instead of clipping/scrolling — capped at MAX_COMPOSER_HEIGHT, after which
  // it scrolls internally. Runs on every value change (typing, prefill, or clearing).
  //
  // Empty content skips the scrollHeight measurement entirely and just clears the
  // inline height: this component remounts fresh whenever the AI rail collapses
  // and re-expands (WorkspaceShell drops it from the tree while collapsed), and a
  // synchronous scrollHeight read on that first layout can race the rail's CSS
  // width transition — an empty textarea has no content to legitimately need
  // 200px for, so there is nothing to measure that a plain reset doesn't already
  // get right (CSS `min-height: 24px` takes back over).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (value.trim() === '') {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [value]);

  const submit = (): void => {
    if (value.trim().length > 0) onSubmit();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !isSlashQuery(value) && !isAtQuery(value)) {
      event.preventDefault();
      submit();
    }
  };

  const pickEntity = (entity: PinnedEntity): void => {
    onChange(removeAtQuery(value));
    props.onPinEntity(entity);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const file = Array.from(event.clipboardData.files)[0];
    if (file) {
      event.preventDefault();
      props.onAddAttachment({
        id: `att_${Date.now()}`,
        kind: file.type.startsWith('image/')
          ? 'image'
          : file.type.startsWith('video/')
            ? 'video'
            : 'document',
        name: file.name || 'pasted',
      });
    }
  };

  return (
    <div className="ai-composer-shell">
      {running && props.runStatus ? (
        // The supplied BeautifulUI loading primitive is intentionally adapted rather
        // than copied as demo state: a compact 3×3 drive wave + shimmer + elapsed time
        // describes the current REAL run phase without adding another spinner source.
        <div className="ai-composer-activity">
          <span className="ai-pixel-loader" aria-hidden="true">
            {ACTIVITY_PIXEL_DELAYS.map((delay, index) => (
              <span
                key={index}
                className="ai-loader-pixel"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          <span className="ai-activity-label ai-shimmer-text" role="status" aria-live="polite">
            {runStatusLabel(props.runStatus)}
          </span>
          <span className="ai-activity-elapsed tabular" aria-hidden="true">
            {elapsed}
          </span>
        </div>
      ) : null}
      {props.contextItems.length > 0 && (
        // Included-context chips (P8.4/P8.7/P12.7): what the orchestrator's
        // `context-builder` actually receives for the next turn — the always-on
        // project/timeline/transcript/asset chips, plus a "Selected" chip when the
        // editor has a live timeline selection. Each is removable; removing one
        // (e.g. the selection chip) means it is NOT sent as context for the next
        // turn (`AiSidebar` filters `contextItems` by the removed-id list before it
        // builds the request) — mirrors the attachment chips' remove affordance.
        <div className="ai-context-chips" aria-label="Included context">
          {props.contextItems.map((item) => (
            <span
              key={item.id}
              className="ai-context-chip"
              data-kind={item.kind}
              title={item.label}
            >
              <span className="ai-context-chip-label">{item.label}</span>
              <button
                type="button"
                aria-label={`Remove ${item.label}`}
                onClick={() => props.onRemoveContext(item.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {props.attachments.length > 0 && (
        <div className="ai-attachments" aria-label="Attachments">
          {props.attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="ai-chip"
              data-kind={attachment.kind}
              title={attachment.name}
            >
              <span className="ai-context-chip-label">{attachment.name}</span>
              {attachment.role ? (
                <span className="ai-chip-badge" data-role={attachment.role}>
                  {attachment.role}
                </span>
              ) : null}
              {attachment.status && attachment.status !== 'ready' ? (
                <span
                  className="ai-chip-status"
                  data-status={attachment.status}
                  title={attachment.error ?? attachment.status}
                >
                  {attachment.status === 'analyzing' ? 'analyzing…' : attachment.status}
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => props.onRemoveAttachment(attachment.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {showQuick && (
        <div className="ai-quick" role="menu" aria-label="Quick actions">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className="ai-quick-item"
              onClick={() => {
                onChange(action.prompt);
                setShowQuick(false);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {slashMatches.length > 0 && (
        <ul className="ai-slash" role="listbox" aria-label="Slash commands">
          {slashMatches.map((command) => (
            <li key={command.name}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onChange(`/${command.name} `)}
              >
                <span className="ai-slash-name">/{command.name}</span>
                <span className="ai-slash-desc">{command.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {atMatches.length > 0 && (
        // "@" pin-context picker (P8.7 narrow slice): search timeline clips + project
        // assets and pin one as an extra, independently-removable context chip — mirrors
        // the slash-command dropdown's interaction shape (reuses its `.ai-slash` styles).
        <ul className="ai-slash" role="listbox" aria-label="Pin context">
          {atMatches.map((entity) => (
            <li key={`${entity.kind}:${entity.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pickEntity(entity)}
              >
                <span className="ai-slash-name">@{entity.kind}</span>
                <span className="ai-slash-desc">{entity.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="ai-composer">
        <button
          type="button"
          className="ai-icon-button"
          aria-label="Quick actions"
          title="Quick actions"
          data-active={showQuick}
          onClick={() => setShowQuick((v) => !v)}
        >
          +
        </button>
        {props.onAttachFiles ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,image/*"
              multiple
              hidden
              aria-label="Reference files"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (files.length > 0) props.onAttachFiles?.(files);
              }}
            />
            <button
              type="button"
              className="ai-icon-button"
              aria-label="Attach reference video or image"
              title="Attach a reference video or image"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </>
        ) : null}
        <textarea
          ref={inputRef}
          className="ai-composer-input"
          value={value}
          placeholder="Message FramePilot…  (/ for commands)"
          aria-label="Message FramePilot"
          rows={1}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {/* Context belongs to workspace chrome, not inside the message row. This component
            keeps owning the value but portals its circular progress control into the AI header. */}
        <ContextWindowIndicator
          value={props.contextWindow}
          phase={props.contextPhase}
          placement="header"
          {...(props.contextDebug ? { debug: props.contextDebug } : {})}
        />
        {running ? (
          // Visually STABLE stop control (H2): no pulsing/blinking — a static ring
          // with distinct hover/pressed states; activity is signalled elsewhere
          // (activity row + streaming text), never by animating the kill switch.
          <button
            type="button"
            className="ai-composer-stop"
            aria-label="Stop agent"
            title="Stop agent"
            onClick={onStop}
          >
            <Square size={12} aria-hidden="true" className="ai-composer-stop-glyph" />
          </button>
        ) : (
          <button
            type="button"
            className="ai-composer-send"
            aria-label="Send"
            title="Send"
            disabled={value.trim().length === 0}
            onClick={submit}
          >
            <Send size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
