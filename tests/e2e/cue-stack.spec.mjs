import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const example = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));

function rehearsal() {
  const file = structuredClone(example);
  file.cues = ['Blackout', 'First light', 'Moving pattern', 'Video reveal', 'Final hold'].map((name, i) => ({
    id: 'cue-' + i, name, tag: 'SHOW', accent: '#ffaa88',
    state: structuredClone(i ? example.cues[1].state : example.cues[0].state),
    ...(i === 1 ? { followSeconds: 3 } : {}),
  }));
  file.activeCueId = file.cues[0].id;
  delete file.timeline;
  delete file.media;
  return file;
}

test('a live override keeps GO, timed follow, Xbox D-pad and the saved show on the same stack position', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  // Each requested press lasts exactly one poll of a standard-mapping pad.
  await page.addInitScript(() => {
    window.testDpad = -1;
    Object.defineProperty(navigator, 'getGamepads', { value: () => {
      const tap = window.testDpad;
      window.testDpad = -1;
      return [{ index: 0, id: 'Test Xbox pad', connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === tap, value: i === tap ? 1 : 0 })) }];
    } });
  });
  await page.goto('/');
  const files = page.getByRole('dialog', { name: 'Show files' });
  const showFile = async file => {
    await page.getByRole('button', { name: 'Show files' }).press('Enter');
    await files.getByLabel('Open show file').setInputFiles(file);
    await expect(files).toBeHidden();
  };
  await showFile({ name: 'club.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(rehearsal())) });
  await page.getByRole('button', { name: 'Show cues', exact: true }).press('Enter');

  const stack = page.getByRole('group', { name: 'Cue stack' });
  const go = page.getByRole('button', { name: 'GO', exact: true });
  const firstLight = page.getByRole('button', { name: 'Cue 2, First light' });
  const crimson = page.getByRole('button', { name: 'Crimson', exact: true });
  await firstLight.press('Enter');
  await expect(firstLight.getByLabel('Follow after 3 seconds')).toBeVisible();
  await expect(stack).toContainText('Follow in');
  await crimson.press('Enter');
  await expect(stack).toContainText('Modified');
  await stack.getByRole('button', { name: 'Hold follow' }).press('Enter');
  await expect(stack).toContainText('Follow held');

  await page.clock.fastForward(3100);
  await expect(firstLight).toHaveAttribute('aria-pressed', 'true');
  await firstLight.press('Enter');
  await crimson.press('Enter');
  await expect(stack).toContainText('Follow in');
  await page.clock.fastForward(3100);
  await expect(stack.getByRole('status')).toHaveText(/Now 03 Moving pattern\s*Next 04 Video reveal/);
  await crimson.press('Enter');
  await page.getByRole('slider', { name: 'MASTER', exact: true }).fill('0.6');
  await expect(stack.getByRole('status')).toHaveText(/03 Moving patternModified\s*Next 04 Video reveal/);

  await page.getByRole('button', { name: 'Show files' }).press('Enter');
  const downloading = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).press('Enter');
  const path = info.outputPath('live-override.stageforge.show.json');
  await (await downloading).saveAs(path);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ activeCueId: 'cue-2', look: { masterDimmer: 0.6 } });
  await files.getByRole('button', { name: 'Close Show files' }).press('Enter');
  await showFile(path);
  await expect(stack).toContainText('Modified');
  await go.press('Enter');
  await expect(stack.getByRole('status')).toHaveText(/Now 04 Video reveal\s*Next 05 Final hold/);
  await crimson.press('Enter');
  await page.clock.runFor(40);
  await page.evaluate(() => { window.testDpad = 15; });
  await page.clock.runFor(40);
  await expect(stack.getByRole('status')).toHaveText(/Now 05 Final hold\s*Next 01 BlackoutWrap/);
  await crimson.press('Enter');
  await page.evaluate(() => { window.testDpad = 14; });
  await page.clock.runFor(40);
  await expect(stack.getByRole('status')).toHaveText(/Now 04 Video reveal\s*Next 05 Final hold/);
  await page.getByRole('button', { name: 'Reset to cue 1' }).press('Enter');
  await expect(stack.getByRole('status')).toHaveText(/Now 01 Blackout\s*Next 02 First light/);
});
