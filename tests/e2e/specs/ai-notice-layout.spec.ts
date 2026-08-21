/**
 * The AI sidebar's notice card — geometry, not appearance.
 *
 * Errors, warnings and plain notices share one card, and its layout was described by
 * three stylesheets at once (`styles.css`, `AiSidebar.beautiful.css`,
 * `AiSidebar.polish.css`) that disagreed with each other. The visible results:
 *
 * - `border: 0` in the second file silenced the tone stripe the first file set, so a
 *   failed run looked like an informational one apart from a small icon;
 * - `.ai-notice-body` was a flex ROW, which made the disclosed `<pre>` detail a third
 *   COLUMN squeezed beside the message instead of a block beneath it;
 * - a `margin-top` meant for the old column layout knocked the Retry / Show details
 *   buttons out of line with the message they belong to;
 * - an info notice renders no icon, so its message started 20px left of every warning
 *   and error in the same thread.
 *
 * All four are geometry, and all four are invisible to a snapshot of the DOM — so this
 * asserts the boxes. It builds the three cards directly rather than provoking a real
 * failure, because what is under test is the CSS contract for a given markup shape, and
 * a run that produces an info, a warning AND an error with a detail on demand does not
 * exist. The markup mirrors `EventNode.tsx`'s notice branch; if that changes shape, this
 * should change with it.
 */
import { test, expect } from '@playwright/test';
import { openEditor, rightTab } from './helpers.js';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Probe {
  readonly infoText: Box;
  readonly warnText: Box;
  readonly errText: Box;
  readonly warnIcon: Box;
  readonly errActions: Box;
  readonly errDetail: Box;
  readonly errCard: Box;
  readonly errShadow: string;
  readonly infoShadow: string;
}

test.describe('AI sidebar: notice card layout', () => {
  test('aligns every level, keeps actions on the message row, and puts detail underneath', async ({
    page,
  }) => {
    await openEditor(page);
    await rightTab(page, 'AI');

    const probe: Probe = await page.evaluate(() => {
      const thread =
        document.querySelector('[data-testid="ai-sidebar"] [role="list"]') ??
        document.querySelector('[data-testid="ai-sidebar"]');
      if (!thread) throw new Error('AI thread not found');
      const notice = (level: string, text: string, detail: boolean): HTMLElement => {
        const el = document.createElement('div');
        el.className = 'ai-event ai-event--notice';
        el.setAttribute('role', 'listitem');
        el.setAttribute('data-level', level);
        const tone = level === 'error' ? 'failed' : 'warning';
        el.innerHTML =
          (level === 'info'
            ? ''
            : `<svg class="ai-tone-icon" data-tone="${tone}" width="14" height="14"></svg>`) +
          '<div class="ai-notice-body"><span class="ai-notice-text">' +
          text +
          '</span><div class="ai-notice-actions">' +
          '<button type="button" class="ai-btn ai-btn--quiet">Retry</button>' +
          '<button type="button" class="ai-btn ai-btn--quiet">Hide details</button></div>' +
          (detail ? '<pre class="ai-notice-detail">line one\nline two</pre>' : '') +
          '</div>';
        thread.appendChild(el);
        return el;
      };
      // Long enough to wrap: a single-line message hides every alignment bug here.
      const info = notice(
        'info',
        'An informational notice long enough to wrap onto a second line in the sidebar column.',
        false,
      );
      const warn = notice(
        'warning',
        'Review could not run: temporal evidence acquisition was cancelled.',
        false,
      );
      const err = notice('error', 'The run failed before anything was applied.', true);
      const box = (root: Element, selector?: string): Box => {
        const target = selector ? root.querySelector(selector) : root;
        if (!target) throw new Error(`missing ${selector ?? 'element'}`);
        const r = target.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      return {
        infoText: box(info, '.ai-notice-text'),
        warnText: box(warn, '.ai-notice-text'),
        errText: box(err, '.ai-notice-text'),
        warnIcon: box(warn, '.ai-tone-icon'),
        errActions: box(err, '.ai-notice-actions'),
        errDetail: box(err, '.ai-notice-detail'),
        errCard: box(err),
        errShadow: getComputedStyle(err).boxShadow,
        infoShadow: getComputedStyle(info).boxShadow,
      };
    });

    // 1. One message column, whatever the level. The icon slot is reserved even when
    //    there is no icon to put in it, so an info notice does not sit 20px left of the
    //    warning above it.
    expect(probe.infoText.x).toBe(probe.warnText.x);
    expect(probe.errText.x).toBe(probe.warnText.x);

    // 2. The tone icon sits in that reserved gutter, inside the card — not pulled out of
    //    it by a hand-tuned negative margin that a padding change silently invalidates.
    expect(probe.warnIcon.x).toBeGreaterThan(probe.errCard.x);
    expect(probe.warnIcon.x).toBeLessThan(probe.warnText.x);

    // 3. Actions share the message's row and sit to its right — not below it, and not
    //    knocked down by a margin left over from an earlier layout.
    expect(probe.errActions.x).toBeGreaterThan(probe.errText.x);
    expect(Math.abs(probe.errActions.y - probe.errText.y)).toBeLessThanOrEqual(6);

    // 4. The disclosed detail is a full-width block BENEATH the message, not a third
    //    column beside it: same left edge, lower down, and wider than the message column.
    expect(probe.errDetail.x).toBe(probe.errText.x);
    expect(probe.errDetail.y).toBeGreaterThan(probe.errActions.y);
    expect(probe.errDetail.w).toBeGreaterThan(probe.errText.w);

    // 5. A failed run looks failed. The stripe is an inset shadow so it follows the
    //    card's radius; an info notice gets the hairline ring and nothing more.
    expect(probe.errShadow).toContain('inset');
    expect(probe.infoShadow).not.toContain('inset');
  });
});
