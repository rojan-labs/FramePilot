/**
 * Settings → Usage & Spend.
 *
 * ## What this screen is for
 *
 * One job: answer *"where is my AI money going, and should I change anything?"* — not
 * "display every number we happen to have". That distinction drives the whole layout.
 *
 * The screen opens with a **sentence**, not a stat block, because a row of large figures
 * makes a reader do the arithmetic that produces the actual insight. "$4.12 across 38
 * edits — about $0.11 each" is the finding; the breakdowns below are the evidence for it.
 * Anything that could not be turned into something a person might act on was left out:
 * there is no cache-read/cache-write split and no year-long activity heatmap, because
 * neither changes what anyone does next.
 *
 * ## The three kinds of dollar, never added together
 *
 * `usage-ledger.ts` classifies every run as metered, subscription or unreported, and this
 * screen keeps them visually apart for the same reason it keeps them apart in the data: a
 * subscription run's dollar figure is a list price nobody was charged, and folding it into
 * a spend total invents a bill. So the headline is metered-only, the plan's contribution
 * gets its own line phrased as what it *saved*, and unreported runs are named as a gap in
 * the measurement rather than silently counted as zero.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, SegmentedControl, Switch } from '@framepilot/ui';
import {
  usdPerMeteredRun,
  type UsageBreakdownRow,
  type UsageRange,
  type UsageReport,
} from '@framepilot/ai-sdk';
import {
  clearUsageHistory,
  onUsageHistoryChange,
  readUsageReport,
  RETENTION_DAYS,
} from '../editor/usageHistory.js';

/** How many rows a breakdown shows before it offers the rest. */
const TOP_ROWS = 5;

const RANGE_OPTIONS: readonly { readonly value: UsageRange; readonly label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All' },
];

const RANGE_PHRASE: Readonly<Record<UsageRange, string>> = {
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  '90d': 'in the last 90 days',
  all: 'so far',
};

/**
 * Money, at the precision the number deserves.
 *
 * Sub-cent amounts are real and common on cheap models, and rounding them to `$0.00`
 * tells a user their run was free when it was not. Anything a cent or more gets two
 * decimals, because that is how people read prices.
 */
function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** `1234567` → `1.2M`. Long numbers are unreadable and the magnitude is the point. */
function compactTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * A ranked breakdown: label, proportional bar, figures.
 *
 * The bar is the reason this is not a table. "Which of these is the expensive one" is a
 * comparison, and a comparison is read from length far faster than from parsing five
 * dollar amounts. It is scaled against the largest row rather than the total so the
 * shape stays legible when one row dominates.
 */
