/**
 * Bootstrap for the P0 WebCodecs feasibility spike page
 * (`preview-spike.html`, plan PREVIEW-WEBCODECS-COMPOSITOR.md). Not part of
 * the app build (the HTML entry isn't in any Vite `rollupOptions.input`) —
 * this only runs when `preview-spike.html` is loaded directly, which is what
 * the Playwright spike spec does.
 */
import { SpikeHarness } from './harness.js';

declare global {
  interface Window {
    __framepilotSpike: SpikeHarness;
  }
}

function mount(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#spike-canvas');
  if (!canvas) throw new Error('preview-spike.html must contain a #spike-canvas element.');

  const harness = new SpikeHarness(canvas);
  window.__framepilotSpike = harness;

  const startButton = document.querySelector<HTMLButtonElement>('#spike-start');
  if (startButton) {
    startButton.addEventListener('click', () => {
      void harness.startAudio().then(() => {
        startButton.textContent = 'Audio running';
        startButton.disabled = true;
      });
    });
  }

  const statusEl = document.querySelector<HTMLElement>('#spike-status');
  if (statusEl) statusEl.textContent = 'ready';
}

mount();
