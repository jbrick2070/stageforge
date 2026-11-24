import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strFromU8 } from 'fflate';

test('a native v3 show bundles secondary-only files, verifies integrity and reopens offline in a fresh desk', async ({page,browser},info) => {
  const showFile = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json',import.meta.url));
  const exampleVideo = await readFile(new URL('../../public/examples/amber-clouds.mp4',import.meta.url));
  const openPanel = async p => {
    await p.getByRole('button',{name:'Show files',exact:true}).click();
    return p.getByRole('dialog',{name:'Show files'});
  };
  await page.goto('/');
  let panel = await openPanel(page);
  await panel.getByLabel('Open show file').setInputFiles(showFile);
  await expect(panel).toBeHidden();
  panel = await openPanel(page);
  const missing = panel.getByText(/Files to relink/);
  await expect(missing).toContainText('guest-surface.mp4');
  await expect(missing).toContainText('blue-raster.mp4');
  await panel.getByRole('button',{name:'Save show bundle'}).click();
  await expect(panel.getByRole('status')).toContainText('Relink these files');
  const upload = name => ({name,mimeType:'video/mp4',buffer:exampleVideo});
  await panel.getByLabel('Relink media files').setInputFiles([upload('guest-surface.mp4'),upload('blue-raster.mp4')]);
  await expect(missing).toHaveText('Files to relink: amber-clouds.mp4');
  await panel.getByLabel('Relink media files').setInputFiles(upload('amber-clouds.mp4'));
  const transfer = page.waitForEvent('download');
  await panel.getByRole('button',{name:'Save show bundle'}).click();
  const download = await transfer;
  const saved = info.outputPath(download.suggestedFilename());
  await download.saveAs(saved);
  expect(download.suggestedFilename()).toBe('split-rig-rehearsal.stageforge.zip');
  const entries = unzipSync(await readFile(saved));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.media).toHaveLength(3);
  expect(manifest.media.every(e => e.durationSec > 0 && e.sha256.length === 64)).toBe(true);

  const fresh = await browser.newContext({baseURL: test.info().project.use.baseURL, acceptDownloads:true});
  try {
    const second = await fresh.newPage();
    await second.goto('/');
    const another = await openPanel(second);
    await another.getByLabel('Open show file').setInputFiles(saved);
    await expect(another).toBeHidden();
    await openPanel(second);
    await expect(another.getByText(/Files to relink/)).toHaveCount(0);
    await expect(another.getByRole('button',{name:'Relink media files…'})).toBeDisabled();
    entries['media/video/guest-surface.mp4'][0] ^= 1;
    await another.getByLabel('Open show file').setInputFiles({name:'bad.stageforge.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(entries))});
    await expect(another.getByRole('status')).toContainText('integrity check failed for guest-surface.mp4');
    await expect(another.getByText('Split Rig rehearsal', { exact: true })).toBeVisible();
    const roundTrip = second.waitForEvent('download');
    await another.getByRole('button',{name:'Save show JSON'}).click();
    const roundTripData = JSON.parse(await readFile(await (await roundTrip).path(),'utf8'));
    expect(roundTripData.stage).toEqual(JSON.parse(await readFile(showFile,'utf8')).stage);
  } finally { await fresh.close(); }
});
