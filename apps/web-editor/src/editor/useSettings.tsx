/**
 * Editor settings — the user's view + interaction preferences (plan 3.4 Part 6).
 *
 * These are view state, not project state. They live in localStorage and are
 * exposed through one React context so every panel reads the same preferences.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_ASR_PROVIDER,
  DEFAULT_MAX_RUN_MINUTES,
  DEFAULT_MAX_RUN_USD,
  migrateAsrProviderName,
  type AsrProviderName,
  type UserAsrProviderName,
} from '@framepilot/ai-sdk';
import type { TimeDisplay } from './selectors.js';

export type Density = 'comfortable' | 'compact';
export type Theme = 'dark' | 'light' | 'system';

export interface EditorSettings {
  readonly timeDisplay: TimeDisplay;
  readonly density: Density;
  readonly theme: Theme;
  readonly snapping: boolean;
  readonly showTimelineThumbnails: boolean;
  /**
   * Clicking a clip on the timeline brings up the Inspector.
   *
   * Off by default. On, the right rail follows the selection — which is what an
   * editor who lives in the Inspector wants, and an interruption to one who lives
   * in the AI panel. A running agent is not hidden by it: it moves to a floating
   * control that leads back (see `AgentFab`).
   */
  readonly openInspectorOnSelect: boolean;
  readonly autoFollow: boolean;
  readonly defaultOverlaySeconds: number;
  readonly loopByDefault: boolean;
  readonly gridByDefault: boolean;
  readonly previewVolume: number;
  readonly previewMuted: boolean;
  readonly safeAreaGuidesByDefault: boolean;
  readonly reducedMotion: boolean;
  readonly inspectorSections: Readonly<Record<string, boolean>>;
  /** Local or TwelveLabs. Legacy Groq/NVIDIA values migrate to Local on load. */
  readonly asrProvider: UserAsrProviderName;
  readonly transcribeOnImport: boolean;
  readonly showAiUsageDetails: boolean;
  /**
   * The run budget (goal.md Workstream D): every agent run stops once it has spent
   * this much money or this much wall clock.
   *
   * It lives here, in Settings, rather than beside the composer — set once, applied to
   * every run. The maintainer chose a permanent, always-inspectable control over the
   * per-run announcement the SDK used to emit: a line of transcript that repeated the
   * same three numbers before every run is noise, and a number the user can look up at
   * any time does not need restating. The run still says WHY it stopped when it
   * actually reaches a limit. Do not reintroduce the per-run notice.
   */
  readonly maxRunUsd: number;
  readonly maxRunMinutes: number;
}

/** Legacy provider values are accepted only as transient migration input. */
export type EditorSettingsUpdate = Omit<Partial<EditorSettings>, 'asrProvider'> & {
  readonly asrProvider?: AsrProviderName;
};

export const OVERLAY_SECONDS_BOUNDS = { min: 0.5, max: 30 } as const;

/** Bounds on the bound. Below the floor a run cannot finish even a trivial edit; above
    the ceiling the budget stops being a guard rail. Defined once, here with the field
    they constrain, so the store and the Settings control cannot drift apart. */
export const MIN_RUN_USD = 0.5;
export const MAX_RUN_USD = 50;
export const RUN_USD_STEP = 0.5;
export const MIN_RUN_MINUTES = 1;
export const MAX_RUN_MINUTES = 120;

export const DEFAULT_SETTINGS: EditorSettings = {
  timeDisplay: 'timecode',
  density: 'comfortable',
  theme: 'system',
  snapping: true,
  showTimelineThumbnails: true,
  openInspectorOnSelect: false,
  autoFollow: true,
  defaultOverlaySeconds: 3,
  loopByDefault: false,
  gridByDefault: false,
  previewVolume: 1,
  previewMuted: false,
  safeAreaGuidesByDefault: false,
  reducedMotion: false,
  inspectorSections: {},
  asrProvider: DEFAULT_ASR_PROVIDER,
  transcribeOnImport: false,
  showAiUsageDetails: false,
  // The SDK owns what "unbudgeted" means; the editor only ever overrides it.
  maxRunUsd: DEFAULT_MAX_RUN_USD,
  maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
};

const STORAGE_KEY = 'framepilot.settings';

const clampOverlaySeconds = (value: number): number =>
  Math.min(OVERLAY_SECONDS_BOUNDS.max, Math.max(OVERLAY_SECONDS_BOUNDS.min, value));

const clampPreviewVolume = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;

/** Read a persisted run budget. A missing, malformed or OUT-OF-RANGE stored value falls
    back to the SDK default rather than being clamped — a stored value outside the range
    was never a choice this UI could have written, so it is not trusted as one. Commits
    from the dialog are clamped on the way IN, so a legitimate choice always survives. */
const coerceRunBudget = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return integer ? Math.round(value) : value;
};

