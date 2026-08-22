/**
 * The declared precondition table must not fall behind the compiler that produces the codes.
 *
 * `COMMAND_REJECTION_CODES` states what can go wrong with each professional command
 * (FRAMEPILOT-95 §7.1's "preconditions" row), and `editor-capabilities.ts` republishes it so a
 * UI or MCP client can grey out a command and say why. A table like that is only worth
 * anything if adding a rejection to the compiler forces it to be updated, so this reads the
 * compiler's own source and checks every inline `rejected(...)` code against the declaration.
 *
 * Source-scanning matches the existing audit convention here (`contract-hardening.audit`,
 * `tool-dispatch.audit`, `runtime-policy.audit`). It catches the case that actually happens:
 * someone adds a new rejection branch to `compileRoll` and never touches the table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_REJECTION_CODES } from './professional-commands.js';

const SOURCE = readFileSync(join(__dirname, 'professional-commands.ts'), 'utf8');

/** Which command types each compile function serves, from the dispatch switch. */
const COMPILER_COMMANDS: Readonly<
  Record<string, readonly (keyof typeof COMMAND_REJECTION_CODES)[]>
> = {
  compileRoll: ['roll_edit'],
  compileSlip: ['slip_edit'],
  compileSlide: ['slide_edit'],
  compileRippleTrim: ['ripple_trim_edit'],
  compileRemoval: ['lift_edit', 'extract_edit'],
  compileInsert: ['insert_edit'],
  compileOverwrite: ['overwrite_edit'],
  compileReplace: ['replace_edit'],
  compileSwitchAngle: ['switch_angle_edit'],
  compileAsymmetricCut: ['j_cut_edit', 'l_cut_edit'],
};

/** Inline `rejected(..., 'code')` calls inside each top-level `compile*` function block. */
function inlineCodesByCompiler(): Map<string, Set<string>> {
  // ALL top-level functions, not just `compile*`: a helper defined between two compilers
  // would otherwise have its codes attributed to the one above it, which is exactly the
  // mistake that produced the first draft of the table.
  const starts = [...SOURCE.matchAll(/^function ([A-Za-z]+)\(/gm)].map((m) => ({
    name: m[1] as string,
    at: m.index as number,
  }));
  const byCompiler = new Map<string, Set<string>>();
  for (const [index, start] of starts.entries()) {
    const end =
      index + 1 < starts.length ? (starts[index + 1] as { at: number }).at : SOURCE.length;
    const body = SOURCE.slice(start.at, end);
    const codes = new Set<string>();
    for (const match of body.matchAll(/rejected\(\s*[a-zA-Z]+,\s*'([a-z_]+)'/g)) {
      codes.add(match[1] as string);
    }
    byCompiler.set(start.name, codes);
  }
  return byCompiler;
}

describe('declared command preconditions match the compiler', () => {
  it('declares every code its compiler raises inline', () => {
    const byCompiler = inlineCodesByCompiler();
    const missing: string[] = [];
    for (const [compiler, commands] of Object.entries(COMPILER_COMMANDS)) {
      const raised = byCompiler.get(compiler);
      expect(raised, `${compiler} not found in professional-commands.ts`).toBeDefined();
      for (const command of commands) {
        const declared = new Set<string>(COMMAND_REJECTION_CODES[command]);
        for (const code of raised ?? []) {
          if (!declared.has(code)) missing.push(`${command} is missing '${code}' (${compiler})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every command type the dispatch switch handles', () => {
    const dispatched = new Set(
      [...SOURCE.matchAll(/^\s+case '([a-z_]+_edit)':/gm)].map((m) => m[1] as string),
    );
    expect(dispatched.size).toBeGreaterThan(0);
    for (const command of dispatched) {
      expect(Object.keys(COMMAND_REJECTION_CODES)).toContain(command);
    }
  });

  it('declares the authority check on every command, since it runs before every dispatch', () => {
    for (const codes of Object.values(COMMAND_REJECTION_CODES)) {
      expect(codes).toContain('stale_timeline');
    }
  });

  it('declares only real rejection codes', () => {
    const union = new Set(
      [...SOURCE.matchAll(/^\s+\| '([a-z_]+)';?$/gm)].map((m) => m[1] as string),
    );
    expect(union.size).toBeGreaterThan(10);
    for (const [command, codes] of Object.entries(COMMAND_REJECTION_CODES)) {
      for (const code of codes) {
        expect(union, `${command} declares unknown code '${code}'`).toContain(code);
      }
    }
  });
});
