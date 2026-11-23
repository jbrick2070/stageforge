import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const example = fileURLToPath(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url));

async function openEditor(page) {
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('button', { name: 'Edit cue list' }).click();
  return page.getByRole('dialog', { name: 'Edit cue list' });
}

test('remove walks forward, stops at the end and can restore the last cue without losing later edits', async ({ page }) => {
  await page.goto('/');
  const editor = await openEditor(page);
  const order = editor.getByLabel('Cue order');
  const name = editor.getByLabel('Cue name');
  await order.selectOption('cue-6');
  for (const cue of ['Techno Cage', 'Prism Wave', 'Encore Finale']) {
    await expect(name).toHaveValue(cue);
    await editor.getByRole('button', { name: 'Remove cue “' + cue + '”' }).press('Enter');
  }
  await expect(order).toBeFocused();
  await expect(editor.getByRole('button', { name: /Remove cue/ })).toHaveCount(0);
  await expect(order.locator('option[value^="cue-"]')).toHaveCount(5);
  await order.selectOption('cue-5');
  await name.fill('House lights');
  await editor.getByRole('button', { name: 'Undo remove' }).press('Enter');
  await expect(order).toHaveValue('cue-8');
  await expect(order).toBeFocused();
  await expect(order.locator('option')).toHaveText([
    '1. Liquid Sky', '2. Laser Tunnel', '3. Festival Drop', '4. Arena Rock', '5. House lights', '6. Encore Finale',
  ]);
  await editor.getByRole('button', { name: 'Apply cues' }).click();
  await expect(page.getByRole('button', { name: 'Cue 5, House lights' })).toContainText('USER');
  await expect(page.getByRole('button', { name: 'Cue 6, Encore Finale' })).toContainText('ALL OUT');
});

test('cue editor validates video start points and saves the selected offset without changing the other cue', async ({ page }, info) => {
  await page.goto('/');
  const files = page.getByRole('dialog', { name: 'Show files' });
  const showFiles = page.getByRole('button', { name: 'Show files', exact: true });
  await showFiles.click();
  await files.getByLabel('Open show file').setInputFiles(example);
  await expect(files).toBeHidden();
  const editor = await openEditor(page);
  const offset = editor.getByLabel('Video start (seconds)');
  await editor.getByLabel('Cue order').selectOption('reveal');
  await offset.fill('-1');
  await expect(editor.getByRole('button', { name: 'Apply cues' })).toBeDisabled();
  await offset.fill('2.375');
  await editor.getByRole('button', { name: 'Apply cues' }).click();
  await showFiles.click();
  const wait = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const output = info.outputPath('edited-show.json');
  await (await wait).saveAs(output);
  const { cues } = JSON.parse(await readFile(output, 'utf8'));
  const original = JSON.parse(await readFile(example, 'utf8'));
  expect(cues[0]).toEqual(original.cues[0]);
  expect(cues[1]).toEqual({ ...original.cues[1], screen: { ...original.cues[1].screen, offsetSeconds: 2.375 } });
});

test.describe('portrait desk', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 393, height: 852 } });

  test('keeps brand and playback separate and displays the full camera name', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Show desk' }).click();
    await expect(page.getByLabel('Camera view')).toBeVisible();
    const layout = await page.locator('.stage-transport').evaluate(header => {
      const select = header.querySelector('.camera-select select');
      const style = getComputedStyle(select);
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = style.font;
      const brand = header.querySelector('.transport-brand > div').getBoundingClientRect();
      const playback = header.querySelector('.transport-playback').getBoundingClientRect();
      return {
        gap: playback.left - brand.right,
        textWidth: measure.measureText(select.selectedOptions[0].text).width,
        available: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        right: header.querySelector('.transport-tools > :last-child').getBoundingClientRect().right,
      };
    });
    expect(layout.gap).toBeGreaterThanOrEqual(4);
    expect(layout.available).toBeGreaterThanOrEqual(layout.textWidth);
    expect(layout.right).toBeLessThanOrEqual(393);
  });
});
