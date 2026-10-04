import { describe, expect, it, vi } from 'vitest';
import type { RecentProject } from '../ipc/contract.js';
import {
  isListableProjectFileName,
  listProjectPage,
  NAME_PROBE_BYTES,
  parseProjectListRequest,
  PROJECT_LIST_MAX_LIMIT,
  projectFileStem,
  readTopLevelName,
  serveProjectList,
  type ProjectListIO,
} from './project-list.js';

const ROOT = '/projects';

interface FakeEntry {
  /** Omitted for a folder (stat reports "not a regular file"). */
  readonly modifiedAt?: number;
  /** File contents; a function throws to simulate an unreadable file. */
  readonly content?: string | (() => never);
  /** Shared by two names that reach the same file (a symlink). Defaults to the name. */
  readonly fileKey?: string;
}

/** In-memory projects root. Absolute paths outside {@link ROOT} are treated as sandbox escapes. */
function fakeIO(entries: Record<string, FakeEntry>, options: { unreadableRoot?: boolean } = {}) {
  const toName = (candidate: string): string | null => {
    if (!candidate.startsWith('/')) return candidate;
    return candidate.startsWith(`${ROOT}/`) ? candidate.slice(ROOT.length + 1) : null;
  };
  const io = {
    readRootNames: vi.fn(async () => {
      if (options.unreadableRoot) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return Object.keys(entries);
    }),
    statProjectFile: vi.fn(async (candidate: string) => {
      const name = toName(candidate);
      const entry = name === null ? undefined : entries[name];
      if (name === null || entry?.modifiedAt === undefined) return null;
      return {
        path: `${ROOT}/${name}`,
        fileKey: entry.fileKey ?? name,
        modifiedAt: entry.modifiedAt,
      };
    }),
    readHead: vi.fn(async (filePath: string, maxBytes: number) => {
      const content = entries[toName(filePath) ?? '']?.content;
      if (typeof content === 'function') content();
      return (content ?? '').slice(0, maxBytes);
    }),
  } satisfies ProjectListIO;
  return io;
}

const projectFile = (name: string): string =>
  JSON.stringify({ schemaVersion: 25, id: `project_${name}`, name, assets: [] }, null, 2);

const file = (modifiedAt: number, name?: string): FakeEntry => ({
  modifiedAt,
  content: projectFile(name ?? `Project at ${modifiedAt}`),
});

const recent = (fileName: string, name: string, openedAt: number): RecentProject => ({
  path: `${ROOT}/${fileName}`,
  name,
  openedAt,
});

const ALL = { offset: 0, limit: PROJECT_LIST_MAX_LIMIT };

describe('listProjectPage — ordering', () => {
  it('lists recents first in recents order, then the rest of the folder newest first', async () => {
    const io = fakeIO({
      'old.fp.json': file(100, 'Old'),
      'newest.fp.json': file(900, 'Newest'),
      'opened-first.fp.json': file(50),
      'middle.fp.json': file(500, 'Middle'),
      'opened-second.fp.json': file(800),
    });
    const recents = [
      recent('opened-first.fp.json', 'Opened first', 2_000),
      recent('opened-second.fp.json', 'Opened second', 1_000),
    ];

    const { entries, total } = await listProjectPage(io, recents, ALL);

    expect(entries.map((entry) => entry.name)).toEqual([
      'Opened first',
      'Opened second',
      'Newest',
      'Middle',
      'Old',
    ]);
    expect(entries.map((entry) => entry.recent)).toEqual([true, true, false, false, false]);
    expect(entries[0]).toEqual({
      path: `${ROOT}/opened-first.fp.json`,
      name: 'Opened first',
      lastActiveAt: 2_000,
      recent: true,
    });
    expect(entries[2]).toEqual({
      path: `${ROOT}/newest.fp.json`,
      name: 'Newest',
      lastActiveAt: 900,
      recent: false,
    });
    expect(total).toBe(5);
  });

  it('orders equal modification times by path so pages stay stable between requests', async () => {
    const io = fakeIO({ 'b.fp.json': file(10, 'B'), 'a.fp.json': file(10, 'A') });
    const { entries } = await listProjectPage(io, [], ALL);
    expect(entries.map((entry) => entry.name)).toEqual(['A', 'B']);
  });
});

