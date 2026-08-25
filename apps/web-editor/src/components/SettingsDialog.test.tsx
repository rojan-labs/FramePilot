/**
 * Tests for the Settings dialog: section navigation, that each control writes
 * through the settings store (persisted), and the reset action.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsProvider, loadSettings } from '../editor/useSettings.js';
import { AiConfigProvider } from '../editor/useAiConfig.js';
import { applyBrowserUpdate, loadBrowserAiConfig } from '../editor/aiConfigStorage.js';
import { loadUserMemory } from '../editor/userMemoryStorage.js';
import { SettingsDialog } from './SettingsDialog.js';
import type { FramePilotBridge } from '@framepilot/shared-types';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete window.framepilot;
});

/**
 * Stub `fetch` so the ASR status probe (network) never runs during unrelated tests.
 *
 * A route may return `wait`: a promise the response is held on until it
 * resolves. That models the real `POST /asr/setup`, which stays pending for the
 * whole download while the UI polls `/asr/setup/progress` alongside it.
 */
function stubAsrFetch(
  impl: (url: string) => { ok: boolean; status: number; json: unknown; wait?: Promise<void> },
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const route = impl(url);
      if (route.wait) await route.wait;
      return {
        ok: route.ok,
        status: route.status,
        text: async () => JSON.stringify(route.json),
      };
    }),
  );
}

/** whisper-cli present, model not yet downloaded — the state Set up acts on. */
const ASR_STATUS_MISSING = {
  binaryAvailable: true,
  binaryPath: '/opt/whisper-cli',
  model: 'base.en',
  modelPresent: false,
  modelPath: '/home/.framepilot/models/ggml-base.en.bin',
  downloadSizeBytes: 147_964_211,
};

