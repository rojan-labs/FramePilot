/**
 * The golden gate's PERCEPTION ceiling, exercised as CI runs it.
 *
 * `framesSeenPerEdit` is the one metric in the gate that is a maximum, and it is the guard
 * on the visual-understanding claim that facts arriving as text remove the need to look.
 * Two ways it has silently failed to protect anything, both pinned here:
 *
 * 1. Neither `floor.json` nor the run CI feeds it carried a `perception` block, so the row
 *    printed "n/a — not measured" and passed. Both are armed now.
 * 2. When a block IS missing the branch printed a warning and still passed — a gate that
 *    warns is not a gate. It fails now, with an explicit flag as the human escape hatch.
 *
 * Driven as a SUBPROCESS against real artifacts rather than by importing the script: the
 * exit code is the contract CI depends on, and a unit test of an internal function would
 * not have caught either failure above.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GATE = join(REPO, 'packages', 'ai-sdk', 'scripts', 'golden-gate.mjs');
const BASELINE = join(REPO, 'reports', 'golden', 'baseline.json');

/** Run the gate exactly as `ci.yml` does. Returns its exit code, never throwing. */
function gate(runFile: string, ...flags: string[]): number {
  try {
    execFileSync('node', [GATE, runFile, ...flags], { encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

/** The shape these tests reach into: the run's golden block and its perception figures. */
interface GoldenRunDoc {
  golden: { perception?: { framesSeenPerEdit?: number } & Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

function writeVariant(mutate: (doc: GoldenRunDoc) => void): string {
  const doc = JSON.parse(readFileSync(BASELINE, 'utf8')) as GoldenRunDoc;
  mutate(doc);
  const file = join(mkdtempSync(join(tmpdir(), 'framepilot-gate-')), 'run.json');
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

describe('golden gate — the perception ceiling', () => {
  it('passes the committed baseline, which is armed', () => {
    // If this fails, `reports/golden/baseline.json` or `floor.json` lost its perception
    // block and the ceiling is unguarded on every CI run.
    expect(gate(BASELINE)).toBe(0);
  });

  it('FAILS when the input carries no perception block', () => {
    // The exact condition the arming commit was written to remove. It used to print
    // "⚠ NOT MEASURED" and exit 0.
    const unarmed = writeVariant((doc) => {
      delete doc.golden.perception;
    });
    expect(gate(unarmed)).toBe(2);
  });

  it('passes an unarmed input only when a human types the waiver', () => {
    const unarmed = writeVariant((doc) => {
      delete doc.golden.perception;
    });
    expect(gate(unarmed, '--allow-unmeasured-perception')).toBe(0);
  });

  it('fails a run that spent frames the floor did not', () => {
    const raised = writeVariant((doc) => {
      if (doc.golden.perception) doc.golden.perception.framesSeenPerEdit = 1.4;
    });
    expect(gate(raised)).toBe(2);
  });

  it('fails a SMALL rise too, because the tolerance is zero', () => {
    // `FRAMES_TOLERANCE` was 0.5 under a comment promising the gate "trips on the first
    // frame a change starts spending". At 0.4 frames per accepted edit — four frames on a
    // ten-edit run — it passed silently.
    const drift = writeVariant((doc) => {
      if (doc.golden.perception) doc.golden.perception.framesSeenPerEdit = 0.4;
    });
    expect(gate(drift)).toBe(2);
  });

  it('holds when the run looked at nothing, which is the floor', () => {
    const held = writeVariant((doc) => {
      if (doc.golden.perception) doc.golden.perception.framesSeenPerEdit = 0;
    });
    expect(gate(held)).toBe(0);
  });
});
