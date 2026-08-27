/**
 * The commit-only surface (02).
 *
 * A run holding sourcing candidates it has not spent loses the catalogue searches for the
 * turn. What it must NOT lose is everything else — every exclusion asserted here is a state
 * where a broader withholding would leave the run with no legal move, which is precisely
 * the ADR 0143 failure ADR 0147 was written to reverse.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { MockProvider } from './providers/mock.js';
import { isCatalogueSearch } from './tool-classification.js';
import { shouldWithholdCatalogueSearch } from './kernel/loop-detector.js';
import type { RunStage } from './kernel/working-state.js';

const orchestrator = (): Orchestrator => new Orchestrator(new MockProvider());
const names = (scope: Parameters<Orchestrator['agentTools']>[0], stage?: RunStage): string[] =>
  orchestrator()
    .agentTools(scope, stage)
    .map((tool) => tool.name);

describe('commit-only withholds the catalogue searches and nothing else', () => {
  it('drops every catalogue search', () => {
    const withheld = names('agent').filter((name) => !names('commit-only').includes(name));
    expect(withheld.length).toBeGreaterThan(0);
    expect(withheld.every(isCatalogueSearch)).toBe(true);
  });

  it('keeps recall_evidence — the only route to a banked remoteId', () => {
    // The agent log keeps payloads for AGENT_LOG_PAYLOAD_FRESH turns and a stock remoteId
    // exists nowhere else. Refusing a recall does not force commitment; it removes the
    // argument `add_stock` takes.
    expect(names('commit-only')).toContain('recall_evidence');
  });

  it('keeps the inspection tools', () => {
    // A run whose downloads all failed, or whose placement is refused for want of a free
    // span, has to be able to read the timeline and say so.
    for (const tool of ['get_timeline', 'get_project_state', 'list_assets']) {
      expect(names('commit-only')).toContain(tool);
    }
  });

  it('keeps the tools that SPEND a candidate', () => {
    for (const tool of ['add_stock', 'add_music', 'add_clip']) {
      expect(names('commit-only')).toContain(tool);
    }
  });

  it('composes with stage narrowing rather than replacing it', () => {
    const stages: RunStage[] = ['inspect', 'analyze', 'plan', 'apply', 'verify'];
    for (const stage of stages) {
      const scoped = names('commit-only', stage);
      expect(scoped.every((name) => names('agent', stage).includes(name))).toBe(true);
      expect(scoped.some(isCatalogueSearch)).toBe(false);
    }
  });

  it('leaves the other scopes untouched', () => {
    // ADR 0147's decision clause: the whole sourcing role survives a recovery turn.
    expect(names('action-recovery').some(isCatalogueSearch)).toBe(true);
    expect(names('agent').some(isCatalogueSearch)).toBe(true);
  });

  it('is stable within a scope — a set that churns per turn breaks the cached prefix', () => {
    expect(names('commit-only')).toEqual(names('commit-only'));
  });
});

describe("the captured run's own state, replayed (02)", () => {
  /**
   * Run `e36235cc` at 11:24:06: nineteen catalogue searches banked, twelve stock clips on
   * disk, a 121-beat grid detected — and both picture tracks empty. What it did next was
   * four `describe_footage` calls, nine recalls, and four more searches.
   */
  const AT_11_24_06 = { bankedSearches: 19, placementsApplied: 0 };

  it('cannot search again from the state the run was actually in', () => {
    expect(shouldWithholdCatalogueSearch(AT_11_24_06)).toBe(true);
  });

  it('can still reach everything it needed to finish the montage', () => {
    const reachable = names('commit-only', 'apply');
    // The ids are only in the recalled payloads; the clips are only placeable by add_clip.
    for (const tool of ['recall_evidence', 'add_clip', 'list_assets', 'get_timeline']) {
      expect(reachable).toContain(tool);
    }
  });

  it('is released the moment one clip lands', () => {
    expect(shouldWithholdCatalogueSearch({ ...AT_11_24_06, placementsApplied: 1 })).toBe(false);
  });

  it('would not have engaged at the start of the run, on an empty project', () => {
    // 11:02:51: nothing banked, nothing placed. Withholding here is the ADR 0143 deadlock.
    expect(shouldWithholdCatalogueSearch({ bankedSearches: 0, placementsApplied: 0 })).toBe(false);
  });
});
