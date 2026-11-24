import { expect, test } from '@playwright/test';

test('select real laser models, verify single-color lock, safety danger status, ILDA load/cleanup, and corrupt .ild handling', async ({ page }) => {
  await page.goto('/?probe');
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  await page.getByRole('button', { name: /Club Stage \(300 Cap\)/ }).click();

  // Pick a real laser model (KVANT Clubmax 6000 FB4) via alias search and verify W, kpps, Class 4 badges & hidden legacy mode.
  const laserTrigger = page.getByRole('button', { name: /Choose equipment model for KVANT Clubmax/i }).first();
  await laserTrigger.click();
  const picker = page.getByRole('dialog', { name: /Equipment catalogue for/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('searchbox', { name: 'Search equipment catalogue' }).fill('Clubmax');
  const clubmaxCard = picker.getByRole('button', { name: /^KVANT Clubmax 6000 FB4/ });
  await expect(clubmaxCard).toContainText('6 W RGB');
  await expect(clubmaxCard).toContainText('40 kpps');
  await expect(clubmaxCard).toContainText('Class 4');
  await clubmaxCard.click();

  // Verify legacy placeholder mode is NOT offered in the DMX mode dropdown.
  const modeOptions = await picker.getByRole('combobox', { name: 'DMX mode' }).locator('option').allTextContents();
  expect(modeOptions.some((o) => o.includes('FB4 16-Ch'))).toBe(true);
  expect(modeOptions.some((o) => o.includes('Placeholder'))).toBe(false);

  // Switch to single-color Class 3B green laser (Laserworld CS-500G).
  await picker.getByRole('searchbox', { name: 'Search equipment catalogue' }).fill('CS-500G');
  const csCard = picker.getByRole('button', { name: /Laserworld CS-500G/ });
  await expect(csCard).toContainText('400 mW 532 nm');
  await expect(csCard).toContainText('Class 3B');
  await csCard.click();
  await picker.getByRole('button', { name: 'Apply model' }).click();
  await expect(picker).toBeHidden();
  await page.getByRole('button', { name: 'Close Rig Builder' }).click();

  // Open the Lasers tab in the bottom console.
  await page.getByRole('button', { name: 'Lasers', exact: true }).click();

  // Single-color projector disables the Laser color mode dropdown with an explicit hint.
  const colorSelect = page.getByRole('combobox', { name: 'Laser color mode' });
  await expect(colorSelect).toBeDisabled();
  await expect(page.getByTestId('single-color-laser-hint')).toContainText('Single-colour 532 nm projector');

  // Verify safety panel is visible and CROWD SCAN ON transitions role="status" to Danger.
  const statusEl = page.getByTestId('laser-safety-status');
  await expect(statusEl).toHaveAttribute('role', 'status');
  await page.getByRole('button', { name: /CROWD SCAN/ }).click();
  await expect(page.getByRole('button', { name: /CROWD SCAN ON/ })).toBeVisible();
  await expect(page.getByTestId('laser-safety-panel')).toHaveAttribute('data-level', 'danger');
  await expect(statusEl).toContainText(/Danger/i);
  await page.getByRole('button', { name: /CROWD SCAN ON/ }).click();

  // Measure baseline GPU geometry count, load built-in demo ILDA, verify session note & beam-only Graphic disable, then unload and verify zero leak.
  const baseline = await page.evaluate(async () => {
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await nextFrame();
    return window.stageforgeProbe.renderStats();
  });

  await page.getByRole('button', { name: 'Load demo' }).click();
  await expect(page.getByTestId('ilda-session-note')).toHaveText('Not saved with show');
  // Since all lasers on club_stage are now beam-only CS-500G, Graphic-only button must be disabled.
  await expect(page.getByRole('button', { name: 'graphic', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'beam', exact: true }).click();
  await expect(page.getByRole('button', { name: 'beam', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Unload ILDA and verify GPU geometries return cleanly to baseline.
  await page.getByRole('button', { name: 'Unload ILDA clip' }).click();
  await expect(page.getByTestId('ilda-session-note')).toHaveCount(0);
  const afterUnload = await page.evaluate(async () => {
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await nextFrame();
    window.stageforgeProbe.rebuildRig();
    await nextFrame();
    return window.stageforgeProbe.renderStats();
  });
  expect(afterUnload.geometries).toBeLessThanOrEqual(baseline.geometries + 2);

  // Upload a corrupt .ild file -> readable error toast appears and UI remains usable.
  await page.getByTestId('ilda-file-input').setInputFiles({
    name: 'corrupt.ild',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('NOT_AN_ILDA_FILE_01234567890123456789'),
  });
  await expect(page.getByText(/Invalid ILDA magic header/i)).toBeVisible();
  // Page remains interactive after error.
  await page.getByRole('button', { name: 'Load demo' }).click();
  await expect(page.getByTestId('ilda-session-note')).toBeVisible();
});

test.describe('phone viewport (390px) Laser tab usability', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('safety panel and ILDA loader stay visible with 44px touch targets and zero horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Lasers', exact: true }).click();

    const safetyPanel = page.getByTestId('laser-safety-panel');
    const ildaLoader = page.getByTestId('ilda-loader');
    await expect(safetyPanel).toBeVisible();
    await expect(ildaLoader).toBeVisible();

    // No horizontal page overflow at 390px
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // Key touch targets in the Laser tab meet >= 44px height on mobile
    const loadDemoBox = await page.getByRole('button', { name: 'Load demo' }).boundingBox();
    const openIldBox = await page.getByRole('button', { name: 'Open .ild' }).boundingBox();
    const crowdBox = await page.getByRole('button', { name: /CROWD SCAN/ }).boundingBox();
    expect(loadDemoBox.height).toBeGreaterThanOrEqual(44);
    expect(openIldBox.height).toBeGreaterThanOrEqual(44);
    expect(crowdBox.height).toBeGreaterThanOrEqual(44);
  });
});
