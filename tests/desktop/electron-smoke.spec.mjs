// Boots the built desktop app (run `npm run desktop:prepare` first) and drives the real
// File menu: main process -> IPC -> sandboxed preload -> contextBridge -> renderer.
import { _electron as electron, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const root = fileURLToPath(new URL('../../', import.meta.url));
const appDir = path.join(root, 'desktop', 'build', 'app');
const showPath = path.join(root, 'tests', 'fixtures', 'native-authoring-v3.stageforge.show.json');
const videoPath = path.join(root, 'public', 'examples', 'amber-clouds.mp4');
const examplePath = path.join(root, 'public', 'examples', 'amber-walk-on.stageforge.show.json');
const MEDIA = ['amber-clouds.mp4', 'blue-raster.mp4', 'guest-surface.mp4'];
const SHOW_NAME = 'Split Rig rehearsal';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// An inline script the CSP must block; Chromium's console error for it names its hash.
const CSP_PROBE = 'window.__inlineRan = true';
const CSP_PROBE_HASH = 'sha256-' + createHash('sha256').update(CSP_PROBE).digest('base64');

test.describe.configure({ mode: 'serial' });

let app, page, tmp, fixture, fixtureText, video;
const problems = [];

// The bundle format of src/data/showBundle.ts, built independently so the renderer has to verify it.
async function writeBundle(target) {
  const show = Buffer.from(fixtureText, 'utf8');
  const files = { 'show.json': new Uint8Array(show) };
  const manifest = { format: 'stageforge-bundle', version: 1, show: { bytes: show.length, sha256: sha256(show) }, media: [] };
  for (const name of MEDIA) {
    const entry = 'media/video/' + name;
    files[entry] = new Uint8Array(video);
    manifest.media.push({ kind: 'video', name, path: entry, mime: 'video/mp4', bytes: video.length, sha256: sha256(video), durationSec: null });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  const zip = zipSync(files, { level: 0 });
  await writeFile(target, zip);
  return zip;
}

async function clickFileMenu(prefix) {
  await app.evaluate(({ Menu }, prefix) => {
    const file = Menu.getApplicationMenu().items.find(item => item.label === 'File');
    // Search nested submenus too (File → Export → …).
    const find = items => {
      for (const entry of items ?? []) {
        if (entry.label?.startsWith(prefix)) return entry;
        const nested = find(entry.submenu?.items);
        if (nested) return nested;
      }
    };
    const item = find(file?.submenu.items);
    if (!item) throw new Error('No File menu item starting with ' + prefix);
    item.click();
  }, prefix);
}

async function openThroughMenu(file) {
  await app.evaluate((_electron, file) => { globalThis.__stageforgeTest.nextOpen = file; }, file);
  await clickFileMenu('Open show or rig');
}

// Records what the renderer's main world receives, alongside the app's own listener.
async function watchRendererCommands() {
  await page.evaluate(() => {
    window.__unwatch?.();
    window.__received = [];
    window.__unwatch = window.stageforgeDesktop.onRigCommand((command, source) => {
      const record = {
        command,
        type: Object.prototype.toString.call(source),
        mainWorldUint8Array: source instanceof Uint8Array,
        length: typeof source === 'string' ? source.length : source?.byteLength,
      };
      window.__received.push(record);
      if (source instanceof Uint8Array) {
        void crypto.subtle.digest('SHA-256', source).then(hash => {
          record.sha256 = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
        });
      }
    });
  });
}

const received = () => page.evaluate(() => window.__received);

async function expectShowLoaded({ missing }) {
  // The opened show's look is in master blackout and its secondary wall lists its wall cues.
  await expect(page.getByText('Master blackout', { exact: true })).toBeVisible();
  const relink = page.getByRole('button', { name: /missing media files · Relink/ });
  if (missing) await expect(relink).toContainText(`${missing} missing media files`);
  else await expect(relink).toHaveCount(0);
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  await expect(files.locator('.file-show-name')).toHaveText(SHOW_NAME);
  await expect(files.getByRole('term').filter({ hasText: 'Stage right' })).toBeVisible();
  await expect(files.getByRole('definition').filter({ hasText: 'guest-surface.mp4, blue-raster.mp4' })).toBeVisible();
  // The take lists the recorded desk actions plus the wall cues.
  const events = (fixture.timeline?.events.length ?? 0) + fixture.stage.screenEvents.length;
  await expect(files.getByText(/^Recorded actions/)).toContainText(`${events} events`);
  if (missing) await expect(files.getByText(/^Files to relink:/)).toContainText('guest-surface.mp4');
  else await expect(files.getByText(/^Files to relink:/)).toHaveCount(0);
  await files.getByRole('button', { name: 'Close Show files' }).click();
  await expect(files).toBeHidden();
}

// Saves through the File menu; an extra will-download listener (after main's) skips the native dialog.
async function saveThroughMenu(prefix, target) {
  await app.evaluate(({ session }, target) => {
    const record = globalThis.__stageforgeTest.download = { state: 'waiting' };
    const listener = (_event, item) => {
      session.defaultSession.off('will-download', listener);
      record.filename = item.getFilename();
      record.options = item.getSaveDialogOptions();
      item.setSavePath(target);
      item.once('done', (_e, state) => { record.state = state; });
    };
    session.defaultSession.on('will-download', listener);
  }, target);
  await clickFileMenu(prefix);
  await expect.poll(() => app.evaluate(() => globalThis.__stageforgeTest.download.state), { timeout: 30_000 }).toBe('completed');
  return app.evaluate(() => globalThis.__stageforgeTest.download);
}

function expectNoProblems() {
  expect(problems, 'renderer errors, alerts or main-process exceptions').toEqual([]);
}

test.beforeAll(async () => {
  // STAGEFORGE_DESKTOP_EXE runs the same checks against a packaged build, e.g.
  // desktop/build/release/win-unpacked/StageForge.exe after `npm run desktop:win`.
  const packaged = process.env.STAGEFORGE_DESKTOP_EXE;
  if (packaged ? !existsSync(packaged) : !existsSync(path.join(appDir, 'main.cjs')) || !existsSync(path.join(appDir, 'renderer', 'index.html'))) {
    throw new Error(packaged ? `No packaged app at ${packaged}.` : 'desktop/build/app is missing: run `npm run desktop:prepare` before `npm run test:desktop`.');
  }
  fixtureText = await readFile(showPath, 'utf8');
  fixture = JSON.parse(fixtureText);
  video = await readFile(videoPath);
  tmp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-desktop-'));
  // A throwaway profile keeps the user's real StageForge storage untouched.
  const profile = `--user-data-dir=${path.join(tmp, 'profile')}`;
  app = await electron.launch(packaged
    ? { executablePath: path.resolve(packaged), args: [profile] }
    : { executablePath: createRequire(import.meta.url)('electron'), args: [appDir, profile] });
  app.process().stderr?.on('data', chunk => {
    const text = String(chunk);
    if (/Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(text)) problems.push('main: ' + text.trim());
  });
  page = await app.firstWindow();
  page.on('pageerror', error => problems.push('pageerror: ' + error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes(CSP_PROBE_HASH)) problems.push('console: ' + message.text());
  });
  page.on('dialog', dialog => { problems.push(`${dialog.type()}: ${dialog.message()}`); void dialog.dismiss(); });
  await app.evaluate(({ dialog }) => {
    const state = globalThis.__stageforgeTest = { nextOpen: null, openOptions: [], download: null };
    dialog.showOpenDialog = async (_window, options) => {
      state.openOptions.push(options);
      return state.nextOpen ? { canceled: false, filePaths: [state.nextOpen] } : { canceled: true, filePaths: [] };
    };
    dialog.showErrorBox = (title, content) => { state.errorBox = `${title}: ${content}`; };
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test.afterEach(async () => {
  // main.cjs reports file read failures with dialog.showErrorBox, stubbed in beforeAll.
  expect(await app.evaluate(() => globalThis.__stageforgeTest.errorBox), 'main-process error box').toBeUndefined();
});

test('boots the renderer from stageforge://app/ with CSP, a sandboxed preload bridge and WebGL', async () => {
  expect(existsSync(path.join(appDir, 'protocol.cjs'))).toBe(true);
  expect(existsSync(path.join(appDir, 'dmx-packets.cjs'))).toBe(true);
  expect(existsSync(path.join(appDir, 'dmx-sender.cjs'))).toBe(true);
  expect(existsSync(path.join(appDir, 'dmx-ipc.cjs'))).toBe(true);
  for (const v of [1, 2, 3, 4, 5, 6]) {
    expect(existsSync(path.join(appDir, 'renderer', 'schemas', `show-v${v}.schema.json`))).toBe(true);
  }
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(path.join(tmp, 'profile'));
  await expect(page).toHaveURL('stageforge://app/');
  await expect(page.getByRole('button', { name: 'Show files', exact: true })).toBeVisible();
  const headers = await page.evaluate(async () => {
    const rootRes = await fetch(location.href);
    const upperRes = await fetch('stageforge://app/INDEX.HTML');
    return {
      csp: rootRes.headers.get('content-security-policy'),
      nosniff: rootRes.headers.get('x-content-type-options'),
      upperCsp: upperRes.headers.get('content-security-policy'),
      upperNosniff: upperRes.headers.get('x-content-type-options'),
    };
  });
  expect(headers.csp).toContain("script-src 'self'");
  expect(headers.csp).toContain("object-src 'none'");
  expect(headers.nosniff).toBe('nosniff');
  expect(headers.upperCsp).toContain("script-src 'self'");
  expect(headers.upperNosniff).toBe('nosniff');
  const world = await page.evaluate(async probe => {
    // The served CSP must block an injected inline script.
    const violation = new Promise(resolve => document.addEventListener('securitypolicyviolation', e => resolve(e.effectiveDirective), { once: true }));
    const script = document.createElement('script');
    script.textContent = probe;
    document.head.append(script);
    script.remove();
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    return {
      bridge: Object.keys(window.stageforgeDesktop ?? {}),
      node: typeof window.require + '/' + typeof window.process,
      secure: window.isSecureContext && !!crypto.subtle,
      inlineScript: window.__inlineRan === true ? 'ran' : await violation,
      webgl2: !!gl && !gl.isContextLost(),
    };
  }, CSP_PROBE);
  expect(world).toEqual({
    bridge: ['onRigCommand', 'sendDmxFrame', 'dmxControl', 'onDmxStatus', 'showControl', 'onShowControlEvent', 'onShowControlStatus'],
    node: 'undefined/undefined',
    secure: true,
    inlineScript: 'script-src-elem',
    webgl2: true,
  });
  // A non-zero frame rate means the WebGL render loop is running.
  await expect(page.getByText(/fixtures · \d+ lasers · [1-9]\d* fps/)).toBeVisible();
  await expect(page.getByText('Master blackout', { exact: true })).toHaveCount(0);
  expectNoProblems();
});

test('File → Open with a .stageforge.show.json sends the text over IPC and loads the show', async () => {
  await watchRendererCommands();
  await openThroughMenu(showPath);
  await expect.poll(received).toEqual([
    { command: 'open', type: '[object String]', mainWorldUint8Array: false, length: fixtureText.length },
  ]);
  const options = await app.evaluate(() => globalThis.__stageforgeTest.openOptions.at(-1));
  expect(options).toMatchObject({ title: 'Open show or rig', properties: ['openFile'] });
  expect(options.filters[0].extensions).toEqual(['json', 'zip', 'mvr']);
  await expectShowLoaded({ missing: 3 });
  expectNoProblems();
});

test('File → Open with a .stageforge.zip passes a Uint8Array through the preload and loads bundled media', async () => {
  const bundlePath = path.join(tmp, 'split-rig-input.stageforge.zip');
  const zip = await writeBundle(bundlePath);
  await watchRendererCommands();
  await openThroughMenu(bundlePath);
  await expect.poll(received).toEqual([{
    command: 'openBundle', type: '[object Uint8Array]', mainWorldUint8Array: true, length: zip.length, sha256: sha256(zip),
  }]);
  // No relink prompt: all three media files came out of the verified bundle.
  await expectShowLoaded({ missing: 0 });
  expectNoProblems();
});

test('File → Save show bundle writes a verified .stageforge.zip that reopens through File → Open', async () => {
  const savedPath = path.join(tmp, 'saved.stageforge.zip');
  const download = await saveThroughMenu('Save show bundle', savedPath);
  expect(download.filename).toBe('split-rig-rehearsal.stageforge.zip');
  // main's will-download handler set the native save dialog options.
  expect(download.options).toMatchObject({
    title: 'Save show bundle', filters: [{ name: 'StageForge show bundle', extensions: ['zip'] }],
  });
  expect(path.basename(download.options.defaultPath)).toBe('split-rig-rehearsal.stageforge.zip');

  const entries = unzipSync(new Uint8Array(await readFile(savedPath)));
  expect(Object.keys(entries).sort()).toEqual(['manifest.json', ...MEDIA.map(name => 'media/video/' + name), 'show.json']);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest).toMatchObject({ format: 'stageforge-bundle', version: 1 });
  expect(manifest.show).toEqual({ bytes: entries['show.json'].length, sha256: sha256(entries['show.json']) });
  expect(manifest.media.map(entry => entry.name).sort()).toEqual(MEDIA);
  for (const entry of manifest.media) {
    expect(entry).toMatchObject({ kind: 'video', path: 'media/video/' + entry.name, mime: 'video/mp4', bytes: video.length, sha256: sha256(video) });
    expect(sha256(entries[entry.path])).toBe(entry.sha256);
    // Durations are read from blob: media URLs, so this also exercises the CSP media-src.
    expect(entry.durationSec).toBeGreaterThan(0);
  }
  const show = JSON.parse(strFromU8(entries['show.json']));
  expect(show.rig.name).toBe(SHOW_NAME);
  expect(show.stage).toEqual(fixture.stage);
  expect(show.cues.map(cue => cue.id)).toEqual(fixture.cues.map(cue => cue.id));

  // Round trip: switch to another show (dropping the split rig's wall media), then reopen the saved bundle.
  await openThroughMenu(examplePath);
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  await expect(files.locator('.file-show-name')).toHaveText('Amber Walk-on');
  await expect(files.getByRole('term').filter({ hasText: 'Stage right' })).toHaveCount(0);
  await files.getByRole('button', { name: 'Close Show files' }).click();
  await watchRendererCommands();
  await openThroughMenu(savedPath);
  const bytes = await readFile(savedPath);
  await expect.poll(received).toEqual([{
    command: 'openBundle', type: '[object Uint8Array]', mainWorldUint8Array: true, length: bytes.length, sha256: sha256(bytes),
  }]);
  await expectShowLoaded({ missing: 0 });
  expectNoProblems();
});

test('File → Save show as… writes the show JSON through the desktop download handler', async () => {
  const savedPath = path.join(tmp, 'saved.stageforge.show.json');
  const download = await saveThroughMenu('Save show as', savedPath);
  expect(download.filename).toBe('split-rig-rehearsal.stageforge.show.json');
  expect(download.options).toMatchObject({
    title: 'Save show', filters: [{ name: 'StageForge show JSON', extensions: ['json'] }],
  });
  const show = JSON.parse(await readFile(savedPath, 'utf8'));
  expect(show).toMatchObject({ format: 'stageforge-show', version: 3, activeCueId: fixture.activeCueId });
  expect(show.rig.name).toBe(SHOW_NAME);
  expect(show.stage).toEqual(fixture.stage);
  expectNoProblems();
});

test('File → Export → MVR scene writes a conforming .mvr that reopens through File → Open as a Uint8Array', async () => {
  const target = path.join(tmp, 'rig-scene.mvr');
  const saved = await saveThroughMenu('MVR scene', target);
  expect(saved.filename).toMatch(/\.mvr$/);
  expect(saved.options.title).toBe('Export MVR scene');
  expect(saved.options.filters).toEqual([{ name: 'MVR scene (DIN SPEC 15801)', extensions: ['mvr'] }]);
  const bytes = new Uint8Array(await readFile(target));
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);
  expect(names).toContain('GeneralSceneDescription.xml');
  expect(names.every(name => !name.includes('/'))).toBe(true);
  expect(names.some(name => name.endsWith('.gdtf'))).toBe(true);
  const scene = strFromU8(entries['GeneralSceneDescription.xml']);
  expect(scene).toContain('verMajor="1" verMinor="6"');
  expect(scene).toContain('<Fixture ');

  await watchRendererCommands();
  await openThroughMenu(target);
  const options = await app.evaluate(() => globalThis.__stageforgeTest.openOptions.at(-1));
  expect(options.filters[0].extensions).toEqual(['json', 'zip', 'mvr']);
  await expect.poll(received).toContainEqual(expect.objectContaining({
    command: 'openMvr', type: '[object Uint8Array]', mainWorldUint8Array: true, length: bytes.length,
  }));
  await expect.poll(async () => (await received()).find(r => r.command === 'openMvr')?.sha256).toBe(sha256(bytes));
  await expect(page.getByText(new RegExp(`Opened ${SHOW_NAME} from MVR`))).toBeVisible();
  expectNoProblems();
});

test('live DMX output stays off by default, streams on enable, stays visible in cinema mode, and blackouts on disable and renderer crash', async () => {
  const { decodeSacnPacket, SACN_OPT_STREAM_TERMINATED } = createRequire(import.meta.url)('../../desktop/dmx-packets.cjs');
  const receiver = dgram.createSocket('udp4');
  const packets = [];
  receiver.on('message', (msg) => {
    const decoded = decodeSacnPacket(Buffer.from(msg));
    if (decoded) packets.push(decoded);
  });
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.bind(0, '127.0.0.1', resolve);
  });
  const port = receiver.address().port;
  const dmxTmp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-dmx-smoke-'));
  const packaged = process.env.STAGEFORGE_DESKTOP_EXE;
  const profile = `--user-data-dir=${path.join(dmxTmp, 'profile')}`;
  let dmxApp;
  try {
    dmxApp = await electron.launch(packaged
      ? { executablePath: path.resolve(packaged), args: [profile] }
      : {
          executablePath: createRequire(import.meta.url)('electron'),
          args: [appDir, profile],
          env: { ...process.env, STAGEFORGE_DMX_TEST_PORT: String(port) },
        });
    const dmxPage = await dmxApp.firstWindow();
    await dmxPage.waitForLoadState('domcontentloaded');
    await expect(dmxPage.getByRole('button', { name: 'DMX monitor', exact: true })).toBeVisible();

    // 1. Output MUST stay off by default for 1 s after boot: zero packets, status disabled, badge absent.
    const initialStatus = await dmxPage.evaluate(() => window.stageforgeDesktop.dmxControl({ type: 'getStatus' }));
    expect(initialStatus.enabled).toBe(false);
    expect(initialStatus.state).toBe('idle');
    await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
    await dmxPage.waitForTimeout(1000);
    expect(packets.length).toBe(0);

    // 2. Open DMX monitor -> Output -> sACN unicast 127.0.0.1 -> Arm -> Go live.
    await dmxPage.getByRole('button', { name: 'DMX monitor', exact: true }).click();
    await dmxPage.getByTestId('dmx-output-toggle').click();
    await dmxPage.getByTestId('dmx-output-mode-sacn').click();
    await dmxPage.getByTestId('dmx-output-iface').selectOption('127.0.0.1');
    await dmxPage.getByTestId('dmx-output-sacn-unicast').click();
    await dmxPage.getByTestId('dmx-output-sacn-targets').fill('127.0.0.1');
    await dmxPage.getByTestId('dmx-output-arm').click();
    await dmxPage.getByTestId('dmx-output-go-live').click();

    // 3. LIVE badge appears and remains visible in cinema mode (H).
    await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
    await expect(dmxPage.getByTestId('live-dmx-badge')).toContainText('LIVE · sACN');
    await dmxPage.getByRole('button', { name: 'Cinema mode', exact: true }).click();
    await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
    await dmxPage.getByRole('button', { name: 'Show desk' }).click();

    if (!packaged) {
      // Trigger a cue so non-zero fixture channels stream through the frame IPC channel.
      await dmxPage.locator('.cue-pad').first().click();
      await expect.poll(() => packets.some((p) => p.universe === 1 && p.slots.some((v) => v > 0)), { timeout: 5000 }).toBe(true);

      // 4. Blackout & stop sends zero data frames followed by Stream_Terminated, then goes silent.
      const beforeDisable = packets.length;
      await dmxPage.getByTestId('live-dmx-stop').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
      await expect.poll(() => {
        const tail = packets.slice(beforeDisable).filter((p) => p.universe === 1);
        const firstTerm = tail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
        return firstTerm >= 3 && tail.slice(firstTerm).length >= 3;
      }, { timeout: 5000 }).toBe(true);

      const u1Tail = packets.slice(beforeDisable).filter((p) => p.universe === 1);
      const firstTerm = u1Tail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
      expect(firstTerm).toBeGreaterThanOrEqual(3);
      // The 3 frames immediately preceding Stream_Terminated must be all-zero blackout frames.
      for (const p of u1Tail.slice(firstTerm - 3, firstTerm)) {
        expect(p.options & SACN_OPT_STREAM_TERMINATED).toBe(0);
        expect(p.slots.every((v) => v === 0)).toBe(true);
      }
      expect(u1Tail.slice(firstTerm).length).toBe(3);
      for (const p of u1Tail.slice(firstTerm)) {
        expect(p.options & SACN_OPT_STREAM_TERMINATED).toBe(SACN_OPT_STREAM_TERMINATED);
        expect(p.slots.every((v) => v === 0)).toBe(true);
      }
      const afterDisableCount = packets.length;
      await dmxPage.waitForTimeout(300);
      expect(packets.length).toBe(afterDisableCount);

      // 5. Re-enable and forcibly crash the renderer: main process MUST still send blackout + terminate.
      await dmxPage.getByTestId('dmx-output-toggle').click();
      await dmxPage.getByTestId('dmx-output-arm').click();
      await dmxPage.getByTestId('dmx-output-go-live').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
      await expect.poll(() => packets.length > afterDisableCount + 2, { timeout: 5000 }).toBe(true);

      const beforeCrash = packets.length;
      await dmxApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.forcefullyCrashRenderer();
      });

      await expect.poll(() => {
        const tail = packets.slice(beforeCrash).filter((p) => p.universe === 1);
        const termIdx = tail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
        return termIdx >= 3 && tail.slice(termIdx).length >= 3;
      }, { timeout: 5000 }).toBe(true);
      const crashTail = packets.slice(beforeCrash).filter((p) => p.universe === 1);
      const crashTermIdx = crashTail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
      for (const p of crashTail.slice(crashTermIdx - 3, crashTermIdx)) {
        expect(p.slots.every((v) => v === 0)).toBe(true);
      }
    } else {
      await dmxPage.getByTestId('live-dmx-stop').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
    }
  } finally {
    await dmxApp?.close().catch(() => {});
    await new Promise((resolve) => receiver.close(() => resolve()));
    await rm(dmxTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('show control boots offline in Master mode, ignores OSC in Master, and triggers cues once in Cue Caller mode', async () => {
  const { encodeOscMessage } = createRequire(import.meta.url)('../../desktop/osc-packets.cjs');
  const scTmp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-sc-smoke-'));
  const packaged = process.env.STAGEFORGE_DESKTOP_EXE;
  const profile = `--user-data-dir=${path.join(scTmp, 'profile')}`;
  const oscPort = 18000 + Math.floor(Math.random() * 10000);
  const udp = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, '127.0.0.1', resolve);
  });
  let scApp;
  try {
    scApp = await electron.launch(packaged
      ? { executablePath: path.resolve(packaged), args: [profile] }
      : { executablePath: createRequire(import.meta.url)('electron'), args: [appDir, profile] });
    const scPage = await scApp.firstWindow();
    await scPage.waitForLoadState('domcontentloaded');
    await expect(scPage.getByRole('button', { name: 'Show control', exact: true })).toBeVisible();

    // 1. Boots offline in Master mode (no listeners active, ClockBadge absent).
    const initial = await scPage.evaluate(() => window.stageforgeDesktop.showControl({ type: 'getStatus' }));
    expect(initial.active).toBe(false);
    expect(initial.oscRxListening).toBe(false);
    await expect(scPage.getByTestId('clock-owner-badge')).toHaveCount(0);

    // 2. Open Show Control drawer, set port (commit on Enter) and enable UDP OSC listener.
    await scPage.getByRole('button', { name: 'Show control', exact: true }).click();
    const portInput = scPage.getByTestId('sc-osc-port');
    await portInput.fill(String(oscPort));
    await portInput.press('Enter');
    await scPage.getByTestId('sc-osc-rx-toggle').check();
    await expect.poll(
      () => scPage.evaluate(() => window.stageforgeDesktop.showControl({ type: 'getStatus' }).then((s) => s.oscRxListening)),
      { timeout: 5000 },
    ).toBe(true);

    // 3. In Master mode, incoming OSC /stageforge/go 2 is ignored and logged as "ignored: master".
    udp.send(encodeOscMessage('/stageforge/go', [{ type: 'i', value: 2 }]), oscPort, '127.0.0.1');
    await expect(scPage.getByTestId('sc-event-log')).toContainText('ignored: master');

    // 4. Switch to Cue Caller mode -> ClockBadge visible -> two back-to-back OSC /stageforge/go 2
    //    packets activate cue 2 once and deduplicate the second within 250 ms.
    await scPage.getByTestId('clock-mode-caller').click();
    await expect(scPage.getByTestId('clock-owner-badge')).toContainText('CALLER');
    const go2 = encodeOscMessage('/stageforge/go', [{ type: 'i', value: 2 }]);
    udp.send(go2, oscPort, '127.0.0.1');
    udp.send(go2, oscPort, '127.0.0.1');
    await expect(scPage.locator('.cue-pad').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(scPage.getByTestId('sc-event-log')).toContainText('deduped');

    // 6. Verify realtime-bpm-analyzer AudioWorklet loads cleanly under Electron strict script-src 'self' CSP.
    const cspErrors = [];
    scPage.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy|CSP|AudioWorklet/i.test(msg.text())) {
        cspErrors.push(msg.text());
      }
    });
    await scPage.getByRole('button', { name: 'Close show control', exact: true }).click();
    await scPage.getByTestId('clock-badge-master').click();
    await expect(scPage.getByTestId('clock-owner-badge')).toHaveCount(0);
    await scPage.getByRole('button', { name: 'Play demo' }).click();
    const liveBpmBtn = scPage.getByTestId('desk-live-bpm');
    await liveBpmBtn.click();
    await scPage.waitForTimeout(400);
    await expect(liveBpmBtn).toHaveAttribute('aria-pressed', 'true');
    expect(cspErrors).toEqual([]);
    await liveBpmBtn.click();

    // 7. Stop OSC listener cleanly.
    await scPage.getByRole('button', { name: 'Show control', exact: true }).click();
    await scPage.getByTestId('sc-osc-rx-toggle').uncheck();
  } finally {
    await scApp?.close().catch(() => {});
    await new Promise((resolve) => udp.close(() => resolve()));
    await rm(scTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('Gear & production Inventory loads under stageforge:// CSP, prints via window.print(), and exports equipment CSV', async () => {
  await page.getByRole('button', { name: 'Gear, cost and crew', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gear & production' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: /Inventory/ })).toHaveAttribute('aria-selected', 'true');

  // Verify window.print() is invoked cleanly without opening any popup window.
  await page.evaluate(() => {
    window.__desktopPrintCalls = 0;
    window.print = () => {
      window.__desktopPrintCalls++;
    };
  });
  await dialog.getByRole('button', { name: 'Print sheet' }).click();
  expect(await page.evaluate(() => window.__desktopPrintCalls)).toBe(1);

  // Verify .equipment.csv download passes main's will-download suffix whitelist and writes a BOM CSV.
  const csvTarget = path.join(tmp, 'rig-inventory.equipment.csv');
  await app.evaluate(({ session }, target) => {
    const record = globalThis.__stageforgeTest.download = { state: 'waiting' };
    const listener = (_event, item) => {
      session.defaultSession.off('will-download', listener);
      record.filename = item.getFilename();
      record.options = item.getSaveDialogOptions();
      item.setSavePath(target);
      item.once('done', (_e, state) => { record.state = state; });
    };
    session.defaultSession.on('will-download', listener);
  }, csvTarget);

  await dialog.getByRole('button', { name: 'Export CSV' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.__stageforgeTest.download.state), { timeout: 15_000 }).toBe('completed');
  const dl = await app.evaluate(() => globalThis.__stageforgeTest.download);
  expect(dl.filename).toMatch(/\.equipment\.csv$/);
  expect(dl.options.title).toBe('Export equipment list');

  const csvBody = await readFile(csvTarget, 'utf8');
  expect(csvBody.startsWith('\uFEFF')).toBe(true);
  expect(csvBody).toContain('Category,Manufacturer,Model,Catalogue ID,DMX mode');
  expect(csvBody).toContain('Total,');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expectNoProblems();
});