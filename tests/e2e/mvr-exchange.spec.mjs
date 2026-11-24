// MVR exchange in the Studio: export a show's rig, reopen it losslessly, and open another tool's file.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const showFile = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));

async function files(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('export the rig as MVR and reopen it in a fresh desk with the same trusses, hangs and screens', async ({ page, browser }, info) => {
  await page.goto('/?probe');
  let dialog = await files(page);
  await dialog.getByLabel('Open show file').setInputFiles(showFile);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.hangs())).length).toBe(2);
  const hangs = await page.evaluate(() => window.stageforgeProbe.hangs());
  const heads = (await page.evaluate(() => window.stageforgeProbe.beamAxes())).length;
  expect(heads).toBeGreaterThan(0);

  dialog = await files(page);
  const transfer = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Rig for consoles and visualizers/ }).click();
  const download = await transfer;
  expect(download.suggestedFilename()).toMatch(/\.mvr$/);
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const archive = unzipSync(new Uint8Array(await readFile(path)));
  expect(strFromU8(archive['GeneralSceneDescription.xml'])).toMatch(/<GeneralSceneDescription verMajor="1" verMinor="6" provider="StageForge"/);

  const fresh = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const second = await fresh.newPage();
    await second.goto('/?probe');
    const opener = await files(second);
    await opener.getByLabel('Open show file').setInputFiles(path);
    await expect(opener).toBeHidden();
    await expect(second.getByText(/from MVR/)).toBeVisible();
    await expect.poll(() => second.evaluate(() => window.stageforgeProbe.hangs())).toEqual(hangs);
    await expect.poll(async () => (await second.evaluate(() => window.stageforgeProbe.screens())).map(s => s.id).sort()).toEqual(['side-led']);
    await expect.poll(async () => (await second.evaluate(() => window.stageforgeProbe.beamAxes())).length).toBe(heads);
  } finally {
    await fresh.close();
  }
});

test('a third-party MVR opens as trusses and fixtures with notes about what changed', async ({ page }, info) => {
  const scene = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="OtherTool" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Club rig"><ChildList>
  <Truss uuid="AAAAAAAA-0000-4000-8000-000000000001" name="Front truss"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,-1000,4500}</Matrix>
   <Geometries/><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
   <ChildList>
    ${[-1500, -500, 500, 1500].map((x, i) => `<Fixture uuid="BBBBBBBB-0000-4000-8000-00000000000${i}" name="Spot ${i + 1}">
     <Matrix>{1,0,0}{0,1,0}{0,0,1}{${x},0,-300}</Matrix><GDTFSpec>missing.gdtf</GDTFSpec><GDTFMode>Std</GDTFMode>
     <FixtureID>${i + 1}</FixtureID><FixtureIDNumeric>${i + 1}</FixtureIDNumeric><UnitNumber>1</UnitNumber>
     <Addresses><Address break="0">${1 + i * 16}</Address></Addresses></Fixture>`).join('')}
   </ChildList></Truss>
  <FocusPoint uuid="CCCCCCCC-0000-4000-8000-000000000001" name="DSC"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,0}</Matrix><Geometries/></FocusPoint>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const path = info.outputPath('club.mvr');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, zipSync({ 'GeneralSceneDescription.xml': strToU8(scene) }));

  await page.goto('/?probe');
  const dialog = await files(page);
  await dialog.getByLabel('Open show file').setInputFiles(path);
  await expect(dialog).toBeHidden();
  const toast = page.getByText(/Opened Club rig from MVR · 4 fixtures · 1 truss/);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('fixture types were guessed');
  await expect(toast).toContainText('focus point');
  await expect(page.locator('header').getByText(/^4 fixtures/).first()).toBeVisible();
});
