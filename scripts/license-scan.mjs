#!/usr/bin/env node
/**
 * Lightweight license gate for FramePilot dependencies.
 *
 * CI requirement (PRD §17): "No new dependency without license review."
 * This script walks installed package manifests and fails if any dependency
 * declares a license on the denylist (or no license at all, unless allow-listed).
 *
 * It is intentionally dependency-free so it runs in any CI step. Swap for a
 * richer tool (e.g. license-checker / FOSSA) once the dependency tree grows.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DENYLIST = ['GPL-3.0', 'AGPL-3.0', 'SSPL-1.0', 'BUSL-1.1', 'Commons-Clause'];
const ALLOW_MISSING = new Set(['framepilot']); // workspace roots without a license field

const root = process.cwd();
const nodeModules = join(root, 'node_modules');

if (!existsSync(nodeModules)) {
  console.log('[license-scan] node_modules not found — run `pnpm install` first. Skipping.');
  process.exit(0);
}

/** @type {{name:string, version:string, license:string}[]} */
const violations = [];
const seen = new Set();

function scanDir(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (entry.startsWith('@')) {
      scanDir(full); // scoped packages
      continue;
    }
    const pkgJson = join(full, 'package.json');
    if (!existsSync(pkgJson)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const license =
        typeof pkg.license === 'string'
          ? pkg.license
          : (pkg.license?.type ?? pkg.licenses?.[0]?.type ?? '');
      if (!license && !ALLOW_MISSING.has(pkg.name)) {
        violations.push({ name: pkg.name, version: pkg.version, license: '(none declared)' });
      } else if (DENYLIST.some((d) => license.includes(d))) {
        violations.push({ name: pkg.name, version: pkg.version, license });
      }
    } catch {
      /* ignore unreadable manifests */
    }
    // Nested node_modules
    const nested = join(full, 'node_modules');
    if (existsSync(nested) && statSync(nested).isDirectory()) scanDir(nested);
  }
}

scanDir(nodeModules);

if (violations.length > 0) {
  console.error('[license-scan] ❌ Disallowed or missing licenses detected:');
  for (const v of violations) console.error(`  - ${v.name}@${v.version}: ${v.license}`);
  console.error('\nReview required. Add an allow-list entry or replace the dependency.');
  process.exit(1);
}

console.log(`[license-scan] ✅ Checked ${seen.size} packages — no denylisted licenses.`);