/** No setup has ever run in this engine process. */
const IDLE_PROGRESS = {
  state: 'idle',
  model: 'base.en',
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

const open = (): void => {
  render(
    <SettingsProvider>
      <SettingsDialog open onClose={() => {}} />
    </SettingsProvider>,
  );
};

describe('SettingsDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <SettingsProvider>
        <SettingsDialog open={false} onClose={() => {}} />
      </SettingsProvider>,
    );
    expect(container.querySelector('.settings-dialog')).toBeNull();
  });

  it('switches the time display to seconds and persists it', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Seconds' }));
    expect(loadSettings().timeDisplay).toBe('seconds');
  });

  it('toggles a switch (snapping) and persists it', () => {
    open();
    fireEvent.click(screen.getByText('Editing'));
    const snap = screen.getByRole('switch', { name: 'Snap to edges' });
    expect(snap.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(snap);
    expect(snap.getAttribute('aria-checked')).toBe('false');
    expect(loadSettings().snapping).toBe(false);
  });

  it('edits the default overlay duration', () => {
    open();
    fireEvent.click(screen.getByText('Editing'));
    fireEvent.change(screen.getByLabelText('Default overlay duration'), {
      target: { value: '5' },
    });
    expect(loadSettings().defaultOverlaySeconds).toBe(5);
  });

  it('toggles playback defaults', () => {
    open();
    fireEvent.click(screen.getByText('Playback'));
    fireEvent.click(screen.getByRole('switch', { name: 'Loop playback' }));
    expect(loadSettings().loopByDefault).toBe(true);
  });

  it('marks complementary desktop sections for a compact two-card layout', () => {
    const { container } = render(
      <SettingsProvider>
        <SettingsDialog open onClose={() => {}} />
      </SettingsProvider>,
    );
    expect(container.querySelector('.settings-panel-content--display')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Playback' }));
    expect(container.querySelector('.settings-panel-content--playback')).toBeTruthy();
  });

  it('embeds the keyboard cheat-sheet in the Shortcuts section', () => {
    open();
    fireEvent.click(screen.getByText('Shortcuts'));
    expect(screen.getByLabelText('Search shortcuts')).toBeDefined();
  });

  it('saves a provider API key and model from the AI section (no bridge → localStorage)', () => {
    open();
    fireEvent.click(screen.getByText('AI'));
    // Anthropic's row is the one expanded by default, so its fields are the visible
    // ones and the labels are scoped to that row rather than repeating the provider name.
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-abc' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    expect(loadBrowserAiConfig().keys.anthropic).toBe('sk-abc');

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-x' } });
    expect(loadBrowserAiConfig().models.anthropic).toBe('claude-x');
  });

  it('switches the active provider from the AI section via the Select (H11)', () => {
    open();
    fireEvent.click(screen.getByText('AI'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Active provider' }));
    fireEvent.click(screen.getByRole('option', { name: 'NVIDIA NIM' }));
    expect(loadBrowserAiConfig().activeProvider).toBe('nvidia');
  });

  it('lists the hosted providers in the picker, and no longer offers GitHub', () => {
    // GitHub Models / GitHub Copilot were removed from the product 2026-08-07. Asserted
    // as an absence, not just deleted from the list, so re-adding them is a decision
    // rather than an accident.
    open();
    fireEvent.click(screen.getByText('AI'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Active provider' }));
    expect(screen.getByRole('option', { name: 'OpenRouter' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'DeepSeek' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /GitHub/i })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'DeepSeek' }));
    expect(loadBrowserAiConfig().activeProvider).toBe('deepseek');
  });

  it('expands a collapsed provider row to reveal its fields (accordion)', () => {
    open();
    fireEvent.click(screen.getByText('AI'));
    // Every row labels its field just "API key", so identity comes from the input id.
    expect(document.getElementById('ai-key-openrouter')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'OpenRouter settings' }));
    const keyField = document.getElementById('ai-key-openrouter') as HTMLInputElement;
    expect(keyField).toBeTruthy();
    fireEvent.change(keyField, { target: { value: 'sk-or-1' } });
    fireEvent.keyDown(keyField, { key: 'Enter' });
    expect(loadBrowserAiConfig().keys.openrouter).toBe('sk-or-1');
  });

  it('expands the collapsed DeepSeek row to reveal its fields (accordion)', () => {
    open();
    fireEvent.click(screen.getByText('AI'));
    // Every row labels its field just "API key", so identity comes from the input id.
    expect(document.getElementById('ai-key-deepseek')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek settings' }));
    const keyField = document.getElementById('ai-key-deepseek') as HTMLInputElement;
    expect(keyField).toBeTruthy();
    fireEvent.change(keyField, { target: { value: 'sk-ds-1' } });
    fireEvent.keyDown(keyField, { key: 'Enter' });
    expect(loadBrowserAiConfig().keys.deepseek).toBe('sk-ds-1');
  });

  it('expands the collapsed Google row to reveal its fields (accordion)', () => {
    open();
    fireEvent.click(screen.getByText('AI'));
    // Every row labels its field just "API key", so identity comes from the input id.
    expect(document.getElementById('ai-key-google')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Google (Gemini) settings' }));
    const keyField = document.getElementById('ai-key-google') as HTMLInputElement;
    expect(keyField).toBeTruthy();
    fireEvent.change(keyField, { target: { value: 'AIza-1' } });
    fireEvent.keyDown(keyField, { key: 'Enter' });
    expect(loadBrowserAiConfig().keys.google).toBe('AIza-1');
  });

  it('does not expose per-tier model routing', () => {
    open();
    fireEvent.click(screen.getByText('AI'));
    expect(screen.queryByRole('tab', { name: 'Routing' })).toBeNull();
    expect(screen.queryByText('Small (fast)')).toBeNull();
  });

  it('toggles the dev/pro "Show AI usage details" setting, off by default (P7.2)', () => {
    open();
    fireEvent.click(screen.getByText('AI'));
    const toggle = screen.getByRole('switch', { name: 'Show AI usage details' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(loadSettings().showAiUsageDetails).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(loadSettings().showAiUsageDetails).toBe(true);
  });

  // Media understanding became automatic: the standalone "Embeddings" sub-view, its
  // NVIDIA key field, its auto-index toggle and its manual "Index now" button are all
  // gone. What survives — and what these cover — is the key that switches the backend
  // on, and an honest read of coverage that never fakes readiness.
  describe('AI → Media intelligence', () => {
    const openAi = (): void => {
      open();
      fireEvent.click(screen.getByText('AI'));
    };

    it('shows and persists the TwelveLabs key', () => {
      applyBrowserUpdate({ twelveLabs: 'tlk-existing' });
      openAi();
      const input = screen.getByLabelText('TwelveLabs API key') as HTMLInputElement;
      expect(input.value).toBe('tlk-existing');
      fireEvent.change(input, { target: { value: 'tlk-new' } });
      expect(loadBrowserAiConfig().twelveLabs).toBe('tlk-new');
    });

    it('says plainly that no key means local facts only, rather than implying failure', () => {
      openAi();
      expect(screen.getByText('Local facts only')).toBeTruthy();
      expect(screen.getByText(/remain available without a media-understanding key/)).toBeTruthy();
    });

    it('reports TwelveLabs ready once a key is configured', () => {
      applyBrowserUpdate({ twelveLabs: 'tlk-1' });
      openAi();
      expect(screen.getByText('TwelveLabs ready')).toBeTruthy();
    });

    it('shows and persists the on-device embeddings key', () => {
      applyBrowserUpdate({ nvidiaEmbeddings: 'nvapi-existing' });
      openAi();
      const input = screen.getByLabelText('On-device embeddings key') as HTMLInputElement;
      expect(input.value).toBe('nvapi-existing');
      fireEvent.change(input, { target: { value: 'nvapi-new' } });
      expect(loadBrowserAiConfig().nvidiaEmbeddings).toBe('nvapi-new');
    });

    it('reports the on-device backend when only an embeddings key is set', () => {
      applyBrowserUpdate({ nvidiaEmbeddings: 'nvapi-1' });
      openAi();
      expect(screen.getByText('On-device ready')).toBeTruthy();
      expect(screen.queryByText('Local facts only')).toBeNull();
    });

    // The engine resolves TwelveLabs before the on-device embedder, so with both keys set
    // the badge must name the hosted backend — a user reading "On-device" while media
    // leaves the machine is the failure this guards.
    it('names the hosted backend and explains priority when both keys are set', () => {
      applyBrowserUpdate({ twelveLabs: 'tlk-1', nvidiaEmbeddings: 'nvapi-1' });
      openAi();
      expect(screen.getByText('TwelveLabs ready')).toBeTruthy();
      expect(screen.getByText(/TwelveLabs takes priority/)).toBeTruthy();
    });

    it('offers no manual indexing controls — preparation is automatic', () => {
      openAi();
      expect(screen.queryByRole('button', { name: 'Index now' })).toBeNull();
      expect(screen.queryByRole('switch', { name: 'Auto-index imported media' })).toBeNull();
      expect(screen.getByText(/There is no manual indexing step/)).toBeTruthy();
    });

    it('asks for a project rather than showing coverage for nothing', () => {
      openAi();
      expect(screen.getByText('Open a project to see media-understanding coverage.')).toBeTruthy();
    });

    const stubVisualFetch = (visualStatus: Record<string, unknown>): void => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const body = String(url).includes('/brain/visual/status')
            ? visualStatus
            : { binaryAvailable: false, model: 'base', modelPresent: false };
          return {
            ok: true,
            status: 200,
            json: async () => body,
            text: async () => JSON.stringify(body),
          };
        }),
      );
    };

    const openAiForProject = (projectId: string): void => {
      render(
        <SettingsProvider>
          <SettingsDialog open initialSection="ai" projectId={projectId} onClose={() => {}} />
        </SettingsProvider>,
      );
    };

    it('renders live coverage from /brain/visual/status', async () => {
      stubVisualFetch({
        available: true,
        backend: 'sqlite-vec',
        counts: { assets: 2, spans: 40, vectors: 40, captions: 8 },
        indexedAssets: 2,
        totalAssets: 4,
        keyConfigured: true,
      });
      openAiForProject('p1');
      await waitFor(() => expect(screen.getByText(/2\/4 assets prepared/)).toBeTruthy());
    });

    it('shows in-flight progress while a preparation job runs', async () => {
      stubVisualFetch({
        available: true,
        backend: 'brute-force',
        counts: { assets: 0 },
        indexedAssets: 0,
        totalAssets: 3,
        keyConfigured: true,
        lastJob: {
          jobId: 'job-1',
          state: 'running',
          progress: 0.33,
          cursor: 1,
          total: 3,
          updatedAt: '2026-07-18T00:00:00Z',
        },
      });
      openAiForProject('p1');
      await waitFor(() => expect(screen.getByText(/0\/3 assets prepared · 33%/)).toBeTruthy());
    });

    it('reports an unreachable engine honestly (no fake success)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      );
      openAiForProject('p1');
      await waitFor(() =>
        expect(screen.getByText(/media engine is currently unreachable/)).toBeTruthy(),
      );
    });
  });
  it('resets every preference to defaults', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Seconds' }));
    expect(loadSettings().timeDisplay).toBe('seconds');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(loadSettings().timeDisplay).toBe('timecode');
  });

  it('opens on the requested tab via initialSection (H2 deep-link)', () => {
    render(
      <SettingsProvider>
        <SettingsDialog open initialSection="ai" onClose={() => {}} />
      </SettingsProvider>,
    );
    const aiTab = screen.getByRole('tab', { name: 'AI' });
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
  });

  it('supports roving keyboard navigation between settings sections', () => {
    open();
    const displayTab = screen.getByRole('tab', { name: 'Display' });
    displayTab.focus();
    fireEvent.keyDown(displayTab, { key: 'ArrowDown' });

    const editingTab = screen.getByRole('tab', { name: 'Editing' });
    expect(editingTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(editingTab);
    expect(screen.getByRole('heading', { name: 'Timeline behavior' })).toBeTruthy();
  });

  it('surfaces local, provider, and footage readiness without exposing secrets', () => {
    render(
      <SettingsProvider>
        <SettingsDialog open projectId="project-1" onClose={() => {}} />
      </SettingsProvider>,
    );
    const readiness = screen.getByRole('complementary', { name: 'System readiness' });
    expect(readiness.textContent).toContain('PreferencesLocal');
    expect(readiness.textContent).toContain('AI providerOffline mock');
    expect(readiness.textContent).toContain('FootageProject open');
  });

  it('closes on Escape', () => {
    let open = true;
    render(
      <SettingsProvider>
        <SettingsDialog open onClose={() => (open = false)} />
      </SettingsProvider>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(open).toBe(false);
  });

  it('edits a cross-project preference in Memory and persists it (K5.1b)', () => {
    open();
    fireEvent.click(screen.getByText('Memory'));
    const caption = screen.getByLabelText('Caption style');
    fireEvent.change(caption, { target: { value: 'karaoke' } });
    fireEvent.blur(caption);
    expect(loadUserMemory().captionStyle).toBe('karaoke');

    const platforms = screen.getByLabelText('Favourite export platforms');
    fireEvent.change(platforms, { target: { value: 'reels, shorts' } });
    fireEvent.blur(platforms);
    expect(loadUserMemory().favoriteExportPlatforms).toEqual(['reels', 'shorts']);
  });

  it('shows local whisper-cli status and offers Set up when the model is missing (H0.1)', async () => {
    const calls: string[] = [];
    stubAsrFetch((url) => {
      calls.push(url);
      if (url.includes('/asr/status')) return { ok: true, status: 200, json: ASR_STATUS_MISSING };
      if (url.includes('/asr/setup/progress'))
        return { ok: true, status: 200, json: IDLE_PROGRESS };
      return { ok: true, status: 200, json: { model: 'base.en', path: '/x' } };
    });
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() =>
      expect(screen.getByText('One-time 141.1 MB model download required.')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(calls.some((u) => u.endsWith('/asr/setup'))).toBe(true));
  });

  it('uses the signed Capability Pack approval path in desktop instead of Python setup', async () => {
    const calls: string[] = [];
    stubAsrFetch((url) => {
      calls.push(url);
      if (url.includes('/asr/status')) return { ok: true, status: 200, json: ASR_STATUS_MISSING };
      if (url.includes('/asr/setup/progress'))
        return { ok: true, status: 200, json: IDLE_PROGRESS };
      return { ok: false, status: 500, json: { error: 'legacy setup must not run' } };
    });
    const identity = {
      id: 'framepilot.local-whisper',
      version: '1.0.0',
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      os: 'darwin' as const,
      arch: 'arm64' as const,
    };
    const host = {
      capabilityPackPropose: vi.fn(async () => ({
        ok: true as const,
        proposal: {
          proposalId: 'c'.repeat(64),
          identity,
          capabilities: ['asr.whisper.local'],
          displayName: 'Local Whisper',
          description: 'Local professional transcription.',
          downloadBytes: 574_041_195,
          installedBytes: 620_000_000,
          licenses: [{ spdx: 'MIT', name: 'MIT', noticeUrl: 'https://example.com' }],
          privacy: {
            execution: 'local' as const,
            mediaLeavesDevice: false,
            disclosure: 'Runs locally.',
          },
        },
      })),
      capabilityPackInstall: vi.fn(async () => ({ ok: true as const, operationId: 'operation-1' })),
      onCapabilityPackProgress: vi.fn(() => () => undefined),
    } as unknown as FramePilotBridge;
    window.framepilot = host;
    open();
    fireEvent.click(screen.getByText('AI'));
    await screen.findByRole('button', { name: 'Set up' });

    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(await screen.findByText(/Local Whisper · 547\.4 MB/)).toBeTruthy();
    expect(calls.some((url) => url.endsWith('/asr/setup'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Approve exact version and download' }));
    await waitFor(() =>
      expect(host.capabilityPackInstall).toHaveBeenCalledWith({
        proposalId: 'c'.repeat(64),
        identity,
        approvedSizeBytes: 574_041_195,
        approvedLicenseSpdx: ['MIT'],
        approvedMediaEgress: false,
        approvedAt: expect.any(String),
      }),
    );
  });

  it('shows a real byte-level progress bar while the model downloads', async () => {
    let releaseSetup = (): void => {};
    const setupSettled = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let downloaded = 0;
    let started = false;
    stubAsrFetch((url) => {
      if (url.includes('/asr/status')) return { ok: true, status: 200, json: ASR_STATUS_MISSING };
      if (url.includes('/asr/setup/progress')) {
        if (!started) return { ok: true, status: 200, json: IDLE_PROGRESS };
        downloaded += 20_000_000;
        return {
          ok: true,
          status: 200,
          json: {
            state: 'downloading',
            model: 'base.en',
            downloadedBytes: downloaded,
            totalBytes: 147_964_211,
            error: null,
          },
        };
      }
      started = true;
      return { ok: true, status: 200, json: { model: 'base.en', path: '/x' }, wait: setupSettled };
    });
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));

    // Real measured progress, not a spinner: a determinate bar whose value tracks the
    // engine's byte counts. The exact percent depends on how many polls have landed, so
    // assert the properties that matter rather than one frame of the animation.
    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0));
    const percent = Number(bar.getAttribute('aria-valuenow'));
    expect(percent).toBeLessThanOrEqual(100);
    expect(screen.getByText(`Downloading local model · ${percent}%`)).toBeTruthy();
    expect(bar.className).not.toContain('indeterminate');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${percent}%`);

    releaseSetup();
  });

  it('offers Cancel mid-download and reports that nothing was installed', async () => {
    let releaseSetup = (): void => {};
    const setupSettled = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let cancelled = false;
    let started = false;
    stubAsrFetch((url) => {
      if (url.includes('/asr/status')) return { ok: true, status: 200, json: ASR_STATUS_MISSING };
      if (url.includes('/asr/setup/cancel')) {
        cancelled = true;
        return { ok: true, status: 200, json: { ...IDLE_PROGRESS, state: 'cancelled' } };
      }
      if (url.includes('/asr/setup/progress')) {
        if (!started) return { ok: true, status: 200, json: IDLE_PROGRESS };
        return {
          ok: true,
          status: 200,
          json: {
            state: cancelled ? 'cancelled' : 'downloading',
            model: 'base.en',
            downloadedBytes: 1_000_000,
            totalBytes: 147_964_211,
            error: null,
          },
        };
      }
      started = true;
      return { ok: false, status: 409, json: { detail: 'cancelled' }, wait: setupSettled };
    });
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    releaseSetup();

    await waitFor(() =>
      expect(
        screen.getByText(/Setup cancelled — the local model was not installed\./),
      ).toBeTruthy(),
    );
  });

  it('adopts a setup already running in the engine when the dialog is reopened', async () => {
    stubAsrFetch((url) => {
      if (url.includes('/asr/status')) return { ok: true, status: 200, json: ASR_STATUS_MISSING };
      return {
        ok: true,
        status: 200,
        json: {
          state: 'downloading',
          model: 'base.en',
          downloadedBytes: 74_000_000,
          totalBytes: 147_964_211,
          error: null,
        },
      };
    });
    open();
    fireEvent.click(screen.getByText('AI'));

    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('50'));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('shows a setup-help popup with a docs link when whisper-cli is missing (H0.1 follow-up)', async () => {
    const calls: string[] = [];
    stubAsrFetch((url) => {
      calls.push(url);
      if (url.includes('/asr/setup/progress'))
        return { ok: true, status: 200, json: IDLE_PROGRESS };
      return {
        ok: true,
        status: 200,
        json: { ...ASR_STATUS_MISSING, binaryAvailable: false, binaryPath: null },
      };
    });
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByText('whisper-cli is not installed.')).toBeTruthy());
    // Pressing Set up must not start a download that cannot succeed; it explains the
    // missing prerequisite inline and links the guide instead.
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(screen.getByText(/Install whisper-cli first, then return here/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open setup guide' })).toHaveProperty(
      'href',
      'https://framepilot.app/docs/local-transcription-setup',
    );
    expect(calls.some((u) => u.endsWith('/asr/setup'))).toBe(false);
  });

  it('shows the engine’s own failure message when setup fails (H0.1 follow-up)', async () => {
    stubAsrFetch((url) => {
      if (url.includes('/asr/status')) return { ok: true, status: 200, json: ASR_STATUS_MISSING };
      if (url.includes('/asr/setup/progress')) {
        return {
          ok: true,
          status: 200,
          json: {
            state: 'error',
            model: 'base.en',
            downloadedBytes: 147_964_211,
            totalBytes: 147_964_211,
            error: "Downloaded model 'base.en' failed checksum verification.",
          },
        };
      }
      return { ok: false, status: 422, json: { detail: 'checksum' } };
    });
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(screen.getByText(/checksum/)).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Open setup guide' })).toHaveProperty(
      'href',
      'https://framepilot.app/docs/local-transcription-setup',
    );
  });

  it('reports the local engine unreachable honestly (never fakes readiness)', async () => {
    stubAsrFetch(() => ({ ok: false, status: 500, json: {} }));
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByText('The local engine is unreachable.')).toBeTruthy());
  });

  it('migrates a legacy Groq ASR selection back to Local', async () => {
    stubAsrFetch(() => ({
      ok: true,
      status: 200,
      json: {
        binaryAvailable: true,
        binaryPath: '/x',
        model: 'base.en',
        modelPresent: true,
        modelPath: '/x',
      },
    }));
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByText('Speech-to-text')).toBeTruthy());
    // The retired provider is not selectable and its key field is gone, so a stored
    // legacy preference can only resolve to Local — it cannot keep sending audio out.
    expect(screen.queryByRole('button', { name: 'Groq' })).toBeNull();
    expect(screen.queryByLabelText('Groq speech-to-text API key')).toBeNull();
    expect(screen.getByRole('button', { name: 'Local' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('uses the shared TwelveLabs key for word-level transcription', async () => {
    stubAsrFetch(() => ({
      ok: true,
      status: 200,
      json: {
        binaryAvailable: true,
        binaryPath: '/x',
        model: 'large-v3-turbo-q5_0',
        modelPresent: true,
        modelPath: '/x',
      },
    }));
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByText('Speech-to-text')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'TwelveLabs' }));
    expect(loadSettings().asrProvider).toBe('twelvelabs');
    expect(
      screen.getByText(/same key powers transcription and semantic footage understanding/),
    ).toBeTruthy();
    // Two fields carry this label once TwelveLabs is selected (transcription and media
    // intelligence share the key), so address the transcription one by id.
    const keyField = document.getElementById('asr-twelvelabs-key') as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: 'tlk-shared' } });
    expect(loadBrowserAiConfig().twelveLabs).toBe('tlk-shared');
    expect(keyField).toHaveProperty('type', 'password');
  });

  it('migrates a legacy NVIDIA ASR selection back to Local', async () => {
    stubAsrFetch(() => ({
      ok: true,
      status: 200,
      json: {
        binaryAvailable: true,
        binaryPath: '/x',
        model: 'base.en',
        modelPresent: true,
        modelPath: '/x',
      },
    }));
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByText('Speech-to-text')).toBeTruthy());
    // The retired provider is not selectable and its key field is gone, so a stored
    // legacy preference can only resolve to Local — it cannot keep sending audio out.
    expect(screen.queryByRole('button', { name: 'NVIDIA' })).toBeNull();
    expect(screen.queryByLabelText('NVIDIA speech-to-text API key')).toBeNull();
    expect(screen.getByRole('button', { name: 'Local' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles transcription between on-demand and automatically-on-import', async () => {
    stubAsrFetch(() => ({
      ok: true,
      status: 200,
      json: {
        binaryAvailable: true,
        binaryPath: '/x',
        model: 'base.en',
        modelPresent: true,
        modelPath: '/x',
      },
    }));
    open();
    fireEvent.click(screen.getByText('AI'));
    await waitFor(() => expect(screen.getByText('Speech-to-text')).toBeTruthy());
    expect(loadSettings().transcribeOnImport).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'On import' }));
    expect(loadSettings().transcribeOnImport).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'On demand' }));
    expect(loadSettings().transcribeOnImport).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Stock media — key custody and the quota readout
  // ---------------------------------------------------------------------------

  describe('Stock media', () => {
    /**
     * Render inside a real {@link AiConfigProvider}.
     *
     * The other tests get away without one because their keys round-trip through
     * the localStorage fallback. The Pexels key deliberately does not: it is
     * desktop-only and write-only, so the fallback no-ops rather than pretending
     * a browser save worked.
     */
    const openWithAiConfig = (): void => {
      render(
        <SettingsProvider>
          <AiConfigProvider>
            <SettingsDialog open onClose={() => {}} />
          </AiConfigProvider>
        </SettingsProvider>,
      );
    };

    /**
     * A bridge host with a controllable quota snapshot.
     *
     * `aiConfigGet` must return a real `AiConfig` — the provider hands whatever
     * it gets straight to the tree, so a browser-storage shape here would leave
     * the AI section unable to render at all.
     */
    function stubStockHost(
      snapshot: import('@framepilot/shared-types').StockQuotaSnapshot,
      options: { pexelsReady?: boolean } = {},
    ): FramePilotBridge {
      const config = {
        activeProvider: 'nvidia' as const,
        providers: [],
        embeddingsAutoIndex: true,
        pexelsReady: options.pexelsReady ?? false,
      };
      const host = {
        stockQuota: vi.fn(async () => snapshot),
        onStockQuotaChanged: vi.fn(() => () => undefined),
        aiConfigGet: vi.fn(async () => config),
        aiConfigSet: vi.fn(async () => config),
      } as unknown as FramePilotBridge;
      window.framepilot = host;
      return host;
    }

    const MONTHLY = {
      limit: 20000,
      remaining: 18431,
      resetAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      observedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    };

    it('offers a key field with no quota block before a key exists', async () => {
      stubStockHost({ kind: 'no_key' });
      openWithAiConfig();
      fireEvent.click(screen.getByText('AI'));
      expect(await screen.findByLabelText('Pexels API key')).toBeTruthy();
      // No key, no quota to speak of — a bar here would be inventing one.
      expect(screen.queryByRole('progressbar', { name: /Monthly Pexels/ })).toBeNull();
    });

    it('says "not measured yet" rather than showing a guessed maximum', async () => {
      stubStockHost({ kind: 'unmeasured' });
      openWithAiConfig();
      fireEvent.click(screen.getByText('AI'));
      expect(await screen.findByText(/Not measured yet/)).toBeTruthy();
      expect(screen.queryByText(/20,000/)).toBeNull();
    });

    it('renders the monthly figures, the reset, and when it saw them', async () => {
      stubStockHost({ kind: 'measured', monthly: MONTHLY });
      openWithAiConfig();
      fireEvent.click(screen.getByText('AI'));

      expect(await screen.findByText(/18,431 of 20,000 requests left/)).toBeTruthy();
      // "Monthly" is in the label because the hourly cap is invisible to us; a
      // bar labelled just "quota" is a lie waiting for the first 429.
      expect(screen.getByText('Monthly API quota')).toBeTruthy();
      expect(screen.getByText(/^Resets /)).toBeTruthy();
      // Last-observed, not live: the same key used elsewhere moves these.
      expect(screen.getByText(/^As of /)).toBeTruthy();

      const bar = screen.getByRole('progressbar', { name: 'Monthly Pexels API quota remaining' });
      expect(bar.getAttribute('aria-valuenow')).toBe('92');
    });

    it('states the hourly limit beside a healthy monthly bar, not instead of it', async () => {
      stubStockHost({
        kind: 'hourly_limited',
        monthly: { ...MONTHLY, remaining: 19400 },
        since: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        retryAfterSeconds: 120,
      });
      openWithAiConfig();
      fireEvent.click(screen.getByText('AI'));

      // Both facts are true at once, and the panel has to hold both.
      expect(await screen.findByText(/19,400 of 20,000 requests left/)).toBeTruthy();
      expect(screen.getByText('Hourly limit')).toBeTruthy();
      expect(screen.getByText(/roughly 200 requests an hour/)).toBeTruthy();
      expect(screen.getByText(/Retry in about 2 min/)).toBeTruthy();
    });

    it('saves a key through to the main-process store', async () => {
      const host = stubStockHost({ kind: 'unmeasured' });
      openWithAiConfig();
      fireEvent.click(screen.getByText('AI'));

      const field = await screen.findByLabelText('Pexels API key');
      fireEvent.change(field, { target: { value: '  563492ad-secret  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Pexels API key' }));

      await waitFor(() =>
        expect(host.aiConfigSet).toHaveBeenCalledWith(
          expect.objectContaining({ pexelsApiKey: '563492ad-secret' }),
        ),
      );
    });

    it('never renders the key back, because it is write-only', async () => {
      stubStockHost({ kind: 'measured', monthly: MONTHLY }, { pexelsReady: true });
      openWithAiConfig();
      fireEvent.click(screen.getByText('AI'));

      // The custody boundary, visible in the UI: there is a state, not a value.
      expect(await screen.findByText('Configured')).toBeTruthy();
      expect(screen.queryByLabelText('Pexels API key')).toBeNull();
      expect(screen.getByRole('button', { name: 'Replace the Pexels API key' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Clear the Pexels API key' })).toBeTruthy();
    });
  });
});
