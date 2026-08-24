#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  CapabilityPackCatalogSchema,
  CapabilityPackReleaseCoreSchema,
  SignedCapabilityPackCatalogSchema,
} from '../contracts.js';
import {
  PreparePackArtifactInputSchema,
  preparePackArtifact,
  prepareReleaseForPublication,
  publicationPlan,
  rollbackCatalog,
  signCatalog,
} from './release-tooling.js';
import { registerLocalCapabilityPack } from './local-registration.js';

const RollbackInputSchema = z.object({
  releaseDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export interface ReleaseCliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIo: ReleaseCliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

/** Run the offline Capability Pack release command without exposing signing keys in arguments. */
export async function runReleaseCli(
  args: readonly string[],
  io: ReleaseCliIo = defaultIo,
): Promise<number> {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const [command, ...operands] = normalizedArgs;
  if (!command || command === 'help' || command === '--help') {
    io.stdout(usage());
    return 0;
  }
  try {
    switch (command) {
      case 'generate-root-key': {
        // The one command that creates trust rather than consuming it. The
        // private key is written 0600 and never printed: a root that has been
        // through a terminal scrollback or a CI log is no longer a root.
        const [keyId, privateKeyPath, trustedKeysPath] = requireOperands(command, operands, 3);
        if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(keyId)) {
          throw new Error(`Root key id '${keyId}' is not a valid identifier.`);
        }
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        await writeFile(
          path.resolve(privateKeyPath),
          privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          { flag: 'wx', mode: 0o600 },
        );
        await writeJsonAtomic(trustedKeysPath, [
          {
            keyId,
            publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
        ]);
        io.stdout(
          `Root key '${keyId}' written. Keep ${privateKeyPath} offline — it never belongs in ` +
            'CI, a password manager shared with the team, or this repository.',
        );
        break;
      }
      case 'prepare-artifact': {
        const [inputPath, outputPath] = requireOperands(command, operands, 2);
        const input = PreparePackArtifactInputSchema.parse(await readJson(inputPath));
        await writeJsonAtomic(outputPath, await preparePackArtifact(input));
        break;
      }
      case 'register-local': {
        // Dev-only escape hatch: seed the store with a locally built worker so
        // pack-backed features are runnable without publishing a signed catalog.
        // Gated by FRAMEPILOT_DEV_PACK_REGISTRATION=1 inside the registration
        // itself — this CLI never bypasses that gate on the developer's behalf.
        const [inputPath, storeRoot, outputPath] = requireOperands(command, operands, 3);
        const input = await readJson(inputPath);
        const result = await registerLocalCapabilityPack(process.env, input, {
          storeRoot,
        });
        await writeJsonAtomic(outputPath, result);
        io.stdout(`Registered local pack ${result.identityKey}.`);
        break;
      }
      case 'sign-catalog': {
        const [catalogPath, keyPath, keyId, outputPath] = requireOperands(command, operands, 4);
        const catalog = CapabilityPackCatalogSchema.parse(await readJson(catalogPath));
        const privateKeyPem = await readFile(keyPath, 'utf8');
        await writeJsonAtomic(outputPath, signCatalog(catalog, { keyId, privateKeyPem }));
        break;
      }
      case 'prepare-release': {
        const [inputPath, outputPath] = requireOperands(command, operands, 2);
        const core = CapabilityPackReleaseCoreSchema.parse(await readJson(inputPath));
        await writeJsonAtomic(outputPath, prepareReleaseForPublication(core));
        break;
      }
      case 'publication-plan': {
        const [catalogPath, outputPath] = requireOperands(command, operands, 2);
        const envelope = SignedCapabilityPackCatalogSchema.parse(await readJson(catalogPath));
        await writeJsonAtomic(outputPath, publicationPlan(envelope));
        break;
      }
      case 'rollback': {
        const [catalogPath, rollbackPath, keyPath, keyId, outputPath] = requireOperands(
          command,
          operands,
          5,
        );
        const current = SignedCapabilityPackCatalogSchema.parse(await readJson(catalogPath));
        const rollback = RollbackInputSchema.parse(await readJson(rollbackPath));
        const privateKeyPem = await readFile(keyPath, 'utf8');
        await writeJsonAtomic(
          outputPath,
          rollbackCatalog(
            current,
            rollback.releaseDigests,
            rollback.generatedAt,
            rollback.expiresAt,
            { keyId, privateKeyPem },
          ),
        );
        break;
      }
      default:
        throw new Error(`Unknown release command: ${command}.`);
    }
    io.stdout(`Capability Pack release command '${command}' completed.`);
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8')) as unknown;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const target = path.resolve(filePath);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
}

function requireOperands(command: string, operands: readonly string[], count: 2): [string, string];
function requireOperands(
  command: string,
  operands: readonly string[],
  count: 3,
): [string, string, string];
function requireOperands(
  command: string,
  operands: readonly string[],
  count: 4,
): [string, string, string, string];
function requireOperands(
  command: string,
  operands: readonly string[],
  count: 5,
): [string, string, string, string, string];
function requireOperands(
  command: string,
  operands: readonly string[],
  count: number,
): string[] {
  if (operands.length !== count || operands.some((operand) => operand.length === 0)) {
    throw new Error(`Command '${command}' received invalid operands.\n${usage()}`);
  }
  return [...operands];
}

function usage(): string {
  return [
    'Usage: framepilot-pack <command>',
    '  generate-root-key <key-id> <private-key.pem> <trusted-keys.json>',
    '  prepare-artifact <input.json> <output.json>',
    '  register-local <input.json> <store-root> <output-record.json>',
    '      (dev only; requires FRAMEPILOT_DEV_PACK_REGISTRATION=1)',
    '  prepare-release <release-core.json> <release.json>',
    '  sign-catalog <catalog.json> <private-key.pem> <key-id> <output.json>',
    '  publication-plan <signed-catalog.json> <output.json>',
    '  rollback <signed-catalog.json> <rollback.json> <private-key.pem> <key-id> <output.json>',
    '',
    'Signing keys are read from files and are never accepted inline or written to output.',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runReleaseCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
