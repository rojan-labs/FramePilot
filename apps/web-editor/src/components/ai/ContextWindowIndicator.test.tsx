/**
 * The context meter (ADR 0080). The behaviour under test is not "does it render a
 * number" but "does it stop a shrinking prompt from reading as lost memory".
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ContextManifest } from '@framepilot/ai-sdk';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import {
  ContextWindowIndicator,
  type ContextWindowState,
  contextPhase,
  latestContextWindow,
} from './ContextWindowIndicator.js';

function manifest(overrides: Partial<ContextManifest> = {}): ContextManifest {
  return {
    requestId: 'req_1',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    sections: [
      { id: 's1', type: 'system', label: 'system contract', tokenEstimate: 1_200, included: true },
      {
        id: 's2',
        type: 'retrieved_evidence',
        label: 'transcript slice',
        tokenEstimate: 5_000,
        included: false,
        omittedReason: 'trimmed to fit the model context budget',
      },
    ],
    usage: {
      modelContextLimit: 1_000_000,
      limitAssumed: false,
      estimatedInputTokensBeforeSend: 17_000,
      reservedOutputTokens: 128_000,
      estimatedRemainingCapacity: 855_000,
      calculationSource: 'local_estimate',
    },
    compaction: { occurred: false, removedTokenEstimate: 0, removedSections: [] },
    ...overrides,
  };
}

const state: ContextWindowState = {
  usedTokens: 17_000,
  contextWindow: 1_000_000,
  estimated: true,
  limitAssumed: false,
  manifest: manifest(),
};

/**
 * The shape of the captured `openrouter/auto` run: no such model in the capability table,
 * so the window is the OpenRouter floor and every figure downstream is a guess.
 */
const assumedState: ContextWindowState = {
  usedTokens: 40_000,
  contextWindow: 128_000,
  estimated: true,
  limitAssumed: true,
  manifest: manifest({
    provider: 'openrouter',
    model: 'openrouter/auto',
    usage: { ...manifest().usage, modelContextLimit: 128_000, limitAssumed: true },
  }),
};

function hover(value: ContextWindowState = state): HTMLElement {
  const { container } = render(<ContextWindowIndicator value={value} />);
  const root = container.querySelector('.ai-context') as HTMLElement;
  fireEvent.mouseEnter(root);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  return root;
}

