import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = process.env.STAGEFORGE_CAST_DESKTOP_EXE ?? process.env.STAGEFORGE_DESKTOP_EXE;
const preparedApp = fileURLToPath(new URL('../../desktop/build/app/', import.meta.url));
const sampleUrl = 'stageforge://app/examples/steamboat-willie.stageforge.show.json';
const modelPrefix = 'stageforge-steamboat-1928-';
const cast = [
  'mickey-capped', 'minnie-with-ukulele', 'pete', 'parrot', 'cow-thin', 'goat', 'galley-cat',
  'waterfowl', 'sow', 'piglet-light', 'piglet-dark', 'piglet-light', 'dock-bird-upright', 'dock-bird-leaning',
].map(suffix => modelPrefix + suffix).sort();

test('cold ' + (installed ? 'installed' : 'prepared') + ' desktop opens the bundled film cast offline in the desk and viewer', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-cast-offline-'));
  const profile = path.join(temp, 'profile');
  // Chromium uses this loopback-only, non-forwarding proxy from process startup,
  // including before Playwright can attach the per-session request guard.
  const denyProxy = createServer(socket => socket.destroy());
  let app;
  try {
    await new Promise((resolve, reject) => {
      denyProxy.once('error', reject);
      denyProxy.listen(0, '127.0.0.1', resolve);
    });
    const args = [
      '--user-data-dir=' + profile,
      '--proxy-server=http://127.0.0.1:' + denyProxy.address().port,
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic', '--disable-background-networking', '--disable-http-cache',
    ];
    app = await electron.launch(installed
      ? { executablePath: path.resolve(installed), args }
      : { executablePath: createRequire(import.meta.url)('electron'), args: [preparedApp, ...args] });
    const identity = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged, profile: app.getPath('userData'),
    }));
    expect(identity).toEqual({ packaged: Boolean(installed), profile });

    await app.evaluate(({ session }) => {
      const blocked = globalThis.__filmCastExternalRequests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, done) => {
        const cancel = /^(?:https?|wss?|ftp):/i.test(details.url);
        if (cancel) blocked.push(details.url);
        done({ cancel });
      });
    });
    // Check the guard with Chromium's network API, outside the renderer CSP.
    // It must cancel this request locally, before DNS or a proxy connection.
    const sentinel = 'https://stageforge-offline-check.invalid/blocked';
    const guard = await app.evaluate(async ({ session }, url) => {
      let failed = false;
      try { await session.defaultSession.fetch(url); } catch { failed = true; }
      return { failed, blocked: [...globalThis.__filmCastExternalRequests] };
    }, sentinel);
    expect(guard).toEqual({ failed: true, blocked: [sentinel] });

    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.dismiss(); });
    await page.goto('stageforge://app/?probe');
    const openFiles = page.getByRole('button', { name: 'Show files', exact: true });
    const files = page.getByRole('dialog', { name: 'Show files' });
    await expect(openFiles).toBeVisible();
    await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.crowd)).toBe('function');
    expect(await page.evaluate(url => performance.getEntriesByName(url).length, sampleUrl)).toBe(0);
    await openFiles.click();
    await files.getByRole('button', { name: 'Open Steamboat Willie example', exact: true }).click();
    await expect(files).toBeHidden();
    await expect.poll(() => page.evaluate(url => performance.getEntriesByName(url).length, sampleUrl)).toBeGreaterThan(0);

    // Read the bytes served by this executable only after the product's own first open.
    const bytes = await page.evaluate(async url => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('Installed example returned ' + response.status);
      return response.text();
    }, sampleUrl);
    const sample = JSON.parse(bytes);
    expect(sample.version).toBe(14);
    expect(sample.$schema).toMatch(/\/show-v14\.schema\.json$/);
    expect(sample.crowd.placements.map(p => p.modelId).sort()).toEqual(cast);
    const expected = sample.crowd.placements.map(person => ({
      placementId: 'explicit:' + person.id, modelId: person.modelId, pose: person.pose,
    })).sort((a, b) => a.placementId.localeCompare(b.placementId));
    const readCrowd = () => page.evaluate(() => window.stageforgeProbe.crowd());
    const readExplicit = async () => (await readCrowd()).placementBindings
      .filter(item => item.placementId.startsWith('explicit:'))
      .map(({ placementId, modelId, pose }) => ({ placementId, modelId, pose }))
      .sort((a, b) => a.placementId.localeCompare(b.placementId));
    await expect.poll(readExplicit).toEqual(expected);
    const desk = await readCrowd();
    expect(desk.authored).toBe(true);
    expect(desk.count).toBeGreaterThan(cast.length);
    expect(desk.resourceAdmission).toMatchObject({ admitted: true, packedVertexTextures: 1 });
    const packed = desk.batches.filter(batch => batch.packed);
    expect(packed).toHaveLength(1);
    expect(packed[0].modelIds.filter(id => id.startsWith(modelPrefix)).sort()).toEqual([...new Set(cast)]);
    for (const placement of sample.crowd.placements) {
      const actual = desk.transforms.find(item => item.placementId === 'explicit:' + placement.id);
      expect(actual).toMatchObject({ modelId: placement.modelId, pose: placement.pose, ...placement.position });
      expect(actual.rotY).toBeCloseTo(placement.yaw * Math.PI / 180, 8);
    }

    // First use of the viewer must work offline too; its lazy JS can come only
    // from the installed application. Preserve the operating desk on return.
    await openFiles.click();
    await files.getByLabel('Open show in viewer').setInputFiles({
      name: 'steamboat-willie.stageforge.show.json',
      mimeType: 'application/json', buffer: Buffer.from(bytes, 'utf8'),
    });
    await expect(page.getByText('VIEW ONLY', { exact: true })).toBeVisible();
    await expect.poll(readExplicit).toEqual(expected);
    await expect.poll(() => page.evaluate(() => {
      const probe = window.stageforgeProbe;
      return !probe.graphicsProbe().contextLost && probe.renderStats().triangles > 0;
    })).toBe(true);
    await page.getByRole('button', { name: 'Exit viewer', exact: true }).click();
    await expect(page.getByText('VIEW ONLY', { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await readCrowd()).placementBindings).toEqual(desk.placementBindings);
    expect(errors, 'renderer, shader and import errors').toEqual([]);
    expect(await app.evaluate(() => globalThis.__filmCastExternalRequests)).toEqual([sentinel]);
  } finally {
    try {
      await app?.close();
    } finally {
      await new Promise(resolve => denyProxy.close(resolve));
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
