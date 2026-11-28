import { _electron as electron, expect, test } from '@playwright/test';
import dgram from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { encodeArtDmxPacket } = require('../../desktop/dmx-packets.cjs');
const { encodeArtNetTimecode } = require('../../desktop/osc-packets.cjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const staged = path.join(root, 'desktop', 'build', 'app');
const show = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));

function bind(socket) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
  });
}
const close = socket => new Promise(resolve => socket.close(resolve));
const button = (scope, name) => scope.getByRole('button', { name, exact: true });

async function openInput(page) {
  await button(page, 'DMX monitor').click();
  const drawer = page.getByRole('complementary', { name: 'DMX monitor', exact: true });
  await button(drawer, 'Art-Net input').click();
  return { drawer, rx: drawer.getByRole('region', { name: 'Art-Net input monitor' }) };
}

test('desktop Art-Net input monitors pinned U3, keeps Timecode listening, emits no UDP and restarts off', async () => {
  // Positive test ports are intentionally available only in the staged, unpackaged build.
  // The packaged editor's cold surface is covered in electron-smoke.spec.mjs.
  const temp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-artnet-input-'));
  const profile = `--user-data-dir=${path.join(temp, 'profile')}`;
  const reserved = dgram.createSocket('udp4');
  const sender = dgram.createSocket('udp4');
  await bind(sender);
  const port = await bind(reserved);
  await close(reserved);
  const launch = () => electron.launch({
    executablePath: require('electron'), args: [staged, profile],
    env: { ...process.env, STAGEFORGE_ARTNET_RX_TEST_PORT: String(port), STAGEFORGE_DMX_TEST_ARTNET_PORT: String(port) },
    timeout: 20_000,
  });
  const send = packet => new Promise((resolve, reject) => sender.send(packet, port, '127.0.0.1',
    error => error ? reject(error) : resolve()));
  const dmx = (sequence, first) => encodeArtDmxPacket({ portAddress: 2, sequence, slots: Uint8Array.of(first, 2) });
  const tc = frames => encodeArtNetTimecode({ hours: 1, minutes: 2, seconds: 3, frames, fps: 30 });
  let app;
  try {
    app = await launch();
    const page = await app.firstWindow({ timeout: 12_000 });
    page.setDefaultTimeout(12_000);
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(() => {
      const dgram = process.getBuiltinModule('node:dgram');
      const sendDatagram = dgram.Socket.prototype.send;
      globalThis.__p3OutgoingUdp = 0;
      dgram.Socket.prototype.send = function (...args) {
        globalThis.__p3OutgoingUdp++;
        return sendDatagram.apply(this, args);
      };
    });
    const before = await page.evaluate(() => localStorage.getItem('stageforge.design.v1'));
    const { rx, drawer } = await openInput(page);
    const status = rx.getByTestId('artnet-input-status');
    const slot = rx.getByTestId('artnet-input-slot-1');
    await expect(status).toHaveText('Off');
    await expect(rx.getByLabel('Art-Net binding')).toHaveValue('127.0.0.1');
    await expect(rx.getByLabel('Port-Address mapping 2')).toHaveValue('2');
    await expect(rx.getByLabel('Universe mapping 2')).toHaveValue('3');
    await expect(rx.getByLabel('Pinned sender mapping 2')).toHaveValue('127.0.0.1');

    await button(rx, 'Start listening').click();
    await expect(status).toHaveText('Awaiting first frame');
    await send(dmx(1, 146));
    await expect(status).toHaveText('Receiving');
    await expect(slot).toHaveAttribute('aria-label', 'U3.001: 146');
    await expect(rx.getByTestId('artnet-input-slot-512')).toHaveAttribute('aria-label', 'U3.512: 0');
    await button(rx, 'Stop listening').click();
    await expect(status).toHaveText('Off');
    await expect(slot).toHaveAttribute('aria-label', 'U3.001: 0');

    const timecodePort = await page.evaluate(async () => {
      window.__p3Timecode = [];
      window.stageforgeDesktop.onShowControlEvent(event => {
        if (event.kind === 'timecode' && event.source === 'artnetTC') window.__p3Timecode.push(event.frames);
      });
      const status = await window.stageforgeDesktop.showControl({ type: 'configure', config: {
        oscRxEnabled: false, oscPort: 8000, oscAllowAllInterfaces: false,
        oscTxEnabled: false, oscTxHost: '127.0.0.1', oscTxPort: 9000,
        artnetTcRxEnabled: true, artnetTcTxEnabled: false, artnetTcTxHost: '127.0.0.1',
      } });
      return status.artnetTcRxPort;
    });
    expect(timecodePort).toBe(port);
    await send(tc(4));
    await expect.poll(() => page.evaluate(() => window.__p3Timecode)).toContain(4);

    await button(rx, 'Start listening').click();
    await expect(rx.getByRole('alert')).toContainText('Art-Net RX already uses 0.0.0.0');
    await expect(status).toHaveText('Off');
    await rx.getByLabel('Art-Net binding').selectOption('0.0.0.0');
    await button(rx, 'Start listening').click();
    await expect(status).toHaveText('Awaiting first frame');
    await send(dmx(1, 211));
    await send(tc(5));
    await expect(slot).toHaveAttribute('aria-label', 'U3.001: 211');
    await expect.poll(() => page.evaluate(() => window.__p3Timecode)).toContain(5);
    const discoveryError = await page.evaluate(() => window.stageforgeDesktop.dmxControl({ type: 'discover', iface: '127.0.0.1' })
      .then(() => '', error => String(error)));
    expect(discoveryError).toContain('Stop Art-Net input');
    const output = await page.evaluate(() => window.stageforgeDesktop.dmxControl({ type: 'getStatus' }));
    expect(output.enabled).toBe(false);
    expect(await app.evaluate(() => globalThis.__p3OutgoingUdp)).toBe(0);
    await expect(status).toHaveText('Stale', { timeout: 6_000 });
    await expect(slot).toHaveAttribute('aria-label', 'U3.001: 0');
    await send(dmx(2, 155));
    await expect(slot).toHaveAttribute('aria-label', 'U3.001: 155');
    await button(rx, 'Stop listening').click();
    await expect(status).toHaveText('Off');
    await send(tc(6));
    await expect.poll(() => page.evaluate(() => window.__p3Timecode)).toContain(6);

    // A valid file change stops this receiver independently of the shared Timecode handle.
    await button(rx, 'Start listening').click();
    await expect(status).toHaveText('Awaiting first frame');
    await button(drawer, 'Close DMX monitor').click();
    await button(page, 'Show files').click();
    const files = page.getByRole('dialog', { name: 'Show files' });
    await files.getByLabel('Open show file').setInputFiles(show);
    await expect(files).toBeHidden();
    const reopened = await openInput(page);
    await expect(reopened.rx.getByTestId('artnet-input-status')).toHaveText('Off');
    await send(tc(7));
    await expect.poll(() => page.evaluate(() => window.__p3Timecode)).toContain(7);
    expect(await page.evaluate(() => localStorage.getItem('stageforge.design.v1'))).toBe(before);
    expect(await app.evaluate(() => globalThis.__p3OutgoingUdp)).toBe(0);

    await app.close();
    app = await launch();
    const restarted = await app.firstWindow({ timeout: 12_000 });
    restarted.setDefaultTimeout(12_000);
    const fresh = await openInput(restarted);
    await expect(fresh.rx.getByTestId('artnet-input-status')).toHaveText('Off');
    await expect(fresh.rx.getByLabel('Art-Net binding')).toHaveValue('127.0.0.1');
    await restarted.goto('stageforge://app/?view');
    await expect(button(restarted, 'DMX monitor')).toHaveCount(0);
    await expect.poll(() => restarted.evaluate(() => window.stageforgeDesktop.artNetInput({ type: 'listInterfaces' })
      .then(() => '', error => String(error)))).toContain('authorized desktop editor');
  } finally {
    await app?.close().catch(() => {});
    await close(sender);
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
