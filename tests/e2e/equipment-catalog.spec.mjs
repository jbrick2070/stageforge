import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('select a real catalogue moving head, LED panel preset, verify DMX warning & estimate, and round-trip Show v6', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await page.getByRole('button', { name: /Club Stage \(300 Cap\)/ }).click();

  // Open the accessible equipment picker for the first beam group and verify Escape + focus restore.
  const trigger = page.getByRole('button', { name: /Choose equipment model for Sharpy X-Beam 350/ }).first();
  await trigger.click();
  const picker = page.getByRole('dialog', { name: /Equipment catalogue for/ });
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();

  // Reopen, search for Robe MegaPointe, and select Mode 1 (39 ch).
  await trigger.click();
  await expect(picker).toBeVisible();
  await picker.getByRole('searchbox', { name: 'Search equipment catalogue' }).fill('MegaPointe');
  await picker.getByRole('button', { name: /Robe MegaPointe/ }).click();
  await picker.getByRole('combobox', { name: 'DMX mode' }).selectOption('Mode 1 (Standard 16-bit)');
  await picker.getByRole('button', { name: 'Apply model' }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: /Choose equipment model for Robe MegaPointe/ }).first()).toContainText('39 ch');

  // Choose a real LED panel cabinet preset.
  await page.getByRole('button', { name: 'Build from LED cabinets' }).click();
  await page.getByRole('combobox', { name: 'Panel model' }).selectOption('roe-bp2-v2');
  await expect(page.getByRole('spinbutton', { name: 'Cabinet width (px)', exact: true })).toHaveValue('176');

  // Close Rig Builder and verify DMX Monitor displays the simulated-layout notice and 39-ch mode.
  await page.getByRole('button', { name: 'Close Rig Builder' }).click();
  await page.getByRole('button', { name: 'DMX monitor', exact: true }).click();
  await expect(page.getByText(/Simulated control layout, not the fixture's real channel map/)).toBeVisible();
  await page.getByRole('button', { name: 'PATCH', exact: true }).click();
  await expect(page.getByText(/Robe MegaPointe/).first()).toBeVisible();
  await expect(page.getByText(/39 channels per fixture/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close DMX monitor' }).click();

  // Verify Production Estimate lists the real model & ROE LED panel.
  await page.getByRole('button', { name: 'Cost and crew' }).click();
  await expect(page.getByText('Robe MegaPointe', { exact: true })).toBeVisible();
  await expect(page.getByText(/ROE Visual Black Pearl BP2 V2/).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Save Show JSON -> must emit version 6 with catalogId/dmxMode/dmxChannels & cabinetId, and reload cleanly.
  await page.getByRole('button', { name: 'Show files' }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const pending = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const raw = await readFile(await (await pending).path());
  const saved = JSON.parse(raw.toString('utf8'));
  expect(saved.version).toBe(6);
  expect(saved.rig.ledWall.cabinets.cabinetId).toBe('roe-bp2-v2');
  const savedBeam = saved.rig.trussPods.flatMap((p) => p.fixtures).find((f) => f.catalogId === 'robe-megapointe');
  expect(savedBeam).toMatchObject({
    catalogId: 'robe-megapointe',
    dmxMode: 'Mode 1 (Standard 16-bit)',
    dmxChannels: 39,
  });

  await files.getByLabel('Open show file').setInputFiles({
    name: 'CatalogV6.stageforge.show.json',
    mimeType: 'application/json',
    buffer: raw,
  });
  await expect(files).toBeHidden();
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await expect(page.getByRole('button', { name: /Choose equipment model for Robe MegaPointe/ }).first()).toContainText('39 ch');
  await expect(page.getByRole('combobox', { name: 'Panel model' })).toHaveValue('roe-bp2-v2');
});
