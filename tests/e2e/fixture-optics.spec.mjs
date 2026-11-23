import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { readFile } from 'node:fs/promises';

// Small authored multi-emitter GDTF fixture, with a geometry that omits flux.
const xml = '<GDTF DataVersion="1.2"><FixtureType Manufacturer="StageForge" Name="Optics rehearsal">' +
  '<Geometries><Geometry Name="Base"><Axis Name="Yoke"><Beam Name="Spot" BeamType="Spot" LuminousFlux="20000" BeamAngle="6"/>' +
  '<Beam Name="Wash" BeamType="Wash" BeamAngle="30"/></Axis></Geometry></Geometries></FixtureType></GDTF>';
const gdtf = { name: 'Rehearsal.gdtf', mimeType: 'application/octet-stream',
  buffer: Buffer.from(zipSync({ 'description.xml': strToU8(xml) })) };

test('import a chosen GDTF emitter, change its lumens, keep the DMX dimmer and reopen the optical settings', async ({ page }) => {
  await page.goto('/?probe');
  const files = page.getByRole('dialog', { name: 'Show files' });
  const openFiles = page.getByRole('button', { name: 'Show files' });
  await openFiles.click();
  await files.getByRole('button', { name: 'Open Amber Walk-on example' }).click();
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('button', { name: 'Cue 2, Amber reveal' }).click();
  await page.getByRole('button', { name: 'Rig builder' }).click();
  const editor = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Fixture optics' }) }).first();
  await editor.locator('summary').click();
  const reading = () => page.evaluate(() => window.stageforgeProbe.beamAxes()[0].optics);
  await expect.poll(async () => (await reading()).dimmer).toBeGreaterThan(0);
  const before = await reading();
  const reference = editor.getByLabel('Reference optics');
  await reference.selectOption({ label: 'MAC Aura XIP · Wide' });
  await expect.poll(async () => (await reading()).lumens).toBe(6000);
  await expect(editor).toContainText('Manufacturer sheet');
  await reference.selectOption({ label: 'Rogue R1 BeamWash · Narrow' });
  await expect.poll(async () => (await reading()).lumens).toBe(1483);
  await reference.selectOption({ label: 'Generic beam' });
  const flux = editor.getByRole('spinbutton', { name: 'Rated lumens per fixture' });
  await flux.fill('15000');
  await flux.press('Enter');
  await expect.poll(async () => {
    const r = await reading();
    return [r.lumens, r.dimmer];
  }).toEqual([15000, before.dimmer]);
  const rated = await reading();
  await flux.fill('7500');
  await flux.press('Enter');
  await expect.poll(async () => (await reading()).emitted).toBeCloseTo(rated.emitted / 2, 3);
  expect((await reading()).dimmer).toBe(before.dimmer);
  await editor.getByLabel('Import GDTF optics').setInputFiles({ ...gdtf, buffer: Buffer.from('invalid') });
  await expect(editor.getByRole('alert')).toContainText('Cannot read this GDTF archive');
  expect((await reading()).lumens).toBe(7500);
  await editor.getByLabel('Import GDTF optics').setInputFiles(gdtf);
  await editor.getByRole('combobox', { name: 'Beam geometry' }).selectOption({ label: 'Optics rehearsal · Wash' });
  await editor.getByRole('button', { name: 'Use beam profile' }).click();
  await expect.poll(async () => (await reading()).farRadius).toBeGreaterThan(before.farRadius * 3);
  await expect(editor).toContainText('Estimated');
  await expect(editor).toContainText('GDTF value');
  await flux.fill('0');
  await flux.press('Enter');
  await expect.poll(async () => (await reading()).emitted).toBe(0);
  expect((await reading()).dimmer).toBe(before.dimmer);
  await page.getByRole('button', { name: 'Close Rig Builder' }).click();
  await openFiles.click();
  const saving = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const bytes = await readFile(await (await saving).path());
  const saved = JSON.parse(bytes);
  expect(saved.rig.trussPods[0].fixtures[0].optics).toEqual({ lumens: 0,
    profile: { manufacturer: 'StageForge', fixture: 'Optics rehearsal', geometry: 'Wash', beamAngle: 30 } });
  await files.getByLabel('Open show file').setInputFiles({ name: 'Optics.stageforge.show.json', mimeType: 'application/json', buffer: bytes });
  await expect(files).toBeHidden();
  await expect.poll(async () => (await reading()).lumens).toBe(0);
});
