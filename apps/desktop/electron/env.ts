/**
 * Repo `.env` loading for the unpackaged desktop app.
 *
 * WHY process env wins: a variable set by the parent process (a test launcher, CI, a
 * developer's shell) is a deliberate override of the checked-out `.env`. The previous
 * inline loader overwrote `process.env` unconditionally, so an *empty* `.env` line such as
 * `FRAMEPILOT_LICENSE_DEV_BYPASS=` silently erased a value the launcher had just set —
 * standard dotenv semantics are "file fills gaps, never overrides". Pure and injectable so
 * the precedence is table-tested.
 */
import { readFileSync } from 'node:fs';

/** Parse `KEY=value` lines (comments and blanks skipped; matching outer quotes stripped). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    out[key] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Apply parsed `.env` values into `env`, filling only keys the process did not already
 * carry. Returns the keys that were applied (for a debug log).
 */
export function applyDotEnv(
  values: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/** Load `envPath` into `process.env` without overriding existing variables; missing file is fine. */
export function loadDotEnvFile(envPath: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  let text: string;
  try {
    text = readFileSync(envPath, 'utf-8');
  } catch {
    return [];
  }
  return applyDotEnv(parseDotEnv(text), env);
}
