/**
 * Local usage history — the store behind Settings → Usage & Spend.
 *
 * The ledger maths lives in `@framepilot/ai-sdk`'s `usage-ledger.ts`; this is only the
 * storage seam plus the change notification the panel listens to.
 *
 * ## Why the renderer owns this, not the main process
 *
 * The numbers being recorded are already in the renderer: the sidebar receives each run's
 * `usage` event, and it alone knows which project and provider the run belonged to.
 * Routing that back out over IPC to write a file, then back again to read it, would add a
 * process boundary and a desktop-only code path to something that is neither. Keeping it
 * here means the browser build gets the same screen for free, and the store is scoped to
 * exactly what it claims to be: local history on this machine.
 *
 * The trade is real and worth naming: this lives in ordinary browser storage, so clearing
 * site data clears it, and it does not follow the user to another machine. That is why the
 * panel calls it *local* history rather than an account-level bill.
 *
 * ## Every read and write is guarded
 *
 * `localStorage` is not merely absent in some contexts, it *throws* — Safari private
 * browsing, a browser set to block site data, a thumbnail/preview renderer. A settings
 * screen must not be the thing that breaks the app, so a failure here degrades to "no
 * history" and is never allowed to propagate.
 */
import {
  aggregateUsage,
  emptyUsageLedger,
  pruneLedger,
  recordRun,
  type UsageLedger,
  type UsageRange,
  type UsageReport,
  type UsageRunEntry,
} from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('web-editor:usage-history');

const STORAGE_KEY = 'framepilot.usage.v1';

/**
 * How long history is kept.
 *
 * Matches the longest range the panel offers, plus nothing. Keeping more than the UI can
 * show would be storing data on the user's machine for no stated purpose.
 */
export const RETENTION_DAYS = 90;

/** Fired on the window whenever the ledger changes, so an open panel can re-read. */
export const USAGE_HISTORY_EVENT = 'framepilot:usage-history-changed';

function readLedger(): UsageLedger {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyUsageLedger();
    const parsed = JSON.parse(raw) as Partial<UsageLedger>;
    // A stored shape from a future/older version is discarded rather than half-read: a
    // partially-understood ledger would render as confidently wrong numbers.
    if (parsed.version !== 1 || typeof parsed.buckets !== 'object' || parsed.buckets === null) {
      return emptyUsageLedger();
    }
    return { version: 1, buckets: parsed.buckets };
  } catch (error) {
    log.warn('could not read usage history', { error: String(error) });
    return emptyUsageLedger();
  }
}

function writeLedger(ledger: UsageLedger): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
    window.dispatchEvent(new CustomEvent(USAGE_HISTORY_EVENT));
  } catch (error) {
    // A full quota or a blocked store means history stops growing. The app keeps working;
    // the panel will simply show what it already had.
    log.warn('could not write usage history', { error: String(error) });
  }
}

/**
 * Fold one finished run into local history.
 *
 * Pruning happens here rather than on read: a user who stops editing for a year should not
 * return to a store that quietly kept everything, and pruning on read would make the
 * numbers depend on whether anyone opened the screen.
 *
 * @param entry - The finished run.
 * @param enabled - The user's "Keep usage history" setting; `false` records nothing.
 */
export function recordUsageRun(entry: UsageRunEntry, enabled: boolean): void {
  if (!enabled) return;
  writeLedger(pruneLedger(recordRun(readLedger(), entry), RETENTION_DAYS));
}

/** Roll local history up for the panel. */
export function readUsageReport(range: UsageRange): UsageReport {
  return aggregateUsage(readLedger(), range);
}

/** Forget everything. Used by the panel's "Clear history" action. */
export function clearUsageHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(USAGE_HISTORY_EVENT));
  } catch (error) {
    log.warn('could not clear usage history', { error: String(error) });
  }
}

/** Subscribe to ledger changes. Returns an unsubscribe function. */
export function onUsageHistoryChange(listener: () => void): () => void {
  window.addEventListener(USAGE_HISTORY_EVENT, listener);
  return () => window.removeEventListener(USAGE_HISTORY_EVENT, listener);
}
