/**
 * The editor's keyboard shortcut **registry** (plan 3.4 Part 3, PROMPT §6).
 *
 * One typed array of `{ id, keys, when, group, label, run }` is the single source
 * of truth: the global key handler (`useShortcuts`) iterates it, and the `?` help
 * overlay and tooltips render from the same data, so they can never drift. Every
 * editing shortcut builds a typed patch and dispatches through `useEditor`
 * (`applyPatch`) — there is no second, unchecked path to mutate the timeline.
 *
 * Key matching is normalised to a canonical "chord" string (e.g. `mod+shift+z`,
 * `space`, `,`). `mod` is ⌘ on macOS and Ctrl elsewhere. Printable symbol keys
 * (`?`, `,`, `[`) already imply Shift on most layouts, so the chord omits it.
 */
import type { Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from './useEditor.js';
import { listEditPoints, nextEditPoint, prevEditPoint } from './edit-points.js';
import {
  adjacentClipId,
  adjacentMarker,
  clipOnAdjacentTrack,
  findClip,
  orderedClips,
  timelineDuration,
  effectLayersInApplyOrder,
} from './selectors.js';
import {
  deleteClipsPatch,
  duplicateClipsPatch,
  moveClipPatch,
  pasteClipPatch,
  splitClipPatch,
  trimClipPatch,
  removeEffectLayersPatch,
} from './patch-builders.js';

/** Fallback frame duration when a project has no usable fps. */
const FALLBACK_FPS = 30;
/** Timeline zoom multiplier per keystroke. */
const ZOOM_STEP = 1.5;
/** Coarse playhead nudge / step distance, in seconds. */
const COARSE_STEP_SECONDS = 1;

/** Logical grouping for the help overlay, in display order. */
export type ShortcutGroup =
  | 'Tools'
  | 'Transport'
  | 'Editing'
  | 'Selection'
  | 'Markers'
  | 'View'
  | 'History'
  | 'AI'
  | 'Help';

/** The active timeline tool — Selection (default) or Blade (click-to-cut). */
export type Tool = 'select' | 'blade';

/** Mutable clipboard holding the last copied clip snapshot (or `null`). */
export interface Clipboard {
  current: Clip | null;
}

/** Live dependencies a shortcut's `run` receives at dispatch time. */
export interface ShortcutDeps {
  readonly editor: UseEditor;
  readonly fps: number;
  readonly clipboard: Clipboard;
  /** Open/close the `?` keyboard help overlay. */
  readonly toggleHelp: () => void;
  /** Open the Settings dialog (⌘,). */
  readonly openSettings: () => void;
  /** Open/close the Cmd+K command palette. */
  readonly togglePalette: () => void;
  /** Open/close the project history panel (⌘⇧H). */
  readonly toggleHistory: () => void;
  /** Ask the timeline to zoom (handled via a window event so this stays decoupled). */
  readonly requestZoom: (mode: 'fit' | 'selection') => void;
  /**
   * Whether the Ripple toggle is ON (view state). When ON, the unmodified
   * Delete/Backspace ripples (closes the gap) and Shift+Delete inverts to a lift;
   * when OFF (default), Delete lifts and Shift+Delete ripples. Defaults to `false`.
   */
  readonly rippleOnDelete?: boolean;
  /**
   * The selected effect LAYERS (schema v13, ADR 0088), and a setter.
   *
   * Separate from `editor.state.selectedIds`, which holds CLIP ids: Delete and
   * Select-all have to act on whichever of the two the user is working with, but
   * a layer id in the clip selection would make every clip operation target
   * something that is not a clip.
   */
  readonly selectedEffectLayerIds?: readonly string[];
  readonly setSelectedEffectLayerIds?: (ids: readonly string[]) => void;
  /** Switch the active timeline tool (Selection/Blade). */
  readonly setTool: (tool: Tool) => void;
  /** Flip magnetic snapping on/off (the same setting the Settings dialog edits). */
  readonly toggleSnapping: () => void;
}

/** A single registered shortcut. */
export interface Shortcut {
  readonly id: string;
  /** Canonical chord strings that trigger it (any match runs it). */
  readonly keys: readonly string[];
  /**
   * Guard; defaults to always-on.
   * - `selection` — requires a selected clip.
   * - `timelineFocus` — only fires while focus rests in the timeline (or nowhere),
   *   so chords the browser also owns (Tab traversal, ⌘A select-all-text) keep
   *   their native behaviour everywhere else.
   */
  readonly when?: 'selection' | 'timelineFocus';
  readonly group: ShortcutGroup;
  readonly label: string;
  readonly run: (deps: ShortcutDeps) => void;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ' ': 'space',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Escape: 'esc',
  Delete: 'delete',
  Backspace: 'backspace',
  Home: 'home',
  End: 'end',
  Tab: 'tab',
};

/** Normalise a `KeyboardEvent.key` to a lowercase canonical token. */
function normalizeKey(key: string): string {
  return NAMED_KEYS[key] ?? key.toLowerCase();
}

/** A single printable symbol (`?`, `,`, `[`) — Shift is implicit, so we omit it. */
function isSymbolKey(token: string): boolean {
  return token.length === 1 && !/[a-z0-9]/.test(token);
}

/** Build the canonical chord for a keyboard event (e.g. `mod+shift+z`). */
export function eventToChord(event: KeyboardEvent): string {
  const token = normalizeKey(event.key);
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey && !isSymbolKey(token)) parts.push('shift');
  parts.push(token);
  return parts.join('+');
}

