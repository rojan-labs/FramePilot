/**
 * PX0.2 — which renderer TODAY's desktop program monitor uses for every feature-matrix
 * timeline, and where it cannot agree with the export.
 *
 * Derived, not remembered: each `tests/fixtures/frame-plan` case goes through the real
 * `webCodecsPreviewEligible` (the gate `Editor.tsx` uses to pick `WebCodecsPreviewPlayer` over
 * the DOM `PreviewPlayer`) and `canvasPreviewEligible` (the gate inside the WebCodecs player that
 * turns segments, overlays and captions off), and its export plan comes from `framePlanAt`.
 * The divergence column is a function of those two facts; every sentence in it points at the
 * preview code that produces the difference.
 *
 * The generated table lives between the `px0:inventory` markers in
 * `plan/background-removal-ai/PX0-INVENTORY.md`, and this test fails when the two disagree, so
 * the inventory cannot go stale as the gates change (PX2/PX3 will make it shrink). The pixel
 * column is read from the PX4.3 baseline the CI oracle run produced, never typed by hand.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { framePlanAt, type FramePlan } from '@framepilot/editor-core';
import { ProjectSchema, type Asset, type Project } from '@framepilot/timeline-schema';
import { webCodecsPreviewEligible as baseWebCodecsPreviewEligible } from '../editor/selectors-base.js';
import { canvasPreviewEligible, webCodecsPreviewEligible } from '../editor/selectors.js';

/** The workspace root, found from the test's cwd (jsdom gives `import.meta.url` no file scheme). */
function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the workspace root.');
    dir = parent;
  }
  return dir;
}

const REPO = repoRoot();
const FIXTURE_DIR = path.join(REPO, 'tests', 'fixtures', 'frame-plan') + path.sep;
const INVENTORY_DOC = path.join(REPO, 'plan', 'background-removal-ai', 'PX0-INVENTORY.md');
/** The PX4.3 baseline, regenerated from the CI oracle run (tests/e2e/scripts/px4-baseline.mjs). */
const PARITY_BASELINE = path.join(REPO, 'tests', 'e2e', 'fixtures', 'preview-parity-baseline.json');

interface ParitySummary {
  readonly renderer: string;
  readonly minPsnr: number | 'Infinity' | null;
  readonly minWithinPercent: number | null;
  readonly failing: readonly string[];
}

/** The pixel column: what the PX4 oracle measured for this case in CI, never typed by hand. */
function pixelCell(caseKey: string): string {
  if (!existsSync(PARITY_BASELINE)) return 'PX4.3';
  const baseline = JSON.parse(readFileSync(PARITY_BASELINE, 'utf8')) as {
    readonly summary?: Readonly<Record<string, ParitySummary>>;
  };
  const measured = baseline.summary?.[caseKey];
  if (!measured) return 'not measured (PX4.3)';
  if (measured.renderer !== 'webcodecs') {
    return `not read back (${measured.renderer === 'dom' ? 'DOM renderer' : 'harness error'})`;
  }
  const numbers = `min PSNR ${measured.minPsnr ?? 'n/a'} dB, min ${measured.minWithinPercent ?? 'n/a'}% within 8/255`;
  return measured.failing.length === 0
    ? `passes (${numbers})`
    : `fails ${measured.failing.join(', ')} (${numbers})`;
}
const START_MARKER = '<!-- px0:inventory:start -->';
const END_MARKER = '<!-- px0:inventory:end -->';

/** The program monitor a timeline gets on the desktop today. */
export type ProgramRenderer =
  'WebCodecs canvas' | 'DOM PreviewPlayer' | 'WebCodecs, overlays disabled' | 'blank';

interface VectorCase {
  readonly id: string;
  readonly row: string;
  readonly burnCaptions: boolean;
  readonly probe: { readonly fps: Readonly<Record<string, number>> };
  readonly project: unknown;
  readonly samples: readonly number[];
}

interface InventoryRow {
  readonly file: string;
  readonly vector: VectorCase;
  readonly renderer: ProgramRenderer;
  readonly reason: string;
  readonly divergences: readonly string[];
}

/**
 * `Editor.tsx` mounts `WebCodecsPreviewPlayer` only when `webCodecsPreviewEligible`; inside it,
 * `canvasPreviewEligible` gates segments/overlays/captions. `blank` is a timeline neither
 * player can put a picture or overlay on at all.
 */
function programRenderer(project: Project): ProgramRenderer {
  const assetById = new Map<string, Asset>(project.assets.map((asset) => [asset.id, asset]));
  const drawable = project.timeline.tracks.some(
    (track) =>
      track.hidden !== true &&
      track.clips.some((clip) => {
        const kind = assetById.get(clip.assetId)?.kind;
        return kind === 'video' || kind === 'image' || clip.assetId.startsWith('__');
      }),
  );
  if (!drawable) return 'blank';
  if (!webCodecsPreviewEligible(project.timeline, assetById, project.resolution)) {
    return 'DOM PreviewPlayer';
  }
  return canvasPreviewEligible(project.timeline, assetById, project.resolution)
    ? 'WebCodecs canvas'
    : 'WebCodecs, overlays disabled';
}

