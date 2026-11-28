import { _electron as electron, expect, test } from '@playwright/test';
import dgram from 'node:dgram';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P4_CAMERA, p4Rehearsal } from '../support/p4-rehearsal.mjs';

const require = createRequire(import.meta.url);
const { encodeArtDmxPacket } = require('../../desktop/dmx-packets.cjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const staged = path.join(root, 'desktop', 'build', 'app');
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const source = page => page.getByLabel('Level source', { exact: true });
const status = page => page.getByTestId('level-source-status');
const contrast = 0.07;

function bind(socket) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
  });
}
const close = socket => new Promise(resolve => socket.close(resolve));
async function openShow(page, show) {
  await button(page, 'Show files').click();
  const files = page.getByRole('dialog', { name: 'Show files', exact: true });
  await files.getByLabel('Open show file').setInputFiles({
    name: 'p4.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(show)),
  });
  await expect(files).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.rig().name)).toBe(show.rig.name);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.patchOccupancy('resolved').units.filter(unit => unit.groupId === 'preview-blinders').length)).toBe(2);
  await page.evaluate(camera => {
    window.stageforgeProbe.setRenderSettings({ bloom: 'half', trueColour: false });
    window.stageforgeProbe.setCameraPose(...camera);
  }, P4_CAMERA);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.renderStats().bloomActive)).toBe(true);
}

async function openInput(page) {
  await button(page, 'DMX monitor').click();
  const drawer = page.getByRole('complementary', { name: 'DMX monitor', exact: true });
  await button(drawer, 'Art-Net input').click();
  return { drawer, rx: drawer.getByRole('region', { name: 'Art-Net input monitor', exact: true }) };
}

const readLenses = page => page.evaluate(() => {
  const p = window.stageforgeProbe;
  const pixels = p.blinderLensPixels();
  return { pixels, levels: pixels.map(unit => Math.max(...unit.lenses.map(sample => sample.luminance))),
    cue: p.activeCueId(), take: p.takeState().mode, live: p.dmxLive(), output: p.physicalDmxSnapshot() };
});

