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
}

/** Legacy provider values are accepted only as transient migration input. */
export type EditorSettingsUpdate = Omit<Partial<EditorSettings>, 'asrProvider'> & {
  readonly asrProvider?: AsrProviderName;
};

export const OVERLAY_SECONDS_BOUNDS = { min: 0.5, max: 30 } as const;

export const DEFAULT_SETTINGS: EditorSettings = {
  timeDisplay: 'timecode',
  density: 'comfortable',
  theme: 'light',
  snapping: true,
  showTimelineThumbnails: true,
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
};

const STORAGE_KEY = 'framepilot.settings';

const clampOverlaySeconds = (value: number): number =>
  Math.min(OVERLAY_SECONDS_BOUNDS.max, Math.max(OVERLAY_SECONDS_BOUNDS.min, value));

const clampPreviewVolume = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;

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

function saveSettings(settings: EditorSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Storage may be unavailable. Settings still apply in this session. */
  }
}

export interface SettingsContextValue {
  readonly settings: EditorSettings;
  readonly update: (patch: EditorSettingsUpdate) => void;
  readonly reset: () => void;
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

  // Apply density/theme before the browser paints so switching to the light
  // editor does not flash the shared dark defaults for one frame on startup.
  useLayoutEffect(() => {
    applyDocumentSettings(settings);
  }, [settings]);

  const update = useCallback((patch: EditorSettingsUpdate): void => {
    setSettings((current) => {
      const next = mergeSettings({ ...current, ...patch });
      saveSettings(next);
      return next;
    });
  }, []);

  const reset = useCallback((): void => {
    saveSettings(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, update, reset }),
    [settings, update, reset],
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
};
