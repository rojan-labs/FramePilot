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

function claudeAgentSdkSource(): string {
  return readFileSync(
    locate([
      path.resolve(process.cwd(), 'src/providers/claude-agent-sdk.ts'),
      path.resolve(process.cwd(), 'packages/ai-sdk/src/providers/claude-agent-sdk.ts'),
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

  // The LangChain adapters are safe to bundle: they are browser-capable, so the renderer
  // downloading a chunk it may never run costs bytes and nothing else. The Claude Agent
  // SDK is a different problem. It is Node-only — it spawns a subprocess and imports
  // `node:` builtins — so Vite would not merely bundle dead weight, it would emit a chunk
  // that throws at runtime, the same class of failure that already needed a bespoke
  // `resolveId` plugin for `@anthropic-ai/sdk`'s subpaths (see web-editor/vite.config.ts).
  //
  // Laziness alone does NOT prevent this: a dynamic `import()` of a string literal is
  // still statically analyzable, so Rollup follows it into the graph. Only a specifier
  // held in a variable is opaque to the bundler, which is why `claude-agent-sdk.ts`
  // routes both SDKs through consts. These assertions are the guard on that — a
  // well-meaning "tidy up the imports" refactor is exactly how it would be lost.
  describe('the Node-only Claude Agent SDK provider', () => {
    it('never statically imports a Node-only SDK', () => {
      const source = claudeAgentSdkSource();
      // `import type` is erased at compile time and carries no runtime dependency, so it
      // is allowed; a value import of either package is not.
      const valueImports = source
        .split('\n')
        .filter((line) => /^import\s/.test(line) && !/^import type\s/.test(line));
      expect(valueImports.join('\n')).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
      expect(valueImports.join('\n')).not.toMatch(/@modelcontextprotocol\/sdk/);
    });

    it('loads both SDKs through a specifier the bundler cannot follow', () => {
      const source = claudeAgentSdkSource();
      // A literal in the import() call would be followed; a const identifier is not.
      expect(source).not.toMatch(/import\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]\s*\)/);
      expect(source).toMatch(/const AGENT_SDK_SPECIFIER = '@anthropic-ai\/claude-agent-sdk'/);
      expect(source).toMatch(/import\(\s*\/\* @vite-ignore \*\/ AGENT_SDK_SPECIFIER\)/);
      expect(source).toMatch(/import\(\s*\/\* @vite-ignore \*\/ MCP_SDK_SPECIFIER\)/);
    });

    it('is reached from the factory only through a dynamic import', () => {
      const factory = readFileSync(
        locate([
          path.resolve(process.cwd(), 'src/providers/index.ts'),
          path.resolve(process.cwd(), 'packages/ai-sdk/src/providers/index.ts'),
        ]),
        'utf8',
      );
      expect(factory).not.toMatch(/^import .*from '\.\/claude-agent-sdk\.js'/m);
      expect(factory).toMatch(/import\('\.\/claude-agent-sdk\.js'\)/);
    });
  });
});
