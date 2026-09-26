/**
 * The release pipeline verifies the feed the app actually reads.
 *
 * electron-builder names the update feed after the publish channel (`channel: stable` in
 * `electron-builder.yml` writes `stable-mac.yml`, `stable.yml`, `stable-linux.yml`), and the app's
 * updater follows one of {@link UPDATE_CHANNELS}. `scripts/verify-update-feed.mjs` looked only for
 * `latest*.yml`, so the first macOS release build that got as far as the check failed it with a
 * correct feed beside it. This runs the script itself over a release directory per channel.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_CHANNELS } from './channel.js';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/verify-update-feed.mjs',
);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A release directory holding one installer and, unless `feed` is null, a feed naming it. */
function releaseDir(feed: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fp-feed-'));
  made.push(dir);
  const installer = Buffer.from('an installer');
  writeFileSync(path.join(dir, 'FramePilot-1.2.3-arm64.dmg'), installer);
  const sha512 = createHash('sha512').update(installer).digest('base64');
  if (feed !== null) {
    writeFileSync(
      path.join(dir, feed),
      [
        'version: 1.2.3',
        'files:',
        '  - url: FramePilot-1.2.3-arm64.dmg',
        `    sha512: ${sha512}`,
        `    size: ${String(installer.length)}`,
        'path: FramePilot-1.2.3-arm64.dmg',
        `sha512: ${sha512}`,
        "releaseDate: '2026-09-26T00:00:00.000Z'",
        '',
      ].join('\n'),
    );
  }
  return dir;
}

const verify = (dir: string) =>
  spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--version', '1.2.3'], { encoding: 'utf8' });

describe('verify-update-feed', () => {
  it.each(UPDATE_CHANNELS.map((channel) => `${channel}-mac.yml`))(
    'verifies the feed electron-builder writes for the channel: %s',
    (feed) => {
      const result = verify(releaseDir(feed));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it('still refuses a release directory with no feed at all', () => {
    const result = verify(releaseDir(null));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/did not emit a feed/u);
  });

  it('does not mistake electron-builder’s own debug file for a feed', () => {
    const dir = releaseDir(null);
    writeFileSync(path.join(dir, 'builder-debug.yml'), 'x64: {}\n');
    expect(verify(dir).status).toBe(1);
  });
});
