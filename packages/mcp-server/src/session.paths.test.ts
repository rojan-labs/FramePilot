/** BR4.12 L5: the MCP sandbox check covers every operation that writes a media path. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import { EditorSession, operationMediaPaths } from './session.js';

describe('MCP media path containment', () => {
  it('lists the paths of add_asset, restore_assets and relink_asset, and nothing else', () => {
    const asset = (path: string) => ({ id: path, path, kind: 'video' as const });
    expect(operationMediaPaths({ type: 'add_asset', asset: asset('/a.mp4') } as AnyOperation)).toEqual(['/a.mp4']);
    expect(operationMediaPaths({ type: 'restore_assets', assets: [asset('/a.mp4'), asset('/b.mp4')] } as AnyOperation)).toEqual(['/a.mp4', '/b.mp4']);
    expect(operationMediaPaths({ type: 'relink_asset', assetId: 'a', path: '/c.mp4' } as AnyOperation)).toEqual(['/c.mp4']);
    expect(operationMediaPaths({ type: 'move_asset', assetId: 'a', folderId: null } as AnyOperation)).toEqual([]);
  });

  it('refuses a relink or restore that escapes the projects root', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'framepilot-mcp-paths-')));
    mkdirSync(path.join(root, 'media'));
    writeFileSync(path.join(root, 'media', 'ok.mp4'), 'x');
    const session = new EditorSession(root);
    const check = (operations: AnyOperation[]) =>
      (session as unknown as { assertAssetPathsSandboxed(ops: AnyOperation[]): void }).assertAssetPathsSandboxed(operations);
    expect(() => check([{ type: 'relink_asset', assetId: 'a', path: '/etc/passwd' } as AnyOperation])).toThrow(
      expect.objectContaining({ code: 'unsafe_path' }),
    );
    expect(() =>
      check([{ type: 'restore_assets', assets: [{ id: 'a', path: path.join(root, 'media', 'ok.mp4'), kind: 'video' }, { id: 'b', path: '/tmp/x.mp4', kind: 'video' }] } as AnyOperation]),
    ).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
    expect(() => check([{ type: 'relink_asset', assetId: 'a', path: path.join(root, 'media', 'ok.mp4') } as AnyOperation])).not.toThrow();
  });
});
