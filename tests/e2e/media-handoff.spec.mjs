import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const video = fileURLToPath(new URL('../../public/examples/amber-clouds.mp4', import.meta.url));
const template = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));
const filesDialog = page => page.getByRole('dialog', { name: 'Show files' });

async function open(page, show) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Show files' }).click();
  await filesDialog(page).getByLabel('Open show file').setInputFiles({
    name: 'rehearsal.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(show)),
  });
  await expect(filesDialog(page)).toBeHidden();
}

async function save(page) {
  await page.getByRole('button', { name: 'Show files' }).click();
  const download = page.waitForEvent('download');
  await filesDialog(page).getByRole('button', { name: 'Save show JSON' }).click();
  const show = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  await filesDialog(page).getByRole('button', { name: 'Close Show files' }).click();
  return show;
}

function silentTrack(duration = 10) {
  const rate = 8000, bytes = rate * 2 * duration;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF'); buffer.writeUInt32LE(36 + bytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40);
  return { name: 'walk-on.wav', mimeType: 'audio/wav', buffer };
}

test('an unopened media handoff names the missing LED clip and relinks the two files', async ({ page }) => {
  const show = structuredClone(template);
  const track = silentTrack();
  show.media.music = { kind: 'file', name: track.name, playing: false, offsetSeconds: 4 };
  show.media.screen = { target: 'main-led', name: '', kind: 'none', playing: false };
  delete show.timeline;
  // Observe the real texture drawing, including the name selected by the cue.
  await page.addInitScript(() => {
    window.slateText = [];
    const draw = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      window.slateText.push(text);
      return draw.call(this, text, ...args);
    };
  });
  await open(page, show);
  const alert = page.getByRole('button', { name: '2 missing media files · Relink' });
  await expect(alert).toBeVisible();
  await page.getByRole('button', { name: 'Cue 2, Amber reveal' }).click();
  await expect.poll(() => page.evaluate(() => window.slateText)).toEqual(expect.arrayContaining(['MISSING MEDIA', 'amber-clouds.mp4']));
  expect((await save(page)).media.screen).toEqual(show.cues[1].screen);
  await alert.click();
  await filesDialog(page).getByLabel('Relink media files').setInputFiles([track, {
    name: 'amber-clouds.mp4', mimeType: 'video/mp4', buffer: await readFile(video),
  }]);
  await expect(filesDialog(page).getByRole('status')).toHaveText('Relinked 2 media references.');
  await filesDialog(page).getByRole('button', { name: 'Close Show files' }).click();
  await expect(alert).toHaveCount(0);
  await page.getByRole('button', { name: 'Play track', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  await page.getByRole('slider', { name: 'Track position' }).fill('7');
  await expect(page.getByRole('slider', { name: 'Track position' })).toHaveValue('7');
  await page.getByRole('button', { name: 'Restart 0:00' }).click();
  await expect(page.getByRole('slider', { name: 'Track position' })).toHaveValue('0');
  const saved = await save(page);
  expect(saved.media.music).toMatchObject({ offsetSeconds: 0, playing: false });
  expect(saved.media.screen.playing).toBe(true);
});

test('video upload restores a dark wall and stored cue in-points are deliberate', async ({ page }) => {
  const show = structuredClone(template);
  // A paused known in-point distinguishes live transport from a stored cue's default.
  show.cues[0].screen.offsetSeconds = 2.25;
  delete show.timeline;
  await open(page, show);
  const motors = page.getByRole('button', { name: 'Motors & FX' });
  const cues = page.getByRole('button', { name: 'Show cues', exact: true });
  await motors.click();
  await page.getByLabel('Load screen media').setInputFiles(video);
  const uploaded = await save(page);
  expect(uploaded.look.led).toMatchObject({ enabled: true, visualMode: 'custom', brightness: 1 });
  await cues.click();
  await page.getByRole('button', { name: 'Cue 1, Walk-on in black' }).click();
  await page.getByRole('button', { name: 'Store cue', exact: true }).click();
  await page.getByRole('button', { name: 'Cue 2, Amber reveal' }).click();
  expect((await save(page)).cues[1].screen.offsetSeconds).toBe(0);
  await motors.click();
  await page.getByLabel('Store cues at current video position').check();
  await cues.click();
  await page.getByRole('button', { name: 'Store cue', exact: true }).click();
  await page.getByRole('button', { name: 'Cue 2, Amber reveal' }).click();
  const saved = await save(page);
  expect(saved.cues[1].screen.offsetSeconds).toBeCloseTo(2.25, 2);
  expect(saved.media.screen.offsetSeconds).toBeCloseTo(2.25, 2);
});

test('relinking during a take restores the recorded hold on both transports', async ({ page }) => {
  const show = structuredClone(template);
  const track = silentTrack();
  const frame = show.timeline.events[0];
  frame.screen = { ...frame.screen, playing: false, offsetSeconds: 2.25 };
  frame.music = { kind: 'file', name: track.name, playing: false, offsetSeconds: 3.5 };
  show.timeline = { durationMs: 60000, events: [frame] };
  await open(page, show);
  await page.getByRole('button', { name: 'Replay take' }).click();
  await page.getByRole('button', { name: '2 missing media files · Relink' }).click();
  await filesDialog(page).getByLabel('Relink media files').setInputFiles([track, {
    name: 'amber-clouds.mp4', mimeType: 'video/mp4', buffer: await readFile(video),
  }]);
  await filesDialog(page).getByRole('button', { name: 'Close Show files' }).click();
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Track position' })).toHaveValue('3.5');
  const saved = await save(page);
  expect(saved.media.screen).toMatchObject({ offsetSeconds: 2.25, playing: false });
  expect(saved.media.music).toMatchObject({ offsetSeconds: 3.5, playing: false });
});

test('closing the relink dialog and choosing an entire media folder leave linked sources running', async ({ page }) => {
  const show = structuredClone(template);
  delete show.timeline;
  show.media.screen = show.cues[1].screen;
  show.look = { ...show.look, ...show.cues[1].state };
  show.cues[0].screen = { target: 'main-led', kind: 'image', name: 'foil.png', playing: false };
  const mp4 = { name: 'amber-clouds.mp4', mimeType: 'video/mp4', buffer: await readFile(video) };
  await page.addInitScript(() => {
    const create = document.createElement.bind(document);
    document.createElement = function(tag, ...rest) {
      const result = create(tag, ...rest);
      if (tag === 'video') window.wallVideo = result;
      return result;
    };
  });
  await open(page, show);
  await page.getByRole('button', { name: '2 missing media files · Relink' }).click();
  await filesDialog(page).getByLabel('Relink media files').setInputFiles(mp4);
  await filesDialog(page).getByRole('button', { name: 'Close Show files' }).click();
  await expect.poll(() => page.evaluate(() => window.wallVideo && !window.wallVideo.paused)).toBe(true);
  const url = await page.evaluate(() => window.wallVideo.src);
  const track = silentTrack(30);
  await page.getByLabel('Load audio file').setInputFiles(track);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  const alert = page.getByRole('button', { name: '1 missing media file · Relink' });
  await alert.click();
  await page.keyboard.press('Escape');
  await expect(alert).toBeVisible();
  await alert.click();
  const replacement = { ...track, buffer: Buffer.from('invalid sound') };
  // The PNG is assigned to another cue. Its bytes are untouched until that cue fires.
  const png = { name: 'foil.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pOgAAAAASUVORK5CYII=', 'base64') };
  await filesDialog(page).getByLabel('Relink media files').setInputFiles([mp4, replacement, png]);
  await expect(filesDialog(page).getByRole('status')).toHaveText('Relinked 1 media reference.');
  await filesDialog(page).getByRole('button', { name: 'Close Show files' }).click();
  expect(await page.evaluate(() => window.wallVideo.src)).toBe(url);
  // An explicit failed audio replacement must preserve the current live source.
  await page.getByLabel('Load audio file').setInputFiles(replacement);
  await expect(page.getByText('Could not play audio file')).toBeVisible();
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  const position = page.getByRole('slider', { name: 'Track position' });
  await expect(position).toHaveAttribute('max', '30');
  const oldPosition = Number(await position.inputValue());
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(oldPosition);
  await page.getByLabel('Load audio file').setInputFiles(silentTrack(20));
  await expect(position).toHaveAttribute('max', '20');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});
