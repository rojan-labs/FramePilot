/**
 * "Use a clip or track as the mask" (MK8.2): the track matte / text-as-a-mask row of the Mask tab.
 *
 * Picks a source — a title, a graphic, another shot, or a whole track — and a channel, and adds
 * a `layer` mask through the same `add_track_matte` command the assistant's `mask_with_layer`
 * compiles to. The source then stops being drawn itself: it is this clip's matte.
 */
import { useState } from 'react';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { Select } from '../../Select.js';
import { InspectorRow } from '../InspectorRow.js';
import {
  TRACK_MATTE_CHANNELS,
  TRACK_MATTE_CHANNEL_LABELS,
  parseTrackMatteSource,
  trackMatteOptions,
} from './trackMatteSources.js';

export interface TrackMatteRowProps {
  readonly timeline: Timeline;
  readonly clip: Clip;
  readonly onAdd: (
    source: NonNullable<ReturnType<typeof parseTrackMatteSource>>,
    channel: (typeof TRACK_MATTE_CHANNELS)[number],
  ) => void;
}

export function TrackMatteRow({ timeline, clip, onAdd }: TrackMatteRowProps): JSX.Element {
  const options = trackMatteOptions(timeline, clip);
  const [picked, setPicked] = useState<string>('');
  const [channel, setChannel] = useState<(typeof TRACK_MATTE_CHANNELS)[number]>('alpha');
  const value = options.some((option) => option.value === picked)
    ? picked
    : (options[0]?.value ?? '');
  const source = parseTrackMatteSource(value);
  return (
    <div className="mask-panel-track-matte" role="group" aria-label="Track matte">
      {options.length === 0 ? (
        <p className="inspector-empty inspector-empty-inline">
          Put a title, a graphic or another clip on a track above or below this one, at the same
          time, to use it as this clip&apos;s mask.
        </p>
      ) : (
        <>
          <InspectorRow label="Track matte" name="track matte source">
            <Select
              label="Track matte source"
              value={value}
              onChange={setPicked}
              options={options.map((option) => ({ value: option.value, label: option.label }))}
            />
          </InspectorRow>
          <InspectorRow label="Channel" name="track matte channel">
            <Select
              label="Track matte channel"
              value={channel}
              onChange={(next) => setChannel(next as (typeof TRACK_MATTE_CHANNELS)[number])}
              options={TRACK_MATTE_CHANNELS.map((option, index) => ({
                value: option,
                label: TRACK_MATTE_CHANNEL_LABELS[index]!,
              }))}
            />
          </InspectorRow>
          <button
            type="button"
            className="inspector-text-button"
            disabled={source === null}
            onClick={() => {
              if (source !== null) onAdd(source, channel);
            }}
          >
            Use as mask
          </button>
        </>
      )}
    </div>
  );
}
