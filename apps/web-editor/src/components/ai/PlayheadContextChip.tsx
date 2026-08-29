/**
 * The playhead chip on the composer's included-context strip (P8.2 "knows").
 *
 * The playhead is threaded into every AI request (`captureEditorInteractionContext`'s
 * `playheadSeconds`), and it is the fact the model leans on hardest for anything
 * positional — "cut here", "add a title now", "what's happening at this point".
 * Until this chip existed it was the one always-sent fact the strip did not
 * account for, so a run that acted on the wrong moment gave the user nothing to
 * look at.
 *
 * WHY a component of its own rather than another entry in `buildContextItems`:
 * the playhead moves at display cadence. A value threaded through the sidebar's
 * `contextItems` memo would re-render `AiSidebar` and the whole composer on every
 * tick of playback — the exact re-render storm `usePlayhead` exists to avoid. As
 * a leaf it subscribes to the playhead clock alone, so only these few characters
 * of DOM update while the programme plays, and it quantises to a whole second
 * because that is all the label can show.
 */
import { useCallback, useSyncExternalStore, type JSX } from 'react';
import type { UseEditor } from '../../editor/useEditor.js';

/** A store that never changes — for hosts that hand the sidebar a partial editor. */
const NEVER_CHANGES = (): (() => void) => () => {};

/**
 * The live playhead, tolerating an editor that has no clock.
 *
 * `usePlayhead` is the real subscription and is what a full editor gets. Several
 * hosts (and every sidebar test) pass a partial editor with only `state` — the
 * same reason `runInputFor` already reads
 * `getPlayhead?.() ?? state?.playhead ?? 0` — and a bare `useSyncExternalStore`
 * on an undefined subscribe would throw rather than degrade.
 */
function useLivePlayhead(editor: UseEditor): number {
  const subscribe = editor.subscribePlayhead ?? NEVER_CHANGES;
  const read = useCallback(() => editor.getPlayhead?.() ?? editor.state?.playhead ?? 0, [editor]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Seconds → `m:ss`, matching the timecode the transport and findings already use. */
function timecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

export function PlayheadContextChip({ editor }: { editor: UseEditor }): JSX.Element {
  const playhead = useLivePlayhead(editor);
  const label = `Playhead ${timecode(playhead)}`;
  return (
    <span className="ai-context-chip" data-kind="playhead" title={label}>
      <span className="ai-context-chip-label">{label}</span>
    </span>
  );
}
