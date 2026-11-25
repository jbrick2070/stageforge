import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixture = new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url);
const side = page => page.evaluate(() => window.stageforgeProbe.screens().find(s => s.id === 'side-led'));
const openFiles = async page => {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  return page.getByRole('dialog', { name: 'Show files' });
};

test('resume, pause and a backward cue jump while playing keep the secondary wall on the take clock', async ({ page }) => {
  test.setTimeout(90_000);
  const video = await readFile(new URL('../../public/examples/amber-clouds.mp4', import.meta.url));
  await page.goto('/?probe');
  let files = await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles(fileURLToPath(fixture));
  await expect(files).toBeHidden();
  files = await openFiles(page);
  await files.getByLabel('Relink media files').setInputFiles(['amber-clouds.mp4', 'blue-raster.mp4', 'guest-surface.mp4']
    .map(name => ({ name, mimeType: 'video/mp4', buffer: video })));
  await expect(files.getByRole('status')).toHaveText('Relinked 3 media references.');
  await files.getByRole('button', { name: 'Close Show files' }).click();

  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  // Idle scrub just before the side wall's 13.5 s "play" cue, then resume from there.
  await page.getByRole('slider', { name: 'Take position' }).fill('13000');
  await page.getByRole('button', { name: 'Resume take', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  await expect.poll(() => side(page), { timeout: 10_000 }).toMatchObject({ name: 'blue-raster.mp4', playing: true });

  // Pause holds the wall: not playing and its position does not drift.
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume take', exact: true })).toBeVisible();
  await expect.poll(async () => (await side(page)).playing).toBe(false);
  const held = (await side(page)).offsetSeconds;
  await page.waitForTimeout(500);
  expect(Math.abs((await side(page)).offsetSeconds - held)).toBeLessThan(0.05);

  await page.getByRole('button', { name: 'Resume take', exact: true }).click();
  await expect.poll(async () => (await side(page)).playing).toBe(true);

  // A backward cue jump while playing keeps the replay running and re-resolves the wall.
  await page.getByRole('button', { name: '0:06.5 Blue sweep' }).click();
  await expect(page.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  await expect.poll(() => side(page)).toMatchObject({ name: 'guest-surface.mp4', playing: false });
  await page.getByRole('button', { name: 'Stop replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Replay take', exact: true })).toBeVisible();
});

test('a show with secondary wall cues but no recorded lighting events can still be replayed and scrubbed', async ({ page }, info) => {
  const show = JSON.parse(await readFile(fixture, 'utf8'));
  show.timeline.events = [];
  const path = info.outputPath('wall-only.stageforge.show.json');
  await writeFile(path, JSON.stringify(show));

  await page.goto('/?probe');
  const files = await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles(path);
  await expect(files).toBeHidden();

  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  const replay = page.getByRole('button', { name: 'Replay take', exact: true });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect(page.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  // Scrubbing while playing moves the wall; the unlinked clip shows its slate.
  await page.getByRole('slider', { name: 'Take position' }).fill('12000');
  await expect.poll(() => side(page)).toMatchObject({ name: 'blue-raster.mp4', missing: true });
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume take', exact: true })).toBeVisible();
});

test('reopening a paused bundle holds the main LED offset, and removing wall-only cues clears the ghost timeline', async ({ page, browser }, info) => {
  test.setTimeout(90_000);
  const video = await readFile(new URL('../../public/examples/amber-clouds.mp4', import.meta.url));
  await page.goto('/?probe');

  // 1. Add a wall cue on a fresh rig, verify Show files lists it, then delete it and verify Replay take disables again.
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await page.getByRole('button', { name: 'Add secondary LED screen', exact: true }).click();
  await page.getByRole('button', { name: 'Close Rig Builder', exact: true }).click();
  await page.getByRole('button', { name: 'Motors & FX', exact: true }).click();
  await page.getByLabel('Wall cue time (s)', { exact: true }).fill('4');
  await page.getByLabel('Load secondary screen media', { exact: true }).setInputFiles({
    name: 'house-loop.mp4', mimeType: 'video/mp4', buffer: video,
  });
  await page.getByRole('button', { name: 'Apply wall cue', exact: true }).click();

  let files = await openFiles(page);
  await files.getByText(/Recorded actions/).click();
  await expect(files.locator('.take-list')).toContainText('house-loop.mp4');
  await files.getByRole('button', { name: 'Close Show files' }).click();

  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Replay take', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Motors & FX', exact: true }).click();
  await page.getByRole('button', { name: 'Remove wall cue at 0:04.0' }).click();
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Replay take', exact: true })).toBeDisabled();

  // 2. Open native v3, relink, scrub to 8.5s (main-led paused at 2.0s), save bundle, reopen fresh and verify held state.
  files = await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles(fileURLToPath(fixture));
  await expect(files).toBeHidden();
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('slider', { name: 'Take position' }).fill('8500');
  files = await openFiles(page);
  await files.getByLabel('Relink media files').setInputFiles(['amber-clouds.mp4', 'blue-raster.mp4', 'guest-surface.mp4']
    .map(name => ({ name, mimeType: 'video/mp4', buffer: video })));
  await expect(files.getByRole('status')).toHaveText('Relinked 3 media references.');
  const dlPromise = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show bundle' }).click();
  const dl = await dlPromise;
  const bundlePath = info.outputPath(dl.suggestedFilename());
  await dl.saveAs(bundlePath);
  // Close the authoring tab before opening a second WebGL context so SwiftShader doesn't contend across two tabs.
  await page.close();

  const fresh = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const second = await fresh.newPage();
    await second.goto('/?probe');
    const dialog = await openFiles(second);
    await dialog.getByLabel('Open show file').setInputFiles(bundlePath);
    await expect(dialog).toBeHidden();
    await expect.poll(() => second.evaluate(() => window.stageforgeProbe.primaryScreen())).toMatchObject({ playing: false });
    await expect.poll(async () => (await second.evaluate(() => window.stageforgeProbe.primaryScreen())).offsetSeconds).toBeCloseTo(2.0, 1);
  } finally {
    await fresh.close();
  }
});
