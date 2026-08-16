/**
 * Smoke tests for `tokens.css` (J1). jsdom has no real CSS cascade/@media
 * engine (it can't evaluate `prefers-color-scheme` or match `:root[data-theme]`
 * attribute selectors against `getComputedStyle`), so this can't drive the
 * stylesheet through a browser and read resolved values the way a real
 * browser/e2e/visual check can (see apps/web-editor's Playwright suite for
 * that). Instead this asserts, textually, on the source of truth every
 * consumer actually loads: every DESIGN_SYSTEM.md token name is declared for
 * the dark default, and light-theme values exist for every token that should
 * differ by theme (color/shadow tokens) while theme-invariant tokens
 * (spacing/radius/type-scale/motion/z-index) are declared exactly once, not
 * duplicated into the light blocks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `vitest run` executes with cwd = the package root (see package.json's `test`
// script), so this resolves regardless of how the test file itself was loaded.
const tokensCss = readFileSync(join(process.cwd(), 'src/tokens.css'), 'utf-8');

/** Every custom-property declaration for `name`, in file order. */
function declarationsOf(name: string): string[] {
  const re = new RegExp(`--${name}:\\s*([^;]+);`, 'g');
  return [...tokensCss.matchAll(re)].map((m) => m[1]!.trim());
}

describe('tokens.css structure', () => {
  it('gates light values behind the media query + explicit data-theme, mirroring the reduced-motion pattern', () => {
    expect(tokensCss).toContain('@media (prefers-color-scheme: light)');
    expect(tokensCss).toContain(":root:not([data-theme='dark'])");
    expect(tokensCss).toContain(":root[data-theme='light']");
  });

  it('declares the dark default for every documented surface/text/accent token', () => {
    for (const name of [
      'bg-app',
      'bg-canvas',
      'bg-panel',
      'bg-surface',
      'bg-elevated',
      'border-subtle',
      'border-default',
      'border-strong',
      'text-primary',
      'text-secondary',
      'text-tertiary',
      'text-disabled',
      'accent',
      'accent-hover',
      'focus-ring',
      'success',
      'warning',
      'danger',
      'playhead',
      'clip-video',
      'clip-audio',
      'clip-text',
      'clip-ai',
    ]) {
      expect(declarationsOf(name).length, `--${name} should be declared`).toBeGreaterThan(0);
    }
  });

  it('gives every color/shadow token a light-theme value in BOTH the media-query and explicit-attribute blocks', () => {
    // One dark declaration (:root) + two light declarations (media block, attribute block).
    for (const name of ['bg-app', 'bg-panel', 'text-primary', 'accent', 'border-default', 'shadow-md']) {
      const decls = declarationsOf(name);
      expect(decls.length, `--${name} should appear exactly 3 times (dark + 2 light overrides)`).toBe(3);
      const [dark, mediaLight, attrLight] = decls;
      expect(dark).not.toBe(mediaLight); // an actual theme difference, not a copy-paste no-op
      expect(mediaLight).toBe(attrLight); // the two light blocks must stay in sync
    }
  });

  it('does not duplicate theme-invariant tokens (spacing/radius/type/motion/z-index) into the light blocks', () => {
    for (const name of ['space-4', 'radius-lg', 'font-size-md', 'dur-fast', 'z-menu']) {
      expect(declarationsOf(name).length, `--${name} should be declared once only`).toBe(1);
    }
  });

  it('keeps non-brand dark values byte-identical to the pre-J1 apps/web-editor styles.css block (zero-visual-diff extraction)', () => {
    // A few load-bearing literal values from the original :root block.
    expect(declarationsOf('bg-app')[0]).toBe('#0a0a0b');
    expect(declarationsOf('space-4')[0]).toBe('16px');
    expect(declarationsOf('radius-lg')[0]).toBe('8px');
    expect(declarationsOf('dur-fast')[0]).toBe('120ms');
  });

  it('pins the accent to the UI-clone blue, not the ADR 0054 logo-rebrand orange', () => {
    // Intentionally overridden post-rebrand to match a reference UI clone — see
    // the 2026-07-18 accent-blue change. Not yet reconciled with ADR 0054.
    expect(declarationsOf('accent')[0]).toBe('#3b82f6');
  });
});
