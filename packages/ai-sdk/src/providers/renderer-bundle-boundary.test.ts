import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function locate(candidates: readonly string[]): string {
  const file = candidates.find(existsSync);
  if (!file) throw new Error(`Could not locate any of: ${candidates.join(', ')}`);
  return file;
}

function readPackageJson(): { sideEffects?: unknown } {
  const candidates = [
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(process.cwd(), 'packages/ai-sdk/package.json'),
  ];
  const file = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      return parsed.name === '@framepilot/ai-sdk';
    } catch {
      return false;
    }
  });
  if (!file) throw new Error('Could not locate @framepilot/ai-sdk package.json.');
  return JSON.parse(readFileSync(file, 'utf8')) as { sideEffects?: unknown };
}

function providerRosterSource(): string {
  return readFileSync(
    locate([
      path.resolve(process.cwd(), 'src/providers/langchain-providers.ts'),
      path.resolve(process.cwd(), 'packages/ai-sdk/src/providers/langchain-providers.ts'),
    ]),
    'utf8',
  );
}

describe('renderer AI bundle boundary', () => {
  it('marks the SDK barrel as side-effect free so unused renderer exports can be dropped', () => {
    expect(readPackageJson().sideEffects).toBe(false);
  });

  it('keeps hosted SDK modules behind dynamic imports', () => {
    const source = providerRosterSource();
    expect(source).not.toMatch(/from ['"]@langchain\//);
    expect(source).toMatch(/import\('\.\/langchain-deepseek\.js'\)/);
    expect(source).toMatch(/import\('\.\/langchain-groq\.js'\)/);
    expect(source).toMatch(/import\('\.\/langchain-google\.js'\)/);
    expect(source).toMatch(/import\('\.\/langchain-ollama\.js'\)/);
    expect(source).toMatch(/import\('\.\/langchain-openai-compatible\.js'\)/);
  });
});
