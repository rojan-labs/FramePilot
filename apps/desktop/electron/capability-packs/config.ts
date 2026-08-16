import { readFile } from 'node:fs/promises';
import type { TrustedCatalogKey } from '@framepilot/capability-packs/node';

export async function loadCapabilityPackRootKeys(
  filePath: string | undefined,
): Promise<readonly TrustedCatalogKey[]> {
  if (filePath === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Error(`Capability Pack root-key file is invalid: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) {
    throw new Error('Capability Pack root-key file must contain one to eight keys.');
  }
  const keys = parsed.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('keyId' in entry) ||
      typeof entry.keyId !== 'string' ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(entry.keyId) ||
      !('publicKeyPem' in entry) ||
      typeof entry.publicKeyPem !== 'string' ||
      entry.publicKeyPem.length < 64 ||
      entry.publicKeyPem.length > 8_192
    ) {
      throw new Error('Capability Pack root-key entry is invalid.');
    }
    return { keyId: entry.keyId, publicKeyPem: entry.publicKeyPem };
  });
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new Error('Capability Pack root-key file contains duplicate ids.');
  }
  return keys;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
