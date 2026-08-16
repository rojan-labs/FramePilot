/**
 * Renderer tests (Phase 11 M4): one assertion per {@link ViewNode} kind — distinct
 * treatment, accessible roles/labels, status tones, and collapse behavior.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditResult, ToolNode } from '@framepilot/ai-sdk';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { EventNode } from './EventNode.js';

const fakeEdit = {
  text: 'Trim dead air',
  diff: { summary: ['Trimmed clip_a by 3.2s'] },
  validation: { valid: true, issues: [] },
  patch: { operations: [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 3.2 }] },
} as unknown as EditResult;

// A patch whose diff carries real before/after timelines (`toReviewCard` only sets
// `before`/`after` when both are present) — the case that gets a live preview toggle.
const beforeTimeline: Timeline = {
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'video_1',
          start: 0,
          end: 5,
          sourceStart: 0,
          sourceEnd: 5,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};
const afterTimeline: Timeline = {
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'video_1',
          start: 0,
          end: 3,
          sourceStart: 0,
          sourceEnd: 3,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};
const fakeEditWithDiff = {
  text: 'Trim dead air',
  diff: { summary: ['Trimmed clip_a by 2s'], before: beforeTimeline, after: afterTimeline },
  validation: { valid: true, issues: [] },
  patch: { operations: [{ type: 'trim_clip', clipId: 'c1', start: 0, end: 3 }] },
} as unknown as EditResult;

// A project the preview popup can re-assemble subset patches against (its timeline
// contains the clip the fixture edits, so `assembleEdit` validates cleanly).
const fakeProject = {
  timeline: beforeTimeline,
  assets: [],
  folders: [],
  fps: 30,
  settings: { width: 1920, height: 1080, fps: 30 },
} as unknown as Project;

describe('EventNode', () => {
  it('renders a user bubble', () => {
    render(<EventNode node={{ kind: 'user', id: 'u', ts: 0, turnId: 't', text: 'Trim it' }} />);
    expect(screen.getByText('Trim it')).toBeTruthy();
  });

  it('defers Markdown parsing until a streamed assistant message settles', () => {
    const { container } = render(
      <EventNode
        node={{ kind: 'assistant', id: 'a', ts: 0, turnId: 't', text: '**Done**', streaming: true }}
      />,
    );
    expect(screen.getByText('**Done**').className).toBe('ai-streaming-text');
    expect(container.querySelector('.ai-caret')).toBeTruthy();

    const settled = render(
      <EventNode
        node={{ kind: 'assistant', id: 'b', ts: 0, turnId: 't', text: '**Done**', streaming: false }}
      />,
    );
    expect(within(settled.container).getByText('Done').tagName).toBe('STRONG');
  });

  it('reasoning auto-expands while thinking and shows its streamed summary (#2)', () => {
    render(
      <EventNode
        node={{
          kind: 'reasoning',
          id: 'r',
          ts: 0,
          turnId: 't',
          summaries: ['Analyzing timeline'],
          done: false,
        }}
      />,
    );
    const toggle = screen.getByRole('button', { name: /thinking/i });
    // While the model is still thinking the panel is open so its live rationale shows.
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Analyzing timeline')).toBeTruthy();
    // It can be collapsed by clicking.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('reasoning collapses to a static heading once done', () => {
    const { container } = render(
      <EventNode
        node={{
          kind: 'reasoning',
          id: 'r',
          ts: 0,
          turnId: 't',
          summaries: ['Analyzed timeline'],
          done: true,
        }}
      />,
    );
    const toggle = screen.getByRole('button', { name: /reasoning/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed content stays mounted (so the accordion can animate open/closed)
    // but is hidden from assistive tech and layout via the accordion wrapper.
    const accordion = container.querySelector('.ai-accordion');
    expect(accordion?.getAttribute('data-open')).toBe('false');
    expect(accordion?.getAttribute('aria-hidden')).toBe('true');
  });

  it('settled reasoning shows "Thought for Ns" from the real elapsed time (U3)', () => {
    render(
      <EventNode
        node={{
          kind: 'reasoning',
          id: 'r',
          ts: 0,
          turnId: 't',
          summaries: ['Analyzed timeline'],
          done: true,
          thoughtMs: 2600,
        }}
      />,
    );
    expect(screen.getByRole('button', { name: /thought for 3s/i })).toBeTruthy();
  });

  it("keeps each step's reasoning immediately before its own tool activity", () => {
    const { container } = render(
      <>
        <EventNode
          node={{
            kind: 'reasoning',
            id: 'turn:reasoning:1',
            ts: 0,
            turnId: 'turn',
            summaries: ['Reading the timeline'],
            done: true,
            thoughtMs: 400,
          }}
        />
        <EventNode
          node={{
            kind: 'tool',
            id: 'tool:1',
            ts: 1,
            turnId: 'turn',
            toolName: 'find_silence',
            status: 'completed',
          }}
        />
        <EventNode
          node={{
            kind: 'reasoning',
            id: 'turn:reasoning:2',
            ts: 2,
            turnId: 'turn',
            summaries: ['Checking the cut'],
            done: true,
            thoughtMs: 800,
          }}
        />
        <EventNode
          node={{
            kind: 'tool',
            id: 'tool:2',
            ts: 3,
            turnId: 'turn',
            toolName: 'detect_scenes',
            status: 'completed',
          }}
        />
      </>,
    );

    expect(
      Array.from(container.querySelectorAll('.ai-event--reasoning, .ai-event--tool')).map(
        (event) => event.className,
      ),
    ).toEqual([
      'ai-event ai-event--reasoning',
      'ai-event ai-event--tool',
      'ai-event ai-event--reasoning',
      'ai-event ai-event--tool',
    ]);
  });

  it('settled reasoning with no captured thinking renders nothing at all', () => {
    // It used to render "Thought for <1s" from the duration alone. That row was a dead
    // end — a claim that the model showed its work, with nothing behind the chevron —
    // and a whole run of them is exactly what a provider that was never ASKED for
    // reasoning produces. The duration is model latency, not thinking; without thinking
    // there is no row.
    const { container } = render(
      <EventNode
        node={{
          kind: 'reasoning',
          id: 'r',
          ts: 0,
          turnId: 't',
          summaries: [],
          done: true,
          thoughtMs: 400,
        }}
      />,
    );
    expect(container.querySelector('.ai-event--reasoning')).toBeNull();
  });

  it('settled empty reasoning with no measured duration renders nothing', () => {
    const { container } = render(
      <EventNode
        node={{ kind: 'reasoning', id: 'r', ts: 0, turnId: 't', summaries: [], done: true }}
      />,
    );
    expect(container.querySelector('.ai-event--reasoning')).toBeNull();
  });

  it('settled reasoning WITH thinking is expandable, and shows what was thought', () => {
    const { container } = render(
      <EventNode
        node={{
          kind: 'reasoning',
          id: 'r',
          ts: 0,
          turnId: 't',
          summaries: ['The intro drags — cut to the first beat.'],
          done: true,
          thoughtMs: 6000,
        }}
      />,
    );
    const toggle = screen.getByRole('button', { name: /Thought for 6s/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.ai-accordion')?.getAttribute('data-open')).toBe('true');
    expect(screen.getByText('The intro drags — cut to the first beat.')).toBeTruthy();
  });

  it('a live reasoning node is open, so streamed thinking is readable as it arrives', () => {
    render(
      <EventNode
        node={{
          kind: 'reasoning',
          id: 'r',
          ts: 0,
          turnId: 't',
          summaries: ['Weighing the'],
          done: false,
        }}
      />,
    );
    expect(screen.getByRole('button', { name: /Thinking/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByText('Weighing the')).toBeTruthy();
  });

  it('renders a plan checklist with per-step status', () => {
    render(
      <EventNode
        node={{
          kind: 'plan',
          id: 'p',
          ts: 0,
          turnId: 't',
          steps: [
            { id: 's1', label: 'Trim', status: 'completed' },
            { id: 's2', label: 'Caption', status: 'running' },
          ],
        }}
      />,
    );
    expect(screen.getByText('Trim')).toBeTruthy();
    expect(screen.getByText('Caption')).toBeTruthy();
  });

  it('tool card shows a status icon + runtime + summary and opens full details on demand (#9,#10)', () => {
    render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'find_silence',
          status: 'completed',
          runtimeMs: 42,
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: 'found 3 gaps',
          },
        }}
      />,
    );
    // Status is an ICON labelled by its tooltip (#10), not a text badge.
    expect(screen.queryByText('completed')).toBeNull();
    expect(screen.getByLabelText('Completed')).toBeTruthy();
    // Runtime reads in editor-friendly language, never raw milliseconds (#2).
    expect(screen.queryByText('42ms')).toBeNull();
    expect(screen.getByText('instant')).toBeTruthy();
    // The collapsed row is a single status line — the short summary is NOT duplicated
    // inline; it lives in the details modal, opened on demand (#9, #1).
    expect(screen.queryByText('found 3 gaps')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('found 3 gaps')).toBeTruthy();
  });

  it('tool card hides the raw args line and ticks live elapsed while running (U4, #2)', () => {
    vi.useFakeTimers();
    try {
      const startTs = Date.now();
      render(
        <EventNode
          node={{
            kind: 'tool',
            id: 'c1',
            ts: startTs,
            turnId: 't',
            toolName: 'detect_beats',
            status: 'running',
            argsSummary: 'assetId: "music_1"',
          }}
        />,
      );
      // The raw id/param args line is debugger noise for a video editor — not rendered.
      expect(screen.queryByText('assetId: "music_1"')).toBeNull();
      // After ~3s of wall clock the card shows a live "3s" elapsed readout.
      act(() => {
        vi.advanceTimersByTime(3200);
      });
      expect(screen.getByText('3s')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tool row: collapsed is a single status line; expanding reveals the actual tool output', () => {
    render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'find_silence',
          status: 'completed',
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: 'found 3 gaps',
            // The real, untruncated output — distinct from the one-line summary.
            result: { gaps: [{ start: 1.2, end: 1.8 }] },
          },
        }}
      />,
    );
    const toggle = screen.getByRole('button', { name: /find silence/i });
    // Collapsed: just the header. Neither the short summary nor the raw output clutters
    // the row until it's opened (#1).
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('found 3 gaps')).toBeNull();
    expect(screen.queryByText(/"gaps"/)).toBeNull();
    // Expanding reveals the tool's ACTUAL output (`result.result`), NOT the summary.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('found 3 gaps')).toBeNull();
    const output = screen.getByText(/"gaps"/);
    expect(output.textContent).toContain('"start": 1.2');
  });

  it('folds a large tool output behind one measured line and caps it when opened', () => {
    // A step that returns the project document (or an engine error echoing it) used to
    // render every one of its thousands of lines into the run thread, burying the rest of
    // the run. It now reports its size and stays shut until asked.
    const peaks = Array.from({ length: 4000 }, (_, i) => i / 4000);
    render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'describe_footage',
          status: 'completed',
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: 'walked the footage',
            result: { assetId: 'a1', peaks },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /describe footage/i }));
    // The fold is shut, and its label says what opening it would cost.
    const fold = screen.getByRole('button', { name: /Output ·/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).toMatch(/4,00\d lines/);
    expect(fold.textContent).toMatch(/Show all/);
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    // Opened, it is still bounded — with the remainder accounted for, not dropped.
    const body = screen.getByText(/"assetId": "a1"/);
    expect(body.textContent).toMatch(/more lines — Copy for the full output/);
    expect(body.textContent!.split('\n').length).toBeLessThan(220);
  });

  it('does not serialize a tool payload until the clipboard actually asks for it', async () => {
    // A collapsed row used to build its whole copy-text — including `JSON.stringify` of
    // the payload — on every render. During a live run that is once per streamed frame
    // batch, per row, over results that reach megabytes on a real project: pure garbage,
    // and the sidebar's share of the heap pressure a long run builds up.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let reads = 0;
    const payload = {
      get peaks(): number[] {
        reads += 1;
        return [0.1, 0.2];
      },
    };
    const { rerender } = render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'describe_footage',
          status: 'completed',
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: 'walked the footage',
            result: payload,
          },
        }}
      />,
    );
    rerender(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 1,
          turnId: 't',
          toolName: 'describe_footage',
          status: 'completed',
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: 'walked the footage',
            result: payload,
          },
        }}
      />,
    );
    // Collapsed and never copied → the payload was never walked.
    expect(reads).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(reads).toBeGreaterThan(0);
    expect(writeText.mock.calls[0]?.[0]).toContain('"peaks"');
  });

  it('keeps a short tool output inline rather than behind a second click', () => {
    render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'detect_beats',
          status: 'completed',
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: 'found the beat',
            result: { bpm: 120 },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /detect beats/i }));
    expect(screen.queryByRole('button', { name: /Output ·/ })).toBeNull();
    expect(screen.getByText(/"bpm": 120/)).toBeTruthy();
  });

  it('tool row falls back to the full summary when there is no structured output', () => {
    const longSummary =
      'Scanned the whole timeline and found three long silent gaps between the takes, ' +
      'the longest just over two seconds around the one-minute mark.';
    render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'find_silence',
          status: 'completed',
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: longSummary,
          },
        }}
      />,
    );
    // A summary too long for one line is expandable even without structured output, and
    // expanding shows it in full (no clamp).
    const toggle = screen.getByRole('button', { name: /find silence/i });
    expect(screen.queryByText(longSummary)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(longSummary)).toBeTruthy();
  });

  it('the details popup shows the plain-language recap AND the tool’s actual output', () => {
    const longJson = { tracks: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}` })) };
    render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'get_timeline',
          status: 'completed',
          result: {
            id: 'res',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            summary: 'Reading the timeline',
            result: longJson,
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    const dialog = screen.getByRole('dialog');
    // The popup leads with the plain-language recap ("what happened") …
    expect(within(dialog).getByText('Reading the timeline')).toBeTruthy();
    // … and also surfaces the tool's ACTUAL output below it, so the modal reflects what
    // really came back rather than only the friendly label.
    expect(dialog.textContent).toContain('"t29"');
  });

  it('reasoning renders nothing when a finished turn produced no rationale', () => {
    const { container } = render(
      <EventNode
        node={{ kind: 'reasoning', id: 'r', ts: 0, turnId: 't', summaries: [], done: true }}
      />,
    );
    expect(container.querySelector('.ai-event--reasoning')).toBeNull();
  });

  it('timeline action renders refs as clickable chips', () => {
    const onReveal = vi.fn();
    render(
      <EventNode
        onReveal={onReveal}
        node={{
          kind: 'timeline_action',
          id: 'ta',
          ts: 0,
          turnId: 't',
          action: 'Deleted range',
          detail: '0s–3.2s',
          refs: [{ kind: 'track', id: 'video_1', label: 'video_1' }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'video_1' }));
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ id: 'video_1' }));
  });

  it('diff card surfaces the reason, op count, and per-op action cards', () => {
    render(<EventNode node={{ kind: 'diff', id: 'd', ts: 0, turnId: 't', edit: fakeEdit }} />);
    expect(screen.getByText('Trim dead air')).toBeTruthy();
    expect(screen.getByText('1 change')).toBeTruthy();
    // Derived from the patch op via describeOperation.
    expect(screen.getByText('Deleted range')).toBeTruthy();
    expect(screen.getByText('0s–3.2s')).toBeTruthy();
  });

  it('tool card uses the registry label/icon and surfaces affected clips as chips', () => {
    const onReveal = vi.fn();
    render(
      <EventNode
        onReveal={onReveal}
        node={{
          kind: 'tool',
          id: 'c1',
          ts: 0,
          turnId: 't',
          toolName: 'find_silence',
          status: 'completed',
          result: {
            id: 'r',
            conversationId: 'c',
            ts: 0,
            turnId: 't',
            type: 'tool_result',
            toolCallId: 'c1',
            clips: ['clip_a'],
          },
        }}
      />,
    );
    // Unknown-to-the-map tool name → humanized label.
    expect(screen.getByText('Find silence')).toBeTruthy();
    // Affected clips live in the details modal, reachable via View details.
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    fireEvent.click(screen.getByRole('button', { name: 'clip_a' }));
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'clip', id: 'clip_a' }));
  });

  it('renders an unavailable tool as visibly gated (Coming soon)', () => {
    render(
      <EventNode
        node={{
          kind: 'tool',
          id: 'g',
          ts: 0,
          turnId: 't',
          toolName: 'detect_faces',
          status: 'running',
        }}
      />,
    );
    expect(screen.getByText('Detect faces')).toBeTruthy();
    // Gated tools read "Coming soon" via the status-icon tooltip label, not a badge.
    expect(screen.getByLabelText('Coming soon')).toBeTruthy();
  });

  // The card is a RECEIPT now, not a decision. Accept/Reject, the batch apply and the
  // keep-a-subset surface are gone with the manual path: edits apply as they land and Undo
  // is how they are taken back. These tests replace the decision-flow suite deliberately —
  // see plan/INSTANT-APPLY.md.
  it('diff card is a past-tense receipt with no decision to make', () => {
    render(<EventNode node={{ kind: 'diff', id: 'd9', ts: 0, turnId: 't', edit: fakeEdit }} />);
    const toggle = screen.getByRole('button', { name: /edited/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('says so plainly when an edit could not be applied', () => {
    render(
      <EventNode
        node={{ kind: 'diff', id: 'd2', ts: 0, turnId: 't', edit: fakeEdit }}
        applyFailed
      />,
    );
    expect(screen.getByText('Couldn’t apply this edit')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/timeline changed/i);
    // A failed edit offers no jump/preview: there is nothing on the timeline to look at.
    expect(screen.queryByRole('button', { name: 'Jump to timeline' })).toBeNull();
  });

  it('offers a live "Show preview" only when a project is available to preview against', () => {
    const { rerender } = render(
      <EventNode
        node={{ kind: 'diff', id: 'd10', ts: 0, turnId: 't', edit: fakeEdit }}
      />,
    );
    // No project → the preview popup can't re-assemble a before/after, so the live
    // affordance is gated (a disabled "Preview"), never an active "Show preview".
    expect(screen.queryByRole('button', { name: 'Show preview' })).toBeNull();
    rerender(
      <EventNode
        node={{ kind: 'diff', id: 'd10', ts: 0, turnId: 't', edit: fakeEdit }}
        project={fakeProject}
      />,
    );
    expect(screen.getByRole('button', { name: 'Show preview' })).toBeTruthy();
  });

  it('opens the before/after preview in a popup (product ask #3)', () => {
    render(
      <EventNode
        node={{ kind: 'diff', id: 'd11', ts: 0, turnId: 't', edit: fakeEditWithDiff }}
        project={fakeProject}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    const dialog = screen.getByRole('dialog', { name: 'Review changes' });
    expect(dialog).toBeTruthy();
    // The real before/after review player mounted inside the popup (defaults to "after").
    expect(within(dialog).getByText('After')).toBeTruthy();
  });

  it('the preview popup is read-only: it inspects an applied edit, it does not decide one', () => {
    render(
      <EventNode
        node={{ kind: 'diff', id: 'd12', ts: 0, turnId: 't', edit: fakeEditWithDiff }}
        project={fakeProject}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /Apply/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Reject all' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Remove this change' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Keep this change' })).toBeNull();
    // It says what is true of the edit — it is already on the timeline.
    expect(within(dialog).getByText(/use Undo to revert/i)).toBeTruthy();
  });

  it('clicking a change chip opens the before/after popup for that change', () => {
    render(
      <EventNode
        node={{ kind: 'diff', id: 'd14', ts: 0, turnId: 't', edit: fakeEditWithDiff }}
        project={fakeProject}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edited/i }));
    fireEvent.click(screen.getByRole('button', { name: 'c1' }));
    const dialog = screen.getByRole('dialog', { name: 'Review changes' });
    expect(within(dialog).getByText('Before / after')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Apply/ })).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Variations / A-B compare (H1.5, AGENT-NATIVE-COMPLETION-PLAN.md P13.1)
  // ---------------------------------------------------------------------------
  const variantB = {
    text: 'Trim more aggressively',
    diff: { summary: ['Trimmed clip_a by 4s'] },
    validation: { valid: true, issues: [] },
    patch: { operations: [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 4 }] },
  } as unknown as EditResult;

  it('a single-candidate diff never shows a variation switcher', () => {
    render(
      <EventNode
        node={{ kind: 'diff', id: 'd20', ts: 0, turnId: 't', edit: fakeEdit, variants: [fakeEdit] }}
      />,
    );
    expect(screen.queryByRole('tablist', { name: /alternative takes/i })).toBeNull();
  });

  it('a multi-candidate diff shows Take A/B tabs and re-points the same card on switch', () => {
    render(
      <EventNode
        node={{
          kind: 'diff',
          id: 'd21',
          ts: 0,
          turnId: 't',
          edit: fakeEdit,
          variants: [fakeEdit, variantB],
        }}
      />,
    );
    expect(screen.getByText('Trim dead air')).toBeTruthy();
    expect(screen.queryByText('Trim more aggressively')).toBeNull();
    const takeB = screen.getByRole('tab', { name: 'Take B' });
    fireEvent.click(takeB);
    // Same card re-points at the newly selected candidate — not a second card.
    expect(screen.getByText('Trim more aggressively')).toBeTruthy();
    expect(screen.queryByText('Trim dead air')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  // `DiffEvent.variants` guarantees `edit` mirrors `variants[0]`, so Take A is what landed.
  // The tabs preview the alternatives and must not imply a choice that no longer exists.
  it('names the take that actually landed and offers no way to "pick" another', () => {
    render(
      <EventNode
        node={{
          kind: 'diff',
          id: 'd22',
          ts: 0,
          turnId: 't',
          edit: fakeEdit,
          variants: [fakeEdit, variantB],
        }}
      />,
    );
    expect(screen.getByRole('tab', { name: /Take A · applied/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    // Switching still previews the alternative — inspection, not selection.
    fireEvent.click(screen.getByRole('tab', { name: 'Take B' }));
    expect(screen.getByText('Trim more aggressively')).toBeTruthy();
  });

  it('progress renders an indeterminate, label-only bar — no percentage (#5)', () => {
    render(
      <EventNode
        node={{ kind: 'progress', id: 'pr', ts: 0, turnId: 't', label: 'Rendering', value: 0.5 }}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Rendering' });
    // No numeric value is claimed — AI work has no measurable percentage.
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(screen.getByText('Rendering')).toBeTruthy();
    expect(screen.queryByText('50%')).toBeNull();
  });

  it('a settled progress (value >= 1) renders nothing, not a fake "Done 100%" (#5)', () => {
    const { container } = render(
      <EventNode
        node={{ kind: 'progress', id: 'pr', ts: 0, turnId: 't', label: 'Done', value: 1 }}
      />,
    );
    expect(container.querySelector('.ai-event--progress')).toBeNull();
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('reference node renders chips', () => {
    render(
      <EventNode
        node={{
          kind: 'reference',
          id: 'rf',
          ts: 0,
          turnId: 't',
          refs: [{ kind: 'file', id: 'a.mp4', label: 'a.mp4' }],
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'a.mp4' })).toBeTruthy();
  });

  it('notice renders error styling and hides its detail behind Show details (D1)', () => {
    const { container } = render(
      <EventNode
        node={{
          kind: 'notice',
          id: 'n',
          ts: 0,
          turnId: 't',
          level: 'error',
          text: 'Render failed',
          detail: 'ffmpeg exit 1',
        }}
      />,
    );
    expect(within(container).getByText('Render failed')).toBeTruthy();
    expect(container.querySelector('[data-level="error"]')).toBeTruthy();
    // Progressive disclosure: the raw detail is a debugger dump, so it stays
    // collapsed until the reviewer explicitly asks for it.
    expect(screen.queryByText('ffmpeg exit 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText('ffmpeg exit 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByText('ffmpeg exit 1')).toBeNull();
  });

  it('notice with no detail and not retryable renders no action row (D1)', () => {
    render(
      <EventNode
        node={{
          kind: 'notice',
          id: 'n',
          ts: 0,
          turnId: 't',
          level: 'info',
          text: 'Steering applied: focus on the outro',
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Show details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows an inline Retry for a retryable error and calls the SAME retry callback the sidebar passes down (D1)', () => {
    const onRetryNotice = vi.fn();
    render(
      <EventNode
        node={{
          kind: 'notice',
          id: 'n',
          ts: 0,
          turnId: 't',
          level: 'error',
          text: 'The run failed.',
          retryable: true,
        }}
        onRetryNotice={onRetryNotice}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryNotice).toHaveBeenCalledTimes(1);
  });

  it('never shows Retry for a non-retryable error, even with a retry callback wired', () => {
    render(
      <EventNode
        node={{ kind: 'notice', id: 'n', ts: 0, turnId: 't', level: 'error', text: 'Oops.' }}
        onRetryNotice={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('disables the inline Retry while a run is already in flight (D1)', () => {
    render(
      <EventNode
        node={{
          kind: 'notice',
          id: 'n',
          ts: 0,
          turnId: 't',
          level: 'error',
          text: 'The run failed.',
          retryable: true,
        }}
        onRetryNotice={vi.fn()}
        retryDisabled
      />,
    );
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('copies the raw detail text via Copy details (D1)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(
      <EventNode
        node={{
          kind: 'notice',
          id: 'n',
          ts: 0,
          turnId: 't',
          level: 'error',
          text: 'Render failed',
          detail: 'ffmpeg exit 1',
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    });
    expect(writeText).toHaveBeenCalledWith('ffmpeg exit 1');
  });
});

describe("EventNode — the model's question (P12)", () => {
  const askNode = (options?: readonly { label: string; description?: string }[]) =>
    ({
      kind: 'tool' as const,
      id: 'ask1',
      ts: 0,
      turnId: 't',
      toolName: 'ask_user',
      status: 'running' as const,
      ask: {
        id: 'e',
        conversationId: 'c',
        ts: 0,
        turnId: 't',
        type: 'ask' as const,
        toolCallId: 'ask1',
        question: 'This footage has no faces to track. What would you like instead?',
        ...(options ? { options } : {}),
      },
    }) satisfies ToolNode;

  it('renders the model’s own question and options verbatim', () => {
    // The wording is the model's, not ours — that is what lets a question nobody
    // anticipated render as well as one we designed for.
    render(
      <EventNode
        node={askNode([
          { label: 'Punch in on the centre', description: 'A slow 110% push on each still.' },
          { label: 'Leave the framing alone' },
        ])}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText(/no faces to track/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Punch in on the centre/ })).toBeTruthy();
    expect(screen.getByText('A slow 110% push on each still.')).toBeTruthy();
  });

  it('sends the chosen option back addressed to the call that asked', () => {
    const onAnswer = vi.fn();
    render(<EventNode node={askNode([{ label: 'Yes' }, { label: 'No' }])} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onAnswer).toHaveBeenCalledWith({ toolCallId: 'ask1', kind: 'answered', answer: 'Yes' });
  });

  it('always allows a free-text answer — the model can only guess at the options', () => {
    const onAnswer = vi.fn();
    render(<EventNode node={askNode([{ label: 'Yes' }, { label: 'No' }])} onAnswer={onAnswer} />);
    const input = screen.getByLabelText('Your answer');
    fireEvent.change(input, { target: { value: 'Actually, cut it to 15s' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledWith({
      toolCallId: 'ask1',
      kind: 'answered',
      answer: 'Actually, cut it to 15s',
    });
  });

  it('never sends an empty answer', () => {
    const onAnswer = vi.fn();
    render(<EventNode node={askNode()} onAnswer={onAnswer} />);
    const input = screen.getByLabelText('Your answer');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('dismissing is a stop, not an answer', () => {
    const onAnswer = vi.fn();
    render(<EventNode node={askNode()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss and stop/ }));
    expect(onAnswer).toHaveBeenCalledWith({ toolCallId: 'ask1', kind: 'cancelled' });
  });

  it('stops offering the prompt once the question is answered', () => {
    // The exchange is over: the answer is the call's result, and a live prompt would
    // invite answering a question that is no longer being asked.
    render(<EventNode node={{ ...askNode(), status: 'completed' }} onAnswer={() => {}} />);
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });
});
