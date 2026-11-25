import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const PHONE = { width: 390, height: 844 };

async function openGearModal(page) {
  await page.getByRole('button', { name: 'Gear, cost and crew', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gear & production' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('Paperwork tab supports 4-tab keyboard nav, 5 sub-sheets, CSV exports, and single-sheet + full-book print media', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => {
      window.__printCalls++;
    };
  });

  await page.goto('/?probe=1');
  const dialog = await openGearModal(page);

  // 4-tab keyboard navigation: Inventory -> Rigging & power -> Paperwork -> Cost & crew -> End/Home.
  const invTab = dialog.getByRole('tab', { name: /Inventory/ });
  const riggingTab = dialog.getByRole('tab', { name: /Rigging & power/ });
  const paperworkTab = dialog.getByRole('tab', { name: /Paperwork/ });
  const costTab = dialog.getByRole('tab', { name: 'Cost & crew' });

  await invTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(riggingTab).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(paperworkTab).toBeFocused();
  await expect(paperworkTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(costTab).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(paperworkTab).toBeFocused();

  const panel = dialog.getByRole('tabpanel', { name: /Paperwork/ });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('StageForge simulated channel map: verify against the GDTF mode.');
  await expect(panel).toContainText('U1.001');

  // Verify single-sheet CSV export for Patch sheet, Instrument schedule, Channel hookup, and Cue sheet.
  const sheetChecks = [
    { radio: 'Patch sheet', suffix: /\.patch-sheet\.csv$/, header: 'Universe,DMX Address,DMX Range,Absolute Address', notice: 'Exported patch sheet CSV.' },
    { radio: 'Instrument schedule', suffix: /\.instrument-schedule\.csv$/, header: 'Position,Mount #,Fixture #,Unit #', notice: 'Exported instrument schedule CSV.' },
    { radio: 'Channel hookup', suffix: /\.channel-hookup\.csv$/, header: 'Fixture #,Position,Unit #,Manufacturer', notice: 'Exported channel hookup CSV.' },
    { radio: 'Cue sheet', suffix: /\.cue-sheet\.csv$/, header: 'Cue #,Name,Tag,Follow,Take Timecode', notice: 'Exported cue sheet CSV.' },
  ];

  for (const check of sheetChecks) {
    await panel.getByRole('radio', { name: new RegExp(check.radio) }).click({ force: true });
    const dlPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export CSV' }).click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toMatch(check.suffix);
    const csvText = await readFile(await dl.path(), 'utf8');
    expect(csvText.startsWith('\uFEFF')).toBe(true);
    expect(csvText).toContain(check.header);
    await expect(panel.getByTestId('paperwork-status')).toContainText(check.notice);
  }

  // Power & load sub-sheet renders and links to Rigging & power tab.
  await panel.getByRole('radio', { name: /Power & load/ }).click({ force: true });
  await expect(panel).toContainText('Simplified static guidance only');
  await expect(panel).toContainText('Overhead Hoist Points');

  // Print single sheet -> exactly 1 .print-sheet and 1 .print-section.
  await panel.getByRole('button', { name: 'Print sheet' }).click();
  expect(await page.evaluate(() => window.__printCalls)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  const singlePrint = await page.evaluate(() => ({
    sheetCount: document.querySelectorAll('.print-sheet').length,
    sectionCount: document.querySelectorAll('.print-sheet .print-section').length,
    rootDisplay: getComputedStyle(document.getElementById('root')).display,
  }));
  expect(singlePrint).toEqual({ sheetCount: 1, sectionCount: 1, rootDisplay: 'none' });
  await page.emulateMedia({ media: 'screen' });

  // Print full production book -> still exactly 1 .print-sheet, containing Plot Plan first + all 5 tabular sheets.
  await panel.getByRole('button', { name: 'Print full book' }).click();
  expect(await page.evaluate(() => window.__printCalls)).toBe(2);
  await page.emulateMedia({ media: 'print' });
  const bookPrint = await page.evaluate(() => {
    const sheets = document.querySelectorAll('.print-sheet');
    const sections = Array.from(document.querySelectorAll('.print-sheet .print-section'));
    const tabularSections = sections.filter((s) => s.getAttribute('data-paperwork-section') !== 'plot');
    return {
      sheetCount: sheets.length,
      sectionCount: sections.length,
      sectionIds: sections.map((s) => s.getAttribute('data-paperwork-section')),
      hasPlotSvg: Boolean(sections[0]?.querySelector('[data-testid="plot-plan-svg"]')),
      hasAllTheads: tabularSections.every((s) => s.querySelectorAll('table thead tr').length >= 1),
      rootDisplay: getComputedStyle(document.getElementById('root')).display,
      sheetDisplay: sheets[0] ? getComputedStyle(sheets[0]).display : null,
    };
  });
  expect(bookPrint).toEqual({
    sheetCount: 1,
    sectionCount: 7,
    sectionIds: ['plot', 'patch', 'instrument', 'hookup', 'power', 'cues', 'commissioning'],
    hasPlotSvg: true,
    hasAllTheads: true,
    rootDisplay: 'none',
    sheetDisplay: 'block',
  });
  await page.emulateMedia({ media: 'screen' });

  // Close modal and verify quick export in Show files -> Exchange formats works via dynamic import.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const filesDialog = page.getByRole('dialog', { name: 'Show files' });
  const quickDlPromise = page.waitForEvent('download');
  await filesDialog.getByRole('button', { name: /Instrument schedule/ }).click();
  const quickDl = await quickDlPromise;
  expect(quickDl.suggestedFilename()).toMatch(/\.instrument-schedule\.csv$/);

  expect(errors).toEqual([]);
});

test('phone 390x844 layout: Paperwork tab has zero horizontal overflow and >=44px touch targets', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/?probe=1');

  const dialog = await openGearModal(page);
  await dialog.getByRole('tab', { name: /Paperwork/ }).click();
  const panel = dialog.getByRole('tabpanel', { name: /Paperwork/ });
  await expect(panel).toBeVisible();

  const printBtnBox = await panel.getByRole('button', { name: 'Print sheet' }).boundingBox();
  const bookBtnBox = await panel.getByRole('button', { name: 'Print full book' }).boundingBox();
  const csvBtnBox = await panel.getByRole('button', { name: 'Export CSV' }).boundingBox();
  expect(printBtnBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(bookBtnBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(csvBtnBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const firstRadioLabel = panel.locator('.paperwork-radio-group label').first();
  const radioBox = await firstRadioLabel.boundingBox();
  expect(radioBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const overflow = await page.evaluate(() => {
    const dlg = document.querySelector('.gear-modal');
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      modalOverflow: dlg ? dlg.scrollWidth - dlg.clientWidth : 0,
    };
  });
  expect(overflow.docOverflow).toBeLessThanOrEqual(0);
  expect(overflow.modalOverflow).toBeLessThanOrEqual(0);
});