describe('listProjectPage — what counts as a project', () => {
  it('lists only top-level .fp.json files: no backups, dotfiles, folders or other files', async () => {
    const io = fakeIO({
      'project_raw.fp.json': file(10, 'Raw'),
      'project_raw.v21.backup.fp.json': file(20),
      'project_old.backup.fp.json': file(30),
      'PROJECT_CAPS.FP.JSON': file(5, 'Caps'),
      '.framepilot-active.json': file(40),
      '.hidden.fp.json': file(50),
      media: {},
      exports: {},
      'looks-like-a-project.fp.json': {},
      'notes.txt': file(60),
      'settings.json': file(70),
    });

    const { entries, total } = await listProjectPage(io, [], ALL);

    expect(entries.map((entry) => entry.name)).toEqual(['Raw', 'Caps']);
    expect(total).toBe(2);
  });

  it.each([
    ['project.fp.json', true],
    ['Project Copy.fp.json', true],
    ['project.FP.JSON', true],
    ['project.v21.backup.fp.json', false],
    ['project.backup.fp.json', false],
    ['.framepilot-active.json', false],
    ['.project.fp.json', false],
    ['project.json', false],
    ['project.fp.json.tmp', false],
  ])('isListableProjectFileName(%j) is %s', (fileName, expected) => {
    expect(isListableProjectFileName(fileName)).toBe(expected);
  });
});

describe('listProjectPage — recents', () => {
  it('skips recents whose file is gone, lies outside the root, or is not a project file', async () => {
    const io = fakeIO({ 'kept.fp.json': file(10) });
    const recents = [
      recent('deleted.fp.json', 'Deleted', 5_000),
      { path: '/elsewhere/outside.fp.json', name: 'Outside', openedAt: 4_000 },
      recent('kept.v21.backup.fp.json', 'Backup', 3_000),
      recent('kept.fp.json', 'Kept', 2_000),
    ];

    const { entries, total } = await listProjectPage(io, recents, ALL);

    expect(entries).toEqual([
      { path: `${ROOT}/kept.fp.json`, name: 'Kept', lastActiveAt: 2_000, recent: true },
    ]);
    expect(total).toBe(1);
    expect(io.statProjectFile).not.toHaveBeenCalledWith(`${ROOT}/kept.v21.backup.fp.json`);
  });

  it('lists a project once when it is both a recent and a folder file', async () => {
    const io = fakeIO({ 'both.fp.json': file(10, 'Name in file'), 'other.fp.json': file(5) });
    const { entries, total } = await listProjectPage(
      io,
      [recent('both.fp.json', 'Name in recents', 1_000)],
      ALL,
    );

    expect(entries.map((entry) => [entry.path, entry.name, entry.recent])).toEqual([
      [`${ROOT}/both.fp.json`, 'Name in recents', true],
      [`${ROOT}/other.fp.json`, 'Project at 5', false],
    ]);
    expect(total).toBe(2);
  });

  it('dedupes by the file on disk, so a symlink or a second spelling is listed once', async () => {
    const io = fakeIO({
      'real.fp.json': { ...file(10, 'Real'), fileKey: 'inode-1' },
      'alias.fp.json': { ...file(10, 'Real'), fileKey: 'inode-1' },
    });
    const recents = [
      recent('alias.fp.json', 'Via alias', 2_000),
      recent('real.fp.json', 'Via real', 1_000),
    ];

    const { entries, total } = await listProjectPage(io, recents, ALL);

    expect(entries.map((entry) => entry.name)).toEqual(['Via alias']);
    expect(total).toBe(1);
  });

  it('keeps the recents path, so opening the entry behaves exactly as before', async () => {
    const io = fakeIO({ 'p.fp.json': file(10) });
    const { entries } = await listProjectPage(io, [recent('p.fp.json', 'P', 1)], ALL);
    expect(entries[0]?.path).toBe(`${ROOT}/p.fp.json`);
  });
});