const coerceSectionMap = (value: unknown): Record<string, boolean> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, open] of Object.entries(value as Record<string, unknown>)) {
    if (typeof open === 'boolean') out[key] = open;
  }
  return out;
};

/** Merge untrusted persisted settings onto valid defaults. */
export function mergeSettings(partial: unknown): EditorSettings {
  const p = (partial ?? {}) as Partial<Record<keyof EditorSettings, unknown>>;
  return {
    timeDisplay: p.timeDisplay === 'seconds' ? 'seconds' : 'timecode',
    density: p.density === 'compact' ? 'compact' : 'comfortable',
    theme:
      p.theme === 'dark' || p.theme === 'light' || p.theme === 'system'
        ? p.theme
        : DEFAULT_SETTINGS.theme,
    snapping: p.snapping === false ? false : true,
    showTimelineThumbnails: p.showTimelineThumbnails === false ? false : true,
    openInspectorOnSelect: p.openInspectorOnSelect === true,
    autoFollow: p.autoFollow === false ? false : true,
    defaultOverlaySeconds:
      typeof p.defaultOverlaySeconds === 'number' && Number.isFinite(p.defaultOverlaySeconds)
        ? clampOverlaySeconds(p.defaultOverlaySeconds)
        : DEFAULT_SETTINGS.defaultOverlaySeconds,
    loopByDefault: p.loopByDefault === true,
    gridByDefault:
      p.gridByDefault === true || (p as Record<string, unknown>).safeAreaByDefault === true,
    previewVolume: clampPreviewVolume(p.previewVolume),
    previewMuted: p.previewMuted === true,
    safeAreaGuidesByDefault: p.safeAreaGuidesByDefault === true,
    reducedMotion: p.reducedMotion === true,
    inspectorSections: coerceSectionMap(p.inspectorSections),
    asrProvider: migrateAsrProviderName(p.asrProvider),
    transcribeOnImport: p.transcribeOnImport === true,
    showAiUsageDetails: p.showAiUsageDetails === true,
    maxRunUsd: coerceRunBudget(
      p.maxRunUsd,
      DEFAULT_SETTINGS.maxRunUsd,
      MIN_RUN_USD,
      MAX_RUN_USD,
      false,
    ),
    maxRunMinutes: coerceRunBudget(
      p.maxRunMinutes,
      DEFAULT_SETTINGS.maxRunMinutes,
      MIN_RUN_MINUTES,
      MAX_RUN_MINUTES,
      true,
    ),
  };
}

export function loadSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return mergeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: EditorSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    /* Storage may be unavailable (quota, privacy mode). The caller owns telling
       the user — a toggle that silently didn't persist is a silent lie. */
    return false;
  }
}

/** Why a settings change could not be persisted. Typed so UI can label it. */
export type SettingsPersistenceError = 'save-failed';

export interface SettingsContextValue {
  readonly settings: EditorSettings;
  readonly update: (patch: EditorSettingsUpdate) => void;
  readonly reset: () => void;
  /**
   * Set when the last change could not be persisted: state was reverted and the
   * user should be told why their toggle "didn't take". Cleared on the next
   * successful save.
   */
  readonly persistenceError: SettingsPersistenceError | null;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function applyDocumentSettings(settings: EditorSettings): void {
  const root = document.documentElement;
  root.dataset.density = settings.density;
  root.dataset.reducedMotion = String(settings.reducedMotion);
  if (settings.theme === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = settings.theme;
  }
}

export interface SettingsProviderProps {
  readonly children: ReactNode;
}

export function SettingsProvider({ children }: SettingsProviderProps): JSX.Element {
  const [settings, setSettings] = useState<EditorSettings>(() => loadSettings());
  const [persistenceError, setPersistenceError] = useState<SettingsPersistenceError | null>(null);

  // Apply density/theme before the browser paints so switching to the light
  // editor does not flash the shared dark defaults for one frame on startup.
  useLayoutEffect(() => {
    applyDocumentSettings(settings);
  }, [settings]);

  const update = useCallback((patch: EditorSettingsUpdate): void => {
    setSettings((current) => {
      const next = mergeSettings({ ...current, ...patch });
      // Persist-first: if the save fails, keep the old state (revert) instead of
      // showing a toggle that lies about what will survive a reload.
      if (saveSettings(next)) {
        setPersistenceError(null);
        return next;
      }
      setPersistenceError('save-failed');
      return current;
    });
  }, []);

  const reset = useCallback((): void => {
    if (saveSettings(DEFAULT_SETTINGS)) {
      setPersistenceError(null);
    } else {
      setPersistenceError('save-failed');
    }
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, update, reset, persistenceError }),
    [settings, update, reset, persistenceError],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext) ?? FALLBACK_VALUE;
}

const FALLBACK_VALUE: SettingsContextValue = {
  settings: DEFAULT_SETTINGS,
  update: () => {},
  reset: () => {},
  persistenceError: null,
};
