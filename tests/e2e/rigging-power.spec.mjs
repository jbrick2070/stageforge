import { expect, test } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

async function openRigBuilder(page) {
  await page.getByRole('button', { name: 'Rig Builder' }).click();
  const drawer = page.getByRole('complementary', { name: 'Rig Builder' });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function openGearModal(page) {
  await page.getByRole('button', { name: 'Gear, cost and crew', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gear & production' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('rigging and power controls update live load pills, power balance, print sheet, and CSV download on desktop', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/?probe=1');
  const drawer = await openRigBuilder(page);

  // Select a real truss profile, hoist, and 3-point count on the first truss pod.
  const trussSelect = drawer.locator('select[aria-label^="Truss profile for "]').first();
  const hoistSelect = drawer.locator('select[aria-label^="Hoist rating for "]').first();
  await expect(trussSelect).toBeVisible();
  await trussSelect.selectOption('prolyte-h30v');
  await hoistSelect.selectOption('chainmaster-d8plus-500');

  // Verify the live load pill is visible and carries readable status text.
  const firstPill = drawer.locator('[data-testid^="pod-load-pill-"]').first();
  await expect(firstPill).toBeVisible();
  await expect(firstPill).toContainText(/OK|Caution|Overload|Uplift/);
  await expect(firstPill).toContainText(/Max pt \d+ kg/);

  // Assign a custom circuit label and phase pin on the first fixture group.
  const circuitInput = drawer.locator('input[aria-label^="Circuit group for "]').first();
  await circuitInput.fill('DIM-1');
  await circuitInput.press('Enter');
  const phaseSelect = drawer.locator('select[aria-label^="Phase pin for "]').first();
  await phaseSelect.selectOption('L2');

  await drawer.getByRole('button', { name: 'Close Rig Builder' }).click();

  // Open Gear & production modal -> switch to Rigging & power tab.
  const dialog = await openGearModal(page);
  const riggingTab = dialog.getByRole('tab', { name: /Rigging & power/ });
  await riggingTab.click();
  await expect(riggingTab).toHaveAttribute('aria-selected', 'true');

  const panel = dialog.getByRole('tabpanel', { name: /Rigging & power/ });
  await expect(panel).toContainText('Simplified static guidance only');
  await expect(panel).toContainText('Prolyte H30V');
  await expect(panel).toContainText('ChainMaster D8Plus 500 kg');
  await expect(panel).toContainText('DIM-1');

  // Switch electrical system to EU 230/400 V 3-Phase Wye & check text-based feeder/phase status (M5).
  await panel.getByLabel('Electrical system').selectOption('eu_400_3p');
  await expect(panel).toContainText('EU 230/400V 3φ');
  await expect(panel).toContainText(/A 3φ · (OK|CAUTION|OVERLOAD)/);

  // Verify portalled printable sheet is rendered with matching disclaimer & content.
  const printSheet = page.locator('section.print-sheet[aria-label="Printable rigging and power report"]');
  await expect(printSheet).toHaveCount(1);
  await expect(printSheet).toContainText('Rigging & Power Report');
  await expect(printSheet).toContainText('DIM-1');

  // Download .rigging-power.csv and check confirmation notice + filename.
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.rigging-power\.csv$/);
  await expect(panel.getByRole('status')).toContainText('Exported rigging and power CSV.');

  // M1 regression: electrical system edit made in the modal persists across a page reload.
  await page.reload();
  const reloadedDialog = await openGearModal(page);
  await reloadedDialog.getByRole('tab', { name: /Rigging & power/ }).click();
  const reloadedPanel = reloadedDialog.getByRole('tabpanel', { name: /Rigging & power/ });
  await expect(reloadedPanel.getByLabel('Electrical system')).toHaveValue('eu_400_3p');

  expect(errors).toEqual([]);
});

test('phone 390x844 layout: Rigging & power tab and Rig Builder have zero horizontal overflow and >=44px touch targets', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/?probe=1');

  // 1. Rig Builder selects have >= 44px height on phone.
  const drawer = await openRigBuilder(page);
  const trussSelect = drawer.locator('select[aria-label^="Truss profile for "]').first();
  const trussBox = await trussSelect.boundingBox();
  expect(trussBox).not.toBeNull();
  expect(trussBox.height).toBeGreaterThanOrEqual(44);
  await drawer.getByRole('button', { name: 'Close Rig Builder' }).click();

  // 2. Rigging & power tab fits 390px cleanly with zero horizontal overflow & >=44px controls.
  const dialog = await openGearModal(page);
  await dialog.getByRole('tab', { name: /Rigging & power/ }).click();
  const panel = dialog.getByRole('tabpanel', { name: /Rigging & power/ });
  await expect(panel).toBeVisible();

  const sysBox = await panel.getByLabel('Electrical system').boundingBox();
  expect(sysBox).not.toBeNull();
  expect(sysBox.height).toBeGreaterThanOrEqual(44);

  const exportBox = await panel.getByRole('button', { name: 'Export CSV' }).boundingBox();
  expect(exportBox).not.toBeNull();
  expect(exportBox.height).toBeGreaterThanOrEqual(44);

  const overflow = await page.evaluate(() => {
    const dlg = document.querySelector('.gear-modal');
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      modalOverflow: dlg ? dlg.scrollWidth - dlg.clientWidth : 0,
    };
  });
  expect(overflow.docOverflow).toBeLessThanOrEqual(1);
  expect(overflow.modalOverflow).toBeLessThanOrEqual(1);
});