describe('listProjectPage — paging', () => {
  const twelve = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`p${index}.fp.json`, file(index, `P${index}`)]),
  );

  it('returns the requested slice and the total of the whole list', async () => {
    const io = fakeIO(twelve);
    const first = await listProjectPage(io, [], { offset: 0, limit: 10 });
    const second = await listProjectPage(io, [], { offset: 10, limit: 10 });

    expect(first.entries.map((entry) => entry.name)).toEqual([
      'P11',
      'P10',
      'P9',
      'P8',
      'P7',
      'P6',
      'P5',
      'P4',
      'P3',
      'P2',
    ]);
    expect(second.entries.map((entry) => entry.name)).toEqual(['P1', 'P0']);
    expect(first.total).toBe(12);
    expect(second.total).toBe(12);
  });

  it('pages across the boundary between recents and folder files', async () => {
    const io = fakeIO(twelve);
    const recents = [recent('p0.fp.json', 'Recent zero', 1_000)];
    const { entries } = await listProjectPage(io, recents, { offset: 0, limit: 2 });
    expect(entries.map((entry) => entry.name)).toEqual(['Recent zero', 'P11']);
  });

  it('returns no entries past the end, with the same total', async () => {
    const io = fakeIO(twelve);
    expect(await listProjectPage(io, [], { offset: 40, limit: 10 })).toEqual({
      entries: [],
      total: 12,
    });
  });
});

describe('listProjectPage — names', () => {
  it('reads names only for folder entries on the returned page, from the file head', async () => {
    const io = fakeIO({
      'a.fp.json': file(3, 'A'),
      'b.fp.json': file(2, 'B'),
      'c.fp.json': file(1, 'C'),
      'r.fp.json': file(0, 'Name in file'),
    });

    await listProjectPage(io, [recent('r.fp.json', 'R', 9)], { offset: 0, limit: 2 });

    expect(io.readHead).toHaveBeenCalledTimes(1);
    expect(io.readHead).toHaveBeenCalledWith(`${ROOT}/a.fp.json`, NAME_PROBE_BYTES);
  });

  it('falls back to the file name when the name cannot be read, never throwing', async () => {
    const io = fakeIO({
      'unreadable.fp.json': {
        modifiedAt: 4,
        content: () => {
          throw new Error('EACCES');
        },
      },
      'corrupt.fp.json': { modifiedAt: 3, content: 'not json at all' },
      'no-name.fp.json': { modifiedAt: 2, content: '{ "schemaVersion": 25, "id": "x" }' },
      'blank-name.fp.json': { modifiedAt: 1, content: '{ "name": "   " }' },
    });

    const { entries } = await listProjectPage(io, [], ALL);

    expect(entries.map((entry) => entry.name)).toEqual([
      'unreadable',
      'corrupt',
      'no-name',
      'blank-name',
    ]);
  });

  it('finds the name in a large project from its head alone', async () => {
    const big = JSON.stringify({
      schemaVersion: 25,
      id: 'project_big',
      name: 'Big project',
      assets: Array.from({ length: 5_000 }, (_, index) => ({ id: `a${index}`, name: 'clip' })),
    });
    expect(big.length).toBeGreaterThan(NAME_PROBE_BYTES);
    const io = fakeIO({ 'big.fp.json': { modifiedAt: 1, content: big } });

    const { entries } = await listProjectPage(io, [], ALL);

    expect(entries[0]?.name).toBe('Big project');
  });
});

describe('listProjectPage — failures', () => {
  it('lists nothing when the root is missing or unreadable', async () => {
    const io = fakeIO({ 'a.fp.json': file(1) }, { unreadableRoot: true });
    const result = await listProjectPage(io, [recent('a.fp.json', 'A', 1)], ALL);
    expect(result).toEqual({ entries: [], total: 0 });
  });

  it('drops only the entry whose stat fails unexpectedly', async () => {
    const io = fakeIO({ 'a.fp.json': file(2, 'A'), 'b.fp.json': file(1, 'B') });
    io.statProjectFile.mockImplementationOnce(async () => {
      throw new Error('EIO');
    });
    const { entries } = await listProjectPage(io, [], ALL);
    expect(entries).toHaveLength(1);
  });
});

