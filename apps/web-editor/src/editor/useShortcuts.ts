/**
 * Global keyboard shortcuts for the editor (plan 3.4 Part 3 — Premiere/Resolve
 * conventions). This hook is a thin DOM shell over the typed {@link SHORTCUTS}
 * registry: it normalises each keystroke to a canonical chord, finds the matching
 * shortcut, honours its `when` guard, and runs it. Every editing shortcut builds a
 * typed patch and routes through the same `useEditor` (`validate → apply → record`)
 * path as the toolbar, so there is no second, unchecked mutation path.
 *
 * The registry is the single source of truth shared with the `?` help overlay and
 * tooltips, so they can never drift (PROMPT §6).
 */
import { useEffect, useRef } from 'react';
import type { UseEditor } from './useEditor.js';
import {
  type Clipboard,
  type ShortcutDeps,
  type Tool,
  eventToChord,
  matchShortcut,
} from './shortcuts.js';

/** Options for the shortcut layer beyond the editor + fps. */
export interface ShortcutOptions {
  /** Open/close the `?` keyboard help overlay. */
  readonly onToggleHelp?: () => void;
  /** Whether the help overlay is currently open (shortcuts pause while it is). */
  readonly helpOpen?: boolean;
  /** Open the Settings dialog (⌘,). */
  readonly onOpenSettings?: () => void;
  /** Open/close the Cmd+K command palette. */
  readonly onTogglePalette?: () => void;
  /** Open/close the project history panel (⌘⇧H). */
  readonly onToggleHistory?: () => void;
  /**
   * Whether the Ripple toggle is ON (view state). Flips the Delete/Backspace
   * default to ripple; Shift then inverts. Defaults to `false`.
   */
  readonly rippleOnDelete?: boolean;
  /** Switch the active timeline tool (Selection `A` / Blade `B`). */
  readonly onSetTool?: (tool: Tool) => void;
  /** Flip magnetic snapping on/off (`N`) — the same setting the Settings dialog edits. */
  readonly onToggleSnapping?: () => void;
  /**
   * The selected effect LAYERS (schema v13) and a setter, so Delete and
   * Select-all act on them too. Held by `Editor` because it is view state.
   */
  readonly selectedEffectLayerIds?: readonly string[];
  readonly setSelectedEffectLayerIds?: (ids: readonly string[]) => void;
}

/** Whether a keystroke is being typed into a text field (so we leave it alone). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Range inputs are transport/transform controls rather than text entry. Keep
 * their native arrow/page-key adjustment, but let the editor's other global
 * shortcuts work when a newly-mounted slider happens to own focus. */
function rangeOwnsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLInputElement) || target.type !== 'range') return false;
  return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(key);
}

/**
 * Whether focus rests in the timeline (or nowhere in particular). Shortcuts the
 * browser also claims — ⌘A/Ctrl+A select-all-text, Delete — are only stolen here;
 * elsewhere the native behaviour is preserved so text selection keeps working.
 *
 * The `document.body` arm is load-bearing: after a marquee drag or a lane click
 * focus rests on the body, and ⌘A / Delete must still reach the timeline there.
 * It is also why NOTHING in this registry may bind Tab — see `select.next`.
 */
function timelineFocused(active: Element | null): boolean {
  return active === null || active === document.body || active.closest('.timeline') !== null;
}

/**
 * Wire global editor keyboard shortcuts to the patch-engine-backed store.
 *
 * @param editor - The active editor (read live via a ref each keystroke).
 * @param fps - Project frame rate, used for single-frame nudges/steps.
 * @param options - Help-overlay toggle + open state.
 */
export function useEditorShortcuts(
  editor: UseEditor,
  fps: number,
  options: ShortcutOptions = {},
): void {
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clipboardRef = useRef<Clipboard>({ current: null });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // While the help overlay is open it owns the keyboard (Esc/close, search).
      if (optionsRef.current.helpOpen) return;
      if (isTypingTarget(event.target) && rangeOwnsKey(event.target, event.key)) return;
      if (
        isTypingTarget(event.target) &&
        !(event.target instanceof HTMLInputElement && event.target.type === 'range')
      )
        return;

      const chord = eventToChord(event);
      const shortcut = matchShortcut(chord);
      if (!shortcut) return;
      const ed = editorRef.current;
      if (shortcut.when === 'selection' && !ed.state.selection) return;
      if (shortcut.when === 'timelineFocus' && !timelineFocused(document.activeElement)) return;

      event.preventDefault();
      const deps: ShortcutDeps = {
        editor: ed,
        fps: fpsRef.current,
        clipboard: clipboardRef.current,
        toggleHelp: () => optionsRef.current.onToggleHelp?.(),
        openSettings: () => optionsRef.current.onOpenSettings?.(),
        togglePalette: () => optionsRef.current.onTogglePalette?.(),
        toggleHistory: () => optionsRef.current.onToggleHistory?.(),
        requestZoom: (mode) =>
          window.dispatchEvent(new CustomEvent('framepilot:zoom', { detail: mode })),
        rippleOnDelete: optionsRef.current.rippleOnDelete === true,
        setTool: (tool) => optionsRef.current.onSetTool?.(tool),
        toggleSnapping: () => optionsRef.current.onToggleSnapping?.(),
        selectedEffectLayerIds: optionsRef.current.selectedEffectLayerIds ?? [],
        setSelectedEffectLayerIds: (ids) => optionsRef.current.setSelectedEffectLayerIds?.(ids),
      };
      shortcut.run(deps);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
