/**
 * Tests for the model-based command classifier (ADR 0055). The prompt builder and the
 * response parser are pure, so these cover the routing-shape guarantees the Orchestrator
 * relies on: route-specific fields are dropped from the wrong routes, and a bad reply
 * returns `null` (→ safe fallback).
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../__fixtures__/project.js';
import {
  projectHeaderOf,
  FALLBACK_CLASSIFICATION,
  buildClassifierMessages,
  parseClassification,
  type ClassifierInput,
} from './command-classifier.js';

const input: ClassifierInput = {
  userText: 'add an intro using advanced keyframes',
  header: { durationSeconds: 12, resolution: { width: 1080, height: 1920 }, layerCount: 2 },
};

describe('buildClassifierMessages', () => {
  it('renders a system turn plus the request, header, and selection', () => {
    const messages = buildClassifierMessages({
      ...input,
      selection: { start: 1, end: 4 },
      hasSelection: true,
    });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('CommandRouter');
    const user = messages[1]?.content ?? '';
    expect(user).toContain('1080x1920');
    expect(user).toContain('Selection: 1.00s–4.00s');
    expect(user).toContain('add an intro using advanced keyframes');
  });

  it('notes a live selection even when no explicit range is given', () => {
    const messages = buildClassifierMessages({ ...input, hasSelection: true });
    expect(messages[1]?.content).toContain('a live selection exists');
  });

  it('includes the target platform in the header when set', () => {
    const messages = buildClassifierMessages({
      ...input,
      header: { ...input.header, platform: 'reels' },
    });
    expect(messages[1]?.content).toContain('platform reels');
  });
});

describe('parseClassification', () => {
  it('accepts a chitchat route and keeps its reply', () => {
    const result = parseClassification('{"route":"chitchat","reply":"Hi there!"}');
    expect(result).toEqual({ route: 'chitchat', reply: 'Hi there!' });
  });

  it('accepts a chitchat route with no reply', () => {
    expect(parseClassification('{"route":"chitchat"}')).toEqual({ route: 'chitchat' });
  });

  it('rejects the retired planned_edit route so the caller falls back to the agent', () => {
    // ADR 0126 removed the second mutating execution route. A model still emitting it
    // (a stale cache, an older fine-tune) must not select a path that no longer exists:
    // an unparseable classification is data, and `Orchestrator.classifyCommand` degrades
    // to FALLBACK_CLASSIFICATION — which is `edit`, the runtime that absorbed the route.
    expect(parseClassification('{"route":"planned_edit"}')).toBeNull();
    expect(FALLBACK_CLASSIFICATION).toEqual({ route: 'edit' });
  });

  it('drops a reply off a non-chitchat route, and unknown fields entirely', () => {
    expect(parseClassification('{"route":"edit","recipe":"add_hook","reply":"x"}')).toEqual({
      route: 'edit',
    });
    expect(parseClassification('{"route":"question","reply":"x"}')).toEqual({ route: 'question' });
  });

  it('tolerates a code-fenced JSON block', () => {
    const result = parseClassification('```json\n{"route":"edit"}\n```');
    expect(result).toEqual({ route: 'edit' });
  });

  it('returns null for non-JSON or an unknown route — including the removed recipe route', () => {
    expect(parseClassification('not json at all')).toBeNull();
    expect(parseClassification('{"route":"delete_everything"}')).toBeNull();
    // A model that has seen an older contract (or a stale cached prompt) must not be able
    // to reach a route that no longer exists — it falls back to `edit`, never dispatches.
    expect(parseClassification('{"route":"recipe","recipe":"remove_silence"}')).toBeNull();
  });
});

describe('FALLBACK_CLASSIFICATION', () => {
  it('is the safe edit route', () => {
    expect(FALLBACK_CLASSIFICATION).toEqual({ route: 'edit' });
  });
});

describe('projectHeaderOf', () => {
  // Moved here from the deleted planner path (ADR 0126); the classifier is its only
  // consumer now, so its coverage lives with it.
  const project = makeProject();

  it('derives duration from the furthest clip end, not the asset length', () => {
    expect(projectHeaderOf(project)).toEqual({
      durationSeconds: 10,
      resolution: { width: 1920, height: 1080 },
      layerCount: 2,
    });
  });

  it('omits platform when none is supplied and carries it when one is', () => {
    expect(projectHeaderOf(project)).not.toHaveProperty('platform');
    expect(projectHeaderOf(project, 'reels')).toMatchObject({ platform: 'reels' });
  });

  it('reports zero duration for a project with no clips', () => {
    const empty = makeProject({ timeline: { tracks: [{ id: 'v', type: 'video', clips: [] }] } });
    expect(projectHeaderOf(empty).durationSeconds).toBe(0);
  });
});