function Breakdown({
  title,
  rows,
  emptyNote,
}: {
  readonly title: string;
  readonly rows: readonly UsageBreakdownRow[];
  readonly emptyNote: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, TOP_ROWS);
  const max = rows.reduce((m, r) => Math.max(m, r.meteredUsd + r.subscriptionUsd), 0);

  return (
    <section className="usage-card" aria-label={title}>
      <h4 className="usage-card-title">{title}</h4>
      {rows.length === 0 ? (
        <p className="usage-empty-note">{emptyNote}</p>
      ) : (
        <>
          <ul className="usage-rows">
            {shown.map((row) => {
              const total = row.meteredUsd + row.subscriptionUsd;
              return (
                <li key={row.key} className="usage-row">
                  <div className="usage-row-head">
                    {/* `title` so an 80-char project name is still identifiable when the
                        visible text truncates. */}
                    <span className="usage-row-label" title={row.label}>
                      {row.label}
                    </span>
                    {/* A row whose work was entirely covered by a plan still shows its
                        amount — a bare dash on the top row reads as missing data. It is
                        muted and suffixed instead, so it is legible as usage without
                        being read as another chunk of the bill. */}
                    <span className="usage-row-figure">
                      {row.meteredUsd > 0 ? (
                        money(row.meteredUsd)
                      ) : row.subscriptionUsd > 0 ? (
                        <span className="usage-row-covered">{`${money(row.subscriptionUsd)} on plan`}</span>
                      ) : (
                        '—'
                      )}
                      <span className="usage-row-sub">{` · ${compactTokens(row.tokens)} tokens`}</span>
                    </span>
                  </div>
                  <div className="usage-bar" aria-hidden="true">
                    <div
                      className="usage-bar-fill"
                      style={{ width: `${max === 0 ? 0 : Math.max(1.5, (total / max) * 100)}%` }}
                      data-covered={row.meteredUsd === 0 && row.subscriptionUsd > 0}
                    />
                  </div>
                  <span className="usage-row-sublabel">
                    {row.sublabel}
                    {/* Only when the row is MIXED — part billed, part on the plan. When it
                        is entirely covered, the figure above already said so, and
                        repeating it reads as two separate amounts. */}
                    {row.subscriptionUsd > 0 && row.meteredUsd > 0
                      ? ` · plus ${money(row.subscriptionUsd)} on your plan`
                      : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          {rows.length > TOP_ROWS ? (
            <Button variant="ghost" type="button" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show less' : `Show all (${String(rows.length)})`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Daily spend, as bars.
 *
 * Inline SVG rather than a charting library: this is one series of plain rectangles, and
 * a dependency for that would be weight with no benefit. Quiet days are drawn as empty
 * slots — a chart built only from days that had runs turns three scattered edits into
 * what looks like a three-day streak.
 */
function DailySpend({ report }: { readonly report: UsageReport }): JSX.Element | null {
  const days = report.byDay;
  const max = days.reduce((m, d) => Math.max(m, d.meteredUsd + d.subscriptionUsd), 0);
  if (max === 0) return null;

  const peak = days.reduce((best, d) =>
    d.meteredUsd + d.subscriptionUsd > best.meteredUsd + best.subscriptionUsd ? d : best,
  );

  return (
    <section className="usage-card" aria-label="Daily spend">
      <h4 className="usage-card-title">Daily spend</h4>
      <div
        className="usage-chart"
        role="img"
        aria-label={`Daily spend. Highest day ${peak.day} at ${money(peak.meteredUsd + peak.subscriptionUsd)}.`}
      >
        {days.map((day) => {
          const total = day.meteredUsd + day.subscriptionUsd;
          return (
            <div
              key={day.day}
              className="usage-chart-col"
              // Native tooltip: a custom one for a read-only chart would be interaction
              // cost for information the browser already knows how to show.
              title={`${day.day} · ${money(total)} · ${String(day.runs)} ${plural(day.runs, 'edit', 'edits')}`}
            >
              <div
                className="usage-chart-bar"
                style={{ height: `${total === 0 ? 0 : Math.max(2, (total / max) * 100)}%` }}
                data-covered={day.meteredUsd === 0 && day.subscriptionUsd > 0}
              />
            </div>
          );
        })}
      </div>
      <div className="usage-chart-axis">
        <span>{days[0]?.day ?? ''}</span>
        <span className="usage-chart-peak">{`Peak ${money(peak.meteredUsd + peak.subscriptionUsd)}`}</span>
        <span>Today</span>
      </div>
    </section>
  );
}

export interface UsageAndSpendProps {
  readonly trackHistory: boolean;
  readonly onTrackHistoryChange: (next: boolean) => void;
  /** The run budget from Settings → AI, so the screen can say whether it is well set. */
  readonly maxRunUsd: number;
  /** Jump to the AI section — the budget lives there, and this screen only reports on it. */
  readonly onOpenAiSettings: () => void;
}

export function UsageAndSpend({
  trackHistory,
  onTrackHistoryChange,
  maxRunUsd,
  onOpenAiSettings,
}: UsageAndSpendProps): JSX.Element {
  const [range, setRange] = useState<UsageRange>('30d');
  // Bumped to force a re-read after a write. The store is synchronous local storage, so
  // there is no loading state to design — the data is there on the first paint.
  const [nonce, setNonce] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const report = useMemo(() => readUsageReport(range), [range, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // A run finishing while the dialog is open updates the numbers underneath it.
  useEffect(() => onUsageHistoryChange(refresh), [refresh]);

  const { totals } = report;
  const perRun = usdPerMeteredRun(totals);
  const hasAnyHistory = report.firstDay !== undefined;
  const hasRowsInRange = totals.runs > 0;

  const clear = (): void => {
    clearUsageHistory();
    setConfirmingClear(false);
    refresh();
  };

  return (
    <div className="usage-panel">
      <div className="usage-head">
        <SegmentedControl
          label="Time range"
          value={range}
          options={RANGE_OPTIONS}
          onValueChange={(next) => setRange(next as UsageRange)}
        />
      </div>

      {!hasRowsInRange ? (
        <section className="usage-card usage-card--empty">
          {!hasAnyHistory ? (
            // First-run. Naming what will appear beats "Nothing here yet", and there is no
            // action button because the action is "use the AI", which happens elsewhere.
            <>
              <h4 className="usage-card-title">Nothing recorded yet</h4>
              <p className="usage-empty-note">
                {trackHistory
                  ? 'Ask the AI to make an edit and what it used shows up here — what you spent, which projects it went to, and which models did the work.'
                  : 'Usage history is off, so nothing is being recorded. Turn it on below to start seeing what your AI edits cost.'}
              </p>
            </>
          ) : (
            // Empty BY FILTER is a different screen from empty-by-default: the fix is to
            // widen the range, not to go and do some work.
            <>
              <h4 className="usage-card-title">{`No AI edits ${RANGE_PHRASE[range]}`}</h4>
              <p className="usage-empty-note">
                {`There is history from ${report.firstDay ?? ''} onward.`}
              </p>
              <Button variant="secondary" type="button" onClick={() => setRange('all')}>
                Show all time
              </Button>
            </>
          )}
        </section>
      ) : (
        <>
          <section className="usage-card usage-headline" aria-label="Summary">
            <p className="usage-sentence">
              <strong className="usage-figure">{money(totals.meteredUsd)}</strong>
              {` on AI across `}
              <strong>{`${String(totals.runs)} ${plural(totals.runs, 'edit', 'edits')}`}</strong>
              {` ${RANGE_PHRASE[range]}`}
              {perRun !== undefined ? (
                <>
                  {` — about `}
                  <strong>{money(perRun)}</strong>
                  {` each.`}
                </>
              ) : (
                '.'
              )}
            </p>

            {totals.subscriptionUsd > 0 ? (
              // Framed as what the plan saved, not as more spend. This is the line that
              // makes the subscription provider's value legible instead of invisible.
              <p className="usage-note usage-note--good">
                {`Another ${money(totals.subscriptionUsd)} of usage was covered by your Claude plan, so it never reached a bill.`}
              </p>
            ) : null}

            {/* Budget calibration — the one genuinely actionable reading on this screen.
                A budget nobody ever approaches is not protecting anything; one a typical
                edit brushes against will start cutting work short. */}
            {perRun !== undefined && maxRunUsd > 0 ? (
              <p className="usage-note">
                {perRun > maxRunUsd * 0.6
                  ? `A typical edit costs ${money(perRun)} against your ${money(maxRunUsd)} run budget — close enough that longer runs may be stopping early.`
                  : `Your run budget stops a run at ${money(maxRunUsd)}. A typical edit costs ${money(perRun)}, so most finish well inside it.`}
                {` `}
                <button type="button" className="usage-link" onClick={onOpenAiSettings}>
                  Adjust budget
                </button>
              </p>
            ) : null}

            {totals.unreportedRuns > 0 ? (
              // A missing reading is not a zero, and the total must admit which it is.
              <p className="usage-note usage-note--warn">
                {`${String(totals.unreportedRuns)} ${plural(totals.unreportedRuns, 'edit', 'edits')} ran on a provider that reported no usage, so ${plural(totals.unreportedRuns, 'it is', 'they are')} missing from these figures.`}
              </p>
            ) : null}

            <p className="usage-meta">
              {`${compactTokens(totals.tokens)} tokens · active on ${String(totals.activeDays)} ${plural(totals.activeDays, 'day', 'days')}`}
            </p>
          </section>

          <Breakdown
            title="Where it went"
            rows={report.byProject}
            emptyNote="No projects recorded in this range."
          />
          <Breakdown
            title="What did the work"
            rows={report.byModel}
            emptyNote="No models recorded in this range."
          />
          <DailySpend report={report} />
        </>
      )}

      <section className="usage-card" aria-label="History settings">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Keep usage history</span>
            <span className="setting-hint">
              {`Records what each AI edit used, on this machine only — nothing is sent anywhere. Kept for ${String(RETENTION_DAYS)} days, then discarded.`}
            </span>
          </div>
          <Switch
            checked={trackHistory}
            label="Keep usage history"
            onCheckedChange={onTrackHistoryChange}
            size="md"
          />
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Clear history</span>
            <span className="setting-hint">
              Forget every recorded edit. This cannot be undone, and it does not affect your
              projects.
            </span>
          </div>
          {/* Confirmation rather than undo: the data cannot be reconstructed once dropped,
              which is the one case the undo-over-confirm rule exempts. The button names
              what it destroys instead of saying "OK". */}
          {confirmingClear ? (
            <div className="usage-confirm">
              <Button variant="ghost" type="button" onClick={() => setConfirmingClear(false)}>
                Cancel
              </Button>
              <Button variant="danger" type="button" onClick={clear}>
                {hasAnyHistory ? 'Clear all history' : 'Clear'}
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              type="button"
              disabled={!hasAnyHistory}
              onClick={() => setConfirmingClear(true)}
            >
              Clear
            </Button>
          )}
        </div>
      </section>

      <p className="usage-disclaimer">
        Estimated from published list prices — a guide, not a receipt. Your provider&rsquo;s own
        billing is the real number.
      </p>
    </div>
  );
}
