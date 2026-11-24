import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Fixture take: 16 s, lighting cues at 0, 2.5, 6.5, 11 and 16 s; main LED plays amber-clouds.mp4
// from 6.5 s; the "Stage right" wall clears at 0, holds guest-surface.mp4 at 6.5, holds
// blue-raster.mp4 at 11, plays it at 13.5 and clears at 16 s.
const fixture = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));
const DURATION = 16_000;

const openFiles = async page => {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  return page.getByRole('dialog', { name: 'Show files' });
};
const openShow = async page => {
  await page.goto('/?probe');
  const files = await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles(fixture);
  await expect(files).toBeHidden();
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
};
const relinkAll = async page => {
  const video = await readFile(new URL('../../public/examples/amber-clouds.mp4', import.meta.url));
  const files = await openFiles(page);
  await files.getByLabel('Relink media files').setInputFiles(['amber-clouds.mp4', 'blue-raster.mp4', 'guest-surface.mp4']
    .map(name => ({ name, mimeType: 'video/mp4', buffer: video })));
  await expect(files.getByRole('status')).toHaveText('Relinked 3 media references.');
  await files.getByRole('button', { name: 'Close Show files' }).click();
};
const badges = page => page.getByRole('list', { name: 'Screen status' });
// Slider drags seek on the next animation frame; software GL renders the laser-heavy
// end of this take at about one frame per second, so scrub-driven checks wait longer.
const expectBadge = async (page, screen, name, state, timeout = 10_000) => {
  const badge = badges(page).locator(`[data-screen="${screen}"]`);
  await expect(badge).toHaveAccessibleName(name, { timeout });
  await expect(badge).toHaveAttribute('data-state', state);
};
// Center of a marker as a fraction of the scrubber's thumb travel (10 px thumb in the desk).
const markerFraction = async (page, marker) => {
  const slider = await page.getByRole('slider', { name: 'Take position' }).boundingBox();
  const box = await marker.boundingBox();
  return (box.x + box.width / 2 - slider.x - 5) / (slider.width - 10);
};

