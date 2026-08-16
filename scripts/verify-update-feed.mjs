#!/usr/bin/env node
/**
 * Verify a desktop update feed before it is published.
 *
 * electron-updater trusts `latest*.yml` completely: it downloads whatever the
 * feed names and checks the sha512 the feed states. That makes a malformed feed
 * the single worst artifact this project can publish — a feed pointing at a
 * missing file, or at a file whose hash no longer matches, breaks auto-update
 * for everyone who already installed, and they cannot be fixed by a later
 * release because their client is stuck on the broken feed.
 *
 * So this runs before upload and refuses to publish a feed that is not
 * internally consistent:
 *
 *   - every file named by the feed exists in the release directory
 *   - every sha512 in the feed matches the bytes on disk
 *   - every size matches
 *   - the feed version matches the version being released
 *   - the feed's primary `path` is one of its own files
 *
 * Dependency-free so it runs in any CI step, matching scripts/license-scan.mjs.
 *
 *   node scripts/verify-update-feed.mjs [--dir apps/desktop/release] [--version 1.2.3]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`--${name} needs a value`);
  }
  return value;
}

const problems = [];
function fail(message) {
  problems.push(message);
}

const directory = option('dir', join('apps', 'desktop', 'release'));
const expectedVersion = option('version', null);

if (!existsSync(directory)) {
  console.error(`[update-feed] release directory not found: ${directory}`);
  process.exit(1);
}

const feeds = readdirSync(directory).filter(
  (entry) => entry.startsWith('latest') && entry.endsWith('.yml'),
);

if (feeds.length === 0) {
  console.error(
    `[update-feed] no latest*.yml in ${directory} — electron-builder did not emit a feed, so ` +
      'publishing would leave clients with no update path.',
  );
  process.exit(1);
}

/**
 * Parse the small, flat subset of YAML electron-builder emits.
 *
 * Deliberately not a general YAML parser: the shape is fixed (scalars plus one
 * `files:` list of `url`/`sha512`/`size`), and a real parser would be a new
 * dependency for the one file in the repo that must never be wrong.
 */
function parseFeed(text) {
  const feed = { files: [] };
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue;
    const listItem = /^\s{2}-\s+(\w+):\s*(.*)$/.exec(rawLine);
    if (listItem) {
      current = { [listItem[1]]: unquote(listItem[2]) };
      feed.files.push(current);
      continue;
    }
    const nested = /^\s{4}(\w+):\s*(.*)$/.exec(rawLine);
    if (nested && current) {
      current[nested[1]] = unquote(nested[2]);
      continue;
    }
    const top = /^(\w+):\s*(.*)$/.exec(rawLine);
    if (top) {
      current = null;
      if (top[2] !== '') feed[top[1]] = unquote(top[2]);
    }
  }
  return feed;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function sha512Of(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

for (const feedName of feeds) {
  const feedPath = join(directory, feedName);
  const feed = parseFeed(readFileSync(feedPath, 'utf8'));

  if (!feed.version) {
    fail(`${feedName}: no version`);
  } else if (expectedVersion && feed.version !== expectedVersion) {
    fail(`${feedName}: version ${feed.version} does not match the release version ${expectedVersion}`);
  }

  if (feed.files.length === 0) {
    fail(`${feedName}: names no files, so a client would find nothing to download`);
  }

  for (const file of feed.files) {
    if (!file.url) {
      fail(`${feedName}: a file entry has no url`);
      continue;
    }
    const artifact = join(directory, decodeURIComponent(file.url));
    if (!existsSync(artifact)) {
      fail(`${feedName}: names ${file.url}, which is not in ${directory}`);
      continue;
    }
    if (file.sha512) {
      const actual = sha512Of(artifact);
      if (actual !== file.sha512) {
        fail(`${feedName}: sha512 for ${file.url} does not match the file on disk`);
      }
    } else {
      fail(`${feedName}: ${file.url} has no sha512, so the client cannot verify its download`);
    }
    if (file.size !== undefined && Number(file.size) !== statSync(artifact).size) {
      fail(`${feedName}: size for ${file.url} does not match the file on disk`);
    }
  }

  if (feed.path && !feed.files.some((file) => file.url === feed.path)) {
    fail(`${feedName}: primary path ${feed.path} is not among its own files`);
  }
}

if (problems.length > 0) {
  console.error('[update-feed] refusing to publish an inconsistent feed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `[update-feed] ok — ${feeds.length} feed(s) verified in ${directory}: ${feeds.join(', ')}`,
);
