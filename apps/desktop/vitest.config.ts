import { defineConfig } from 'vitest/config';

// Tests cover the pure main-process modules (IPC contract, sidecar manager,
// recent-files store, updater channel). `main.ts`/`preload.ts` are thin Electron
// glue that requires an Electron runtime, so they are excluded from coverage —
// the logic they wire lives in the covered modules.
export default defineConfig({
  test: {
    include: ['electron/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['electron/**/*.ts'],
      exclude: ['electron/**/*.test.ts', 'electron/main.ts', 'electron/preload.ts'],
    },
  },
});