/** Why the gates chose that renderer: the first gate that refused, in the order they run. */
function routingReason(project: Project, renderer: ProgramRenderer): string {
  if (renderer === 'blank') return 'nothing drawable';
  const assetById = new Map<string, Asset>(project.assets.map((asset) => [asset.id, asset]));
  const { timeline, resolution } = project;
  if (!canvasPreviewEligible(timeline, assetById, resolution)) {
    const pictures = timeline.tracks
      .filter((track) => track.hidden !== true)
      .flatMap((track) => track.clips)
      .filter((clip) => ['video', 'image'].includes(assetById.get(clip.assetId)?.kind ?? ''));
    if (pictures.length === 0) return 'canvas gate: no picture clip';
    if (pictures.some((clip) => (clip.speed ?? 1) !== 1)) return 'canvas gate: speed ≠ 1';
    return 'canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170)';
  }
  if (!baseWebCodecsPreviewEligible(timeline, assetById, resolution)) {
    return 'WebCodecs gate: unproxied video';
  }
  if (!webCodecsPreviewEligible(timeline, assetById, resolution)) {
    return 'decoded-audio admission (selectors.ts): a clip whose asset has no duration — synthetic text/caption ids count — or over the PCM budget';
  }
  return 'all gates pass';
}

function plansFor(vector: VectorCase, project: Project): readonly FramePlan[] {
  return vector.samples.map((t) =>
    framePlanAt(project.timeline, project.assets, t, project.resolution, {
      burnCaptions: vector.burnCaptions,
      sourceFps: vector.probe.fps,
      transcript: project.transcript,
    }),
  );
}

/** What the export plan contains that today's renderer draws differently, one fact per line. */
function divergences(vector: VectorCase, project: Project, renderer: ProgramRenderer): string[] {
  const plans = plansFor(vector, project);
  const found: string[] = [];
  const dom = renderer === 'DOM PreviewPlayer';
  const assetKind = new Map(project.assets.map((asset) => [asset.id, asset.kind]));
  const pictures = project.timeline.tracks
    .filter((track) => track.hidden !== true)
    .flatMap((track) => track.clips)
    .filter((clip) => ['video', 'image'].includes(assetKind.get(clip.assetId) ?? 'video'))
    .filter((clip) => !clip.assetId.startsWith('__'));

  // Track clips only: an under-layer is reported on its own line below.
  const maxStack = Math.max(
    0,
    ...plans.map(
      (plan) =>
        plan.layers.filter((layer) => layer.kind === 'picture' && layer.role === 'clip').length,
    ),
  );
  if (maxStack >= 2) {
    found.push(
      dom
        ? `export stacks up to ${maxStack} pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)`
        : `export stacks up to ${maxStack} pictures; flat EDL paints only the front clip, admitted only because it hides the rest (ADR 0169/0170)`,
    );
  }
  const textUnder = plans.some((plan) =>
    plan.layers.some(
      (layer, index) =>
        (layer.kind === 'text' || layer.kind === 'caption') &&
        plan.layers.slice(index + 1).some((above) => above.kind === 'picture'),
    ),
  );
  if (textUnder) {
    found.push(
      'text sits under a picture in the export; preview paints overlays above every picture (drawOverlays / DOM overlay div)',
    );
  }
  const hasCaptionTrack = project.timeline.tracks.some((track) => track.type === 'caption');
  if (hasCaptionTrack && vector.burnCaptions) {
    found.push(
      'burned captions composite above everything in caption-track list order; preview draws them as a DOM layer in its own order',
    );
  }
  if (hasCaptionTrack && !vector.burnCaptions) {
    found.push('export burns no captions (burn-in off); preview still draws caption clips');
  }
  if (pictures.some((clip) => (clip.speed ?? 1) !== 1) && dom) {
    found.push(
      'retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h)',
    );
  }
  if (pictures.some((clip) => (clip.speedRamp?.length ?? 0) > 0)) {
    found.push(
      dom
        ? 'speed ramp: DOM maps element time 1:1, so source frames drift from the export'
        : 'speed ramp: the canvas gate checks only constant `speed`, so WebCodecs admits the clip and its source frames do not follow the ramp',
    );
  }
  if (plans.some((plan) => plan.layers.some((layer) => layer.role === 'underlay'))) {
    found.push(
      "transition under-layer: export plays the neighbour's handle past its cut; preview reveals over a held frame of the previous shot",
    );
  }
  const catalogPath = plans.some((plan) =>
    plan.layers.some((layer) => layer.transitions.some((state) => state.path === 'catalog')),
  );
  if (catalogPath && dom) {
    found.push(
      'catalog transition pass: DOM player only has the legacy envelopes (transition-envelope.ts), no GL transition chain',
    );
  }
  if (plans.some((plan) => plan.frameEffects.length > 0)) {
    found.push(
      dom
        ? 'effect layers: export applies them to the finished frame; DOM overlay sits below text and captions (PreviewEffectOverlay)'
        : 'effect layers: export applies them to the finished frame incl. burned captions; canvas pass runs after text but the caption DOM layer is not covered',
    );
  }
  if (plans.some((plan) => plan.layers.some((layer) => layer.mask !== null))) {
    found.push(
      dom
        ? 'clip mask: DOM draws the stack raster on the one visible clip only (maskRasterCssImage)'
        : 'clip mask: canvas paints the stack raster (paintMaskRaster); pixel agreement unmeasured',
    );
  }
  const stillQuirk = pictures.some(
    (clip) =>
      assetKind.get(clip.assetId) === 'image' &&
      (clip.crop !== undefined || clip.keyframes.some((k) => k.property === 'opacity')),
  );
  if (stillQuirk) {
    found.push(
      'still image: export ignores its crop and opacity keyframes (_compile_image_clip); preview crops it (crop-fill.ts)',
    );
  }
  if (!pictures.length && plans.some((plan) => plan.layers.some((l) => l.kind === 'text'))) {
    found.push(
      'no picture clip: canvas gate refuses overlay-only timelines, DOM draws text on black',
    );
  }
  const unproxied = pictures.some(
    (clip) =>
      assetKind.get(clip.assetId) === 'video' &&
      !project.assets.find((asset) => asset.id === clip.assetId)?.media?.proxyPath,
  );
  if (unproxied) {
    found.push('unproxied original: routed to DOM because the WebCodecs demuxer loads whole files');
  }
  return found;
}

