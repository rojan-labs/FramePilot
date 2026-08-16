#!/usr/bin/env node
/**
 * Guard the base installer against payloads that belong in a Capability Pack.
 *
 * ADR 0114 draws one hard line: heavy CV/ML payloads ship as signed, on-demand
 * packs and NEVER inside the base installer, which the pack system itself may
 * grow by at most 10 MiB. That rule is easy to state and easy to break by
 * accident — one stray import of a worker module, one `extraResources` entry,
 * and 42 MiB of ONNX weights or a 90 MiB OpenCV tree rides along silently. The
 * installer still builds, the tests still pass, and nobody notices until the
 * download doubles.
 *
 * So this checks the built application tree for things that must not be there,
 * and reports installer sizes against a recorded budget.
 *
 *   node scripts/check-installer-budget.mjs [--dir apps/desktop/release] [--budget-mib 400]
 *
 * Dependency-free, matching the other scripts in this directory.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  return value;
}

const directory = option('dir', join('apps', 'desktop', 'release'));
const budgetMib = Number(option('budget-mib', '400'));
const MIB = 1024 * 1024;

/**
 * Payloads that mean a Capability Pack leaked into the base app.
 *
 * Matched on the file name, because the mechanism of the leak does not matter —
 * a bundled dependency, a copied resource and a stray build artifact are all the
 * same problem for a user's download.
 */
const FORBIDDEN = [
  { test: (name) => extname(name) === '.onnx', why: 'an ONNX model belongs in a Capability Pack' },
  { test: (name) => extname(name) === '.pt' || extname(name) === '.pth', why: 'a PyTorch checkpoint belongs in a Capability Pack' },
  { test: (name) => /^libopencv|^opencv_|^cv2\./i.test(name), why: 'OpenCV belongs in a Capability Pack' },
  { test: (name) => /^libonnxruntime/i.test(name), why: 'the ONNX runtime belongs in a Capability Pack' },
  { test: (name) => /^libtorch|^torch_/i.test(name), why: 'PyTorch belongs in a Capability Pack' },
  { test: (name) => /^framepilot[-_](tracking[-_]lite|subject[-_]intelligence)/i.test(name), why: 'a pack worker must never ship inside the base installer' },
];

const INSTALLER_SUFFIXES = new Set(['.dmg', '.exe', '.appimage', '.deb', '.rpm', '.zip']);

if (!existsSync(directory)) {
  console.log(`[installer-budget] ${directory} not found — nothing built to check. Skipping.`);
  process.exit(0);
}

const violations = [];
const installers = [];
let scanned = 0;

function walk(current) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return; // unreadable directory (e.g. a mounted image) is not a budget failure
  }
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    scanned += 1;
    const name = basename(entry.name);
    for (const rule of FORBIDDEN) {
      if (rule.test(name)) {
        violations.push({ path: full, why: rule.why });
        break;
      }
    }
    if (INSTALLER_SUFFIXES.has(extname(name).toLowerCase())) {
      installers.push({ name, bytes: statSync(full).size });
    }
  }
}

walk(directory);

if (installers.length === 0) {
  console.log(`[installer-budget] no installers under ${directory}; scanned ${scanned} files.`);
}

const oversized = installers.filter((installer) => installer.bytes > budgetMib * MIB);

for (const installer of installers.sort((a, b) => b.bytes - a.bytes)) {
  const mib = (installer.bytes / MIB).toFixed(1);
  const marker = installer.bytes > budgetMib * MIB ? 'OVER' : 'ok  ';
  console.log(`[installer-budget] ${marker} ${mib.padStart(8)} MiB  ${installer.name}`);
}

if (violations.length > 0) {
  console.error('\n[installer-budget] Capability Pack payload found inside the base installer:');
  for (const violation of violations) {
    console.error(`  - ${violation.path}\n      ${violation.why}`);
  }
}

if (oversized.length > 0) {
  console.error(
    `\n[installer-budget] ${oversized.length} installer(s) exceed the ${budgetMib} MiB budget.`,
  );
}

if (violations.length > 0 || oversized.length > 0) {
  process.exit(1);
}

console.log(`[installer-budget] ok — ${scanned} files scanned, no pack payload, within budget.`);
