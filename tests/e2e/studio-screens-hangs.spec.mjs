import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('Studio renders and seeks native v3 hangs and dual screens, then authors and reopens a portable bundle', async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  const showFile = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));
  const exampleVideo = await readFile(new URL('../../public/examples/amber-clouds.mp4', import.meta.url));
  const openFiles = async p => {
    await p.getByRole('button', { name: 'Show files', exact: true }).click();
    return p.getByRole('dialog', { name: 'Show files' });
  };

  await page.goto('/?probe');
  let files = await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles(showFile);
  await expect(files).toBeHidden();

  // Verify the native-authored 7-box aimed speaker hang rendered directly in Studio 3D.
  await expect.poll(async () => {
    const hangs = await page.evaluate(() => window.stageforgeProbe.hangs());
    return hangs.find(h => h.cabinets === 7);
  }).toMatchObject({ cabinets: 7, yaw: -21, tilt: -8, splay: 5.5 });

  // Seek to 8.5s before relinking to verify the secondary screen shows its missing-media slate.
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  const scrubber = page.getByRole('slider', { name: 'Take position' });
  await expect(scrubber).toBeVisible();
  await scrubber.fill('8500');
  await expect.poll(async () => {
    const [side] = await page.evaluate(() => window.stageforgeProbe.screens());
    return side;
  }).toMatchObject({ id: 'side-led', name: 'guest-surface.mp4', missing: true });

  // Relink all three videos (main + two secondary wall clips) and verify the secondary slate clears immediately.
  files = await openFiles(page);
  const upload = name => ({ name, mimeType: 'video/mp4', buffer: exampleVideo });
  await files.getByLabel('Relink media files').setInputFiles([
    upload('amber-clouds.mp4'),
    upload('blue-raster.mp4'),
    upload('guest-surface.mp4'),
  ]);
  await expect(files.getByRole('status')).toHaveText('Relinked 3 media references.');
  await files.getByRole('button', { name: 'Close Show files' }).click();

  await expect.poll(async () => {
    const [side] = await page.evaluate(() => window.stageforgeProbe.screens());
    return side;
  }).toMatchObject({ id: 'side-led', name: 'guest-surface.mp4', missing: false });
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.primaryScreen())).toMatchObject({ playing: false });
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.primaryScreen())).offsetSeconds).toBeCloseTo(2.0, 1);

  await scrubber.fill('14000');
  await expect.poll(async () => {
    const [side] = await page.evaluate(() => window.stageforgeProbe.screens());
    return side?.name;
  }).toBe('blue-raster.mp4');

  // Click timestamped cue jump chip back to 0:06.5 Blue sweep.
  await page.getByRole('button', { name: '0:06.5 Blue sweep' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.screens()))[0]?.name).toBe('guest-surface.mp4');

  // Author a speaker hang change and add a new secondary wall + timed clip directly in Studio.
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await page.getByLabel('Speaker hang', { exact: true }).selectOption('1');
  const yawInput = page.getByLabel('Hang aim (°)', { exact: true });
  await yawInput.fill('-30');
  await yawInput.press('Enter');
  await expect.poll(async () => {
    const hangs = await page.evaluate(() => window.stageforgeProbe.hangs());
    return hangs.find(h => h.cabinets === 7)?.yaw;
  }).toBe(-30);

  await page.getByRole('button', { name: 'Add screen', exact: true }).click();
  await page.getByLabel('Screen label', { exact: true }).fill('House left');
  await page.getByLabel('Screen label', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Close Rig Builder', exact: true }).click();

  await page.getByRole('button', { name: 'Motors & FX', exact: true }).click();
  await page.getByLabel('Secondary screen', { exact: true }).selectOption('wall-2');
  await page.getByLabel('Wall cue time (s)', { exact: true }).fill('4');
  await page.getByLabel('Wall cue offset (s)', { exact: true }).fill('0.5');
  await page.getByLabel('Load secondary screen media', { exact: true }).setInputFiles(upload('house-left.mp4'));
  await page.getByRole('button', { name: 'Apply wall cue', exact: true }).click();

  // Save as a portable .stageforge.zip bundle and reopen in a clean browser context with zero relinking.
  files = await openFiles(page);
  const transfer = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show bundle' }).click();
  const download = await transfer;
  const bundlePath = info.outputPath(download.suggestedFilename());
  await download.saveAs(bundlePath);

  const fresh = await browser.newContext({ baseURL: test.info().project.use.baseURL, acceptDownloads: true });
  try {
    const second = await fresh.newPage();
    await second.goto('/?probe');
    const dialog = await openFiles(second);
    await dialog.getByLabel('Open show file').setInputFiles(bundlePath);
    await expect(dialog).toBeHidden();
    await expect(second.getByRole('button', { name: /missing media/ })).toHaveCount(0);
    await expect.poll(async () => {
      const hangs = await second.evaluate(() => window.stageforgeProbe.hangs());
      return hangs.find(h => h.cabinets === 7);
    }).toMatchObject({ cabinets: 7, yaw: -30, tilt: -8, splay: 5.5 });
    await expect.poll(async () => {
      const screens = await second.evaluate(() => window.stageforgeProbe.screens());
      return screens.map(s => s.id).sort();
    }).toEqual(['side-led', 'wall-2']);

    await second.getByRole('button', { name: 'Show cues', exact: true }).click();
    await second.getByRole('slider', { name: 'Take position' }).fill('4500');
    await expect.poll(async () => {
      const screens = await second.evaluate(() => window.stageforgeProbe.screens());
      return screens.find(s => s.id === 'wall-2');
    }).toMatchObject({ id: 'wall-2', name: 'house-left.mp4', missing: false });
  } finally {
    await fresh.close();
  }
});
