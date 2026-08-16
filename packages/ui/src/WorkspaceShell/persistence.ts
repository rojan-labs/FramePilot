/**
 * Pluggable persistence for {@link useRailLayout} / {@link useDockHeight} (J1
 * extraction — plan/FRAMEPILOT-AI-PRODUCT-PLAN.md §6). The rail/dock splitter
 * mechanism used to be hand-rolled directly in apps/web-editor's `Editor.tsx` +
 * `useRailLayout.ts`, hardcoding `localStorage`. Pulling it into `packages/ui`
 * means it can no longer assume a specific host, so persistence is injected
 * through this minimal contract instead.
 */

/**
 * A minimal key-value contract — deliberately the same shape as `Storage`
 * (`localStorage`/`sessionStorage`), so the browser's `localStorage` is a valid
 * adapter with zero glue, but it is *injected* rather than hardcoded so a
 * non-browser host (or a test) can supply its own (e.g. an in-memory map).
 */
export interface WorkspacePersistenceAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The default adapter: the browser's `localStorage`, tolerating a private-mode
 * / storage-disabled environment by swallowing access errors and degrading to
 * in-memory-only behavior (mirrors every pre-extraction call site's
 * try/catch-and-degrade pattern).
 */
export const localStorageAdapter: WorkspacePersistenceAdapter = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable (private mode) — value stays in-memory only */
    }
  },
};
