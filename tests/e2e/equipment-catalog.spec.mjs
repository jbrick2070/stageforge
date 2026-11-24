import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('select a real catalogue moving head, LED panel preset, verify DMX warning & estimate, and round-trip Show v6', async ({ page }) => {
  await page.goto('/?probe');
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await page.getByRole('button', { name: /Club Stage \(300 Cap\)/ }).click();

  // Open the accessible equipment picker for the first beam group and verify Escape + focus restore.
  const trigger = page.getByRole('button', { name: /Choose equipment model for Sharpy X-Beam 350/ }).first();
  await trigger.click();
  const picker = page.getByRole('dialog', { name: /Equipment catalogue for/ });
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-equipment-family="moving-beam"]').first()).toBeVisible();
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

  // Verify Production Estimate lists the real model & ROE LED panel with matching equipment silhouettes.
  await page.getByRole('button', { name: 'Cost and crew' }).click();
  await expect(page.getByText('Robe MegaPointe', { exact: true })).toBeVisible();
  await expect(page.getByText(/ROE Visual Black Pearl BP2 V2/).first()).toBeVisible();
  await expect(page.locator('[data-equipment-family="moving-beam"]').first()).toBeVisible();
  await expect(page.locator('[data-equipment-family="led-panel"]').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Verify 2D Stage Designer displays fixture plan symbols and toggles them cleanly.
  await page.getByRole('button', { name: 'Design stage', exact: true }).first().click();
  const designer = page.getByRole('dialog', { name: 'Stage designer' });
  await expect(designer).toBeVisible();
  await expect(designer.getByTestId('plan-fixture-symbols')).toBeVisible();
  await expect(designer.locator('.sf-plan-fixture').first()).toBeVisible();
  await designer.getByLabel('Show fixtures on plan').uncheck();
  await expect(designer.getByTestId('plan-fixture-symbols')).toHaveCount(0);
  await designer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(designer).toBeHidden();

  // Enter live 3D preview, then verify GPU draw-call/triangle budgets and zero geometry/texture leaks across rebuilds.
  const canvas = page.locator('canvas').first();
  const cbox = await canvas.boundingBox();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cbox.x + cbox.width / 2 + 20, cbox.y + cbox.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await page.evaluate(() => window.stageforgeProbe.renderStats())).calls).toBeGreaterThan(0);

  const stats = await page.evaluate(async () => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await nextFrame();
    window.stageforgeProbe.rebuildRig();
    await nextFrame();
    const baseline = window.stageforgeProbe.renderStats();
    for (let i = 0; i < 10; i++) {
      window.stageforgeProbe.rebuildRig();
      await nextFrame();
    }
    const after = window.stageforgeProbe.renderStats();
    return { baseline, after };
  });
  expect(stats.baseline.calls).toBeGreaterThan(0);
  expect(stats.baseline.calls).toBeLessThanOrEqual(350);
  expect(stats.baseline.triangles).toBeGreaterThan(0);
  expect(stats.baseline.triangles).toBeLessThanOrEqual(400_000);
  // Across 10 full rebuilds, geometry count stays flat (<= +2 for lazy BeamPools receivers; any leak would add >= 10).
  expect(stats.after.geometries).toBeLessThanOrEqual(stats.baseline.geometries + 2);
  expect(stats.after.textures).toBe(stats.baseline.textures);

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
