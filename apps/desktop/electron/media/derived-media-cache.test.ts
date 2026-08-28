import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheDerivedMedia, type DeriveAssetMedia } from './derived-media-cache.js';
import type { DerivedAssetMedia } from './asset-media-client.js';

const PROXY_REL = '.framepilot-derived/abc/proxy.mp4';
const THUMB_REL = '.framepilot-derived/def/thumbs/thumb_000.png';

let root: string;
let source: string;

/** A projects root holding one source file and the artefacts a derivation would name. */
async function seedRoot(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'fp-derive-cache-'));
  source = join(root, 'media', 'p1', 'clip.mp4');
  await mkdir(join(root, 'media', 'p1'), { recursive: true });
  await writeFile(source, 'source bytes');
  for (const rel of [PROXY_REL, THUMB_REL]) {
    const absolute = join(root, rel);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, 'derived');
  }
}

const video = (media: DerivedAssetMedia['media']): DerivedAssetMedia => ({
  ok: true,
  kind: 'video',
  durationSeconds: 12,
  media,
});

const DERIVED = video({ proxyPath: PROXY_REL, thumbnailPaths: [THUMB_REL] });

const stub = (impl: () => Promise<DerivedAssetMedia | null>): DeriveAssetMedia =>
  vi.fn(impl) as unknown as DeriveAssetMedia;

describe('cacheDerivedMedia', () => {
  beforeEach(seedRoot);

  it('derives once for the warm pass and the serial commit that follows', async () => {
    // The whole point. `add_stock` is acquired concurrently then committed in series, so
    // the same file is materialized twice; the second pass downloaded zero bytes and paid
    // for a full ffprobe + waveform decode + thumbnail pass anyway (1.5–3.2s per asset in
    // the captured 42-download run).
    const derive = stub(async () => DERIVED);
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    expect(await cached(source)).toBe(DERIVED); // warm
    expect(await cached(source)).toBe(DERIVED); // serial commit
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('shares one derivation between callers racing for the same file', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const derive = stub(async () => {
      await gate;
      return DERIVED;
    });
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    const both = Promise.all([cached(source), cached(source)]);
    release();
    expect(await both).toEqual([DERIVED, DERIVED]);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('re-derives when the file on disk has been replaced', async () => {
    const derive = stub(async () => DERIVED);
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    await cached(source);
    await writeFile(source, 'different bytes, different length');
    await cached(source);

    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('re-derives when the file was rewritten at the same length', async () => {
    // Size alone is not identity — a re-fetch of the same rendition lands the same byte
    // count. The mtime is the other half of the stamp.
    const derive = stub(async () => DERIVED);
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    await cached(source);
    const later = new Date(Date.now() + 60_000);
    await utimes(source, later, later);
    await cached(source);

    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('re-derives when the derived proxy has been cleared from disk', async () => {
    // What makes this a memo and not a bet: handing back a proxy path that resolves to
    // nothing is the `fp-media://` ENOENT class of bug.
    const derive = stub(async () => DERIVED);
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    await cached(source);
    await rm(join(root, PROXY_REL));
    await cached(source);

    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('re-derives when a thumbnail has been cleared, not only the proxy', async () => {
    const derive = stub(async () => DERIVED);
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    await cached(source);
    await rm(join(root, THUMB_REL));
    await cached(source);

    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('caches a result that names no artefacts at all', async () => {
    // Audio: no proxy, no thumbnails, peaks only. Nothing to re-check on disk.
    const audio: DerivedAssetMedia = {
      ok: true,
      kind: 'audio',
      durationSeconds: 90,
      media: { peaks: [0.1], peaksPerSecond: 10 },
    };
    const derive = stub(async () => audio);
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    await cached(source);
    await cached(source);

    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('never remembers a failure', async () => {
    // A failure here usually means the sidecar was not running. Remembering it would turn
    // a restartable condition into a permanent one for the life of the session.
    const derive = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(DERIVED) as unknown as DeriveAssetMedia;
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    expect(await cached(source)).toBeNull();
    expect(await cached(source)).toBe(DERIVED);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('passes a missing source straight through to the real derivation', async () => {
    const derive = stub(async () => null);
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });
    const absent = join(root, 'media', 'p1', 'gone.mp4');

    expect(await cached(absent)).toBeNull();
    expect(derive).toHaveBeenCalledWith(absent);
  });

  it('evicts oldest-first so a long session cannot grow it without bound', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = join(root, 'media', 'p1', `${i}.mp4`);
      await writeFile(p, `bytes ${i}`);
      paths.push(p);
    }
    const derive = stub(async () => video({}));
    const cached = cacheDerivedMedia(derive, { projectsRoot: root, maxEntries: 2 });

    await cached(paths[0]!);
    await cached(paths[1]!);
    await cached(paths[2]!); // evicts paths[0]
    await cached(paths[1]!); // still cached
    expect(derive).toHaveBeenCalledTimes(3);

    await cached(paths[0]!); // evicted → re-derived
    expect(derive).toHaveBeenCalledTimes(4);
  });

  it('refuses a cached artefact path that no longer resolves inside the root', async () => {
    const derive = stub(async () => video({ proxyPath: '../../etc/passwd' }));
    const cached = cacheDerivedMedia(derive, { projectsRoot: root });

    await cached(source);
    await cached(source);

    // Never served from cache: a path that escapes the root is not one to hand back.
    expect(derive).toHaveBeenCalledTimes(2);
  });
});
