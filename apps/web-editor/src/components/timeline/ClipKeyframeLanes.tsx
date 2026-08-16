/**
 * One clip's stack of keyframe lanes (revamp Phase 6, F4).
 *
 * ## Why this exists rather than the lanes being inlined
 *
 * The lanes need the playhead — for the "a keyframe is under the playhead" marker
 * state, and as a snap target — but `TimelineView` deliberately does **not** read
 * `editor.state.playhead`: its heavy `trackLanes` subtree is memoised precisely so a
 * seek (60×/s during playback) does not rebuild every clip, waveform and badge.
 *
 * So the subscription lives here, in a leaf. This component re-renders on the
 * playhead — at *project-frame* cadence, via `useFramePlayhead` — while the memoised
 * lane tree above it does not. That is the same split the playhead marker and the
 * ruler already use ("the nodes that DISPLAY it subscribe directly"), and it is only
 * paid for clips the user has explicitly expanded.
 */
import type { Clip, Marker } from '@framepilot/timeline-schema';
import { type UseEditor, useFramePlayhead } from '../../editor/useEditor.js';
import { secondsToPx } from '../../editor/selectors.js';
import { KeyframeLane } from './KeyframeLane.js';
import { KEYFRAME_LANE_HEIGHT, clipKeyframeLanes } from './keyframe-lanes.js';

export interface ClipKeyframeLanesProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly pxPerSecond: number;
  readonly fps: number;
  readonly markers: readonly Marker[];
  readonly selectedKeys: ReadonlySet<string>;
  readonly snapEnabled: boolean;
  readonly onSelect: (key: string, additive: boolean) => void;
  readonly onMove: (grabbedKey: string, delta: number) => void;
  readonly onAddAt: (clipId: string, property: string, clipTime: number) => void;
  readonly onDelete: () => void;
  readonly onClearSelection: () => void;
}

export function ClipKeyframeLanes({
  editor,
  clip,
  pxPerSecond,
  fps,
  markers,
  selectedKeys,
  snapEnabled,
  onSelect,
  onMove,
  onAddAt,
  onDelete,
  onClearSelection,
}: ClipKeyframeLanesProps): JSX.Element {
  const playhead = useFramePlayhead(editor, fps);
  const lanes = clipKeyframeLanes(clip);
  // `null` when the playhead is not over this clip, so a marker at 2s does not read
  // as "at the playhead" because the playhead is at 2s on a different clip.
  const relative = playhead - clip.start;
  const playheadClipTime = relative >= 0 && relative <= clip.end - clip.start ? relative : null;

  return (
    <div
      className="keyframe-lanes"
      // Delete is handled HERE rather than in the global shortcut map, so it only
      // removes keyframes while focus is actually inside a lane. Bound globally it
      // would fight the clip-delete shortcut, and "Delete" would mean different
      // things depending on invisible state.
      onKeyDown={(event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          onDelete();
          return;
        }
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClearSelection();
        }
      }}
      style={{
        left: `${secondsToPx(clip.start, pxPerSecond)}px`,
        width: `${secondsToPx(clip.end - clip.start, pxPerSecond)}px`,
        height: `${lanes.length * KEYFRAME_LANE_HEIGHT}px`,
      }}
    >
      {lanes.map((lane, index) => (
        <KeyframeLane
          key={lane.property}
          clip={clip}
          property={lane.property}
          keyframes={lane.keyframes}
          pxPerSecond={pxPerSecond}
          row={index}
          playheadClipTime={playheadClipTime}
          markers={markers}
          selectedKeys={selectedKeys}
          snapEnabled={snapEnabled}
          onSelect={onSelect}
          onMove={onMove}
          onAddAt={(property, clipTime) => onAddAt(clip.id, property, clipTime)}
        />
      ))}
    </div>
  );
}
