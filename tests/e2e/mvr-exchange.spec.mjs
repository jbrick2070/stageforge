// MVR exchange in the Studio: lossless StageForge round trip, foreign preflight, block Cancel purity, and accept-anyway.
import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const showFile = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));

async function files(page) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('export the rig as MVR and reopen it in a fresh desk with no warnings and the same trusses, hangs and screens', async ({ page, browser }, info) => {
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
    // Clean StageForge round trip commits directly with no preflight warnings.
    await expect(second.getByText(/from MVR/)).toBeVisible();
    await expect(second.getByRole('dialog', { name: 'MVR import preflight' })).toHaveCount(0);
    await expect.poll(() => second.evaluate(() => window.stageforgeProbe.hangs())).toEqual(hangs);
    await expect.poll(async () => (await second.evaluate(() => window.stageforgeProbe.screens())).map(s => s.id).sort()).toEqual(['side-led']);
    await expect.poll(async () => (await second.evaluate(() => window.stageforgeProbe.beamAxes())).length).toBe(heads);

    // Last import report stays viewable from Show files and shows zero warnings.
    const checkDialog = await files(second);
    await checkDialog.getByRole('button', { name: /Last MVR import report.*\(clean\)/ }).click();
    const reportDialog = second.getByRole('dialog', { name: 'Last MVR import report' });
    await expect(reportDialog).toBeVisible();
    await expect(reportDialog).toContainText('No warnings or losses detected');
    await reportDialog.getByRole('button', { name: 'Done' }).click();
    await expect(reportDialog).toBeHidden();
  } finally {
    await fresh.close();
  }
});

test('a third-party MVR opens preflight, imports on confirm, and keeps UUIDs and report viewable', async ({ page }, info) => {
  const scene = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="OtherTool" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Club rig"><ChildList>
  <Truss uuid="AAAAAAAA-0000-4000-8000-000000000001" name="Front truss"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,-1000,4500}</Matrix>
   <Geometries/><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
   <ChildList>
    ${[-1000, -333, 333, 1000].map((x, i) => `<Fixture uuid="BBBBBBBB-0000-4000-8000-00000000000${i}" name="Spot ${i + 1}">
     <Matrix>{1,0,0}{0,1,0}{0,0,1}{${x},0,-280}</Matrix><GDTFSpec>missing.gdtf</GDTFSpec><GDTFMode>Std</GDTFMode>
     <FixtureID>${i + 1}</FixtureID><FixtureIDNumeric>${i + 1}</FixtureIDNumeric><UnitNumber>1</UnitNumber>
     <Addresses><Address break="0">${1 + i * 16}</Address></Addresses></Fixture>`).join('')}
   </ChildList></Truss>
  <FocusPoint uuid="CCCCCCCC-0000-4000-8000-000000000001" name="DSC"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,0}</Matrix><Geometries/></FocusPoint>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const path = info.outputPath('club.mvr');
  await writeFile(path, zipSync({ 'GeneralSceneDescription.xml': strToU8(scene) }));

  await page.goto('/?probe');
  const dialog = await files(page);
  await dialog.getByLabel('Open show file').setInputFiles(path);
  await expect(dialog).toBeHidden();

  const preflight = page.getByRole('dialog', { name: 'MVR import preflight' });
  await expect(preflight).toBeVisible();
  await expect(preflight).toContainText('gdtf-missing');
  await expect(preflight).toContainText('fixture types were guessed');
  await expect(preflight).toContainText('focus point');
  const importBtn = preflight.getByRole('button', { name: 'Import', exact: true });
  await expect(importBtn).toBeEnabled();
  await importBtn.click();
  await expect(preflight).toBeHidden();

  const toast = page.getByText(/Opened Club rig from MVR · 4 fixtures · 1 truss/);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('fixture types were guessed');
  await expect(page.locator('header').getByText(/^4 fixtures/).first()).toBeVisible();

  // Save the imported foreign MVR as Show JSON (must emit v4 with persisted UUIDs & passthrough)
  // and re-export MVR (must keep original UUIDs and unmodeled FocusPoint/Support).
  const saveDialog = await files(page);
  const jsonTransfer = page.waitForEvent('download');
  await saveDialog.getByRole('button', { name: 'Save show JSON' }).click();
  const jsonDownload = await jsonTransfer;
  const jsonPath = info.outputPath(jsonDownload.suggestedFilename());
  await jsonDownload.saveAs(jsonPath);
  const savedShow = JSON.parse(await readFile(jsonPath, 'utf8'));
  expect(savedShow.version).toBe(4);
  expect(savedShow.interchange?.mvr?.uuids?.['truss:mvr-truss-1']).toBe('AAAAAAAA-0000-4000-8000-000000000001');
  expect(savedShow.interchange?.mvr?.passthrough?.sceneNodes?.some(s => s.includes('CCCCCCCC-0000-4000-8000-000000000001'))).toBe(true);

  const mvrTransfer = page.waitForEvent('download');
  await saveDialog.getByRole('button', { name: /Rig for consoles and visualizers/ }).click();
  const mvrDownload = await mvrTransfer;
  const mvrPath = info.outputPath('reexport-' + mvrDownload.suggestedFilename());
  await mvrDownload.saveAs(mvrPath);
  const reexported = unzipSync(new Uint8Array(await readFile(mvrPath)));
  const reexportedXml = strFromU8(reexported['GeneralSceneDescription.xml']);
  expect(reexportedXml).toContain('AAAAAAAA-0000-4000-8000-000000000001');
  expect(reexportedXml).toContain('BBBBBBBB-0000-4000-8000-000000000000');
  expect(reexportedXml).toContain('CCCCCCCC-0000-4000-8000-000000000001');
});

