/**
 * Track mattes in the monitor's composite (MK8.2): which layers are drawn and which are only a
 * matte for another clip.
 *
 * The frame plan marks a layer `matteOnly` when an enabled `layer` mask reads it (its clip, an
 * under-layer for that clip, or anything on a track read whole). The export renders such a layer
 * for the matte and never composites it (`LayerMatteResolver` in `render/layer_mattes.py`); this
 * does the same for the compositor: it takes those layers out of the list the frame is built
 * from and hands each masked picture layer, per track matte, the layers its source is made of.
 *
 * Pure: no GL. `layer-compositor.ts` composites the sources and reads the matte from them.
 */
import type { FramePlanLayer } from '@framepilot/editor-core';
import { masksOf } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';

import type { CompositeLayer } from './layer-compositor.js';

const log = createLogger('web-editor:preview:track-mattes');

/** How deep a chain of track mattes is followed (the validator and the export refuse loops). */
const MAX_CHAIN = 8;

type PictureLayer = Extract<CompositeLayer, { kind: 'picture' }>;

/** Every enabled `layer` mask a picture layer's stack holds, with its source. */
function trackMattesOf(
  layer: CompositeLayer,
): Extract<ReturnType<typeof masksOf>[number], { kind: 'layer' }>[] {
  if (layer.kind !== 'picture' || layer.step.mask === null) return [];
  const stack = layer.step.mask.stack;
  return masksOf(stack.clip).filter(
    (mask): mask is Extract<typeof mask, { kind: 'layer' }> =>
      mask.enabled && mask.kind === 'layer',
  );
}

/**
 * The layers to composite, each masked picture carrying its track mattes' sources.
 *
 * @param origins - The plan layer each composite layer was built from, index for index.
 * @param layers - The composite layers, back to front.
 * @returns The layers to draw (without the `matteOnly` ones), back to front.
 */
export function withTrackMattes(
  origins: readonly FramePlanLayer[],
  layers: readonly CompositeLayer[],
): CompositeLayer[] {
  if (!origins.some((origin) => origin.matteOnly === true)) {
    if (!layers.some((layer) => trackMattesOf(layer).length > 0)) return [...layers];
  }
  const byClip = new Map<string, number[]>();
  const byTrack = new Map<string, number[]>();
  origins.forEach((origin, index) => {
    if (origin.matteOnly !== true) return;
    const owner = origin.forClipId ?? origin.clipId;
    if (owner !== null) byClip.set(owner, [...(byClip.get(owner) ?? []), index]);
    byTrack.set(origin.trackId, [...(byTrack.get(origin.trackId) ?? []), index]);
  });

  const attached = new Map<number, CompositeLayer>();
  const attach = (index: number, depth: number): CompositeLayer => {
    const done = attached.get(index);
    if (done !== undefined) return done;
    const layer = layers[index]!;
    const mattes = trackMattesOf(layer);
    if (mattes.length === 0 || depth > MAX_CHAIN) {
      if (depth > MAX_CHAIN) log.warn('track matte chain too deep; left unresolved', { index });
      attached.set(index, layer);
      return layer;
    }
    const sources = new Map<string, readonly CompositeLayer[]>();
    for (const mask of mattes) {
      const indices =
        mask.source.kind === 'clip'
          ? (byClip.get(mask.source.clipId) ?? [])
          : (byTrack.get(mask.source.trackId) ?? []);
      sources.set(
        mask.id,
        indices.filter((source) => source !== index).map((source) => attach(source, depth + 1)),
      );
    }
    const withSources: PictureLayer = { ...(layer as PictureLayer), layerMattes: sources };
    attached.set(index, withSources);
    return withSources;
  };

  const drawn: CompositeLayer[] = [];
  layers.forEach((_layer, index) => {
    if (origins[index]?.matteOnly === true) return;
    drawn.push(attach(index, 0));
  });
  return drawn;
}
