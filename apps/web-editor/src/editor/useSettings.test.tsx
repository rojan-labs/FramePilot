/** Tests for the editor settings store and persistence shell. */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_MAX_RUN_MINUTES, DEFAULT_MAX_RUN_USD } from '@framepilot/ai-sdk';
import {
  DEFAULT_SETTINGS,
  MAX_RUN_MINUTES,
  MAX_RUN_USD,
  MIN_RUN_MINUTES,
  MIN_RUN_USD,
  SettingsProvider,
  loadSettings,
  mergeSettings,
  useSettings,
} from './useSettings.js';

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.reducedMotion;
  delete document.documentElement.dataset.theme;
});

describe('mergeSettings', () => {
  it('returns the defaults for an empty or nullish partial', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('coerces enum fields and ignores unknown values', () => {
    expect(mergeSettings({ timeDisplay: 'seconds' }).timeDisplay).toBe('seconds');
    expect(mergeSettings({ timeDisplay: 'nonsense' }).timeDisplay).toBe('timecode');
    expect(mergeSettings({ density: 'compact' }).density).toBe('compact');
    expect(mergeSettings({ density: 'huge' }).density).toBe('comfortable');
  });

  it('defaults snapping on unless explicitly false', () => {
    expect(mergeSettings({ snapping: false }).snapping).toBe(false);
    expect(mergeSettings({ snapping: 'yes' }).snapping).toBe(true);
  });

  it('defaults timeline thumbnails on unless explicitly false', () => {
    expect(DEFAULT_SETTINGS.showTimelineThumbnails).toBe(true);
    expect(mergeSettings({ showTimelineThumbnails: false }).showTimelineThumbnails).toBe(false);
    expect(mergeSettings({ showTimelineThumbnails: 'no' }).showTimelineThumbnails).toBe(true);
  });

  it('clamps the overlay duration into bounds and rejects bad types', () => {
    expect(mergeSettings({ defaultOverlaySeconds: 100 }).defaultOverlaySeconds).toBe(30);
    expect(mergeSettings({ defaultOverlaySeconds: 0 }).defaultOverlaySeconds).toBe(0.5);
    expect(mergeSettings({ defaultOverlaySeconds: 5 }).defaultOverlaySeconds).toBe(5);
    expect(mergeSettings({ defaultOverlaySeconds: 'x' }).defaultOverlaySeconds).toBe(
      DEFAULT_SETTINGS.defaultOverlaySeconds,
    );
  });

  it('treats boolean flags as opt-in', () => {
    expect(mergeSettings({ loopByDefault: true }).loopByDefault).toBe(true);
    expect(mergeSettings({ gridByDefault: true }).gridByDefault).toBe(true);
    expect(mergeSettings({ safeAreaByDefault: true }).gridByDefault).toBe(true);
    expect(mergeSettings({ safeAreaGuidesByDefault: true }).safeAreaGuidesByDefault).toBe(true);
    expect(mergeSettings({ safeAreaByDefault: true }).safeAreaGuidesByDefault).toBe(false);
    expect(mergeSettings({ reducedMotion: true }).reducedMotion).toBe(true);
    expect(mergeSettings({ loopByDefault: 1 }).loopByDefault).toBe(false);
  });

  it('clamps the monitor volume to [0,1] and defaults to unity', () => {
    expect(mergeSettings({}).previewVolume).toBe(1);
    expect(mergeSettings({ previewVolume: 0.4 }).previewVolume).toBe(0.4);
    expect(mergeSettings({ previewVolume: 5 }).previewVolume).toBe(1);
    expect(mergeSettings({ previewVolume: -3 }).previewVolume).toBe(0);
    expect(mergeSettings({ previewVolume: Number.NaN }).previewVolume).toBe(1);
    expect(mergeSettings({ previewVolume: 'loud' }).previewVolume).toBe(1);
  });

  it('keeps monitor mute independent of the level', () => {
    expect(mergeSettings({}).previewMuted).toBe(false);
    const muted = mergeSettings({ previewVolume: 0.4, previewMuted: true });
    expect(muted.previewMuted).toBe(true);
    expect(muted.previewVolume).toBe(0.4);
    expect(mergeSettings({ previewMuted: 1 }).previewMuted).toBe(false);
  });

  it('drops the retired WebCodecs preference from persisted settings', () => {
    expect('webCodecsPreview' in DEFAULT_SETTINGS).toBe(false);
    expect('webCodecsPreview' in mergeSettings({ webCodecsPreview: false })).toBe(false);
  });

  it('keeps Local and TwelveLabs, and migrates Groq or NVIDIA to Local', () => {
    expect(mergeSettings({}).asrProvider).toBe('whisper-cli');
    expect(mergeSettings({ asrProvider: 'twelvelabs' }).asrProvider).toBe('twelvelabs');
    expect(mergeSettings({ asrProvider: 'groq' }).asrProvider).toBe('whisper-cli');
    expect(mergeSettings({ asrProvider: 'nvidia' }).asrProvider).toBe('whisper-cli');
    expect(mergeSettings({ asrProvider: 'bogus' }).asrProvider).toBe('whisper-cli');
    expect(mergeSettings({ asrProvider: 42 }).asrProvider).toBe('whisper-cli');
  });

  it('coerces theme to system, light, or dark', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system');
    expect(mergeSettings({}).theme).toBe('system');
    expect(mergeSettings({ theme: 'light' }).theme).toBe('light');
    expect(mergeSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(mergeSettings({ theme: 'bogus' }).theme).toBe('system');
    expect(mergeSettings({ theme: 1 }).theme).toBe('system');
  });

  it('defaults showAiUsageDetails off unless explicitly true', () => {
    expect(DEFAULT_SETTINGS.showAiUsageDetails).toBe(false);
    expect(mergeSettings({}).showAiUsageDetails).toBe(false);
    expect(mergeSettings({ showAiUsageDetails: true }).showAiUsageDetails).toBe(true);
    expect(mergeSettings({ showAiUsageDetails: 'yes' }).showAiUsageDetails).toBe(false);
  });

  // goal.md Workstream D: the run budget is a setting, so the store is the one place that
  // decides what a run is bounded by. The SDK owns the default; the editor only overrides.
  it('takes the run budget defaults from the SDK, never a hard-coded figure', () => {
    expect(DEFAULT_SETTINGS.maxRunUsd).toBe(DEFAULT_MAX_RUN_USD);
    expect(DEFAULT_SETTINGS.maxRunMinutes).toBe(DEFAULT_MAX_RUN_MINUTES);
    expect(mergeSettings({}).maxRunUsd).toBe(DEFAULT_MAX_RUN_USD);
    expect(mergeSettings({}).maxRunMinutes).toBe(DEFAULT_MAX_RUN_MINUTES);
  });

  it('keeps a persisted budget that is in range', () => {
    expect(mergeSettings({ maxRunUsd: 2.5, maxRunMinutes: 7 })).toMatchObject({
      maxRunUsd: 2.5,
      maxRunMinutes: 7,
    });
    // The bounds themselves are legal choices.
    expect(mergeSettings({ maxRunUsd: MIN_RUN_USD }).maxRunUsd).toBe(MIN_RUN_USD);
    expect(mergeSettings({ maxRunUsd: MAX_RUN_USD }).maxRunUsd).toBe(MAX_RUN_USD);
    expect(mergeSettings({ maxRunMinutes: MAX_RUN_MINUTES }).maxRunMinutes).toBe(MAX_RUN_MINUTES);
    // Minutes are whole; a fractional stored value rounds rather than reaching the SDK.
    expect(mergeSettings({ maxRunMinutes: 7.6 }).maxRunMinutes).toBe(8);
  });

  it('does not trust an out-of-range budget as a choice — it defaults, it does not clamp', () => {
    // The dialog clamps on commit, so a stored value outside the range was never something
    // this UI could have written. Clamping it would silently adopt a figure the user never
    // chose; the default is the honest reading.
    expect(mergeSettings({ maxRunUsd: 999 }).maxRunUsd).toBe(DEFAULT_MAX_RUN_USD);
    expect(mergeSettings({ maxRunUsd: MIN_RUN_USD - 0.1 }).maxRunUsd).toBe(DEFAULT_MAX_RUN_USD);
    expect(mergeSettings({ maxRunMinutes: 0 }).maxRunMinutes).toBe(DEFAULT_MAX_RUN_MINUTES);
    expect(mergeSettings({ maxRunMinutes: MAX_RUN_MINUTES + 1 }).maxRunMinutes).toBe(
      DEFAULT_MAX_RUN_MINUTES,
    );
    expect(mergeSettings({ maxRunMinutes: MIN_RUN_MINUTES }).maxRunMinutes).toBe(MIN_RUN_MINUTES);
  });

  it('never lets a non-numeric budget reach the SDK as a bound', () => {
    for (const bad of ['5', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      const merged = mergeSettings({ maxRunUsd: bad, maxRunMinutes: bad });
      expect(merged.maxRunUsd).toBe(DEFAULT_MAX_RUN_USD);
      expect(merged.maxRunMinutes).toBe(DEFAULT_MAX_RUN_MINUTES);
      expect(Number.isFinite(merged.maxRunUsd)).toBe(true);
    }
  });
});

describe('loadSettings', () => {
  it('falls back to defaults when storage is empty', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem('framepilot.settings', '{not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('reads, coerces, and migrates a persisted blob', () => {
    localStorage.setItem(
      'framepilot.settings',
      JSON.stringify({ density: 'compact', asrProvider: 'nvidia' }),
    );
    expect(loadSettings()).toMatchObject({ density: 'compact', asrProvider: 'whisper-cli' });
  });
});

function Probe(): JSX.Element {
  const { settings, update, reset } = useSettings();
  return (
    <div>
      <span data-testid="density">{settings.density}</span>
      <span data-testid="loop">{String(settings.loopByDefault)}</span>
      <span data-testid="theme">{settings.theme}</span>
      <button type="button" onClick={() => update({ density: 'compact', loopByDefault: true })}>
        go compact
      </button>
      <button type="button" onClick={() => update({ theme: 'light' })}>
        go light
      </button>
      <button type="button" onClick={() => update({ theme: 'system' })}>
        go system
      </button>
      <button type="button" onClick={reset}>
        reset
      </button>
    </div>
  );
}

describe('SettingsProvider', () => {
  it('reflects density and reduced motion onto html and persists updates', () => {
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(document.documentElement.dataset.reducedMotion).toBe('false');

    fireEvent.click(screen.getByText('go compact'));
    expect(screen.getByTestId('density').textContent).toBe('compact');
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(loadSettings().loopByDefault).toBe(true);

    fireEvent.click(screen.getByText('reset'));
    expect(screen.getByTestId('density').textContent).toBe('comfortable');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('reflects an explicit theme and clears it for system', () => {
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.click(screen.getByText('go light'));
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    fireEvent.click(screen.getByText('go system'));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('returns inert defaults when used outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('density').textContent).toBe('comfortable');
    fireEvent.click(screen.getByText('go compact'));
    expect(screen.getByTestId('density').textContent).toBe('comfortable');
    expect(localStorage.getItem('framepilot.settings')).toBeNull();
  });
});
