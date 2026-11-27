import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });

function deskControls(page) {
  const header = page.locator('header.stage-transport');
  return [
    header.locator('.play-btn'),
    button(header, 'Design stage'),
    button(header, 'Show files'),
    button(header, 'Audio settings'),
    button(header, 'Auto-LD'),
    header.getByRole('combobox', { name: 'Camera view', exact: true }),
    button(header, 'Rig builder'),
    button(header, 'DMX monitor'),
    button(header, 'Measure overlay'),
    header.getByRole('button', { name: /^Pre-flight status: / }),
    button(header, 'Gear, cost and crew'),
    button(header, 'Show control'),
    button(header, 'Display and safety settings'),
    button(header, 'Cinema mode'),
  ];
}

async function assertContained(locator, width, height) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
  return box;
}

async function assertTools(page, width, height) {
  const controls = deskControls(page);
  const boxes = [];
  for (const control of controls) {
    boxes.push(await assertContained(control, width, height));
    expect(await control.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), `pointer access at ${width} px for ${await control.getAttribute('aria-label') ?? 'primary Play'}`).toBe(true);
  }
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (const b of boxes.slice(i + 1)) {
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(overlapX <= 0.5 || overlapY <= 0.5, `overlapping controls at ${width} px`).toBe(true);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('header.stage-transport').evaluate(header => header.scrollLeft)).toBe(0);
}

async function testFocusOrder(page, width, height) {
  const controls = deskControls(page);
  await controls[0].focus();
  for (const target of controls.slice(1)) {
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
    await assertContained(target, width, height);
  }
  for (const target of controls.slice(0, -1).reverse()) {
    await page.keyboard.press('Shift+Tab');
    await expect(target).toBeFocused();
    await assertContained(target, width, height);
  }
  expect(await page.evaluate(() => scrollX)).toBe(0);
  expect(await page.locator('header.stage-transport').evaluate(header => header.scrollLeft)).toBe(0);
}

test('desk tools stay visible, focusable and reachable on laptops and phones', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?probe');
  for (const [width, height] of [[960, 800], [1023, 800], [1024, 800], [1280, 800], [1366, 768],
    [1440, 900], [1536, 864], [1599, 900], [1600, 900], [1601, 900], [1700, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await assertTools(page, width, height);
    if ([960, 1024, 1280, 1366, 1599, 1600, 390].includes(width)) await testFocusOrder(page, width, height);
  }
  for (const [width, height] of [[1280, 800], [1366, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const audio = button(page, 'Audio settings');
    await audio.press('Enter');
    await assertContained(page.getByRole('region', { name: 'Audio settings', exact: true }), width, height);
    await expect(button(page, 'Play synth demo')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(audio).toBeFocused();

    const display = button(page, 'Display and safety settings');
    await display.press('Enter');
    await assertContained(page.getByRole('dialog', { name: 'Display and safety settings', exact: true }), width, height);
    await page.keyboard.press('Escape');
    await expect(display).toBeFocused();

    const cinema = button(page, 'Cinema mode');
    await cinema.press('Enter');
    await expect(page.locator('main')).toHaveAttribute('data-cinema', 'true');
    await expect(button(page, 'Play demo')).toBeVisible();
    await button(page, 'Show desk').press('Enter');
    await expect(page.locator('main')).toHaveAttribute('data-cinema', 'false');
    await assertTools(page, width, height);
  }
});

test('long loading progress fits the primary action at the responsive boundary and on phones', async ({ page }) => {
  const mp3 = await readFile(new URL('../../public/demo/track.mp3', import.meta.url));
  await page.route('**/demo/track.mp3', route => route.fulfill({
    contentType: 'audio/mpeg', headers: { 'content-length': String(mp3.byteLength) }, body: mp3,
  }));
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.src.startsWith('blob:') && !this.muted && !this.loop) return new Promise(() => {});
      return play.call(this);
    };
  });
  await page.goto('/?probe');
  // Exercise the longest existing percentage label from the actual bundled fetch.
  await button(page, 'Play demo').press('Enter');
  const loading = button(page, 'Loading 100% demo track');
  await expect(loading).toBeFocused({ timeout: 15_000 });
  await expect(loading).toHaveAttribute('aria-disabled', 'true');
  for (const [width, height] of [[390, 844], [1599, 900], [1600, 900]]) {
    await page.setViewportSize({ width, height });
    await assertTools(page, width, height);
    await expect(loading).toBeFocused();
  }
  await button(page, 'GO').press('Enter');
  await expect(button(page, 'Play demo')).toBeVisible();
});
