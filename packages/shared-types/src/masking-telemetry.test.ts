/**
 * RD2.2: the masking observability events carry no media, frames, prompts, paths or ids.
 *
 * Three checks: the catalogue's field names and kinds (nothing that could hold identifying or
 * media content), the allow-list (whatever an emit site passes, only catalogued scalars come
 * out), and the emit sites themselves (every catalogued event is logged through the allow-list,
 * at the catalogued level, by the catalogued scope).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MASKING_TELEMETRY_EVENTS,
  maskingEventPayload,
  type MaskingEventName,
  type MaskingFieldKind,
} from './masking-telemetry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_ROOTS = [
  'apps/desktop/electron',
  'apps/web-editor/src',
  'packages/capability-packs/src',
  'packages/ai-sdk/src',
  'packages/editor-core/src',
];

/**
 * Field names that would carry identity or content: ids, paths, names, text, prompts (as
 * content), media, pictures, hashes, keys, credentials. Counts of such things are named in the
 * plural (`frames`, `keys`, `prompts`) and typed `count`, which the kind check enforces.
 */
const FORBIDDEN_NAME =
  /(^id$|Id$|ids$|Ids$|path|url|uri|dir|file|name$|text|caption|media|image|picture|pixels$|^frame$|Frame$|hash|sha\d|^sha$|^key$|Key$|token|secret|email|user|account|project|asset|clip(?!s$)|mask(?!s$|ed)|request)/i;

const SCALAR_KINDS: ReadonlySet<MaskingFieldKind> = new Set<MaskingFieldKind>([
  'count',
  'ms',
  'ratio',
  'measure',
  'boolean',
  'enum',
  'version',
  'timestamp',
  'msByPhase',
]);

const EVENTS = Object.entries(MASKING_TELEMETRY_EVENTS) as [
  MaskingEventName,
  (typeof MASKING_TELEMETRY_EVENTS)[MaskingEventName],
][];

describe('the masking event catalogue', () => {
  it.each(EVENTS)('%s names no field that could carry an id, a path or media', (_, spec) => {
    for (const [field, kind] of Object.entries(spec.fields)) {
      expect(field, `${field} looks like identifying or media content`).not.toMatch(
        FORBIDDEN_NAME,
      );
      expect(SCALAR_KINDS.has(kind as MaskingFieldKind), `${field}: ${kind}`).toBe(true);
    }
  });

  it('a count of things is a number, never the things', () => {
    for (const [, spec] of EVENTS) {
      for (const [field, kind] of Object.entries(spec.fields)) {
        if (/s$/.test(field) && !/Ms$|ms$|Bytes$|alpha$|status$/.test(field)) {
          expect(['count', 'measure', 'msByPhase'], `${field}`).toContain(kind);
        }
      }
    }
  });
});

describe('maskingEventPayload', () => {
  it('keeps only catalogued fields of the declared kind', () => {
    const payload = maskingEventPayload('matteJobEnd', {
      at: '2026-09-18T12:00:00.000Z',
      status: 'completed',
      executionProvider: 'coreml',
      packVersion: '1.4.0',
      verifiedFrames: 90,
      flaggedFrames: 10,
      flaggedRatio: 0.1,
      phasesMs: { media: 12, 'worker.segment': 900, '/Users/me/clip.mov': 1 },
      totalMs: 1234,
      // What must never pass, however it arrives.
      clipId: 'clip_1',
      assetPath: '/Users/me/Movies/interview.mov',
      prompts: [{ x: 1, y: 2 }],
      frame: new Uint8Array(4),
    });
    expect(payload).toEqual({
      at: '2026-09-18T12:00:00.000Z',
      status: 'completed',
      executionProvider: 'coreml',
      packVersion: '1.4.0',
      verifiedFrames: 90,
      flaggedFrames: 10,
      flaggedRatio: 0.1,
      phasesMs: { media: 12, 'worker.segment': 900 },
      totalMs: 1234,
    });
  });

  it('drops a value of the wrong kind rather than coercing it', () => {
    expect(
      maskingEventPayload('matteJobStart', { prompts: [{ x: 1 }], rerun: 'yes' } as never),
    ).toEqual({});
    expect(
      maskingEventPayload('segmentFrameFailed', { code: '/private/tmp/worker.sock' }),
    ).toEqual({});
    expect(maskingEventPayload('matteJobEnd', { flaggedRatio: 1.5, totalMs: -3 })).toEqual({});
    expect(maskingEventPayload('trackingComplete', { pack: 'not a version' })).toEqual({});
    expect(maskingEventPayload('warmWorkerKilled', { reason: 'timed out' })).toEqual({
      reason: 'timed out',
    });
  });
});

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.(test|spec|perf\.test)\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(path.join(REPO_ROOT, root));
  return out;
}

interface EmitSite {
  readonly file: string;
  readonly level: string;
  readonly payload: string;
  readonly scope: string | undefined;
}

/** Every `log.<level>('<event>', <payload>` for a catalogued event, with the file's scope. */
function emitSites(): Map<MaskingEventName, EmitSite[]> {
  const names = EVENTS.map(([name]) => name).join('|');
  const call = new RegExp(`\\blog\\.(\\w+)\\(\\s*'(${names})'\\s*,\\s*([^\\n]*)`, 'g');
  const sites = new Map<MaskingEventName, EmitSite[]>();
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf-8');
      const scope = /createLogger\(\s*'([^']+)'\s*\)/.exec(text)?.[1];
      for (const match of text.matchAll(call)) {
        const name = match[2] as MaskingEventName;
        const list = sites.get(name) ?? [];
        list.push({
          file: path.relative(REPO_ROOT, file),
          level: match[1]!,
          payload: match[3]!.trim(),
          scope,
        });
        sites.set(name, list);
      }
    }
  }
  return sites;
}

describe('the emit sites', () => {
  const sites = emitSites();

  it.each(EVENTS)(
    '%s is emitted, by its scope and level, through the allow-list',
    (name, spec) => {
      const found = sites.get(name) ?? [];
      expect(found.length, `no emit site for ${name}`).toBeGreaterThan(0);
      for (const site of found) {
        expect(site.scope, site.file).toBe(spec.scope);
        expect(site.level, site.file).toBe(spec.level);
        // The payload is built by the allow-list, directly or by a helper that returns it.
        expect(site.payload, site.file).toMatch(/^(maskingEventPayload\(|\w+Payload\()/);
      }
    },
  );
});
