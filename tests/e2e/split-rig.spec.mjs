import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('split rehearsal heads move and tint independently, and can share an attribute again', async ({ page }) => {
  test.setTimeout(100_000);
  await page.goto('/?probe');
  const button = name => page.getByRole('button', { name, exact: true });
  await button('Show files').click();
  await button('Open Split Rig rehearsal').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await button('Show cues').click();
  await button('Cue 3, Blue sweep').click();
  const heads = () => page.evaluate(() => window.stageforgeProbe.beamAxes());
  await expect.poll(async () => (await heads()).filter(h => h.group === 'wash').map(h => h.rgb))
    .toEqual(['ffb869', 'ffb869']);
  await expect.poll(async () => (await heads()).filter(h => h.group === 'beam').map(h => h.rgb))
    .toEqual(['6fbbff', '6fbbff']);
  const target = [0.5, 1.3, -1.1];
  await expect.poll(async () => Math.max(...(await heads()).filter(h => h.group === 'wash').map(h => {
    const v = target.map((n, i) => n - h.origin[i]);
    const along = v.reduce((dot, n, i) => dot + n * h.dir[i], 0);
    return along > 0 ? Math.hypot(...v.map((n, i) => n - along * h.dir[i])) : Infinity;
  })), { timeout: 20_000 }).toBeLessThan(0.15);
  const initialBeam = (await heads()).find(h => h.group === 'beam').dir;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const nextBeam = (await heads()).find(h => h.group === 'beam').dir;
  expect(Math.hypot(...nextBeam.map((n, i) => n - initialBeam[i]))).toBeGreaterThan(0.00001);
  await button('Lighting').click();
  await button('Washes').click();
  await expect(button('Drum riser')).toHaveAttribute('aria-pressed', 'true');
  const primary = page.getByLabel('PRIMARY', { exact: true });
  const chooseColor = value => primary.evaluate((input, rgb) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, rgb);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await chooseColor('#00ff00');
  await expect.poll(async () => (await heads()).filter(h => h.group === 'wash').map(h => h.rgb)).toEqual(['00ff00','00ff00']);
  expect((await heads()).find(h => h.group === 'beam').rgb).toBe('6fbbff');
  await button('All heads').click();
  await chooseColor('#ff0000');
  await expect.poll(async () => (await heads()).map(h => h.rgb)).toEqual(Array(4).fill('ff0000'));
  await button('Show files').click();
  const saving = page.waitForEvent('download');
  await button('Save show JSON').click();
  const show = JSON.parse(await readFile(await (await saving).path(), 'utf8'));
  expect(show.version).toBe(2);
  expect(show.look.movingGroups.wash.focusMarkId).toBe('platform:drums');
  expect(show.look.movingGroups.wash.primaryColor).toBeUndefined();
  expect(show.cues[3].state.laser.projectors['["cl-front","lasers",2]'].beamCount).toBe(17);
});
