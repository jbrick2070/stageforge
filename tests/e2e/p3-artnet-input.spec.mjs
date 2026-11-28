import { expect, test } from '@playwright/test';

test('the web desk keeps SIM and WIRE controls and has no desktop Art-Net receive surface', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'DMX monitor', exact: true });
  await trigger.click();
  const drawer = page.getByRole('complementary', { name: 'DMX monitor', exact: true });
  await expect(drawer.getByTestId('dmx-monitor-mode-sim')).toBeVisible();
  await expect(drawer.getByTestId('dmx-monitor-mode-phys')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Art-Net input', exact: true })).toHaveCount(0);
  await page.goto('/?view');
  await expect(trigger).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Art-Net input monitor' })).toHaveCount(0);
});