const MAC_GLYPH: Readonly<Record<string, string>> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  space: 'Space',
  esc: 'Esc',
  delete: 'Del',
  backspace: '⌫',
  home: 'Home',
  end: 'End',
  tab: 'Tab',
};

const PC_LABEL: Readonly<Record<string, string>> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  space: 'Space',
  esc: 'Esc',
  delete: 'Del',
  backspace: 'Backspace',
  home: 'Home',
  end: 'End',
  tab: 'Tab',
};

/** Render a chord as platform-correct key glyphs (⌘⇧Z on macOS, Ctrl+Shift+Z else). */
export function formatChord(chord: string, isMac: boolean): string {
  const table = isMac ? MAC_GLYPH : PC_LABEL;
  const parts = chord
    .split('+')
    .map((token) => table[token] ?? (token.length === 1 ? token.toUpperCase() : token));
  return isMac ? parts.join('') : parts.join('+');
}

/** Detect a macOS platform for glyph rendering (best-effort, SSR-safe). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
}

/** Apply a patch when the builder produced one (a no-op edit returns `null`). */
const dispatch = (editor: UseEditor, patch: ReturnType<typeof splitClipPatch>): void => {
  if (patch) editor.applyPatch(patch);
};

const frameSeconds = (fps: number): number => (fps > 0 ? 1 / fps : 1 / FALLBACK_FPS);

/**
 * The full keyboard map. Kept as data so the handler, the help overlay, and
 * tooltips all derive from this one list (PROMPT §6 — single source of truth).
 */
