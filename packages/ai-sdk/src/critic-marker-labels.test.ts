/**
 * Run `df81d58e` (2026-09-08) placed "Hook — founders stop scrolling" at 0 s on a cut that
 * still opened with "Today we are talking about mastering motion design". The marker
 * described the plan; nothing compared it to the timeline.
 */
import { describe, expect, it } from 'vitest';
import { critique } from './critic.js';
import { makeProject } from './__fixtures__/project.js';

const words = [
  ['Today', 0.06, 0.25], ['we', 0.25, 0.35], ['are', 0.35, 0.48], ['talking', 0.55, 0.85],
  ['about', 0.85, 1.09], ['mastering', 1.1, 1.56], ['motion', 1.56, 1.86], ['design.', 1.86, 2.22],
  ['If', 2.5, 2.6], ['you', 2.6, 2.7], ['want', 2.7, 2.9], ['to', 2.9, 3.0], ['make', 3.9, 4.1],
  ['founders', 4.1, 4.6], ['stop', 4.6, 4.9], ['scrolling,', 4.9, 5.3],
  ['to', 7.9, 8.0], ['over', 8.0, 8.2], ['1,50,000', 8.2, 8.9], ['subscribers', 8.9, 9.5],
] as const;

const project = (markers: { time: number; label: string }[]) =>
  makeProject({
    transcript: words.map(([word, start, end]) => ({ word, start, end, assetId: 'asset_1' })),
    markers: markers.map((m, i) => ({ id: `m${String(i)}`, ...m })),
  });

const markerCheck = (markers: { time: number; label: string }[]) =>
  critique(project(markers)).checks.find((c) => c.id === 'marker_labels');

describe('marker_labels — a marker sits where its words are spoken', () => {
  it('warns on the run’s hook marker, and names it', () => {
    const check = markerCheck([{ time: 0, label: 'Hook — founders stop scrolling' }]);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('"Hook — founders stop scrolling" at 0s');
    expect(check?.detail).toContain('reorder_clips');
  });

  it('passes a marker placed on its line, and matches numbers across comma styles', () => {
    expect(markerCheck([{ time: 4.1, label: 'Hook — founders stop scrolling' }])?.status).toBe('pass');
    expect(markerCheck([{ time: 8.5, label: 'Proof — 150,000 subscribers' }])?.status).toBe('pass');
  });

  it('skips a label made only of editorial words, and a project with no labelled markers', () => {
    expect(markerCheck([{ time: 0, label: 'Hook' }])?.status).toBe('skipped');
    expect(markerCheck([])?.status).toBe('skipped');
  });
});