test('a blocking MVR opens preflight, Cancel leaves rig and saved design byte-identical, and accept-anyway imports and keeps report viewable', async ({ page }, info) => {
  await page.goto('/?probe');
  // Load a known v3 show so localStorage has a saved design and the desk has real authored state.
  let dialog = await files(page);
  await dialog.getByLabel('Open show file').setInputFiles(showFile);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.hangs())).length).toBe(2);

  // Snapshot localStorage and live probe state before opening the blocking MVR.
  const beforeStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return JSON.stringify(out);
  });
  const beforeProbe = await page.evaluate(() => JSON.stringify({
    hangs: window.stageforgeProbe.hangs(),
    screens: window.stageforgeProbe.screens(),
    beamCount: window.stageforgeProbe.beamAxes().length,
  }));

  // Synthetic blocking MVR: feet-scaled unit-suspect (< 0.5 m) + universe 3 + multi-break + custom fixture numbers + missing GDTF.
  const blockScene = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="FeetCAD" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Feet Block Rig"><ChildList>
  <Truss uuid="AAAAAAAA-9999-4000-8000-000000000001" name="LX1">
   <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,6,20}</Matrix>
   <Geometries/><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
   <ChildList>
    ${[-15, -5, 5, 15].map((ft, i) => `<Fixture uuid="BBBBBBBB-9999-4000-8000-00000000000${i + 1}" name="Block Spot ${i + 1}">
     <Matrix>{1,0,0}{0,1,0}{0,0,1}{${ft},0,-1}</Matrix><GDTFSpec>missing.gdtf</GDTFSpec><GDTFMode>Std</GDTFMode>
     <FixtureID>${101 + i}</FixtureID><FixtureIDNumeric>${101 + i}</FixtureIDNumeric><UnitNumber>1</UnitNumber>
     <Addresses><Address break="0">${1025 + i * 16}</Address><Address break="1">${1537 + i * 16}</Address></Addresses></Fixture>`).join('')}
   </ChildList>
  </Truss>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const blockPath = info.outputPath('feet-block.mvr');
  await writeFile(blockPath, zipSync({ 'GeneralSceneDescription.xml': strToU8(blockScene) }));

  // 1) Open the blocking MVR, inspect findings, and Cancel.
  dialog = await files(page);
  await dialog.getByLabel('Open show file').setInputFiles(blockPath);
  await expect(dialog).toBeHidden();

  const preflight = page.getByRole('dialog', { name: 'MVR import preflight' });
  await expect(preflight).toBeVisible();
  await expect(preflight).toContainText('Blocking issues');
  await expect(preflight).toContainText('unit-suspect');
  await expect(preflight).toContainText('universe-repatched');
  await expect(preflight).toContainText('break-dropped');
  await expect(preflight).toContainText('fixture-number-lost');

  // Expand affected items to confirm fixture IDs are surfaced.
  const firstDetails = preflight.locator('details.mvr-finding-ids').first();
  await firstDetails.locator('summary').click();
  await expect(firstDetails).toContainText('Block Spot');

  const importBtn = preflight.getByRole('button', { name: 'Import', exact: true });
  await expect(importBtn).toBeDisabled();

  await preflight.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(preflight).toBeHidden();

  // Verify localStorage and live desk probe are byte-identical after Cancel.
  const afterCancelStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return JSON.stringify(out);
  });
  const afterCancelProbe = await page.evaluate(() => JSON.stringify({
    hangs: window.stageforgeProbe.hangs(),
    screens: window.stageforgeProbe.screens(),
    beamCount: window.stageforgeProbe.beamAxes().length,
  }));
  expect(afterCancelStorage).toBe(beforeStorage);
  expect(afterCancelProbe).toBe(beforeProbe);

  // 2) Reopen, tick checkbox, press Escape (= Cancel), verify byte-identical, then reopen and verify checkbox reset.
  dialog = await files(page);
  await dialog.getByLabel('Open show file').setInputFiles(blockPath);
  await expect(dialog).toBeHidden();
  await expect(preflight).toBeVisible();
  await expect(importBtn).toBeDisabled();

  await preflight.getByLabel('Import anyway — the layout will differ').check();
  await expect(importBtn).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(preflight).toBeHidden();

  const afterEscStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return JSON.stringify(out);
  });
  expect(afterEscStorage).toBe(beforeStorage);

  // 3) Reopen again: checkbox must be reset (unchecked, Import disabled), then tick and confirm Import.
  dialog = await files(page);
  await dialog.getByLabel('Open show file').setInputFiles(blockPath);
  await expect(dialog).toBeHidden();
  await expect(preflight).toBeVisible();
  await expect(importBtn).toBeDisabled();

  await preflight.getByLabel('Import anyway — the layout will differ').check();
  await expect(importBtn).toBeEnabled();
  await importBtn.click();
  await expect(preflight).toBeHidden();

  await expect(page.getByText(/Opened Feet Block Rig from MVR · 4 fixtures · 1 truss/)).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.beamAxes())).length).toBe(4);
  const importedDesignName = await page.evaluate(() => JSON.parse(localStorage.getItem('stageforge.design.v1') ?? '{}').name);
  expect(importedDesignName).toBe('Feet Block Rig');

  const filesAfter = await files(page);
  await filesAfter.getByRole('button', { name: /Last MVR import report.*feet-block\.mvr/ }).click();
  const reportDialog = page.getByRole('dialog', { name: 'Last MVR import report' });
  await expect(reportDialog).toBeVisible();
  await expect(reportDialog).toContainText('unit-suspect');
  await expect(reportDialog).toContainText('Blocking issues');
  await reportDialog.getByRole('button', { name: 'Done' }).click();
  await expect(reportDialog).toBeHidden();
});
