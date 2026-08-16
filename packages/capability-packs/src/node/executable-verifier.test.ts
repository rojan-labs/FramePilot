import { describe, expect, it, vi } from 'vitest';
import type { CapabilityPackArtifact } from '../contracts.js';
import {
  CapabilityPackExecutableError,
  runBoundedCommand,
  verifyCapabilityPackExecutable,
  type BoundedCommandRunner,
} from './executable-verifier.js';

const macArtifact: CapabilityPackArtifact = {
  os: 'darwin',
  arch: 'arm64',
  url: 'https://packs.framepilot.ai/worker.zip',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  unpackedSizeBytes: 200,
  format: 'zip',
  entrypoint: 'bin/worker',
  maxFileCount: 1,
  files: ['bin/worker'],
  executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
};

describe('verifyCapabilityPackExecutable', () => {
  it('requires codesign identity and Gatekeeper approval for macOS', async () => {
    const runner = vi.fn<BoundedCommandRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: 'Identifier=ai.framepilot.worker\nTeamIdentifier=ABCDE12345\n',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: 'accepted' });

    await verifyCapabilityPackExecutable('/packs/worker', macArtifact, runner);

    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      executable: '/usr/bin/codesign',
      args: expect.arrayContaining(['--verify', '--strict', '/packs/worker']),
    });
    expect(runner.mock.calls[2]?.[0]).toMatchObject({ executable: '/usr/sbin/spctl' });
  });

  it('rejects a valid macOS signature from the wrong signed Team ID', async () => {
    const runner = vi.fn<BoundedCommandRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: 'TeamIdentifier=WRONG12345\n',
      });

    await expect(
      verifyCapabilityPackExecutable('/packs/worker', macArtifact, runner),
    ).rejects.toMatchObject({ code: 'executable_untrusted' });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('requires a valid Windows signature with the exact SHA-256 certificate identity', async () => {
    const certificateSha256 = 'b'.repeat(64);
    const artifact: CapabilityPackArtifact = {
      ...macArtifact,
      os: 'win32',
      arch: 'x64',
      executableTrust: { kind: 'windows_authenticode', certificateSha256 },
    };
    const runner = vi.fn<BoundedCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: `${certificateSha256}\r\n`,
      stderr: '',
    });

    await verifyCapabilityPackExecutable('C:\\packs\\worker.exe', artifact, runner);

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: 'powershell.exe',
        env: { FRAMEPILOT_PACK_ENTRYPOINT: 'C:\\packs\\worker.exe' },
      }),
    );
  });

  it('fails closed when the platform verifier reports an error', async () => {
    const runner = vi.fn<BoundedCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'invalid signature',
    });
    await expect(
      verifyCapabilityPackExecutable('/packs/worker', macArtifact, runner),
    ).rejects.toBeInstanceOf(CapabilityPackExecutableError);
  });
});

describe('runBoundedCommand', () => {
  it('runs an exact executable without a shell and captures bounded output', async () => {
    const result = await runBoundedCommand({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
    });
    expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
  });

  it('rejects an already cancelled command before spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runBoundedCommand({ executable: process.execPath, args: ['--version'], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'download_cancelled' });
  });
});
