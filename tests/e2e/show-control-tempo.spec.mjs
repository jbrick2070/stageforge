import { expect, test } from '@playwright/test';

test('clock owner switching shows ClockBadge (including cinema mode) and gates cue/replay controls cleanly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Show control', exact: true })).toBeVisible();

  // Default boot is Master mode: ClockBadge is absent so default DOM is unchanged.
  await expect(page.getByTestId('clock-owner-badge')).toHaveCount(0);

  // Open Show Control drawer
  await page.getByRole('button', { name: 'Show control', exact: true }).click();
  const drawer = page.getByTestId('show-control-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('clock-mode-master')).toHaveAttribute('aria-pressed', 'true');

  // Switch to Chase TC: badge appears, GO/cue pads disabled, badge stays visible in Cinema mode.
  await drawer.getByTestId('clock-mode-chase').click();
  await expect(page.getByTestId('clock-owner-badge')).toBeVisible();
  await expect(page.getByTestId('clock-owner-badge')).toContainText('CHASE');
  await expect(page.getByRole('button', { name: 'GO', exact: true })).toBeDisabled();

  // Cinema mode keeps ClockBadge visible
  await page.getByRole('button', { name: 'Cinema mode', exact: true }).click();
  await expect(page.getByTestId('clock-owner-badge')).toBeVisible();
  await page.getByRole('button', { name: 'Show desk' }).click();

  // Switch to Cue Caller: badge updates to CALLER, GO re-enables for manual/caller use.
  await drawer.getByTestId('clock-mode-caller').click();
  await expect(page.getByTestId('clock-owner-badge')).toContainText('CALLER');
  await expect(page.getByRole('button', { name: 'GO', exact: true })).toBeEnabled();

  // One-click Master button on badge returns cleanly to Master and hides badge.
  await page.getByTestId('clock-badge-master').click();
  await expect(page.getByTestId('clock-owner-badge')).toHaveCount(0);
  await expect(drawer.getByTestId('clock-mode-master')).toHaveAttribute('aria-pressed', 'true');
});

test('desk tempo controls support half/double bounds without folding and tap tempo updates BPM', async ({ page }) => {
  await page.goto('/');
  const readout = page.getByTestId('desk-bpm-readout');
  await expect(readout).toContainText('128 BPM');

  // At 128 BPM, both half (64 < 70) and double (256 > 180) are out of schema range and marked aria-disabled.
  const halfBtn = page.getByTestId('desk-half-time');
  const doubleBtn = page.getByTestId('desk-double-time');
  await expect(halfBtn).toHaveAttribute('aria-disabled', 'true');
  await expect(doubleBtn).toHaveAttribute('aria-disabled', 'true');

  // Adjust BPM to 160 in Audio popover so half-time (80 BPM) is enabled.
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  const inc = page.getByRole('button', { name: 'Increase tempo', exact: true });
  for (let i = 0; i < 16; i++) await inc.click(); // 128 -> 160
  await expect(readout).toContainText('160 BPM');
  await expect(halfBtn).toHaveAttribute('aria-disabled', 'false');
  await halfBtn.click();
  await expect(readout).toContainText('80 BPM');

  // At 80 BPM, double-time (160 BPM) is enabled and half-time is disabled.
  await expect(doubleBtn).toHaveAttribute('aria-disabled', 'false');
  await expect(halfBtn).toHaveAttribute('aria-disabled', 'true');
  await doubleBtn.click();
  await expect(readout).toContainText('160 BPM');

  // Tap tempo at ~450 ms intervals (~133 BPM) updates BPM out of 160.
  const tapBtn = page.getByTestId('desk-tap-tempo');
  await tapBtn.click();
  await page.waitForTimeout(450);
  await tapBtn.click();
  await page.waitForTimeout(450);
  await tapBtn.click();
  await expect(readout).not.toContainText('160 BPM');
});
