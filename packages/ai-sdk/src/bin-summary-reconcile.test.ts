/**
 * The project brain's media-bin summary, reconciled against the bin the project has.
 *
 * The brain accumulates every asset it has ever analysed; the bin does not. Until this
 * existed, `session_context` handed the accumulated version to the model as present-tense
 * fact — and run `e8cb2636` placed a music track from a previous session that the project
 * no longer held, on the strength of it. `add_clip` answered "Unknown asset
 * 'music_openverse_63510d28_…'", the bed never landed, and the creator was shown a change
 * that "did not land" with no way to see why.
 */
import { describe, expect, it } from 'vitest';
import { reconcileBinSummary } from './orchestrator.js';

const HEADER = [
  '# Media bin summary',
  '',
  'Derived from the project brain — regenerated after each analysis pass; do not edit.',
].join('\n');

const section = (id: string, path: string, transcript = 'not transcribed'): string =>
  [
    `## ${id} (${path})`,
    '',
    '- duration: 49.8s',
    '- resolution: 1920x1080',
    '- loudness: not analyzed',
    '- scenes: not analyzed',
    '- silence: 0% silent (0 silent ranges)',
    `- transcript: ${transcript}`,
  ].join('\n');

/** The captured summary: a recording under an old path, plus a track that is long gone. */
const CAPTURED = [
  HEADER,
  section('asset_isom_batch1_assignment1', 'media/p/ISOM_Batch1_Assignment1.mp4'),
  section('music_openverse_63510d28_28df_45f0_8b4f_48574242835e', 'media/p/Chillout.mp3'),
].join('\n\n');

describe('reconcileBinSummary', () => {
  it('drops an asset the project no longer holds', () => {
    const reconciled = reconcileBinSummary(CAPTURED, [
      { id: 'asset_isom_batch1_assignment1', path: 'media/p/ISOM_Batch1_Assignment1_2.mp4' },
    ]);
    expect(reconciled).not.toContain('music_openverse_63510d28');
    expect(reconciled).not.toContain('Chillout.mp3');
  });

  it('says the summary was filtered, so the omission is not itself a lie', () => {
    const reconciled = reconcileBinSummary(CAPTURED, [
      { id: 'asset_isom_batch1_assignment1', path: 'media/p/ISOM_Batch1_Assignment1_2.mp4' },
    ]);
    expect(reconciled).toContain('1 analysed asset is no longer in this project');
    expect(reconciled).toContain('list_assets');
  });

  it('refreshes the path of an asset that was re-imported under the same id', () => {
    // A memory is allowed to be old. It is not allowed to be wrong about what is on disk.
    const reconciled = reconcileBinSummary(CAPTURED, [
      { id: 'asset_isom_batch1_assignment1', path: 'media/p/ISOM_Batch1_Assignment1_2.mp4' },
    ]);
    expect(reconciled).toContain(
      '## asset_isom_batch1_assignment1 (media/p/ISOM_Batch1_Assignment1_2.mp4)',
    );
    expect(reconciled).not.toContain('(media/p/ISOM_Batch1_Assignment1.mp4)');
  });

  it('keeps every line of analysis for an asset that is still there', () => {
    // The analysis is the whole value of the memory, and an unrelated asset leaving the
    // bin invalidates none of it.
    const reconciled = reconcileBinSummary(CAPTURED, [
      { id: 'asset_isom_batch1_assignment1', path: 'media/p/ISOM_Batch1_Assignment1.mp4' },
      { id: 'music_openverse_63510d28_28df_45f0_8b4f_48574242835e', path: 'media/p/Chillout.mp3' },
    ]);
    expect(reconciled).toBe(CAPTURED);
  });

  it('leaves the file header alone even when every section goes', () => {
    const reconciled = reconcileBinSummary(CAPTURED, []);
    expect(reconciled).toContain('# Media bin summary');
    expect(reconciled).toContain('2 analysed assets are no longer in this project');
    expect(reconciled).not.toContain('## asset_isom');
  });

  it('pluralises honestly', () => {
    expect(reconcileBinSummary(CAPTURED, [])).toContain('2 analysed assets are');
  });

  it('passes an empty or section-less summary through untouched', () => {
    const empty = `${HEADER}\n\nNo assets analyzed yet.\n`;
    expect(reconcileBinSummary(empty, [])).toBe(empty);
    expect(reconcileBinSummary('', [])).toBe('');
  });
});
