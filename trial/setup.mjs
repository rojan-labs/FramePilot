#!/usr/bin/env node
/**
 * Trial-only bootstrap for auth2api.
 *
 * auth2api is not published to npm, so it cannot be a normal dependency: the
 * only supported install is a git clone + build. This script does that
 * idempotently into `trial/auth2api`, which is gitignored — FramePilot tracks
 * this bootstrap, never the vendored source.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_URL = 'https://github.com/AmazingAng/auth2api';
const TRIAL_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKOUT_DIR = join(TRIAL_DIR, 'auth2api');

/** Runs a command with inherited stdio, failing the script on a non-zero exit. */
function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(' ')}  (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function cloneOrUpdate() {
  if (!existsSync(CHECKOUT_DIR)) {
    run('git', ['clone', '--depth', '1', REPO_URL, CHECKOUT_DIR], TRIAL_DIR);
    return;
  }
  console.log(`\nauth2api already cloned at ${CHECKOUT_DIR} — updating.`);
  run('git', ['pull', '--ff-only'], CHECKOUT_DIR);
}

cloneOrUpdate();
run('npm', ['install'], CHECKOUT_DIR);
run('npm', ['run', 'build'], CHECKOUT_DIR);

console.log(
  [
    '\nauth2api is built.',
    '',
    'Next:',
    '  npm run login            # OAuth into Claude (browser)',
    '  npm run login:codex      # or ChatGPT Plus/Pro',
    '  npm start                # serve on http://127.0.0.1:8317',
    '',
    'The API key is auto-generated into trial/config.yaml on first start.',
  ].join('\n'),
);
