import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Gear & production modal defaults to Inventory, supports ARIA tabs, focus trap, Escape restore, print sheet, and CSV export', async ({ page }) => {
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => {
      window.__printCalls++;
    };
  });

  await page.goto('/');
  const gearBtn = page.getByRole('button', { name: 'Gear, cost and crew', exact: true });
  await gearBtn.click();

  const dialog = page.getByRole('dialog', { name: 'Gear & production' });
  await expect(dialog).toBeVisible();

  // Default tab is Inventory; Rigging & power sits between Inventory and Cost & crew.
  const invTab = dialog.getByRole('tab', { name: /Inventory/ });
  const riggingTab = dialog.getByRole('tab', { name: /Rigging & power/ });
  const costTab = dialog.getByRole('tab', { name: 'Cost & crew' });
  await expect(invTab).toHaveAttribute('aria-selected', 'true');
  await expect(riggingTab).toHaveAttribute('aria-selected', 'false');
  await expect(costTab).toHaveAttribute('aria-selected', 'false');

  // Arrow keys move between tabs; Home/End work too.
  await invTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(riggingTab).toBeFocused();
  await expect(riggingTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(costTab).toBeFocused();
  await expect(costTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(invTab).toBeFocused();
  await expect(invTab).toHaveAttribute('aria-selected', 'true');

  // Focus trap stays inside the dialog even with the shop <select> present.
  const shopSelect = dialog.getByRole('combobox', { name: 'Shop stock profile' });
  await shopSelect.focus();
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const dlg = document.querySelector('dialog[open]');
      return Boolean(dlg && dlg.contains(document.activeElement));
    });
    expect(inside).toBe(true);
  }

  // Print calls window.print(), and print media hides #root while showing black-on-white print-sheet.
  await dialog.getByRole('button', { name: 'Print sheet' }).click();
  expect(await page.evaluate(() => window.__printCalls)).toBe(1);

  await page.emulateMedia({ media: 'print' });
  const printState = await page.evaluate(() => {
    const root = document.getElementById('root');
    const sheet = document.querySelector('.print-sheet');
    const rootDisplay = root ? getComputedStyle(root).display : null;
    const sheetStyle = sheet ? getComputedStyle(sheet) : null;
    return {
      rootDisplay,
      sheetDisplay: sheetStyle?.display ?? null,
      sheetColor: sheetStyle?.color ?? null,
      hasTable: Boolean(sheet?.querySelector('table caption')),
    };
  });
  expect(printState.rootDisplay).toBe('none');
  expect(printState.sheetDisplay).toBe('block');
  expect(printState.sheetColor).toBe('rgb(0, 0, 0)');
  expect(printState.hasTable).toBe(true);
  await page.emulateMedia({ media: 'screen' });

  // Export CSV downloads a UTF-8 BOM CSV with expected headers, shows in-modal status notice, and has no unescaped leading '='.
  const dlPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export CSV' }).click();
  await expect(dialog.getByTestId('inventory-stock-status')).toContainText('Exported equipment list CSV.');
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toMatch(/\.equipment\.csv$/);
  const csvText = await readFile(await dl.path(), 'utf8');
  expect(csvText.startsWith('\uFEFF')).toBe(true);
  expect(csvText).toContain('Category,Manufacturer,Model,Catalogue ID,DMX mode');
  expect(csvText).toContain('Total,');
  const lines = csvText.slice(1).split('\r\n').filter(Boolean);
  for (const line of lines) {
    for (const cell of line.split(',')) {
      expect(cell.startsWith('=')).toBe(false);
    }
  }

  // Escape closes the dialog and restores focus to the Gear button.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(gearBtn).toBeFocused();
});

test('shop stock limits block over-stock additions, unblock in Unlimited, and preserve over-stock shows while allowing removals', async ({ page }) => {
  await page.goto('/');

  // Select Local Club Shop in Gear -> Inventory.
  await page.getByRole('button', { name: 'Gear, cost and crew', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gear & production' });
  await dialog.getByRole('combobox', { name: 'Shop stock profile' }).selectOption('club');
  // Default Arena Mainstage exceeds Local Club Shop stock -> shortages appear immediately without deleting any gear.
  await expect(dialog.getByTestId('inventory-stock-status')).toContainText(/Shortage:/);
  await expect(dialog.getByText(/Sub-rent/).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Open Rig Builder: trying to add another beam fixture (already over club stock) is blocked with role="alert".
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  const addBeam = page.getByRole('button', { name: /Add one Sharpy X-Beam 350/ }).first();
  const beforeCount = await addBeam.locator('..').locator('span').textContent();
  await addBeam.click();
  const alert = page.locator('.rig-builder-panel [role="alert"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/Shop has 8 Claypaky Sharpy/);
  expect(await addBeam.locator('..').locator('span').textContent()).toBe(beforeCount);

  // Decrementing (-) while over stock MUST still work!
  const removeBeam = page.getByRole('button', { name: /Remove one Sharpy X-Beam 350/ }).first();
  await removeBeam.click();
  expect(Number(await addBeam.locator('..').locator('span').textContent())).toBe(Number(beforeCount) - 1);

  // Switching back to Unlimited from the Rig Builder shop bar unblocks +.
  await page.locator('.rig-builder-panel').getByRole('button', { name: 'Unlimited', exact: true }).click();
  await addBeam.click();
  expect(Number(await addBeam.locator('..').locator('span').textContent())).toBe(Number(beforeCount));
});

test.describe('mobile 390x844 phone usability', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Gear & production Inventory panel has zero horizontal overflow and >=44px touch targets on a 390px phone', async ({ page }) => {
    await page.goto('/');
    // Phone boots in cinema mode -> show desk first.
    const showDesk = page.getByRole('button', { name: /Show desk/ });
    if (await showDesk.isVisible()) {
      await showDesk.click();
    }

    await page.getByRole('button', { name: 'Gear, cost and crew', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Gear & production' });
    await expect(dialog).toBeVisible();

    // Check zero horizontal overflow on document and dialog.
    const overflow = await page.evaluate(() => {
      const dlg = document.querySelector('.gear-modal');
      return {
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        dlgScroll: dlg ? dlg.scrollWidth : 0,
        dlgClient: dlg ? dlg.clientWidth : 0,
      };
    });
    expect(overflow.docScroll).toBeLessThanOrEqual(overflow.docClient);
    expect(overflow.dlgScroll).toBeLessThanOrEqual(overflow.dlgClient);

    // Every primary interactive control in the dialog header & toolbar is >= 44x44 px.
    for (const locator of [
      dialog.getByRole('button', { name: 'Close gear and production' }),
      dialog.getByRole('tab', { name: /Inventory/ }),
      dialog.getByRole('tab', { name: 'Cost & crew' }),
      dialog.getByRole('combobox', { name: 'Shop stock profile' }),
      dialog.getByRole('button', { name: 'Print sheet' }),
      dialog.getByRole('button', { name: 'Export CSV' }),
    ]) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });
});
