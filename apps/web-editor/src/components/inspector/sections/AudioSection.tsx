/** Audio controls grouped into level, fades, and enhancement workflows. */
import { useState } from 'react';
import { Button } from '@framepilot/ui';
import type { Clip, Track } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { type AudioSettings, audioSettings, duckTrackOptions } from '../../../editor/selectors.js';
import { setAudioPatch } from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';
import { Select } from '../../Select.js';
import { Checkbox } from '../../Checkbox.js';

const FADE_MAX_SECONDS = 5;
const GAIN_MIN_DB = -24;
const GAIN_MAX_DB = 24;

export function AudioPanel({
  editor,
  clip,
  track,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly track: Track;
}): JSX.Element {
  const [audio, setAudio] = useState<AudioSettings>(() => audioSettings(clip));
  const duckable = duckTrackOptions(editor.state.timeline, track.id);
  const set = <K extends keyof AudioSettings>(key: K, value: AudioSettings[K]): void =>
    setAudio((prev) => ({ ...prev, [key]: value }));

  const apply = (): void => {
    const patch = setAudioPatch(editor.state.timeline, clip.id, audio);
    if (patch) editor.applyPatch(patch);
  };

  return (
    <div className="inspector-subpanel" aria-label="audio settings">
      <div className="inspector-control-cluster">
        <h4>Level</h4>
        <ScrubNumber
          label="Volume"
          ariaLabel="gain"
          unit="dB"
          value={audio.gainDb}
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          onChange={(value) => set('gainDb', value)}
        />
        <Checkbox ariaLabel="mute" checked={audio.muted} onChange={(value) => set('muted', value)}>
          Mute clip audio
        </Checkbox>
      </div>

      <div className="inspector-control-cluster">
        <h4>Fades</h4>
        <ScrubNumber
          label="Fade in"
          ariaLabel="fade in"
          unit="s"
          value={audio.fadeInSeconds}
          min={0}
          max={FADE_MAX_SECONDS}
          step={0.1}
          onChange={(value) => set('fadeInSeconds', value)}
        />
        <ScrubNumber
          label="Fade out"
          ariaLabel="fade out"
          unit="s"
          value={audio.fadeOutSeconds}
          min={0}
          max={FADE_MAX_SECONDS}
          step={0.1}
          onChange={(value) => set('fadeOutSeconds', value)}
        />
      </div>

      <div className="inspector-control-cluster">
        <h4>Enhance</h4>
        <Checkbox
          ariaLabel="normalize"
          checked={audio.normalize}
          onChange={(value) => set('normalize', value)}
        >
          Normalize loudness
        </Checkbox>
        {duckable.length > 0 && (
          <div className="inspector-select-row">
            <span className="inspector-select-caption">Duck under</span>
            <Select
              label="duck under track"
              value={audio.duckUnderTrackId ?? ''}
              onChange={(value) => set('duckUnderTrackId', value || null)}
              options={[
                { value: '', label: 'None' },
                ...duckable.map((option) => ({
                  value: option.id,
                  label: `${option.id} (${option.type})`,
                })),
              ]}
            />
          </div>
        )}
      </div>

      <div className="inspector-actions">
        <Button variant="secondary" type="button" onClick={apply}>
          Apply audio
        </Button>
      </div>
    </div>
  );
}