function loadInventory(): readonly InventoryRow[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const document = JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as {
        readonly cases: readonly VectorCase[];
      };
      return document.cases.map((vector) => {
        const project = ProjectSchema.parse(vector.project);
        const renderer = programRenderer(project);
        return {
          file,
          vector,
          renderer,
          reason: routingReason(project, renderer),
          divergences: divergences(vector, project, renderer),
        };
      });
    });
}

function renderTable(rows: readonly InventoryRow[]): string {
  const escape = (text: string): string => text.replace(/\|/g, '\\|');
  const lines = [
    '| Matrix row | Case | Today’s program monitor | Why (first gate that decided) | Known divergence vs export (derived) | Pixel diff vs `frame_grab` |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const notes =
      row.divergences.length > 0 ? row.divergences.map(escape).join('<br>') : 'none derived';
    lines.push(
      `| ${escape(row.vector.row)} | \`${row.file.replace('.json', '')}/${row.vector.id}\` | ${row.renderer} | ${escape(row.reason)} | ${notes} | ${escape(pixelCell(`${row.file.replace('.json', '')}/${row.vector.id}`))} |`,
    );
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.renderer, (counts.get(row.renderer) ?? 0) + 1);
  const summary = (
    ['WebCodecs canvas', 'DOM PreviewPlayer', 'WebCodecs, overlays disabled', 'blank'] as const
  )
    .map((renderer) => `${renderer}: ${counts.get(renderer) ?? 0}`)
    .join(' · ');
  return [`**${rows.length} cases.** ${summary}`, '', ...lines].join('\n');
}

/**
 * The table with formatting noise removed, so `prettier` padding cells or widening the
 * delimiter row cannot fail the comparison — only content can.
 */
function normalizeTable(table: string): string {
  return table
    .split('\n')
    .map((line) => {
      if (!line.startsWith('|')) return line.trim();
      const cells = line
        .slice(1, line.endsWith('|') ? -1 : undefined)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim())
        .map((cell) => (/^:?-+:?$/.test(cell) ? '---' : cell));
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');
}

function documentedTable(): string {
  const doc = readFileSync(INVENTORY_DOC, 'utf8');
  const start = doc.indexOf(START_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start < 0 || end < start) return '';
  return doc.slice(start + START_MARKER.length, end).trim();
}

describe('PX0 inventory', () => {
  const rows = loadInventory();

  it('covers every frame-plan fixture', () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  it('never mounts the WebCodecs player with its canvas gate closed', () => {
    // `webCodecsPreviewEligible` implies `canvasPreviewEligible`, so the overlays-disabled
    // state is unreachable from the desktop program monitor today.
    expect(rows.filter((row) => row.renderer === 'WebCodecs, overlays disabled')).toEqual([]);
  });

  it('matches the committed table in PX0-INVENTORY.md', () => {
    // On a mismatch the diff below IS the new table: paste it between the markers.
    expect(normalizeTable(documentedTable())).toBe(normalizeTable(renderTable(rows)));
  });
});