describe('ContextWindowIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing on the surface but used over capacity', () => {
    render(<ContextWindowIndicator value={state} />);
    expect(screen.getByRole('button').textContent).toBe('17K/1M');
    // No percentage, no ring, no third rendering of the same fact.
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/remaining/)).toBeNull();
  });

  it('keeps the exact figures in the accessible name, where sight cannot reach', () => {
    render(<ContextWindowIndicator value={state} />);
    expect(screen.getByRole('button', { name: /17K of 1M tokens, estimated/ })).toBeTruthy();
  });

  it('stays quiet until hovered, and explains the figure when it is', () => {
    const root = hover();
    expect(screen.getByRole('tooltip')).toBeTruthy();
    expect(screen.getByText('17K of 1M tokens, estimated')).toBeTruthy();
    fireEvent.mouseLeave(root);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus too, so the explanation is not mouse-only', () => {
    render(<ContextWindowIndicator value={state} />);
    const trigger = screen.getByRole('button');
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    expect(trigger.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip').getAttribute('id'),
    );
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Escape, for a tooltip the pointer is parked on', () => {
    hover();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes when a tap-opened tooltip is dismissed by an outside pointer', () => {
    render(<ContextWindowIndicator value={state} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('says what room is left and what is held back for the reply', () => {
    hover();
    expect(screen.getByText('855K still available · 128K reserved for the reply')).toBeTruthy();
  });

  it('labels a provider-settled figure as reported, not estimated', () => {
    hover({
      ...state,
      estimated: false,
      manifest: manifest({
        usage: { ...manifest().usage, calculationSource: 'provider_reported' },
      }),
    });
    expect(screen.getByText(/17K of 1M tokens, reported/)).toBeTruthy();
  });

  it('explains a drop caused by compaction in this request', () => {
    hover({
      ...state,
      manifest: manifest({
        compaction: {
          occurred: true,
          removedTokenEstimate: 5_000,
          removedSections: ['transcript slice'],
        },
      }),
    });
    expect(screen.getByText(/summarized in this request \(−5K tokens\)/)).toBeTruthy();
  });

  it('dates a compaction from an earlier request', () => {
    hover({ ...state, requestsSinceCompaction: 1 });
    expect(screen.getByText(/summarized 1 request ago/)).toBeTruthy();
  });

  it('pluralizes the compaction distance', () => {
    hover({ ...state, requestsSinceCompaction: 3 });
    expect(screen.getByText(/summarized 3 requests ago/)).toBeTruthy();
  });

  it('stays silent about compaction that never happened', () => {
    hover();
    expect(screen.queryByText(/summarized/)).toBeNull();
  });

  it('carries the reassurance that the memory outlives the request', () => {
    hover();
    expect(screen.getByText(/your project memory and committed decisions stay saved/)).toBeTruthy();
  });

  it('marks the in-flight phases without animating the composer', () => {
    const { rerender } = render(<ContextWindowIndicator value={state} phase="assembling" />);
    expect(screen.getByRole('button', { name: /^Preparing context\./ })).toBeTruthy();
    expect(screen.getByRole('button').getAttribute('data-phase')).toBe('assembling');
    rerender(<ContextWindowIndicator value={state} phase="generating" />);
    expect(screen.getByRole('button', { name: /^Generating\./ })).toBeTruthy();
    rerender(<ContextWindowIndicator value={state} phase="idle" />);
    expect(screen.getByRole('button', { name: /^Context: 17K of 1M/ })).toBeTruthy();
  });

  it('renders an empty state without inventing a capacity', () => {
    hover({ usedTokens: 0, contextWindow: 0, estimated: true, limitAssumed: false });
    expect(screen.getByRole('button').textContent).toBe('—');
    expect(screen.getByText('No request accounted for yet')).toBeTruthy();
  });

  it('qualifies an assumed capacity everywhere the figure is read', () => {
    hover(assumedState);
    expect(screen.getByText(/40K of 128K tokens \(assumed\), estimated/)).toBeTruthy();
    expect(screen.getByRole('button').getAttribute('data-limit-assumed')).toBe('true');
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('capacity assumed');
    expect(
      screen.getByText(/"openrouter\/auto" is not a model this app knows/),
    ).toBeTruthy();
    expect(screen.getByText(/Pin a specific model in Settings → AI/)).toBeTruthy();
  });

  it('says nothing about assumption when the model window is a known fact', () => {
    hover();
    expect(screen.queryByText(/\(assumed\)/)).toBeNull();
    expect(screen.queryByText(/is not a model this app knows/)).toBeNull();
    expect(screen.getByRole('button').getAttribute('data-limit-assumed')).toBe('false');
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain(
      'capacity assumed',
    );
  });

  it('does not claim an assumption before any request has been accounted for', () => {
    hover({ usedTokens: 0, contextWindow: 0, estimated: true, limitAssumed: false });
    expect(screen.getByRole('button').getAttribute('data-limit-assumed')).toBe('false');
    expect(screen.queryByText(/is not a model this app knows/)).toBeNull();
  });

  it('shows the dev inspector only when the parent passes one', () => {
    const { container } = render(
      <ContextWindowIndicator value={state} debug={{ conversationId: 'c1', latest: manifest() }} />,
    );
    fireEvent.mouseEnter(container.querySelector('.ai-context') as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Context inspector · dev')).toBeTruthy();
  });
});

const emit = createTurnEmitter({ conversationId: 'c1', turnId: 't1' });

describe('latestContextWindow', () => {
  it('takes the latest call, never a cumulative total', () => {
    const events: AiEvent[] = [
      emit.contextUsage({ usedTokens: 60_000, contextWindow: 200_000, estimated: true }),
      emit.contextUsage({ usedTokens: 12_000, contextWindow: 200_000, estimated: false }),
    ];
    expect(latestContextWindow(events)).toMatchObject({ usedTokens: 12_000, estimated: false });
  });

  it("keeps the latest turn's primary request stable across internal model calls", () => {
    const firstTurn = createTurnEmitter({ conversationId: 'c1', turnId: 'turn-1' });
    const secondTurn = createTurnEmitter({ conversationId: 'c1', turnId: 'turn-2' });
    const withRequest = (requestId: string): ContextManifest => manifest({ requestId });
    const events: AiEvent[] = [
      firstTurn.contextUsage({
        usedTokens: 40_000,
        contextWindow: 200_000,
        estimated: false,
        manifest: withRequest('turn-1:seg-1'),
      }),
      secondTurn.contextUsage({
        usedTokens: 500,
        contextWindow: 200_000,
        estimated: true,
        manifest: withRequest('classify'),
      }),
      secondTurn.contextUsage({
        usedTokens: 52_000,
        contextWindow: 200_000,
        estimated: true,
        manifest: withRequest('turn-2:seg-1'),
      }),
      secondTurn.contextUsage({
        usedTokens: 53_000,
        contextWindow: 200_000,
        estimated: false,
        manifest: withRequest('turn-2:seg-1'),
      }),
      secondTurn.contextUsage({
        usedTokens: 9_000,
        contextWindow: 200_000,
        estimated: true,
        manifest: withRequest('turn-2:repair'),
      }),
    ];
    expect(latestContextWindow(events)).toMatchObject({
      usedTokens: 53_000,
      estimated: false,
      manifest: { requestId: 'turn-2:seg-1' },
    });
  });

  it('does not replace the last stable value with a classifier-only in-flight turn', () => {
    const previous = createTurnEmitter({ conversationId: 'c1', turnId: 'turn-1' });
    const current = createTurnEmitter({ conversationId: 'c1', turnId: 'turn-2' });
    const events: AiEvent[] = [
      previous.contextUsage({
        usedTokens: 40_000,
        contextWindow: 200_000,
        estimated: false,
        manifest: manifest({ requestId: 'turn-1:seg-1' }),
      }),
      current.contextUsage({
        usedTokens: 500,
        contextWindow: 200_000,
        estimated: true,
        manifest: manifest({ requestId: 'classify' }),
      }),
    ];
    expect(latestContextWindow(events).usedTokens).toBe(40_000);
  });

  it('returns an honest empty state with no events', () => {
    expect(latestContextWindow(undefined)).toEqual({
      usedTokens: 0,
      contextWindow: 0,
      estimated: true,
      limitAssumed: false,
    });
    expect(latestContextWindow([])).toMatchObject({ contextWindow: 0 });
  });

  it('carries the manifest\u2019s assumed-limit flag through to the meter', () => {
    const assumed = manifest({
      provider: 'openrouter',
      model: 'openrouter/auto',
      usage: { ...manifest().usage, modelContextLimit: 128_000, limitAssumed: true },
    });
    const events = [
      emit.contextUsage({
        usedTokens: 40_000,
        contextWindow: 128_000,
        estimated: true,
        manifest: assumed,
      }),
    ];
    expect(latestContextWindow(events).limitAssumed).toBe(true);
  });

  it('clamps a used figure that exceeds the window', () => {
    const events = [
      emit.contextUsage({ usedTokens: 500_000, contextWindow: 200_000, estimated: true }),
    ];
    expect(latestContextWindow(events).usedTokens).toBe(200_000);
  });

  it('reports how long ago the prompt was last compacted', () => {
    const compacted = manifest({
      compaction: { occurred: true, removedTokenEstimate: 900, removedSections: ['transcript'] },
    });
    const nextTurn = createTurnEmitter({ conversationId: 'c1', turnId: 't2' });
    const latestTurn = createTurnEmitter({ conversationId: 'c1', turnId: 't3' });
    const events: AiEvent[] = [
      emit.contextUsage({
        usedTokens: 10,
        contextWindow: 100,
        estimated: true,
        manifest: compacted,
      }),
      nextTurn.contextUsage({
        usedTokens: 10,
        contextWindow: 100,
        estimated: true,
        manifest: manifest({ requestId: 'req_2' }),
      }),
      latestTurn.contextUsage({
        usedTokens: 10,
        contextWindow: 100,
        estimated: true,
        manifest: manifest({ requestId: 'req_3' }),
      }),
    ];
    expect(latestContextWindow(events).requestsSinceCompaction).toBe(2);
  });

  it('leaves the compaction distance unset when it has never happened', () => {
    const events = [emit.contextUsage({ usedTokens: 10, contextWindow: 100, estimated: true })];
    expect(latestContextWindow(events).requestsSinceCompaction).toBeUndefined();
  });
});

describe('contextPhase', () => {
  it('is idle when no request is running, whatever the log says', () => {
    const events = [emit.contextUsage({ usedTokens: 1, contextWindow: 10, estimated: true })];
    expect(contextPhase(events, false)).toBe('idle');
  });

  it('is assembling once a run starts but before any request has been accounted for', () => {
    expect(contextPhase([], true)).toBe('assembling');
    expect(contextPhase(undefined, true)).toBe('assembling');
    expect(contextPhase([emit.status('thinking')], true)).toBe('assembling');
  });

  it('is generating once the request has gone out', () => {
    const events = [
      emit.status('thinking'),
      emit.contextUsage({ usedTokens: 1, contextWindow: 10, estimated: true }),
    ];
    expect(contextPhase(events, true)).toBe('generating');
  });

  it('is generating while the model streams', () => {
    const events = [emit.delta('a1', 'trimming')];
    expect(contextPhase(events, true)).toBe('generating');
  });
});
