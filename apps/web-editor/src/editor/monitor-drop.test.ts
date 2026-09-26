/**
 * A sticker or shape tile dropped on the program monitor (plan/elements EL11, 02 §3): added at the
 * playhead, centred where it was dropped — one validated, reversible patch through the builders a
 * click uses, with the drop point in each builder's own units.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyProjectPatch, invertProjectPatch, validatePatch } from '@framepilot/editor-core';
import { stickerCatalog, type StickerItem } from '@framepilot/ai-sdk';
import type { ElementAssetWire, ElementMaterializeResult } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { placeMonitorDrop, type MonitorDrop } from './monitor-drop.js';

const fire: StickerItem = {
  id: 'fire',
  name: 'Fire',
  glyph: '🔥',
  unicode: null,
  group: 'Travel & Places',
  collections: [],
  keywords: [],
  availability: 'bundled',
  source: 'assets/Fire/3D/fire_3d.png',
};

const catalog = stickerCatalog({
  spec: 'test',
  library: 'fluent3d',
  provider: 'fluent-emoji',
  commit: 'abc',
  license: 'mit',
  licenseUrl: 'https://example.test/LICENSE',
  attribution: 'Fluent Emoji by Microsoft (MIT)',
  creator: 'Microsoft',
  attributionRequired: false,
  sourceBase: 'https://example.test/',
  collections: [],
  items: [fire],
});

const wire: ElementAssetWire = {
  id: 'element_fluent3d_fire',
  path: 'media/p/elements/fluent3d/fire.webp',
  kind: 'image',
  media: { width: 318, height: 318 },
  sharpSize: 256,
  source: {
    provider: 'fluent-emoji',
    remoteId: 'fire',
    license: 'mit',
    licenseUrl: 'https://example.test/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl: 'https://example.test/fire.png',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
  deduped: false,
};

/** A vertical short: the offset's pixels are the project's, not the monitor's. */
const project: Project = {
  id: 'p',
  name: 'p',
  version: 1,
  fps: 30,
  resolution: { width: 1080, height: 1920 },
  assets: [],
  folders: [],
  timeline: {
    tracks: [
      { id: 'graphics', type: 'overlay', clips: [] },
      { id: 'v', type: 'video', clips: [] },
    ],
  },
} as unknown as Project;

const target = () => project;

function deps(answer: ElementMaterializeResult) {
  return { materialize: vi.fn(async () => answer), loadCatalog: async () => catalog };
}

const drop = (item: MonitorDrop['item'], point: MonitorDrop['point']): MonitorDrop => ({
  item,
  point,
  projectId: 'p',
  atSeconds: 2,
  durationSeconds: 3,
  target,
});

const clipOf = (after: Project, clipId: string) =>
  after.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId)!;

describe('placeMonitorDrop', () => {
  it('centres a shape on the drop point, at the playhead, as one undoable patch', async () => {
    const d = deps({ ok: true, asset: wire });
    const placed = await placeMonitorDrop(
      d,
      drop({ kind: 'shape', presetId: 'rounded-rect/highlight', colour: null }, { x: 0.3, y: 0.4 }),
    );
    if (!placed.ok) throw new Error(placed.message);
    // A shape is drawn by the engine: nothing to copy.
    expect(d.materialize).not.toHaveBeenCalled();
    const check = validatePatch(project.timeline, placed.added.patch, {
      assetIds: [],
      folders: [],
    });
    expect(check.valid, JSON.stringify(check.issues)).toBe(true);
    const after = applyProjectPatch(project, placed.added.patch);
    const clip = clipOf(after, placed.added.clipId);
    expect(clip).toMatchObject({ trackId: 'graphics', start: 2, end: 5 });
    // The box centre, in percent of each axis: where the pointer let go.
    expect(clip.effects.find((effect) => effect.type === 'shape')?.params).toMatchObject({
      shape: 'rounded-rect',
      x: 30,
      y: 40,
      stroke: '#FFD400',
    });
    expect(applyProjectPatch(after, invertProjectPatch(project, placed.added.patch))).toEqual(
      project,
    );
  });

  it('keeps the Shapes tab’s colour on a dropped shape, and centres a line on the point', async () => {
    const placed = await placeMonitorDrop(
      deps({ ok: true, asset: wire }),
      drop(
        { kind: 'shape', presetId: 'underline-marker/yellow', colour: '#FF3B30' },
        { x: 0.5, y: 0.8 },
      ),
    );
    if (!placed.ok) throw new Error(placed.message);
    const params = clipOf(
      applyProjectPatch(project, placed.added.patch),
      placed.added.clipId,
    ).effects.find((effect) => effect.type === 'shape')?.params as {
      readonly stroke: string;
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    };
    expect(params.stroke).toMatch(/^#FF3B30/);
    expect((params.x1 + params.x2) / 2).toBeCloseTo(50);
    expect((params.y1 + params.y2) / 2).toBeCloseTo(80);
  });

  it('copies a sticker in by id and centres it on the drop point, in canvas pixels', async () => {
    const d = deps({ ok: true, asset: wire });
    const placed = await placeMonitorDrop(
      d,
      drop({ kind: 'sticker', elementId: 'fire' }, { x: 0.25, y: 0.75 }),
    );
    expect(d.materialize).toHaveBeenCalledWith({ projectId: 'p', elementId: 'fire' });
    if (!placed.ok) throw new Error(placed.message);
    const after = applyProjectPatch(project, placed.added.patch);
    const clip = clipOf(after, placed.added.clipId);
    expect(clip).toMatchObject({ start: 2, end: 5 });
    const base = (property: string) =>
      clip.keyframes.find((k) => k.property === property && k.time === 0)?.value;
    // A quarter of the way across and three quarters down a 1080 × 1920 frame.
    expect([base('x'), base('y')]).toEqual([-270, 480]);
    expect(applyProjectPatch(after, invertProjectPatch(project, placed.added.patch))).toEqual(
      project,
    );
  });

  it('says why a sticker could not be copied, in the Stickers tab’s words', async () => {
    const placed = await placeMonitorDrop(
      deps({ ok: false, error: 'disk_full' }),
      drop({ kind: 'sticker', elementId: 'fire' }, { x: 0.5, y: 0.5 }),
    );
    expect(placed).toEqual({
      ok: false,
      message: "Couldn't add this sticker: there isn't enough disk space.",
    });
  });

  it('says so, with what to do, for a shape this build does not have', async () => {
    const placed = await placeMonitorDrop(
      deps({ ok: true, asset: wire }),
      drop({ kind: 'shape', presetId: 'no-such/shape', colour: null }, { x: 0.5, y: 0.5 }),
    );
    expect(placed).toEqual({ ok: false, message: 'That shape could not be added. Try another.' });
  });
});
