import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AiEvent, ContextManifest } from '@framepilot/ai-sdk';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import { ContextDebugger, recentManifests } from './ContextDebugger.js';

function manifest(overrides: Partial<ContextManifest> = {}): ContextManifest {
  return {
    requestId: 'req_1',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    sections: [
      { id: 's1', type: 'system', label: 'system contract', tokenEstimate: 1_000, included: true },
      {
        id: 's2',
        type: 'retrieved_evidence',
        label: 'timeline summary',
        tokenEstimate: 800,
        included: true,
      },
    ],
    usage: {
      modelContextLimit: 1_000_000,
      limitAssumed: false,
      estimatedInputTokensBeforeSend: 1_800,
      reservedOutputTokens: 128_000,
      estimatedRemainingCapacity: 870_200,
      calculationSource: 'local_estimate',
    },
    compaction: { occurred: false, removedTokenEstimate: 0, removedSections: [] },
    ...overrides,
  };
}

describe('ContextDebugger', () => {
  it('shows the identifiers a change has to be traced through', () => {
    render(
      <ContextDebugger
        debug={{
          conversationId: 'conv_9',
          latest: manifest({
            memory: {
              runId: 'run_3',
              stage: 'apply',
              projectRevision: 7,
              objectiveKnown: true,
              committedDecisions: 2,
              facts: 5,
              evidenceHandles: 3,
              remainingObjectives: 0,
            },
          }),
        }}
      />,
    );
    expect(screen.getByText('conv_9')).toBeTruthy();
    expect(screen.getByText('run_3')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('anthropic · claude-opus-4-8')).toBeTruthy();
  });

  it('distinguishes the estimate from the reported figure rather than showing one number', () => {
    render(<ContextDebugger debug={{ conversationId: 'c', latest: manifest() }} />);
    expect(screen.getByText('Estimated in')).toBeTruthy();
    expect(screen.getByText('not reported')).toBeTruthy();
  });

  it('attributes a change to the sections that caused it', () => {
    const previous = manifest();
    const latest = manifest({
      requestId: 'req_2',
      sections: [
        {
          id: 's1',
          type: 'system',
          label: 'system contract',
          tokenEstimate: 1_000,
          included: true,
        },
        {
          id: 's2',
          type: 'retrieved_evidence',
          label: 'timeline summary',
          tokenEstimate: 2_800,
          included: true,
        },
        { id: 's3', type: 'skill', label: 'skills manifest', tokenEstimate: 600, included: true },
      ],
      usage: { ...manifest().usage, estimatedInputTokensBeforeSend: 4_400 },
    });
    render(<ContextDebugger debug={{ conversationId: 'c', previous, latest }} />);
    expect(screen.getByText('Input +2.6K')).toBeTruthy();
    expect(screen.getByText('grew · +2K')).toBeTruthy();
    expect(screen.getByText('added · +600')).toBeTruthy();
    // An unchanged section is not noise worth a row.
    expect(screen.queryByText('system contract')).toBeNull();
  });

  it('says so plainly when there is nothing to compare against yet', () => {
    render(<ContextDebugger debug={{ conversationId: 'c', latest: manifest() }} />);
    expect(screen.getByText(/nothing to compare against yet/)).toBeTruthy();
  });

  it('flags a model switch, which changes the capacity as well as the usage', () => {
    render(
      <ContextDebugger
        debug={{
          conversationId: 'c',
          previous: manifest(),
          latest: manifest({ requestId: 'req_2', model: 'claude-haiku-4-5' }),
        }}
      />,
    );
    expect(screen.getByText(/model changed/)).toBeTruthy();
  });

  it('reports what compaction removed, by name', () => {
    render(
      <ContextDebugger
        debug={{
          conversationId: 'c',
          latest: manifest({
            compaction: {
              occurred: true,
              removedTokenEstimate: 5_000,
              removedSections: ['transcript slice'],
            },
          }),
        }}
      />,
    );
    expect(screen.getByText('−5K (transcript slice)')).toBeTruthy();
  });
});

const emit = createTurnEmitter({ conversationId: 'c1', turnId: 't1' });

describe('recentManifests', () => {
  it('returns the two most recent distinct requests, newest last', () => {
    const events: AiEvent[] = [
      emit.contextUsage({
        usedTokens: 1,
        contextWindow: 10,
        estimated: true,
        manifest: manifest(),
      }),
      emit.contextUsage({
        usedTokens: 2,
        contextWindow: 10,
        estimated: true,
        manifest: manifest({ requestId: 'req_2' }),
      }),
      emit.contextUsage({
        usedTokens: 3,
        contextWindow: 10,
        estimated: true,
        manifest: manifest({ requestId: 'req_3' }),
      }),
    ];
    const { previous, latest } = recentManifests(events);
    expect(previous?.requestId).toBe('req_2');
    expect(latest?.requestId).toBe('req_3');
  });

  it('never compares a request with itself when the provider settles it', () => {
    // One call emits twice: the pre-send estimate, then the settled figure.
    const events: AiEvent[] = [
      emit.contextUsage({
        usedTokens: 1,
        contextWindow: 10,
        estimated: true,
        manifest: manifest(),
      }),
      emit.contextUsage({
        usedTokens: 2,
        contextWindow: 10,
        estimated: false,
        manifest: manifest({
          usage: { ...manifest().usage, providerReportedInputTokens: 2_100 },
        }),
      }),
    ];
    const { previous, latest } = recentManifests(events);
    expect(previous).toBeUndefined();
    // The settled manifest wins — it is the one carrying the reported figure.
    expect(latest?.usage.providerReportedInputTokens).toBe(2_100);
  });

  it('ignores context_usage events that carry no manifest', () => {
    const events = [emit.contextUsage({ usedTokens: 1, contextWindow: 10, estimated: true })];
    expect(recentManifests(events)).toEqual({});
  });

  it('returns nothing for an absent log', () => {
    expect(recentManifests(undefined)).toEqual({});
  });
});
