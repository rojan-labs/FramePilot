/**
 * Minimal, non-blocking toast notifications (plan 3.4 Part 4, PROMPT §7). Toasts
 * replace the old inline red validation-issue list: a rejected edit surfaces here
 * as a calm, auto-dismissing message instead of shifting the toolbar layout.
 *
 * `useToasts` is a small local queue (push / dismiss, auto-expiry). `<Toasts>`
 * renders the stack and, given the editor, watches `state.issues` to raise an
 * error toast whenever a patch is rejected — read-only observation, never an edit.
 *
 * Successful edits are intentionally NOT announced here: the project history
 * panel (HistoryPanel) is the durable, scrubbable record of every change, so a
 * per-edit "Timeline updated" toast would be redundant noise. Only failures
 * (which the panel does not surface) still toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseEditor } from '../editor/useEditor.js';
import { ICON_SIZE, X } from './icons.js';

/** Visual tone of a toast. */
export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
  /** Optional inline action (e.g. "Undo"). */
  readonly action?: { readonly label: string; readonly run: () => void };
}

/** How long a toast stays before auto-dismissing, by tone (ms). */
const AUTO_DISMISS_MS: Record<ToastTone, number> = {
  info: 4000,
  success: 4000,
  error: 6000,
};

export interface ToastQueue {
  readonly toasts: readonly Toast[];
  readonly push: (toast: Omit<Toast, 'id'>) => void;
  readonly dismiss: (id: number) => void;
}

/** A self-expiring toast queue. */
export function useToasts(): ToastQueue {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>): void => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...toast, id }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS[toast.tone]);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export interface ToastsProps {
  /** When provided, rejected-patch issues are surfaced as error toasts. */
  readonly editor?: UseEditor;
}

/**
 * The toast stack. Pass `editor` to auto-surface validation failures; the same
 * region can also be fed manually via the {@link useToasts} queue it owns.
 */
export function Toasts({ editor }: ToastsProps): JSX.Element {
  const { toasts, push, dismiss } = useToasts();
  // Track the last issue signature so we raise one toast per rejection, not per render.
  const lastIssueKey = useRef<string>('');

  useEffect(() => {
    const issues = editor?.state.issues ?? [];
    if (issues.length === 0) {
      lastIssueKey.current = '';
      return;
    }
    const key = issues.map((issue) => `${issue.code}:${issue.message}`).join('|');
    if (key === lastIssueKey.current) return;
    lastIssueKey.current = key;
    push({ tone: 'error', message: issues[0]!.message });
  }, [editor?.state.issues, push]);

  return (
    <div className="toast-host" role="status" aria-live="polite" aria-label="notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast is-${toast.tone}`}>
          <span className="toast-message">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                toast.action!.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
          >
            <X size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
