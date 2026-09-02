/**
 * The `add_stock` host, tested on the decision that broke a captured run: what
 * an ABSENT `atSeconds` means.
 *
 * The scenario in `run.md` is the load-bearing case — one placement lands, then
 * four gathers arrive for a bin that has no span to conflict with.
 */
import { describe, expect, it, vi } from 'vitest';
import { STOCK_ERROR_CODES } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { StockDownloadResult } from '../ipc/contract.js';
import { createStockHost, type StockHostIO } from './stock-host.js';

/** A project whose only video layer holds one 7.767s clip at the head. */
function projectWithClipAtHead(): Project {
  return parseProject({
    id: 'stock_host_project',
    name: 'Stock host fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [{ id: 'base', path: 'media/base.mp4', kind: 'video', durationSeconds: 7.767 }],
    timeline: {
      revision: 1,
      tracks: [
        {
          id: 'layer_video_1',
          type: 'video',
          clips: [
            {
              id: 'base_clip',
              assetId: 'base',
              trackId: 'layer_video_1',
              start: 0,
              end: 7.767,
              sourceStart: 0,
              sourceEnd: 7.767,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/** An empty project, for the very first download of a run. */
function emptyProject(): Project {
  return parseProject({
    id: 'stock_host_empty',
    name: 'Empty',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [],
    timeline: { revision: 1, tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function downloaded(remoteId: string): StockDownloadResult {
  return {
    ok: true,
    asset: {
      relativePath: `media/Video_${remoteId}.mp4`,
      kind: 'video',
      durationSeconds: 7.767,
      source: {
        provider: 'pexels',
        remoteId,
        license: 'pexels',
        attributionRequired: false,
        fetchedAt: '2026-08-26T05:33:39.310Z',
      },
    },
  } as unknown as StockDownloadResult;
}

/** A stock service that knows every id and always downloads. */
function io(
  durationSeconds: number | null = 13,
): StockHostIO & { download: ReturnType<typeof vi.fn> } {
  const download = vi.fn(async (request: { remoteId: string }) => downloaded(request.remoteId));
  return {
    unresolvableReason: () => null,
    knownItem: () => ({ durationSeconds }),
    download: download as unknown as StockHostIO['download'],
  } as StockHostIO & { download: ReturnType<typeof vi.fn> };
}

describe('createStockHost — an absent atSeconds means the bin', () => {
  it('gathers into the bin even when the head of the timeline is occupied', async () => {
    // The run.md failure, exactly: the first stock clip is already at 0–7.767s
    // and four more arrive with no position. They are bin fills, not placements,
    // so there is nothing for them to collide with.
    const deps = io();
    const host = createStockHost(deps);

    for (const remoteId of ['8475065', '854232', '7087631', '5377991']) {
      const outcome = await host(projectWithClipAtHead(), { remoteId, kind: 'video' });
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).not.toMatch(/already picture/);
    }
    expect(deps.download).toHaveBeenCalledTimes(4);
  });

  it('echoes NO position back, so the orchestrator builds bin-only operations', async () => {
    const host = createStockHost(io());
    const outcome = await host(emptyProject(), { remoteId: '8474616', kind: 'video' });
    expect(outcome.status).toBe('completed');
    const data = outcome.data as { atSeconds?: number };
    // An echoed `0` reads as "place it at the head" downstream. Absent must stay absent.
    expect(data.atSeconds).toBeUndefined();
    expect('atSeconds' in data).toBe(false);
  });

  it('does not spend a download when the id is unresolvable', async () => {
    const deps = io();
    const host = createStockHost({ ...deps, unresolvableReason: () => 'That clip is gone.' });
    const outcome = await host(emptyProject(), { remoteId: 'x', kind: 'video' });
    expect(outcome).toEqual({ status: 'failed', summary: 'That clip is gone.' });
    expect(deps.download).not.toHaveBeenCalled();
  });
});

describe('createStockHost — a given atSeconds still means the timeline', () => {
  it('refuses an occupied span before spending the download, naming a free moment', async () => {
    const deps = io(13);
    const host = createStockHost(deps);
    const outcome = await host(projectWithClipAtHead(), {
      remoteId: '8475065',
      kind: 'video',
      atSeconds: 0,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toMatch(/already picture on the timeline between 0.0s and 13.0s/);
    // The whole point of the refusal: it says where to go instead. 7.767s is the
    // end of the clip in the way, and nothing follows it.
    expect(outcome.summary).toMatch(/starts at 7.8s/);
    // And it DECLARES the rule it refused under, which is what makes the run remember it.
    expect(outcome.refusalCause).toBe('picture_over_picture');
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('places into empty time and echoes the clamped position', async () => {
    const host = createStockHost(io(13));
    const outcome = await host(projectWithClipAtHead(), {
      remoteId: '8475065',
      kind: 'video',
      atSeconds: 10,
    });
    expect(outcome.status).toBe('completed');
    expect((outcome.data as { atSeconds?: number }).atSeconds).toBe(10);
  });

  it('clamps a negative position to 0 rather than failing the download over it', async () => {
    const host = createStockHost(io(13));
    const outcome = await host(emptyProject(), {
      remoteId: '8475065',
      kind: 'video',
      atSeconds: -5,
    });
    expect(outcome.status).toBe('completed');
    expect((outcome.data as { atSeconds?: number }).atSeconds).toBe(0);
  });

  it('gives a still the default length when probing occupancy', async () => {
    // No duration of its own: the probe has to use the same default the
    // placement builder does, or the two disagree about what fits.
    const deps = io(null);
    const host = createStockHost(deps);
    const outcome = await host(projectWithClipAtHead(), {
      remoteId: 'photo1',
      kind: 'photo',
      atSeconds: 0,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toMatch(/between 0.0s and 5.0s/);
    expect(deps.download).not.toHaveBeenCalled();
  });
});

/**
 * WHICH failures declare a cause, and which must not.
 *
 * A declared `refusalCause` is the one way a host outcome earns a run-memory key
 * (`orchestrator.ts#deterministicFailureKey`), and the key is permanent for the run. That
 * is the right answer for a POLICY verdict — this module's placement refusal is a pure
 * function of the arguments and the project, decided before a byte is spent, and
 * undeclared it was the last unbounded arm of run `369e8c82`'s loop: four refusals of ADR
 * 0140 in fifteen minutes, none of them matching, because the sentence interpolates the
 * times and the colliding clip.
 *
 * It is the WRONG answer for anything that merely failed. A download timeout, a provider
 * 5xx, a rate limit, a missing key, an id from a closed session — every one of those can
 * succeed on the next attempt, and a permanent block would lose `add_stock` for the rest
 * of the run over a bad network moment. So this walks the module's other failure exits and
 * pins that they declare nothing.
 */
describe('createStockHost — only the policy refusal declares a cause', () => {
  it('leaves an unresolvable id undeclared, so the model may try another', async () => {
    const host = createStockHost({ ...io(), unresolvableReason: () => 'That clip is gone.' });
    const outcome = await host(emptyProject(), { remoteId: 'x', kind: 'video' });
    expect(outcome.status).toBe('failed');
    expect(outcome).not.toHaveProperty('refusalCause');
  });

  it('leaves a failed download undeclared, however it failed', async () => {
    // Walked over the whole closed union rather than a sample: a code added tomorrow must
    // be answered deliberately, and none of these says anything about PLACEMENT — they say
    // the fetch did not happen, which the next attempt may well change.
    for (const error of STOCK_ERROR_CODES) {
      const deps = io();
      const host = createStockHost({
        ...deps,
        download: (async () => ({ ok: false, error })) as unknown as StockHostIO['download'],
      });
      const outcome = await host(emptyProject(), { remoteId: '8475065', kind: 'video' });
      expect(outcome.status).toBe('failed');
      expect(outcome).not.toHaveProperty('refusalCause');
    }
  });

  it('declares nothing on the paths that succeed', async () => {
    const host = createStockHost(io(13));
    const placed = await host(projectWithClipAtHead(), {
      remoteId: '8475065',
      kind: 'video',
      atSeconds: 10,
    });
    const binned = await host(projectWithClipAtHead(), { remoteId: '8475065', kind: 'video' });
    expect(placed).not.toHaveProperty('refusalCause');
    expect(binned).not.toHaveProperty('refusalCause');
  });
});
