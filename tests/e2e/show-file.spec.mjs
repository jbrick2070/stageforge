import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const examplePath = fileURLToPath(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url));
const example = JSON.parse(await readFile(examplePath, 'utf8'));

async function openFiles(page) {
  await page.getByRole('button', { name: 'Show files' }).click();
  return page.getByRole('dialog', { name: 'Show files' });
}

async function saveShow(page, dialog, path) {
  const saving = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save show JSON' }).click();
  const download = await saving;
  expect(download.suggestedFilename()).toBe('amber-walk-on.stageforge.show.json');
  await download.saveAs(path);
  return JSON.parse(await readFile(path, 'utf8'));
}

// A real one-minute PCM soundtrack gives the invalid-import check a live media clock.
function rehearsalTrack() {
  const rate = 8000, samples = rate * 60;
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  return { name: 'Rehearsal #2.wav', mimeType: 'audio/wav', buffer: wav };
}

test('open an authored show, run and edit its cues, reject an invalid file during playback, then reopen the download', async ({ page }, info) => {
  await page.goto('/');
  const files = await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles(examplePath);
  await expect(files).toBeHidden();
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  const go = page.getByRole('button', { name: 'GO', exact: true });
  await expect(page.getByRole('button', { name: 'Cue 1, Walk-on in black' })).toHaveAttribute('aria-pressed', 'true');
  await go.click();
  await expect(page.getByRole('button', { name: 'Cue 2, Amber reveal' })).toHaveAttribute('aria-pressed', 'true');
  await openFiles(page);
  const reveal = await saveShow(page, files, info.outputPath('reveal.stageforge.show.json'));
  expect(reveal.look.masterDimmer).toBe(0.72);
  expect(reveal.timeline).toEqual(example.timeline);
  await files.getByRole('button', { name: 'Close Show files' }).click();

  await page.getByRole('button', { name: 'Edit cue list' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit cue list' });
  await editor.getByLabel('Follow after (seconds)').fill('');
  await editor.getByLabel('Cue order').selectOption('reveal');
  await editor.getByLabel('Cue name').fill('House amber');
  await editor.getByLabel('Follow after (seconds)').fill('0.75');
  await editor.getByRole('button', { name: 'Move earlier' }).click();
  await editor.getByRole('button', { name: 'Apply cues' }).click();
  await expect(editor).toBeHidden();

  const amber = page.getByRole('button', { name: 'Cue 1, House amber' });
  const black = page.getByRole('button', { name: 'Cue 2, Walk-on in black' });
  await black.click();
  await go.click();
  await expect(amber).toHaveAttribute('aria-pressed', 'true');
  await expect(black).toHaveAttribute('aria-pressed', 'true', { timeout: 8000 });
  await expect(go).toBeEnabled();

  await page.getByLabel('Load audio file').setInputFiles(rehearsalTrack());
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await openFiles(page);
  await expect(files.getByText('Rehearsal #2.wav', { exact: true })).toBeVisible();
  const before = await saveShow(page, files, info.outputPath('before-invalid.stageforge.show.json'));
  expect(before.media.music.playing).toBe(true);
  const bad = { ...before, rig: { ...before.rig, name: 'Must not load' }, activeCueId: 'missing' };
  await files.getByLabel('Open show file').setInputFiles({
    name: 'invalid.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)),
  });
  await expect(files.getByRole('status')).toContainText('activeCueId');
  await expect(files.getByText('Amber Walk-on', { exact: true })).toBeVisible();
  await expect(files.getByText('Rehearsal #2.wav', { exact: true })).toBeVisible();

  const output = info.outputPath('amber-walk-on.stageforge.show.json');
  const saved = await saveShow(page, files, output);
  expect(saved).toEqual({ ...before, media: { ...before.media, music: { ...before.media.music, offsetSeconds: saved.media.music.offsetSeconds } } });
  expect(saved.media.music.offsetSeconds).toBeGreaterThan(before.media.music.offsetSeconds);
  expect(saved.controls).toEqual(example.controls);
  expect(saved.timeline).toEqual(example.timeline);
  expect(saved.cues.map(cue => [cue.id, cue.name, cue.followSeconds])).toEqual([
    ['reveal', 'House amber', 0.75], ['walk-on', 'Walk-on in black', undefined],
  ]);
  expect(saved.activeCueId).toBe('walk-on');
  expect(saved.look.led.customMediaUrl).toBe(null);
  await info.attach('portable-show', { path: output, contentType: 'application/json' });

  // Reopen exactly the bytes the browser downloaded after a full page reload.
  await page.reload();
  await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles(output);
  await expect(files).toBeHidden();
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await expect(amber).toBeVisible();
  await expect(black).toHaveAttribute('aria-pressed', 'true');
  await openFiles(page);
  await expect(files.getByText('Rehearsal #2.wav', { exact: true })).toBeVisible();
  await expect(files.getByText(/Files to relink/)).toContainText('amber-clouds.mp4');
  await expect(files.getByText(/4 events/)).toBeVisible();
});

test('Resume demo continues the saved score position under the authored manual look', async ({ page }, info) => {
  const saved = structuredClone(example);
  saved.activeCueId = 'reveal';
  saved.look.masterDimmer = 0.51;
  saved.look.primaryColor = '#b28a41';
  saved.media.music = { kind: 'demo', name: 'Arena Anthem', playing: false, demoStep: 96.5 };
  await page.goto('/');
  const files = await openFiles(page);
  await files.getByLabel('Open show file').setInputFiles({
    name: 'resume.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(files).toBeHidden();
  await page.getByRole('button', { name: 'Resume demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Auto-LD' })).toHaveAttribute('aria-pressed', 'false');
  await openFiles(page);
  const playing = await saveShow(page, files, info.outputPath('resumed.stageforge.show.json'));
  expect(playing.activeCueId).toBe('reveal');
  expect(playing.look).toEqual(saved.look);
  expect(playing.media.music).toMatchObject({ kind: 'demo', playing: true });
  expect(playing.media.music.demoStep).toBeGreaterThanOrEqual(96.5);
  expect(playing.media.music.demoStep).toBeLessThan(192);
});
