/**
 * "The preview frame equals the export frame", measured the way the PX4 oracle measures it.
 *
 * The export's frame comes from the engine's own compositor (`grab_frame(lossless=True)` at the
 * monitor's canvas size) on the project file the editor just saved; the preview's frame is the
 * live program monitor's canvas after a seek, read back in the page. The comparison is the
 * oracle's `seekAndCompare` and the gates are the oracle's: PSNR >= 40 dB and >= 99.5% of pixels
 * within 8/255 per channel. Nothing is re-implemented here.
 */
import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { seekAndCompare, type Rgb } from '../parity-compare.js';
import type { Workspace } from './workspace.js';

/** The PX4 gates (`preview-parity-oracle.spec.ts`). Tightened there, never loosened here. */
export const PSNR_MIN_DB = 40;
export const CHANNEL_TOLERANCE = 8;
export const WITHIN_TOLERANCE_MIN_FRACTION = 0.995;
const GATES = { channelTolerance: CHANNEL_TOLERANCE, sentinelRadius: 40 };

/** The WebCodecs monitor mounted and loaded its first segments. */
export async function waitForMonitor(page: Page): Promise<void> {
  await expect(page.locator('.webcodecs-preview')).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const engine = (
            window as unknown as { __fpPreviewEngine?: { debugStats(): Record<string, number> } }
          ).__fpPreviewEngine;
          return engine ? engine.debugStats().segCount : 0;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
}

/** Put the monitor back on the program picture (a mask debug view tints the canvas). */
export async function monitorViewOff(page: Page): Promise<void> {
  const off = page
    .getByRole('group', { name: 'Mask view', exact: true })
    .getByRole('button', { name: 'Off', exact: true });
  if ((await off.count()) > 0) await off.click();
}

export interface ParitySample {
  readonly time: number;
  readonly psnr: number | null;
  readonly withinFraction: number | null;
  readonly maxChannelError: number | null;
}

/**
 * Assert the monitor matches the export at every `times` sample of the SAVED project.
 *
 * @param label - Names the attachments (and the case, in failure messages).
 * @returns The per-sample numbers, which the caller may log.
 */
export async function expectPreviewMatchesExport(
  page: Page,
  workspace: Workspace,
  times: readonly number[],
  label: string,
  testInfo: TestInfo,
  background: Rgb = [0, 0, 0],
): Promise<ParitySample[]> {
  await monitorViewOff(page);
  await waitForMonitor(page);
  const origin = new URL(page.url()).origin;
  const frames = await workspace.frames(times, label);
  const samples: ParitySample[] = [];
  const failures: string[] = [];
  for (const [index, time] of times.entries()) {
    const frame = frames[index]!;
    const args = {
      time,
      background,
      engineUrl: `${origin}${workspace.urlPath(frame.path)}`,
      palette: [],
      wantImages: false,
    };
    const compared = await seekAndCompare(page, args, GATES);
    samples.push({
      time,
      psnr: compared.psnr,
      withinFraction: compared.withinFraction,
      maxChannelError: compared.maxChannelError,
    });
    const reason =
      compared.presented === null
        ? 'the monitor never presented this time'
        : compared.psnr === null
          ? `size: preview ${compared.width}x${compared.height} != export ${compared.engineWidth}x${compared.engineHeight}`
          : compared.psnr < PSNR_MIN_DB || compared.withinFraction! < WITHIN_TOLERANCE_MIN_FRACTION
            ? `PSNR ${compared.psnr.toFixed(2)} dB (min ${PSNR_MIN_DB}), ${(compared.withinFraction! * 100).toFixed(3)}% within ${CHANNEL_TOLERANCE}/255`
            : null;
    if (reason === null) continue;
    failures.push(`${label} t=${time}: ${reason}`);
    // Evidence for the failure: the preview as read, the export's frame and the difference.
    const images = await seekAndCompare(page, { ...args, wantImages: true }, GATES);
    if (images.previewPng) {
      await testInfo.attach(`${label}-t${time}-preview.png`, {
        body: Buffer.from(images.previewPng, 'base64'),
        contentType: 'image/png',
      });
    }
    await testInfo.attach(`${label}-t${time}-export.png`, {
      body: await readFile(frame.path),
      contentType: 'image/png',
    });
    if (images.diffPng) {
      await testInfo.attach(`${label}-t${time}-diff.png`, {
        body: Buffer.from(images.diffPng, 'base64'),
        contentType: 'image/png',
      });
    }
  }
  testInfo.annotations.push({ type: `parity ${label}`, description: JSON.stringify(samples) });
  expect(failures, `${label}: preview != export`).toEqual([]);
  return samples;
}
