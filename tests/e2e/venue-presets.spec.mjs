// Venue presets load as complete rooms, and a first-time user's edits to one survive a reload.
import { expect, test } from '@playwright/test';

const KEY = 'stageforge.design.v1';
const saved = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY);

async function openRigBuilder(page) {
  await page.getByRole('button', { name: 'Rig builder' }).click();
  return page.getByRole('dialog').or(page.locator('aside')).filter({ hasText: 'LOAD VENUE & RIG PRESET' }).first();
}

test('a first-time user edits the small theatre preset and keeps it after reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.reload();

  const drawer = await openRigBuilder(page);
  await drawer.getByRole('button', { name: /Small Proscenium Theatre/ }).click();
  await expect(page.getByText('29 fixtures · 0 lasers')).toBeVisible();
  expect(await saved(page)).toBeNull(); // loading a preset doesn't write anything

  await drawer.getByRole('button', { name: 'club', exact: true }).click(); // venue only: same rig, other room
  await drawer.getByRole('button', { name: 'theatre', exact: true }).click();
  await drawer.getByText('Main LED Wall').click();
  await expect.poll(async () => (await saved(page))?.ledWall.enabled).toBe(true);

  await page.reload();
  expect((await saved(page)).name).toBe('Small Proscenium Theatre');
  await expect(page.getByText('29 fixtures · 0 lasers')).toBeVisible();
  const reopened = await openRigBuilder(page);
  await expect(reopened.getByRole('button', { name: 'theatre', exact: true })).toHaveClass(/border-cyan-400/);
});

test('editing a preset never overwrites a design that is already saved', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async (k) => {
    const { createBlankDesign } = await import('/src/data/stageDesign.ts');
    localStorage.setItem(k, JSON.stringify({ ...createBlankDesign(), name: 'My club night' }));
  }, KEY);
  await page.reload();

  const drawer = await openRigBuilder(page);
  await drawer.getByRole('button', { name: /Club Stage \(300 Cap\)/ }).click();
  await drawer.getByText('Main LED Wall').click();
  await page.waitForTimeout(600); // past the 250 ms save debounce
  expect((await saved(page)).name).toBe('My club night');
});
