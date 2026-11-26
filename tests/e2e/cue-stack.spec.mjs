import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const example = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));

function rehearsal() {
  const file = structuredClone(example);
  file.version = 9;
  file.$schema = 'https://jbrick2070.github.io/stageforge/schemas/show-v9.schema.json';
  file.cues = ['Blackout', 'First light', 'Moving pattern', 'Video reveal', 'Final hold'].map((name, i) => ({
    id: 'cue-' + i, name, tag: 'SHOW', accent: '#ffaa88',
    state: {
      ...structuredClone(i ? example.cues[1].state : example.cues[0].state),
      ...(i ? { beamIntensity: i === 1 ? 0.9 : 0.2 + i * 0.1, washIntensity: i === 1 ? 0.8 : 0.15 + i * 0.1 } : {}),
    },
    ...(i === 1 ? { fadeSeconds: 4, followSeconds: 3 } : i === 2 ? { fadeSeconds: 1 } : {}),
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
  await page.goto('/?probe');
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
  await expect(firstLight).toContainText('Fade 4s');
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.showStateSummary().beamIntensity)).toBe(0.9);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.cuePreview())).not.toBeNull();
  await expect(firstLight.getByLabel('Follow after 3 seconds')).toBeVisible();
  await expect(stack).toContainText('Follow in');
  await crimson.press('Enter');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.cuePreview())).toBeNull();
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
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.showStateSummary().beamIntensity)).toBeCloseTo(0.4, 5);
  const followedPreview = await page.evaluate(() => window.stageforgeProbe?.cuePreview());
  expect(followedPreview).not.toBeNull();
  expect(followedPreview.beamIntensity, 'follow starts from the currently displayed level').toBeCloseTo(0.9, 5);
  await page.clock.fastForward(500);
  const followedMidpoint = await page.evaluate(() => window.stageforgeProbe?.cuePreview());
  expect(followedMidpoint.beamIntensity).toBeGreaterThan(0.4);
  expect(followedMidpoint.beamIntensity).toBeLessThan(0.9);
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

test('a recorded cue fade saves one transition descriptor and seek/play restore the same midpoint', async ({ page }, info) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const file = rehearsal();
  file.cues = file.cues.slice(0, 2);
  file.cues[1].fadeSeconds = 2;
  delete file.cues[1].followSeconds;
  file.activeCueId = file.cues[0].id;

  await page.goto('/?probe');
  const files = page.getByRole('dialog', { name: 'Show files' });
  await page.getByRole('button', { name: 'Show files' }).click();
  await files.getByLabel('Open show file').setInputFiles({
    name: 'fade-take.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)),
  });
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('button', { name: 'Record take', exact: true }).click();
  await page.getByRole('button', { name: 'Cue 2, First light' }).click();
  await page.clock.fastForward(2100);
  await page.getByRole('button', { name: 'Stop recording' }).click();

  await page.getByRole('button', { name: 'Show files' }).click();
  const downloading = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const output = info.outputPath('fade-take.stageforge.show.json');
  await (await downloading).saveAs(output);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  const transitions = saved.timeline.events.filter((event) => event.cueFade);
  expect(transitions).toHaveLength(1);
  expect(transitions[0].cueFade.durationMs).toBe(2000);
  expect(transitions[0].cueFade.to.beamIntensity).toBe(0.9);
  await files.getByRole('button', { name: 'Close Show files' }).click();

  const takePosition = page.getByRole('slider', { name: 'Take position' });
  await takePosition.fill(String(transitions[0].atMs + 1000));
  await page.clock.runFor(20);
  const seekMidpoint = await page.evaluate(() => window.stageforgeProbe?.cuePreview());
  expect(seekMidpoint.beamIntensity).toBeCloseTo(0.625, 2);
  expect(seekMidpoint.washIntensity).toBeCloseTo(0.4, 2);

  await page.getByRole('button', { name: 'Replay take' }).click();
  await page.clock.fastForward(transitions[0].atMs + 1000);
  const playMidpoint = await page.evaluate(() => window.stageforgeProbe?.cuePreview());
  expect(playMidpoint.beamIntensity).toBeCloseTo(seekMidpoint.beamIntensity, 2);
  expect(playMidpoint.washIntensity).toBeCloseTo(seekMidpoint.washIntensity, 2);
});