export const SHORTCUTS: readonly Shortcut[] = [
  // --- Transport -----------------------------------------------------------
  {
    id: 'transport.playpause',
    keys: ['space'],
    group: 'Transport',
    label: 'Play / pause',
    run: ({ editor }) => editor.setPlaying(!editor.state.playing),
  },
  {
    id: 'transport.play',
    keys: ['l'],
    group: 'Transport',
    label: 'Play forward',
    run: ({ editor }) => editor.setPlaying(true),
  },
  {
    id: 'transport.pause',
    keys: ['k'],
    group: 'Transport',
    label: 'Pause',
    run: ({ editor }) => editor.setPlaying(false),
  },
  {
    id: 'transport.back',
    keys: ['j'],
    group: 'Transport',
    label: 'Pause and step back',
    run: ({ editor }) => {
      editor.setPlaying(false);
      editor.seek(editor.getPlayhead() - COARSE_STEP_SECONDS);
    },
  },
  {
    id: 'transport.frameBack',
    keys: ['left'],
    group: 'Transport',
    label: 'Step back one frame',
    run: ({ editor, fps }) => editor.seek(editor.getPlayhead() - frameSeconds(fps)),
  },
  {
    id: 'transport.frameFwd',
    keys: ['right'],
    group: 'Transport',
    label: 'Step forward one frame',
    run: ({ editor, fps }) =>
      editor.seek(
        Math.min(timelineDuration(editor.state.timeline), editor.getPlayhead() + frameSeconds(fps)),
      ),
  },
  {
    id: 'transport.secBack',
    keys: ['shift+left'],
    group: 'Transport',
    label: 'Step back one second',
    run: ({ editor }) => editor.seek(editor.getPlayhead() - COARSE_STEP_SECONDS),
  },
  {
    id: 'transport.secFwd',
    keys: ['shift+right'],
    group: 'Transport',
    label: 'Step forward one second',
    run: ({ editor }) =>
      editor.seek(
        Math.min(
          timelineDuration(editor.state.timeline),
          editor.getPlayhead() + COARSE_STEP_SECONDS,
        ),
      ),
  },
  {
    id: 'transport.start',
    keys: ['home'],
    group: 'Transport',
    label: 'Go to start',
    run: ({ editor }) => editor.seek(0),
  },
  {
    id: 'transport.end',
    keys: ['end'],
    group: 'Transport',
    label: 'Go to end',
    run: ({ editor }) => editor.seek(timelineDuration(editor.state.timeline)),
  },
  // Prev/next EDIT POINT (revamp Phase 2, F3). Premiere and Resolve both put this
  // on bare Up/Down, but those are already "select clip on track above/below"
  // here, so these take the Shift variants rather than making one of the two
  // gestures conditional on whether something happens to be selected.
  {
    id: 'transport.prevEdit',
    keys: ['shift+up'],
    group: 'Transport',
    label: 'Previous edit point',
    run: ({ editor }) => {
      const target = prevEditPoint(editor.getPlayhead(), listEditPoints(editor.state.timeline));
      editor.setPlaying(false);
      editor.seek(target ?? 0);
    },
  },
  {
    id: 'transport.nextEdit',
    keys: ['shift+down'],
    group: 'Transport',
    label: 'Next edit point',
    run: ({ editor }) => {
      const points = listEditPoints(editor.state.timeline);
      const target = nextEditPoint(editor.getPlayhead(), points);
      editor.setPlaying(false);
      editor.seek(target ?? timelineDuration(editor.state.timeline));
    },
  },
  // --- Tools -----------------------------------------------------------------
  {
    id: 'tool.select',
    keys: ['a'],
    group: 'Tools',
    label: 'Selection tool',
    run: ({ setTool }) => setTool('select'),
  },
  {
    id: 'tool.blade',
    keys: ['b'],
    group: 'Tools',
    label: 'Blade tool',
    run: ({ setTool }) => setTool('blade'),
  },
  // --- Editing -------------------------------------------------------------
  {
    id: 'edit.split',
    keys: ['s'],
    when: 'selection',
    group: 'Editing',
    label: 'Split at playhead',
    run: ({ editor }) =>
      dispatch(
        editor,
        splitClipPatch(editor.state.timeline, editor.state.selection!, editor.getPlayhead()),
      ),
  },
  {
    // Default delete: lift, unless the Ripple toggle is ON — then it ripples
    // (the toggle flips the default; Shift+Delete then inverts back to a lift).
    id: 'edit.delete',
    keys: ['delete', 'backspace'],
    // `timelineFocus`, not `selection`: `selection` means a CLIP is selected, and
    // Delete must also work when only effect layers are selected. The run below
    // no-ops when neither is.
    when: 'timelineFocus',
    group: 'Editing',
    label: 'Delete clip or effect (lift; ripples when Ripple is on)',
    run: ({ editor, rippleOnDelete, selectedEffectLayerIds, setSelectedEffectLayerIds }) => {
      // Delete everything that is selected — clips AND effect layers. Effect
      // layers used to be handled "first, and exclusively", which made Delete
      // after a select-all (⌘A selects both) quietly drop only the effects and
      // leave every clip standing. The two are merged into ONE patch so the whole
      // thing still reverses with a single undo.
      const layerIds = selectedEffectLayerIds ?? [];
      const layerPatch =
        layerIds.length > 0 ? removeEffectLayersPatch(editor.state.timeline, layerIds) : null;
      const clipPatch = editor.state.selection
        ? deleteClipsPatch(editor.state.timeline, editor.state.selectedIds, rippleOnDelete === true)
        : null;
      if (layerPatch && clipPatch) {
        // Effect-layer removals first: they are lane-local, so they cannot be
        // invalidated by the clip ops, while a ripple delete shifts the timeline
        // the layer ops were resolved against.
        dispatch(editor, {
          ...clipPatch,
          reason: `${layerPatch.reason} and ${clipPatch.reason.toLowerCase()}`,
          operations: [...layerPatch.operations, ...clipPatch.operations],
        });
      } else {
        dispatch(editor, layerPatch ?? clipPatch);
      }
      if (layerPatch) setSelectedEffectLayerIds?.([]);
    },
  },
  {
    // Shift+Delete inverts the active default: ripples normally, lifts when the
    // Ripple toggle is ON.
    id: 'edit.ripple',
    keys: ['shift+delete', 'shift+backspace'],
    when: 'selection',
    group: 'Editing',
    label: 'Ripple delete clip (lifts when Ripple is on)',
    run: ({ editor, rippleOnDelete }) =>
      dispatch(
        editor,
        deleteClipsPatch(editor.state.timeline, editor.state.selectedIds, rippleOnDelete !== true),
      ),
  },
  {
    id: 'edit.duplicate',
    keys: ['mod+d'],
    when: 'selection',
    group: 'Editing',
    label: 'Duplicate clip',
    run: ({ editor }) =>
      dispatch(editor, duplicateClipsPatch(editor.state.timeline, editor.state.selectedIds)),
  },
  {
    id: 'edit.copy',
    keys: ['mod+c'],
    when: 'selection',
    group: 'Editing',
    label: 'Copy clip',
    run: ({ editor, clipboard }) => {
      const loc = findClip(editor.state.timeline, editor.state.selection!);
      if (loc) clipboard.current = loc.clip;
    },
  },
  {
    id: 'edit.cut',
    keys: ['mod+x'],
    when: 'selection',
    group: 'Editing',
    label: 'Cut clip',
    run: ({ editor, clipboard }) => {
      const loc = findClip(editor.state.timeline, editor.state.selection!);
      if (!loc) return;
      clipboard.current = loc.clip;
      // Cut is single-clip (the clipboard holds one clip); ripple-remove just it.
      dispatch(editor, deleteClipsPatch(editor.state.timeline, [loc.clip.id], true));
    },
  },
  {
    id: 'edit.paste',
    keys: ['mod+v'],
    group: 'Editing',
    label: 'Paste clip at playhead',
    run: ({ editor, clipboard }) => {
      const source = clipboard.current;
      if (!source) return;
      dispatch(
        editor,
        pasteClipPatch(editor.state.timeline, source, source.trackId, editor.getPlayhead()),
      );
    },
  },
  {
    id: 'edit.trimIn',
    keys: ['['],
    when: 'selection',
    group: 'Editing',
    label: 'Trim in-point to playhead',
    run: ({ editor }) => {
      const loc = findClip(editor.state.timeline, editor.state.selection!);
      if (loc)
        dispatch(
          editor,
          trimClipPatch(editor.state.timeline, loc.clip.id, editor.getPlayhead(), loc.clip.end),
        );
    },
  },
  {
    id: 'edit.trimOut',
    keys: [']'],
    when: 'selection',
    group: 'Editing',
    label: 'Trim out-point to playhead',
    run: ({ editor }) => {
      const loc = findClip(editor.state.timeline, editor.state.selection!);
      if (loc)
        dispatch(
          editor,
          trimClipPatch(editor.state.timeline, loc.clip.id, loc.clip.start, editor.getPlayhead()),
        );
    },
  },
  {
    id: 'edit.nudgeBack',
    keys: [','],
    when: 'selection',
    group: 'Editing',
    label: 'Nudge clip back one frame',
    run: ({ editor, fps }) => {
      const loc = findClip(editor.state.timeline, editor.state.selection!);
      if (loc)
        dispatch(
          editor,
          moveClipPatch(editor.state.timeline, loc.clip.id, loc.clip.start - frameSeconds(fps)),
        );
    },
  },
  {
    id: 'edit.nudgeFwd',
    keys: ['.'],
    when: 'selection',
    group: 'Editing',
    label: 'Nudge clip forward one frame',
    run: ({ editor, fps }) => {
      const loc = findClip(editor.state.timeline, editor.state.selection!);
      if (loc)
        dispatch(
          editor,
          moveClipPatch(editor.state.timeline, loc.clip.id, loc.clip.start + frameSeconds(fps)),
        );
    },
  },
  // --- Selection / navigation ---------------------------------------------
  {
    // ⌘A/Ctrl+A in an editing app means "select every clip", not "select all the
    // page's text" — but only while the timeline has focus, so ⌘A still selects
    // text in the AI chat, inspector, or anywhere else.
    id: 'select.all',
    keys: ['mod+a'],
    when: 'timelineFocus',
    group: 'Selection',
    label: 'Select all clips and effects',
    run: ({ editor, setSelectedEffectLayerIds }) => {
      editor.selectMany(orderedClips(editor.state.timeline).map((loc) => loc.clip.id));
      // Effect layers are selected alongside, not instead: "select all" on a
      // timeline that has both means everything on it.
      setSelectedEffectLayerIds?.(
        effectLayersInApplyOrder(editor.state.timeline).map((layer) => layer.id),
      );
    },
  },
  {
    id: 'select.next',
    keys: ['tab'],
    when: 'timelineFocus',
    group: 'Selection',
    label: 'Select next clip',
    run: ({ editor }) => {
      const id = adjacentClipId(editor.state.timeline, editor.state.selection, 1);
      if (id) editor.select(id);
    },
  },
  {
    id: 'select.prev',
    keys: ['shift+tab'],
    when: 'timelineFocus',
    group: 'Selection',
    label: 'Select previous clip',
    run: ({ editor }) => {
      const id = adjacentClipId(editor.state.timeline, editor.state.selection, -1);
      if (id) editor.select(id);
    },
  },
  {
    id: 'select.trackUp',
    keys: ['up'],
    when: 'selection',
    group: 'Selection',
    label: 'Select clip on track above',
    run: ({ editor }) => {
      const id = clipOnAdjacentTrack(editor.state.timeline, editor.state.selection, -1);
      if (id) editor.select(id);
    },
  },
  {
    id: 'select.trackDown',
    keys: ['down'],
    when: 'selection',
    group: 'Selection',
    label: 'Select clip on track below',
    run: ({ editor }) => {
      const id = clipOnAdjacentTrack(editor.state.timeline, editor.state.selection, 1);
      if (id) editor.select(id);
    },
  },
  {
    id: 'select.clear',
    keys: ['esc'],
    group: 'Selection',
    label: 'Deselect',
    run: ({ editor }) => editor.select(null),
  },
  // --- Markers -------------------------------------------------------------
  {
    id: 'marker.toggle',
    keys: ['m'],
    group: 'Markers',
    label: 'Toggle marker at playhead',
    run: ({ editor }) => editor.toggleMarker(editor.getPlayhead()),
  },
  {
    id: 'marker.next',
    keys: ['shift+m'],
    group: 'Markers',
    label: 'Jump to next marker',
    run: ({ editor }) => {
      const next = adjacentMarker(
        editor.state.markers.map((m) => m.time),
        editor.getPlayhead(),
        1,
      );
      if (next !== null) editor.seek(next);
    },
  },
  {
    id: 'marker.prev',
    keys: ['alt+m'],
    group: 'Markers',
    label: 'Jump to previous marker',
    run: ({ editor }) => {
      const prev = adjacentMarker(
        editor.state.markers.map((m) => m.time),
        editor.getPlayhead(),
        -1,
      );
      if (prev !== null) editor.seek(prev);
    },
  },
  // --- View ----------------------------------------------------------------
  {
    id: 'view.zoomIn',
    keys: ['=', '+'],
    group: 'View',
    label: 'Zoom in',
    run: ({ editor }) => editor.setZoom(editor.state.pxPerSecond * ZOOM_STEP),
  },
  {
    id: 'view.zoomOut',
    keys: ['-', '_'],
    group: 'View',
    label: 'Zoom out',
    run: ({ editor }) => editor.setZoom(editor.state.pxPerSecond / ZOOM_STEP),
  },
  {
    id: 'view.zoomFit',
    keys: ['shift+z'],
    group: 'View',
    label: 'Zoom to fit',
    run: ({ requestZoom }) => requestZoom('fit'),
  },
  {
    id: 'view.zoomSelection',
    keys: ['shift+f'],
    when: 'selection',
    group: 'View',
    label: 'Zoom to selection',
    run: ({ requestZoom }) => requestZoom('selection'),
  },
  {
    id: 'view.snapToggle',
    keys: ['n'],
    group: 'View',
    label: 'Toggle snapping',
    run: ({ toggleSnapping }) => toggleSnapping(),
  },
  // --- History -------------------------------------------------------------
  {
    id: 'history.undo',
    keys: ['mod+z'],
    group: 'History',
    label: 'Undo',
    run: ({ editor }) => editor.undo(),
  },
  {
    id: 'history.redo',
    keys: ['mod+shift+z', 'mod+y'],
    group: 'History',
    label: 'Redo',
    run: ({ editor }) => editor.redo(),
  },
  {
    id: 'history.panel',
    keys: ['mod+shift+h'],
    group: 'History',
    label: 'Open history',
    run: ({ toggleHistory }) => toggleHistory(),
  },
  // --- AI --------------------------------------------------------------------
  {
    id: 'ai.commandPalette',
    keys: ['mod+k'],
    group: 'AI',
    label: 'Open command palette',
    run: ({ togglePalette }) => togglePalette(),
  },
  // --- Help ----------------------------------------------------------------
  {
    id: 'help.toggle',
    keys: ['?', 'shift+/'],
    group: 'Help',
    label: 'Keyboard shortcuts',
    run: ({ toggleHelp }) => toggleHelp(),
  },
  {
    id: 'settings.open',
    keys: ['mod+,'],
    group: 'Help',
    label: 'Settings',
    run: ({ openSettings }) => openSettings(),
  },
];

/** Find the first shortcut whose `keys` include `chord`. */
export function matchShortcut(
  chord: string,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): Shortcut | null {
  return shortcuts.find((s) => s.keys.includes(chord)) ?? null;
}

/** The chord+glyphs to advertise for a shortcut id (for tooltips). `null` if unknown. */
export function hintFor(id: string, isMac = isMacPlatform()): string | null {
  const shortcut = SHORTCUTS.find((s) => s.id === id);
  if (!shortcut || shortcut.keys.length === 0) return null;
  return formatChord(shortcut.keys[0]!, isMac);
}
