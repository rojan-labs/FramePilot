import { test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDesktop, FIXTURE_PROJECTS } from './launch.js';

test('probe', async () => {
  test.setTimeout(180_000);
  const udd = mkdtempSync(join(tmpdir(), 'fp-probe-'));
  writeFileSync(
    join(udd, 'recent-projects.json'),
    JSON.stringify([
      {
        path: join(FIXTURE_PROJECTS, 'mission-montage.fp.json'),
        name: 'mission-montage',
        openedAt: Date.now(),
      },
    ]),
  );
  const session = await launchDesktop({
    sidecarPort: 8798,
    userDataDir: udd,
    extraEnv: { FRAMEPILOT_LOG_LEVEL: 'debug' },
  });
  session.app.process().stdout?.on('data', (d) => console.log('MAIN', String(d).slice(0, 400)));
  session.app.process().stderr?.on('data', (d) => console.log('MAINERR', String(d).slice(0, 400)));
  session.page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 400)));
  session.page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 800)));
  await session.page.getByRole('button', { name: 'mission-montage' }).first().click();
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    const n = await session.page.locator('section[aria-label="timeline"]').count();
    const clips = await session.page.getByRole('button', { name: /^clip / }).count();
    console.log('TICK', ((Date.now() - t0) / 1000).toFixed(0), 'timeline=', n, 'clips=', clips);
    if (n > 0 && clips > 0) break;
    await session.page.waitForTimeout(5_000);
  }
  await session.app.close();
});