test('scrubber markers place cue and wall events at their take positions, name them and seek', async ({ page }) => {
  await openShow(page);
  const markers = page.getByRole('toolbar', { name: 'Take markers' });
  await expect(markers.locator('[data-kind="cue"]')).toHaveCount(5);
  await expect(markers.locator('[data-kind="wall"]')).toHaveCount(5);

  for (const [name, atMs] of [
    ['Cue Walk in black at 0:00.0', 0],
    ['Cue Drummer in amber at 0:02.5', 2_500],
    ['Cue Blue sweep at 0:06.5', 6_500],
    ['Cue Two laser projectors at 0:11.0', 11_000],
    ['Stage right: guest-surface.mp4 (hold) at 0:06.5', 6_500],
    ['Stage right: blue-raster.mp4 (hold) at 0:11.0', 11_000],
    ['Stage right: blue-raster.mp4 (play) at 0:13.5', 13_500],
    ['Stage right: clear at 0:16.0', 16_000],
  ]) {
    const marker = markers.getByRole('button', { name, exact: true });
    await expect(marker).toHaveAttribute('data-at-ms', String(atMs));
    await expect(marker).toHaveAttribute('title', name);
    expect(Math.abs(await markerFraction(page, marker) - atMs / DURATION)).toBeLessThan(0.01);
  }
  // Lighting cues and wall events use separate lanes and colours.
  const cueTick = markers.getByRole('button', { name: 'Cue Blue sweep at 0:06.5', exact: true });
  const wallTick = markers.getByRole('button', { name: 'Stage right: guest-surface.mp4 (hold) at 0:06.5', exact: true });
  expect((await wallTick.boundingBox()).y).toBeGreaterThan((await cueTick.boundingBox()).y);
  const colour = locator => locator.locator('span').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await colour(cueTick)).not.toBe(await colour(wallTick));

  // Clicking a marker seeks; the rail is one tab stop with arrow/Home/End roving.
  const scrubber = page.getByRole('slider', { name: 'Take position' });
  await markers.getByRole('button', { name: 'Stage right: blue-raster.mp4 (play) at 0:13.5', exact: true }).click();
  await expect(scrubber).toHaveValue('13500');
  await expect(markers.locator('button[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('End');
  await expect(markers.getByRole('button', { name: 'Stage right: clear at 0:16.0', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(markers.getByRole('button', { name: 'Cue Walk in black at 0:16.0', exact: true })).toBeFocused();
  // Home is the 0 s cue, then the 0 s wall clear, then the 2.5 s cue.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(markers.getByRole('button', { name: 'Cue Drummer in amber at 0:02.5', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(scrubber).toHaveValue('2500');

  // Markers never cover the scrubber, so a drag still works.
  const slider = await scrubber.boundingBox();
  await page.mouse.move(slider.x + 5 + (slider.width - 10) * 0.15625, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(slider.x + 5 + (slider.width - 10) * 0.75, slider.y + slider.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await scrubber.inputValue()), { timeout: 15_000 }).toBeGreaterThan(11_000);
});

test('Use playhead fills the wall cue time while idle, paused and playing, and the saved cue gets a marker', async ({ page }) => {
  test.setTimeout(90_000);
  await openShow(page);
  const scrubber = page.getByRole('slider', { name: 'Take position' });
  const time = page.getByLabel('Wall cue time (s)', { exact: true });

  // Idle: scrub, then one click copies the playhead.
  await scrubber.fill('9000');
  await expect(page.locator('.take-actions output')).toHaveText(/^0:09\.0 /, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Motors & FX', exact: true }).click();
  await time.fill('1');
  await page.getByRole('button', { name: 'Use playhead', exact: true }).click();
  await expect(time).toHaveValue('9');
  await page.getByLabel('Wall cue action', { exact: true }).selectOption('play');
  await page.getByLabel('Wall cue media filename', { exact: true }).fill('intro.mp4');
  await page.getByRole('button', { name: 'Apply wall cue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove wall cue at 0:09.0', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  const markers = page.getByRole('toolbar', { name: 'Take markers' });
  const saved = markers.getByRole('button', { name: 'Stage right: intro.mp4 (play) at 0:09.0', exact: true });
  await expect(saved).toHaveAttribute('data-at-ms', '9000');
  expect(Math.abs(await markerFraction(page, saved) - 9_000 / DURATION)).toBeLessThan(0.01);
  await expect(markers.locator('[data-kind="wall"]')).toHaveCount(6);
  // The new clip is not linked, so its wall reads Missing at the playhead.
  await expectBadge(page, 'side-led', 'Stage right: intro.mp4, Missing', 'missing');

  // Paused: the field takes the exact held position shown by the transport.
  const clock = page.locator('.take-actions output');
  const heldAt = await clock.textContent();
  await page.getByRole('button', { name: 'Resume take', exact: true }).click();
  // Let the take run until the transport readout moves (software GL can be slow).
  await expect.poll(async () => (await clock.textContent()) !== heldAt, { timeout: 20_000 }).toBe(true);
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume take', exact: true })).toBeVisible();
  const shown = (await page.locator('.take-actions output').textContent()).split(' / ')[0];
  const [minutes, seconds] = shown.split(':').map(Number);
  await page.getByRole('button', { name: 'Motors & FX', exact: true }).click();
  await time.fill('0');
  await page.getByRole('button', { name: 'Use playhead', exact: true }).click();
  const paused = Number(await time.inputValue());
  expect(paused).toBeGreaterThan(9);
  expect(Math.floor(Math.round(paused * 1000) / 100)).toBe(Math.round((minutes * 60 + seconds) * 10));

  // Playing: the field follows the running clock.
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('button', { name: 'Resume take', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Motors & FX', exact: true }).click();
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Use playhead', exact: true }).click();
    return Number(await time.inputValue());
  }, { timeout: 20_000 }).toBeGreaterThan(paused + 0.3);
  const playing = Number(await time.inputValue());
  expect(playing).toBeLessThanOrEqual(DURATION / 1000);
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('button', { name: 'Stop replay', exact: true }).click();
});

test('screen badges show the clip and state in effect on every screen while playing, paused and scrubbed', async ({ page }) => {
  test.setTimeout(90_000);
  await openShow(page);
  const scrubber = page.getByRole('slider', { name: 'Take position' });
  await expect(badges(page).getByRole('listitem')).toHaveCount(2);

  // Scrubbed, unlinked: nothing before the 6.5 s screen events, then both clips are Missing.
  await scrubber.fill('3000');
  await expectBadge(page, 'main-led', 'Upstage wall: no clip, Empty', 'none');
  await expectBadge(page, 'side-led', 'Stage right: no clip, Empty', 'none');
  await scrubber.fill('7000');
  await expectBadge(page, 'main-led', 'Upstage wall: amber-clouds.mp4, Missing', 'missing');
  await expectBadge(page, 'side-led', 'Stage right: guest-surface.mp4, Missing', 'missing');

  // Linked and idle: a scrubbed position holds every clip.
  await relinkAll(page);
  await expectBadge(page, 'main-led', 'Upstage wall: amber-clouds.mp4, Hold', 'hold');
  await expectBadge(page, 'side-led', 'Stage right: guest-surface.mp4, Hold', 'hold');

  const probeSide = () => page.evaluate(() => window.stageforgeProbe.screens().find(s => s.id === 'side-led'));
  const probeMain = () => page.evaluate(() => window.stageforgeProbe.primaryScreen());

  // Playing across the 6.5 s screen events: both screens empty before, then main plays and the wall holds.
  await scrubber.fill('5000');
  await expectBadge(page, 'main-led', 'Upstage wall: no clip, Empty', 'none');
  await page.getByRole('button', { name: 'Resume take', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  await expectBadge(page, 'side-led', 'Stage right: no clip, Empty', 'none');
  await expectBadge(page, 'main-led', 'Upstage wall: amber-clouds.mp4, Play', 'play', 15_000);
  await expectBadge(page, 'side-led', 'Stage right: guest-surface.mp4, Hold', 'hold');
  // The badges agree with what the renderer put on the walls.
  await expect.poll(probeMain).toMatchObject({ playing: true });
  await expect.poll(probeSide).toMatchObject({ name: 'guest-surface.mp4', playing: false, missing: false });

  // Paused: the running main clip holds.
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume take', exact: true })).toBeVisible();
  await expectBadge(page, 'main-led', 'Upstage wall: amber-clouds.mp4, Hold', 'hold');
  await expectBadge(page, 'side-led', 'Stage right: guest-surface.mp4, Hold', 'hold');
  await expect.poll(probeMain).toMatchObject({ playing: false });

  // blue-raster.mp4 holds from 11 s and its 13.5 s cue plays it: Hold while parked before the
  // cue, Play once the running take crosses it, Hold again when paused.
  await scrubber.fill('13000');
  await expectBadge(page, 'side-led', 'Stage right: blue-raster.mp4, Hold', 'hold', 15_000);
  await page.getByRole('button', { name: 'Resume take', exact: true }).click();
  await expectBadge(page, 'side-led', 'Stage right: blue-raster.mp4, Play', 'play');
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume take', exact: true })).toBeVisible();
  await expectBadge(page, 'side-led', 'Stage right: blue-raster.mp4, Hold', 'hold');
  await expectBadge(page, 'main-led', 'Upstage wall: amber-clouds.mp4, Hold', 'hold');
  await expect.poll(probeSide).toMatchObject({ name: 'blue-raster.mp4', playing: false });

  // The final clears empty both screens.
  await scrubber.fill('16000');
  await expectBadge(page, 'main-led', 'Upstage wall: no clip, Empty', 'none', 20_000);
  await expectBadge(page, 'side-led', 'Stage right: no clip, Empty', 'none');
});
