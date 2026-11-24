import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('an authored cabinet wall keeps its requested grid and exports each installed pixel canvas', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await page.getByRole('button', { name: /Club Stage \(300 Cap\)/ }).click();
  await page.getByRole('button', { name: 'Build from LED cabinets' }).click();
  const edit = async (label, value) => {
    const field = page.getByRole('spinbutton', { name: label, exact: true });
    await field.fill(String(value));
    await field.press('Enter');
  };
  await edit('Requested columns', 8);
  await edit('Requested rows', 20);
  await edit('Cabinet width (px)', 16);
  await edit('Cabinet height (px)', 8);
  await page.getByRole('button', { name: 'IMAG Side Wings' }).click();
  await expect(page.getByLabel('Installed LED wall')).toHaveText('Main wall · 8 × 7 cabinets · 128 × 56 px');
  await expect(page.getByText('Each wing · 6 × 6 cabinets · 96 × 48 px')).toBeVisible();
  await page.getByRole('button', { name: 'Close Rig Builder' }).click();
  await page.getByRole('button', { name: 'Cost and crew' }).click();
  await page.getByRole('tab', { name: 'Cost & crew' }).click();
  await expect(page.getByText('128 cabinets · 32 m²')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show files' }).click();
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  async function download(label) {
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: label }).click();
    return readFile(await (await pending).path());
  }
  const file = JSON.parse((await download('Save show JSON')).toString('utf8'));
  expect(file.version).toBe(2);
  expect(file.rig.ledWall.cabinets).toMatchObject({ columns: 8, rows: 20, pixelsWide: 16, pixelsHigh: 8 });
  const glb = await download('3D scene GLB');
  const { nodes } = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  expect(nodes.find(n => n.name === 'LED wall').extras).toMatchObject({ cabinetGrid: [8, 7], canvasPixels: [128, 56] });
  expect(nodes.find(n => n.name.startsWith('LED wing')).extras).toMatchObject({ cabinetGrid: [6, 6], canvasPixels: [96, 48] });
  await dialog.getByLabel('Open show file').setInputFiles({ name: 'Cabinets.stageforge.show.json',
    mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Requested rows', exact: true })).toHaveValue('20');
});