test('P4 packaged desktop opens on Desk with External Levels unavailable until listening', async () => {
  const packaged = process.env.STAGEFORGE_DESKTOP_EXE;
  test.skip(!packaged, 'Supply STAGEFORGE_DESKTOP_EXE for the packaged cold-start proof.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-p4-offline-'));
  let app;
  try {
    app = await electron.launch({ executablePath: path.resolve(packaged), args: [`--user-data-dir=${path.join(temp, 'profile')}`], timeout: 20_000 });
    const page = await app.firstWindow({ timeout: 12_000 });
    page.setDefaultTimeout(12_000);
    await expect(source(page)).toHaveValue('desk');
    await expect(source(page).locator('option[value="external"]')).toBeDisabled();
    const { rx } = await openInput(page);
    await expect(rx.getByTestId('artnet-input-status')).toHaveText('Off');
    await expect(rx.getByLabel('Art-Net binding')).toHaveValue('127.0.0.1');
    expect(await page.evaluate(() => window.stageforgeDesktop.dmxControl({ type: 'getStatus' }).then(current => current.enabled))).toBe(false);
  } finally {
    await app?.close().catch(() => {});
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('P4 Art-Net External Levels renders independently over desktop loopback and returns to the current Desk cue', async ({}, info) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-external-levels-'));
  const profile = `--user-data-dir=${path.join(temp, 'profile')}`;
  const sender = dgram.createSocket('udp4');
  const reservation = dgram.createSocket('udp4');
  await bind(sender);
  const port = await bind(reservation);
  await close(reservation);
  let sequence = 0;
  const send = (left, right) => new Promise((resolve, reject) => {
    sequence = sequence % 255 + 1;
    const packet = encodeArtDmxPacket({ portAddress: 2, sequence, slots: Uint8Array.of(left, right) });
    sender.send(packet, port, '127.0.0.1', error => error ? reject(error) : resolve());
  });
  const launch = () => electron.launch({
    executablePath: require('electron'), args: [staged, profile], timeout: 20_000,
    env: { ...process.env, STAGEFORGE_ARTNET_RX_TEST_PORT: String(port), STAGEFORGE_DMX_TEST_ARTNET_PORT: String(port) },
  });
  let app;
  try {
    app = await launch();
    const page = await app.firstWindow({ timeout: 12_000 });
    page.setDefaultTimeout(12_000);
    await page.goto('stageforge://app/?probe', { waitUntil: 'domcontentloaded' });
    await app.evaluate(() => {
      const dgram = process.getBuiltinModule('node:dgram');
      const sendDatagram = dgram.Socket.prototype.send;
      globalThis.__p4Sends = 0;
      dgram.Socket.prototype.send = function (...args) {
        globalThis.__p4Sends++;
        return sendDatagram.apply(this, args);
      };
    });
    const show = p4Rehearsal();
    await openShow(page, show);
    await expect.poll(async () => (await readLenses(page)).pixels.filter(unit => unit.lenses.length > 0).length).toBe(2);
    const initial = await readLenses(page);
    expect(initial.take).toBe('idle');
    expect(initial.pixels.map(unit => unit.address)).toEqual([{ universe: 3, start: 1 }, { universe: 3, start: 2 }]);
    const { drawer, rx } = await openInput(page);
    await expect(source(page)).toHaveValue('desk');
    await expect(rx.getByTestId('artnet-input-status')).toHaveText('Off');
    await button(rx, 'Start listening').click();
    await expect(status(page)).toContainText('awaiting first frame');
    await send(0, 255);
    await expect(rx.getByTestId('artnet-input-slot-1')).toHaveAttribute('aria-label', 'U3.001: 0');
    await expect(rx.getByTestId('artnet-input-slot-2')).toHaveAttribute('aria-label', 'U3.002: 255');
    const monitorOnly = await readLenses(page);
    monitorOnly.levels.forEach((level, index) => expect(Math.abs(level - initial.levels[index])).toBeLessThan(0.02));
    await source(page).selectOption('external');
    await expect.poll(async () => { const { levels } = await readLenses(page); return levels[1] - levels[0]; })
      .toBeGreaterThan(contrast);
    const right = await readLenses(page);
    expect(right.output).toEqual(initial.output);

    await send(255, 0);
    await expect(rx.getByTestId('artnet-input-slot-1')).toHaveAttribute('aria-label', 'U3.001: 255');
    await expect(rx.getByTestId('artnet-input-slot-2')).toHaveAttribute('aria-label', 'U3.002: 0');
    await expect.poll(async () => { const { levels } = await readLenses(page); return levels[0] - levels[1]; })
      .toBeGreaterThan(contrast);
    const left = await readLenses(page);
    expect(left.output).toEqual(initial.output);

    await button(drawer, 'Close DMX monitor').click();
    await expect(source(page)).toHaveValue('external');
    await button(page, 'Show cues').click();
    await page.getByRole('button', { name: /^Cue 2, Desk full,/ }).press('Enter');
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('warm');
    await expect.poll(() => status(page).textContent(), { timeout: 6000 }).toContain('stale');
    const expired = await readLenses(page);
    expect(expired.levels[0]).toBeLessThan(left.levels[0] - contrast);
    await send(0, 255);
    await expect.poll(async () => { const { levels } = await readLenses(page); return levels[1] - levels[0]; })
      .toBeGreaterThan(contrast);
    const fresh = await readLenses(page);
    const reopened = await openInput(page);
    await button(reopened.rx, 'Stop listening').click();
    await expect(source(page)).toHaveValue('desk');
    const handoff = await readLenses(page);
    expect(handoff.levels[1]).toBeGreaterThan(fresh.levels[1] - contrast / 2);
    await expect.poll(async () => (await readLenses(page)).levels[0]).toBeGreaterThan(expired.levels[0] + contrast);
    expect((await readLenses(page)).live).toBe(false);
    await button(reopened.drawer, 'Close DMX monitor').click();

    const savedPath = path.join(temp, 'p4-saved.stageforge.show.json');
    await app.evaluate(({ session }, target) => {
      globalThis.__p4Download = 'waiting';
      const download = (_event, item) => {
        session.defaultSession.off('will-download', download);
        item.setSavePath(target);
        item.once('done', (_event, state) => { globalThis.__p4Download = state; });
      };
      session.defaultSession.on('will-download', download);
    }, savedPath);
    await button(page, 'Show files').click();
    const files = page.getByRole('dialog', { name: 'Show files', exact: true });
    await button(files, 'Save show JSON').click();
    await expect.poll(() => app.evaluate(() => globalThis.__p4Download)).toBe('completed');
    const saved = JSON.parse(await readFile(savedPath, 'utf8'));
    expect(saved.cues).toEqual(show.cues);
    expect(saved.rig.trussPods[0].fixtures).toEqual(show.rig.trussPods[0].fixtures);
    expect(saved.look.blinderLevel).toBe(1);
    expect(saved).not.toHaveProperty('levelSource');
    await button(files, 'Close Show files').click();
    await openShow(page, saved);
    await expect(source(page)).toHaveValue('desk');
    expect((await readLenses(page)).live).toBe(false);
    expect(await app.evaluate(() => globalThis.__p4Sends)).toBe(0);
    await info.attach('p4-desktop-post-bloom-lenses', { body: JSON.stringify({ right: right.pixels, left: left.pixels,
      expired: expired.pixels, handoff: handoff.pixels }), contentType: 'application/json' });

    await app.close();
    app = await launch();
    const restarted = await app.firstWindow({ timeout: 12_000 });
    restarted.setDefaultTimeout(12_000);
    await expect(source(restarted)).toHaveValue('desk');
    await expect(status(restarted)).toContainText('off');
    await expect(source(restarted).locator('option[value="external"]')).toBeDisabled();
  } finally {
    await app?.close().catch(() => {});
    await close(sender);
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
