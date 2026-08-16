import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CapabilityPackLocation {
  readonly activeRoot: string;
  readonly previousRoot?: string;
}

/** Durable authority pointer for the active Capability Pack storage root. */
export class FileCapabilityPackLocation {
  constructor(
    private readonly configPath: string,
    private readonly defaultRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(): Promise<CapabilityPackLocation> {
    try {
      const parsed = parseLocation(JSON.parse(await readFile(this.configPath, 'utf8')));
      return {
        activeRoot: requireAbsolute(parsed.activeRoot),
        ...(parsed.previousRoot === undefined
          ? {}
          : { previousRoot: requireAbsolute(parsed.previousRoot) }),
      };
    } catch (error) {
      if (isMissing(error)) return { activeRoot: path.resolve(this.defaultRoot) };
      throw new Error(`Capability Pack storage location is invalid: ${errorMessage(error)}`);
    }
  }

  async commit(activeRootInput: string, previousRootInput: string): Promise<void> {
    const activeRoot = requireAbsolute(activeRootInput);
    const previousRoot = requireAbsolute(previousRootInput);
    const parent = path.dirname(this.configPath);
    const temporary = path.join(parent, `.${path.basename(this.configPath)}.${randomUUID()}.tmp`);
    await mkdir(parent, { recursive: true });
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({
          schemaVersion: 1,
          activeRoot,
          previousRoot,
          committedAt: this.now().toISOString(),
        })}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, this.configPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function parseLocation(input: unknown): {
  readonly activeRoot: string;
  readonly previousRoot?: string;
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('location record must be an object');
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'activeRoot', 'previousRoot', 'committedAt']);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.schemaVersion !== 1) {
    throw new Error('location record schema is unsupported');
  }
  if (typeof record.activeRoot !== 'string' || record.activeRoot.length === 0) {
    throw new Error('active storage root is missing');
  }
  if (record.previousRoot !== undefined && typeof record.previousRoot !== 'string') {
    throw new Error('previous storage root is invalid');
  }
  if (typeof record.committedAt !== 'string' || !Number.isFinite(Date.parse(record.committedAt))) {
    throw new Error('location commit timestamp is invalid');
  }
  return {
    activeRoot: record.activeRoot,
    ...(record.previousRoot === undefined ? {} : { previousRoot: record.previousRoot }),
  };
}

function requireAbsolute(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('storage root must be absolute');
  return path.resolve(input);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