describe('readTopLevelName', () => {
  it('reads the project name, decoding escapes', () => {
    expect(readTopLevelName('{"schemaVersion":25,"id":"x","name":"Caf\\u00e9 \\"cut\\""}')).toBe(
      'Café "cut"',
    );
  });

  it('ignores a nested name and keeps scanning to the top-level one', () => {
    const head = JSON.stringify({
      assets: [{ id: 'a', name: 'clip name' }],
      meta: { name: 'nested' },
      label: 'name',
      name: 'Top level',
    });
    expect(readTopLevelName(head)).toBe('Top level');
  });

  it('ignores braces and quotes inside strings', () => {
    expect(readTopLevelName('{"note":"} { \\" [","name":"Safe"}')).toBe('Safe');
  });

  it.each([
    ['a head cut off inside the name', '{"id":"x","name":"Unfinish'],
    ['a head cut off before the name', '{"id":"x","assets":[{"name":"clip"'],
    ['a non-string name', '{"name":42}'],
    ['a JSON array', '[{"name":"x"}]'],
    ['an object that closes before any name', '{"id":"x"} {"name":"after"}'],
    ['empty text', ''],
  ])('returns null for %s', (_label, head) => {
    expect(readTopLevelName(head)).toBeNull();
  });
});

describe('projectFileStem', () => {
  it('drops the .fp.json extension in any case', () => {
    expect(projectFileStem('/p/My Edit.fp.json')).toBe('My Edit');
    expect(projectFileStem('/p/LOUD.FP.JSON')).toBe('LOUD');
  });
});

describe('parseProjectListRequest', () => {
  it('accepts whole-number offset and limit', () => {
    expect(parseProjectListRequest({ offset: 10, limit: 10 })).toEqual({ offset: 10, limit: 10 });
  });

  it('caps the limit', () => {
    expect(parseProjectListRequest({ offset: 0, limit: 10_000 })).toEqual({
      offset: 0,
      limit: PROJECT_LIST_MAX_LIMIT,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'all'],
    ['an array', [0, 10]],
    ['a missing offset', { limit: 10 }],
    ['a missing limit', { offset: 0 }],
    ['a negative offset', { offset: -1, limit: 10 }],
    ['a fractional offset', { offset: 1.5, limit: 10 }],
    ['a zero limit', { offset: 0, limit: 0 }],
    ['a NaN limit', { offset: 0, limit: Number.NaN }],
    ['an infinite limit', { offset: 0, limit: Number.POSITIVE_INFINITY }],
    ['a string limit', { offset: 0, limit: '10' }],
  ])('refuses %s', (_label, request) => {
    expect(parseProjectListRequest(request)).toBeNull();
  });
});

describe('serveProjectList', () => {
  it('refuses a malformed request without touching the disk', async () => {
    const io = fakeIO({ 'a.fp.json': file(1) });
    const result = await serveProjectList({ offset: -5, limit: 10 }, io, async () => []);
    expect(result.ok).toBe(false);
    expect(io.readRootNames).not.toHaveBeenCalled();
  });

  it('serves a page with its total', async () => {
    const io = fakeIO({ 'a.fp.json': file(1, 'A') });
    const result = await serveProjectList({ offset: 0, limit: 10 }, io, async () => []);
    expect(result).toEqual({
      ok: true,
      entries: [{ path: `${ROOT}/a.fp.json`, name: 'A', lastActiveAt: 1, recent: false }],
      total: 1,
    });
  });

  it('still lists the folder when the recents list cannot be read', async () => {
    const io = fakeIO({ 'a.fp.json': file(1, 'A') });
    const result = await serveProjectList({ offset: 0, limit: 10 }, io, async () => {
      throw new Error('recents unreadable');
    });
    expect(result).toMatchObject({ ok: true, total: 1 });
  });
});
