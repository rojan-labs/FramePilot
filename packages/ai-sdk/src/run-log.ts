/**
 * @framepilot/ai-sdk/run-log — dev-only tool/capability hit counter.
 *
 * NOT a product feature: no UI reads this, no persisted project state depends
 * on it. It exists so a developer can answer "how often does each tool fire,
 * and what happened when it did" while iterating locally. Opt-in only (set
 * `FRAMEPILOT_RUNS_LOG`) and a Node-only no-op everywhere else (browser
 * bundles have no filesystem), so it can sit on the hot tool-call path
 * without touching prod/browser behavior or test runs that don't opt in.
 *
 * View the log with `artifacts/tests/tool-analytics.html` (open it directly
 * in a browser and pick the JSONL file — nothing served, nothing installed).
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:run-log');

export interface RunLogEntry {
  readonly ts: string;
  readonly tool: string;
  readonly kind?: string;
  readonly mutates?: boolean;
  readonly status: string;
  readonly runtimeMs: number;
  readonly summary?: string;
  readonly fromCache?: boolean;
  readonly argsSummary?: string;
  readonly error?: string;
}

/**
 * Find the monorepo root (nearest ancestor with `pnpm-workspace.yaml`), walking up
 * from this module's own file — NOT `process.cwd()`. The desktop app's dev script
 * launches `electron .` with cwd = `apps/desktop`, the MCP server and CLI-driven
 * runs have their own cwd, and a relative filename resolved against `process.cwd()`
 * silently scatters the log across whichever directory happened to launch the host,
 * which is exactly what made a first pass at this feature write nothing findable.
 * A default anchored to this file's real location is the same on every host.
 */
function findRepoRoot(startDir: string, fsSync: typeof import('node:fs')): string {
  let dir = startDir;
  for (;;) {
    if (fsSync.existsSync(`${dir}/pnpm-workspace.yaml`)) return dir;
    const parent = dir.slice(0, dir.lastIndexOf('/'));
    if (!parent || parent === dir) return startDir;
    dir = parent;
  }
}

let cachedLogPath: string | null | undefined;

/** `FRAMEPILOT_RUNS_LOG=1` (or unset) ⇒ off. A path ⇒ that file. `1`/`true` ⇒ `<repo root>/framepilot.runs.jsonl`. */
async function resolveLogPath(): Promise<string | undefined> {
  if (cachedLogPath !== undefined) return cachedLogPath ?? undefined;
  /* v8 ignore next -- browser bundles have no `process` */
  if (typeof process === 'undefined' || !process.versions?.node) {
    cachedLogPath = null;
    return undefined;
  }
  const raw = process.env.FRAMEPILOT_RUNS_LOG;
  if (!raw) {
    cachedLogPath = null;
    return undefined;
  }
  if (raw !== '1' && raw !== 'true') {
    cachedLogPath = raw;
    return raw;
  }
  const [fsSync, url] = await Promise.all([import('node:fs'), import('node:url')]);
  const here = url.fileURLToPath(new URL('.', import.meta.url));
  const root = findRepoRoot(here.replace(/\/$/, ''), fsSync);
  cachedLogPath = `${root}/framepilot.runs.jsonl`;
  return cachedLogPath;
}

let warnedOnce = false;
let announcedPath: string | undefined;

/** Append one line for a completed tool call. Fire-and-forget; never throws, never blocks the run. */
export function recordToolRun(entry: RunLogEntry): void {
  void resolveLogPath().then((path) => {
    if (!path) return;
    if (announcedPath !== path) {
      announcedPath = path;
      log.action('recordToolRun → armed', { path });
    }
    import('node:fs')
      .then(({ appendFileSync }) => appendFileSync(path, `${JSON.stringify(entry)}\n`))
      .catch((error) => {
        if (warnedOnce) return;
        warnedOnce = true;
        log.warn('recordToolRun → failed to append', { path, reason: String(error) });
      });
  });
}
