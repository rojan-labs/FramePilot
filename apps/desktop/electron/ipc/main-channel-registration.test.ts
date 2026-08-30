import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IpcChannels } from './contract.js';

/**
 * plan/system-mission P6.3: every contract channel is wired in main exactly once.
 *
 * `ipcMain.handle` throws on a second registration for the same channel at runtime —
 * but only when the second call happens, which in a 127 KB `main.ts` is a code path a
 * refactor can reach long after the test suite passed. Reading the source pins it at
 * test time instead, and also catches the quieter failure: a channel the contract
 * declares that nothing in main serves, which surfaces to the renderer as a promise
 * that never settles.
 */
function electronRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), 'electron'),
    path.resolve(process.cwd(), 'apps/desktop/electron'),
  ];
  const dir = candidates.find((candidate) => existsSync(path.join(candidate, 'main.ts')));
  if (!dir) throw new Error('Could not locate apps/desktop/electron.');
  return dir;
}

/** Every main-process source (not tests, not the contract itself), concatenated. */
function mainProcessSource(): string {
  const root = electronRoot();
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (
        /\.(ts|cts)$/.test(entry.name) &&
        !/\.test\.(ts|cts)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        full !== path.join(root, 'ipc', 'contract.ts') &&
        entry.name !== 'preload.cts'
      ) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files
    .sort()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * Channels main registers by kind: request/response (`ipcMain.handle` or the deferred
 * `registrar.handle`), fire-and-forget (`ipcMain.on`), and any other reference (a push
 * channel handed to a hub as its event channel name).
 */
export function channelUses(source: string): {
  handle: Map<string, number>;
  on: Map<string, number>;
  referenced: Set<string>;
} {
  const count = (re: RegExp): Map<string, number> => {
    const out = new Map<string, number>();
    for (const match of source.matchAll(re)) {
      const key = match[1]!;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  };
  const handle = count(/(?:ipcMain|registrar)\.handle\(\s*IpcChannels\.([A-Za-z0-9_]+)/g);
  const on = count(/ipcMain\.on\(\s*IpcChannels\.([A-Za-z0-9_]+)/g);
  const referenced = new Set(
    [...source.matchAll(/IpcChannels\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!),
  );
  return { handle, on, referenced };
}

describe('main-process IPC registration', () => {
  const uses = channelUses(mainProcessSource());

  it('registers each request/response channel exactly once', () => {
    const twice = [...uses.handle.entries()].filter(([, n]) => n > 1).map(([key]) => key);
    expect(twice).toEqual([]);
  });

  it('serves or emits every channel the contract declares (nothing dangles)', () => {
    const unserved = Object.keys(IpcChannels).filter((key) => !uses.referenced.has(key));
    expect(unserved).toEqual([]);
  });

  it('never wires a channel as both request/response and fire-and-forget', () => {
    const both = [...uses.handle.keys()].filter((key) => uses.on.has(key));
    expect(both).toEqual([]);
  });
});
