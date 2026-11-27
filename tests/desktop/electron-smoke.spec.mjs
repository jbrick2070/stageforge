// Boots the built desktop app (run `npm run desktop:prepare` first) and drives the real
// File menu: main process -> IPC -> sandboxed preload -> contextBridge -> renderer.
import { _electron as electron, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
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
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    expect(existsSync(path.join(appDir, 'renderer', 'schemas', `show-v${v}.schema.json`))).toBe(true);
  }
  const demoMapPath = path.join(appDir, 'renderer', 'demo', 'track.json');
  const demoMp3Path = path.join(appDir, 'renderer', 'demo', 'track.mp3');
  expect(existsSync(demoMapPath)).toBe(true);
  expect(existsSync(demoMp3Path)).toBe(true);
  expect(statSync(demoMp3Path).size).toBe(3_715_925);
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(path.join(tmp, 'profile'));
  await expect(page).toHaveURL('stageforge://app/');
  await expect(page.getByRole('button', { name: 'Show files', exact: true })).toBeVisible();
  // Shipped demo/track.json returns 200 with CSP, surfaces "Play demo track", and fetches ZERO MP3 bytes on boot.
  await expect(page.getByRole('button', { name: 'Play demo track', exact: true })).toBeVisible({ timeout: 10_000 });
  const demoCheck = await page.evaluate(async () => {
    const r = await fetch('stageforge://app/demo/track.json');
    const json = await r.json();
    const mp3Entries = performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/demo/track.mp3'));
    return {
      status: r.status,
      csp: r.headers.get('content-security-policy'),
      bpm: json.bpm,
      sectionCount: json.sections.length,
      totalBars: json.sections.reduce((sum, s) => sum + s.bars, 0),
      mp3FetchedOnBoot: mp3Entries.length,
    };
  });
  expect(demoCheck.status).toBe(200);
  expect(demoCheck.csp).toContain("script-src 'self'");
  expect(demoCheck.bpm).toBe(122);
  expect(demoCheck.sectionCount).toBe(11);
  expect(demoCheck.totalBars).toBe(158);
  expect(demoCheck.mp3FetchedOnBoot).toBe(0);
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
    bridge: [
      'onRigCommand',
      'sendDmxFrame',
      'sendDmxHeartbeat',
      'dmxControl',
      'onDmxStatus',
      'showControl',
      'onShowControlEvent',
      'onShowControlStatus',
      'setViewerMode',
      'aiBridgeControl',
      'onAiBridgeStatus',
      'onAiBridgeRequest',
      'replyAiBridgeRequest',
      'outputClaim',
    ],
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

    // 2. Patch verified catalogue personalities onto MAC Aura Pro RGBW (ETC ColorSource PAR, U1 433..462) and
    //    Molefay 4-Lite Warm (CHAUVET STRIKE 4, U1 129..144) so Universe 1 has implemented physical personalities
    //    alongside generic non-catalogue fixtures (U1 1..128 and 145..432, which MUST stay 0 per SF-H1).
    await dmxPage.getByRole('button', { name: 'Rig builder', exact: true }).click();
    await dmxPage.getByRole('button', { name: /Choose equipment model for MAC Aura Pro RGBW/ }).first().click();
    const eqPicker = dmxPage.getByRole('dialog', { name: /Equipment catalogue for/ });
    await expect(eqPicker).toBeVisible();
    await eqPicker.getByRole('searchbox', { name: 'Search equipment catalogue' }).fill('ColorSource PAR');
    await eqPicker.getByRole('button', { name: /ETC ColorSource PAR/ }).click();
    await eqPicker.getByRole('button', { name: 'Apply model' }).click();
    await expect(eqPicker).toBeHidden();

    await dmxPage.getByRole('button', { name: /Choose equipment model for Molefay 4-Lite Warm/ }).first().click();
    await expect(eqPicker).toBeVisible();
    await eqPicker.getByRole('searchbox', { name: 'Search equipment catalogue' }).fill('STRIKE 4');
    await eqPicker.getByRole('button', { name: /CHAUVET Professional STRIKE 4/ }).click();
    await eqPicker.getByRole('combobox', { name: 'DMX mode' }).selectOption('4-Ch');
    await eqPicker.getByRole('button', { name: 'Apply model' }).click();
    await expect(eqPicker).toBeHidden();

    // Also patch Martin JEM ZR45 (1-Ch, Universe 2 slots 312..315) onto JEM ZR45 Smoke Machine so Universe 2 has an
    // active implemented physical personality alongside Universe 1 (Codex qa-06 R1).
    await dmxPage.getByRole('button', { name: /Choose equipment model for JEM ZR45 Smoke Machine/ }).first().click();
    await expect(eqPicker).toBeVisible();
    await eqPicker.getByRole('searchbox', { name: 'Search equipment catalogue' }).fill('ZR45');
    await eqPicker.getByRole('button', { name: /^Martin JEM ZR45/ }).click();
    await eqPicker.getByRole('combobox', { name: 'DMX mode' }).selectOption('1-Ch');
    await eqPicker.getByRole('button', { name: 'Apply model' }).click();
    await expect(eqPicker).toBeHidden();
    await dmxPage.getByRole('button', { name: 'Close Rig Builder' }).click();

    // Open DMX monitor -> Advanced starts collapsed -> expand Advanced (remembered) -> complete pre-flight gate -> sACN unicast 127.0.0.1 -> Arm -> Go live.
    await dmxPage.getByRole('button', { name: 'DMX monitor', exact: true }).click();
    const advDetails = dmxPage.getByTestId('dmx-advanced-details');
    await expect(advDetails).not.toHaveAttribute('open', '');
    await dmxPage.getByTestId('dmx-advanced-summary').click();
    await expect(advDetails).toHaveAttribute('open', '');
    await expect(dmxPage.getByTestId('dmx-experimental-note')).toContainText('Live output to real lights is experimental.');

    // Verify open state of Advanced is remembered across closing & reopening DMX monitor.
    await dmxPage.getByRole('button', { name: 'Close DMX monitor', exact: true }).click();
    await dmxPage.getByRole('button', { name: 'DMX monitor', exact: true }).click();
    await expect(dmxPage.getByTestId('dmx-advanced-details')).toHaveAttribute('open', '');

    // Arm output MUST be disabled until pre-flight gate is completed.
    await expect(dmxPage.getByTestId('dmx-output-arm')).toBeDisabled();

    // Configure transport first (so transport settings are bound into pre-flight revision).
    await dmxPage.getByTestId('dmx-output-mode-sacn').click();
    await dmxPage.getByTestId('dmx-output-iface').selectOption('127.0.0.1');
    await dmxPage.getByTestId('dmx-output-sacn-unicast').click();
    await dmxPage.getByTestId('dmx-output-sacn-targets').fill('127.0.0.1');

    // Run pre-flight check, acknowledge non-laser warnings, and inhibit unassessed lasers.
    await dmxPage.getByTestId('dmx-open-preflight').click();
    const pfPanel = dmxPage.getByTestId('preflight-panel');
    await expect(pfPanel).toBeVisible();
    await pfPanel.getByTestId('preflight-run-check').click();
    const ackBoxes = pfPanel.locator('input[type="checkbox"][data-testid^="preflight-ack-"]');
    for (let i = 0; i < (await ackBoxes.count()); i++) await ackBoxes.nth(i).check();
    const laserBoxes = pfPanel.locator('input[type="checkbox"][data-testid^="preflight-laser-inhibit-"]');
    for (let i = 0; i < (await laserBoxes.count()); i++) await laserBoxes.nth(i).check();
    await expect(pfPanel.getByTestId('preflight-eligibility')).toContainText('Eligible to arm');
    await pfPanel.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(pfPanel).toBeHidden();

    await expect(dmxPage.getByTestId('dmx-output-arm')).toBeEnabled();
    await dmxPage.getByTestId('dmx-output-arm').click();
    await dmxPage.getByTestId('dmx-output-go-live').click();

    // 3. LIVE badge, Pre-flight badge, and Blackout & stop stay visible outside collapsed Advanced AND in cinema mode (H).
    await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
    await expect(dmxPage.getByTestId('live-dmx-badge')).toContainText('LIVE · sACN');
    await expect(dmxPage.getByTestId('live-preflight-badge')).toBeVisible();
    // Collapse Advanced while output is live -> LIVE status, Pre-flight badge, and Blackout & stop MUST stay visible!
    await dmxPage.getByTestId('dmx-advanced-summary').click();
    await expect(dmxPage.getByTestId('dmx-advanced-details')).not.toHaveAttribute('open', '');
    await expect(dmxPage.getByTestId('dmx-output-status-pill')).toContainText('LIVE');
    await expect(dmxPage.getByTestId('dmx-preflight-badge')).toBeVisible();
    await expect(dmxPage.getByTestId('dmx-output-stop')).toBeVisible();
    await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
    await dmxPage.getByRole('button', { name: 'Cinema mode', exact: true }).click();
    await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
    await expect(dmxPage.getByTestId('live-preflight-badge')).toBeVisible();
    await dmxPage.getByRole('button', { name: 'Show desk' }).click();

    if (!packaged) {
      const assertBothUniversesTerminated = async (sliceStart) => {
        await expect.poll(() => {
          for (const u of [1, 2]) {
            const tail = packets.slice(sliceStart).filter((p) => p.universe === u);
            const termIdx = tail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
            if (termIdx < 3 || tail.slice(termIdx).length < 3) return false;
          }
          return true;
        }, { timeout: 5000 }).toBe(true);
        for (const u of [1, 2]) {
          const tail = packets.slice(sliceStart).filter((p) => p.universe === u);
          const termIdx = tail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
          for (const p of tail.slice(termIdx - 3, termIdx)) {
            expect(p.options & SACN_OPT_STREAM_TERMINATED).toBe(0);
            expect(p.slots.every((v) => v === 0)).toBe(true);
          }
          expect(tail.slice(termIdx).length).toBe(3);
          for (const p of tail.slice(termIdx)) {
            expect(p.options & SACN_OPT_STREAM_TERMINATED).toBe(SACN_OPT_STREAM_TERMINATED);
            expect(p.slots.every((v) => v === 0)).toBe(true);
          }
        }
      };

      // Trigger Cue 1 so non-zero ColorSource PAR channels stream while generic channels stay 0.
      await dmxPage.locator('.cue-list-row').first().click();
      await expect.poll(() => packets.some((p) => p.universe === 1 && p.slots.slice(432, 462).some((v) => v > 0)), { timeout: 5000 }).toBe(true);
      // Sprint 24 (Codex SF-H1 / N1): All generic non-catalogue fixture slots in Universe 1 (0..431) MUST remain 0 on physical sACN!
      const liveCueFrames = packets.filter((p) => p.universe === 1 && p.slots.slice(432, 462).some((v) => v > 0));
      expect(liveCueFrames.length).toBeGreaterThan(0);
      for (const p of liveCueFrames) {
        expect(p.slots.slice(0, 432).every((v) => v === 0)).toBe(true);
      }

      // Positive physical drive proof (Codex qa-06 R1 & qa-07): Trigger Cue 4 (Arena Rock, blinderLevel=0.28, smokeOutput=0.14)
      // to prove StageEngine actively drives STRIKE 4 on U1 (128..143) AND Martin JEM ZR45 on U2 (311..314), then return to Cue 1!
      const beforeArenaCue = packets.length;
      await dmxPage.getByRole('button', { name: /Arena Rock/ }).first().click();
      await expect.poll(
        () =>
          packets.slice(beforeArenaCue).some((p) => p.universe === 1 && p.slots.slice(128, 144).some((v) => v > 0)) &&
          packets.slice(beforeArenaCue).some((p) => p.universe === 2 && p.slots.slice(311, 315).some((v) => v > 0)),
        { timeout: 5000 },
      ).toBe(true);
      const beforeBackToCue1 = packets.length;
      await dmxPage.locator('.cue-list-row').first().click();
      await expect.poll(
        () => packets.slice(beforeBackToCue1).some((p) => p.universe === 1 && p.slots.slice(128, 144).every((v) => v === 0)),
        { timeout: 5000 },
      ).toBe(true);

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

      // 4b. Sprint 24 (review-06 R1): Direct un-armed DMX enable IPC MUST be rejected by main (`requireArmedClaim: true`).
      const unarmedEnableErr = await dmxPage.evaluate(async (p) => {
        try {
          await window.stageforgeDesktop.dmxControl({
            type: 'enable',
            config: { protocol: 'sacn', iface: '127.0.0.1', rateHz: 30, sacn: { mode: 'unicast', universes: [1, 2], priority: 100, ttl: 1, targets: [`127.0.0.1:${p}`] } },
          });
          return null;
        } catch (e) {
          return String(e?.message ?? e);
        }
      }, port);
      expect(unarmedEnableErr).toMatch(/arm live dmx output/i);

      // 4c. Sprint 24 (review-06 R1): WebGL context loss while live DMX is active MUST send paced blackout + Stream_Terminated,
      //     surface the stopped notice, and NEVER auto-resume when WebGL context is restored without fresh two-step arming.
      if ((await dmxPage.getByTestId('dmx-advanced-details').getAttribute('open')) === null) {
        await dmxPage.getByTestId('dmx-advanced-summary').click();
      }
      if (await dmxPage.getByTestId('dmx-output-arm').isDisabled()) {
        await dmxPage.getByTestId('dmx-open-preflight').click();
        const pfCtx = dmxPage.getByTestId('preflight-panel');
        await pfCtx.getByTestId('preflight-run-check').click();
        const ackCtx = pfCtx.locator('input[type="checkbox"][data-testid^="preflight-ack-"]');
        for (let i = 0; i < (await ackCtx.count()); i++) {
          if (!(await ackCtx.nth(i).isChecked())) await ackCtx.nth(i).check();
        }
        const lasCtx = pfCtx.locator('input[type="checkbox"][data-testid^="preflight-laser-inhibit-"]');
        for (let i = 0; i < (await lasCtx.count()); i++) {
          if (!(await lasCtx.nth(i).isChecked())) await lasCtx.nth(i).check();
        }
        await pfCtx.getByRole('button', { name: 'Done', exact: true }).click();
      }
      const countBeforeStep5 = packets.length;
      await dmxPage.getByTestId('dmx-output-arm').click();
      await dmxPage.getByTestId('dmx-output-go-live').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
      await expect.poll(() => packets.length > countBeforeStep5 + 2, { timeout: 5000 }).toBe(true);

      const beforeCtxLoss = packets.length;
      await dmxPage.evaluate(() => {
        const canvas = document.querySelector('canvas');
        canvas?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      });
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
      await expect(dmxPage.getByTestId('live-dmx-stopped-badge')).toContainText('Output stopped: graphics context lost');
      await expect.poll(() => {
        const tail = packets.slice(beforeCtxLoss).filter((p) => p.universe === 1);
        const termIdx = tail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
        return termIdx >= 3 && tail.slice(termIdx).length >= 3;
      }, { timeout: 5000 }).toBe(true);

      // Restore WebGL context -> live DMX MUST remain OFF until the human arms and clicks Go live again.
      const countBeforeRestore = packets.length;
      await dmxPage.evaluate(() => {
        const canvas = document.querySelector('canvas');
        canvas?.dispatchEvent(new Event('webglcontextrestored'));
      });
      await dmxPage.waitForTimeout(350);
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
      expect(packets.length).toBe(countBeforeRestore);

      // 4d. Sprint 24 (Codex SF-M1): Mutating the rig while live DMX is active (making pre-flight stale) MUST immediately
      //     stop physical output with 3 blackout frames + 3 Stream_Terminated packets and surface the stopped notice!
      if ((await dmxPage.getByTestId('dmx-advanced-details').getAttribute('open')) === null) {
        await dmxPage.getByTestId('dmx-advanced-summary').click();
      }
      await dmxPage.getByTestId('dmx-output-arm').click();
      await dmxPage.getByTestId('dmx-output-go-live').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
      await expect.poll(() => packets.length > countBeforeRestore + 2, { timeout: 5000 }).toBe(true);

      const beforeStaleEdit = packets.length;
      await dmxPage.getByRole('button', { name: 'Close DMX monitor', exact: true }).click();
      await dmxPage.getByRole('button', { name: 'Rig builder', exact: true }).click();
      await dmxPage.getByRole('button', { name: /^DJ Console / }).click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
      await expect(dmxPage.getByTestId('live-dmx-stopped-badge')).toContainText('Output stopped:');
      await expect.poll(() => {
        const tail = packets.slice(beforeStaleEdit).filter((p) => p.universe === 1);
        const termIdx = tail.findIndex((p) => (p.options & SACN_OPT_STREAM_TERMINATED) !== 0);
        return termIdx >= 3 && tail.slice(termIdx).length >= 3;
      }, { timeout: 5000 }).toBe(true);
      await dmxPage.getByTestId('live-dmx-stopped-dismiss').click();
      await expect(dmxPage.getByTestId('live-dmx-stopped-badge')).toHaveCount(0);
      await dmxPage.getByRole('button', { name: 'Close Rig Builder' }).click();
      await dmxPage.getByRole('button', { name: 'DMX monitor', exact: true }).click();

      // 4e. Sprint 24 (Codex qa-04 R2 & qa-06 R1): Revoking a pre-flight warning acknowledgement while BOTH Universe 1 & 2
      //     are streaming nonzero fixtures MUST immediately stop BOTH universes (3 blackout + 3 Stream_Terminated + silence)!
      if ((await dmxPage.getByTestId('dmx-advanced-details').getAttribute('open')) === null) {
        await dmxPage.getByTestId('dmx-advanced-summary').click();
      }
      await dmxPage.getByTestId('dmx-open-preflight').click();
      const pfRevoke = dmxPage.getByTestId('preflight-panel');
      await pfRevoke.getByTestId('preflight-run-check').click();
      const ackRevoke = pfRevoke.locator('input[type="checkbox"][data-testid^="preflight-ack-"]');
      for (let i = 0; i < (await ackRevoke.count()); i++) {
        if (!(await ackRevoke.nth(i).isChecked())) await ackRevoke.nth(i).check();
      }
      const lasRevoke = pfRevoke.locator('input[type="checkbox"][data-testid^="preflight-laser-inhibit-"]');
      for (let i = 0; i < (await lasRevoke.count()); i++) {
        if (!(await lasRevoke.nth(i).isChecked())) await lasRevoke.nth(i).check();
      }
      await pfRevoke.getByRole('button', { name: 'Done', exact: true }).click();
      await dmxPage.getByTestId('dmx-output-arm').click();
      await dmxPage.getByTestId('dmx-output-go-live').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
      const beforeRevokeCue = packets.length;
      await dmxPage.getByRole('button', { name: /Arena Rock/ }).first().click();
      await expect.poll(
        () => packets.slice(beforeRevokeCue).some((p) => p.universe === 2 && p.slots.slice(311, 315).some((v) => v > 0)),
        { timeout: 5000 },
      ).toBe(true);
      const beforeRevoke = packets.length;
      await dmxPage.getByTestId('live-preflight-badge').click();
      await expect(pfRevoke).toBeVisible();
      await ackRevoke.first().uncheck();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
      await expect(dmxPage.getByTestId('live-dmx-stopped-badge')).toContainText('Output stopped:');
      await assertBothUniversesTerminated(beforeRevoke);
      const afterRevokeSilent = packets.length;
      await dmxPage.waitForTimeout(250);
      expect(packets.length).toBe(afterRevokeSilent);
      await ackRevoke.first().check();
      await pfRevoke.getByRole('button', { name: 'Done', exact: true }).click();
      await dmxPage.getByTestId('live-dmx-stopped-dismiss').click();

      // Engage Blackout (`[Space]`) so BOTH STRIKE 4 (U1 128..143) AND Martin JEM ZR45 (U2 311..314) are strictly 0
      // before importing `hotShowBuf` (`blackout: false, blinderLevel: 1, smokeOutput: 1`) in Viewer and Show Open!
      await dmxPage.keyboard.press('Space');

      const rawLegacyShow = JSON.parse(await readFile(path.join(root, 'tests/fixtures/legacy-v1.stageforge.show.json'), 'utf8'));
      rawLegacyShow.rig.venue = 'club';
      rawLegacyShow.look.blackout = false;
      rawLegacyShow.look.masterDimmer = 1;
      rawLegacyShow.look.blinderLevel = 1;
      rawLegacyShow.look.atmo = { ...rawLegacyShow.look.atmo, smokeOutput: 1, hazeLevel: 1 };
      const hotShowBuf = Buffer.from(JSON.stringify(rawLegacyShow), 'utf8');

      // 4f. Sprint 24 (Codex qa-07 R1, qa-06 R1, qa-08 R2): Opening a show in Pitch Viewer while live DMX is active MUST
      //     synchronously stop BOTH universes before applying `blinderLevel: 1 / smokeOutput: 1` (zero U1 or U2 leak)!
      await expect(dmxPage.getByTestId('dmx-output-arm')).toBeEnabled();
      await dmxPage.getByTestId('dmx-output-arm').click();
      await expect(dmxPage.getByTestId('dmx-output-go-live')).toBeEnabled();
      await dmxPage.getByTestId('dmx-output-go-live').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
      const countAtViewerLive = packets.length;
      await expect.poll(
        () =>
          packets.slice(countAtViewerLive).some((p) => p.universe === 1 && p.slots.slice(128, 144).every((v) => v === 0)) &&
          packets.slice(countAtViewerLive).some((p) => p.universe === 2 && p.slots.slice(311, 315).every((v) => v === 0)),
        { timeout: 5000 },
      ).toBe(true);
      await dmxPage.getByRole('button', { name: 'Close DMX monitor', exact: true }).click();
      const beforeOpenViewer = packets.length;
      await dmxPage.getByRole('button', { name: 'Show files', exact: true }).click();
      const viewerFilesDialog = dmxPage.getByRole('dialog', { name: 'Show files' });
      await expect(viewerFilesDialog).toBeVisible();
      await viewerFilesDialog.getByLabel('Open show in viewer').setInputFiles({
        name: 'HotViewerImport.stageforge.show.json',
        mimeType: 'application/json',
        buffer: hotShowBuf,
      });
      await expect(dmxPage.getByText('VIEW ONLY', { exact: true })).toBeVisible();
      await assertBothUniversesTerminated(beforeOpenViewer);
      for (const p of packets.slice(beforeOpenViewer).filter((pkt) => pkt.universe === 1)) {
        expect(p.slots.slice(128, 144).every((v) => v === 0)).toBe(true);
      }
      for (const p of packets.slice(beforeOpenViewer).filter((pkt) => pkt.universe === 2)) {
        expect(p.slots.slice(311, 315).every((v) => v === 0)).toBe(true);
      }
      await dmxPage.getByRole('button', { name: 'Exit viewer' }).click();
      await expect(dmxPage.getByRole('button', { name: 'Show files', exact: true })).toBeVisible();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
      const countAfterExitViewer = packets.length;
      await dmxPage.waitForTimeout(250);
      expect(packets.length).toBe(countAfterExitViewer);
      if ((await dmxPage.getByTestId('live-dmx-stopped-dismiss').count()) > 0) {
        await dmxPage.getByTestId('live-dmx-stopped-dismiss').click();
      }
      await dmxPage.getByRole('button', { name: 'DMX monitor', exact: true }).click();
      if ((await dmxPage.getByTestId('dmx-advanced-details').getAttribute('open')) === null) {
        await dmxPage.getByTestId('dmx-advanced-summary').click();
      }
      if (await dmxPage.getByTestId('dmx-output-arm').isDisabled()) {
        await dmxPage.getByTestId('dmx-open-preflight').click();
        const pfAfterViewer = dmxPage.getByTestId('preflight-panel');
        await pfAfterViewer.getByTestId('preflight-run-check').click();
        const ackAfterViewer = pfAfterViewer.locator('input[type="checkbox"][data-testid^="preflight-ack-"]');
        for (let i = 0; i < (await ackAfterViewer.count()); i++) {
          if (!(await ackAfterViewer.nth(i).isChecked())) await ackAfterViewer.nth(i).check();
        }
        const lasAfterViewer = pfAfterViewer.locator('input[type="checkbox"][data-testid^="preflight-laser-inhibit-"]');
        for (let i = 0; i < (await lasAfterViewer.count()); i++) {
          if (!(await lasAfterViewer.nth(i).isChecked())) await lasAfterViewer.nth(i).check();
        }
        await pfAfterViewer.getByRole('button', { name: 'Done', exact: true }).click();
      }

      // 4g. Sprint 24 (Codex qa-04 R1, qa-06 R1, qa-08 R2): Opening a show file while live DMX is active MUST synchronously
      //     detach StageEngine's frame listener BEFORE applying `blinderLevel: 1 / smokeOutput: 1`, with zero U1 or U2 leak!
      await expect(dmxPage.getByTestId('dmx-output-arm')).toBeEnabled();
      await dmxPage.getByTestId('dmx-output-arm').click();
      await expect(dmxPage.getByTestId('dmx-output-go-live')).toBeEnabled();
      await dmxPage.getByTestId('dmx-output-go-live').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
      const countAtImportLive = packets.length;
      await expect.poll(
        () =>
          packets.slice(countAtImportLive).some((p) => p.universe === 1 && p.slots.slice(128, 144).every((v) => v === 0)) &&
          packets.slice(countAtImportLive).some((p) => p.universe === 2 && p.slots.slice(311, 315).every((v) => v === 0)),
        { timeout: 5000 },
      ).toBe(true);

      await dmxPage.getByRole('button', { name: 'Close DMX monitor', exact: true }).click();
      const beforeOpenDoc = packets.length;
      await dmxPage.getByRole('button', { name: 'Show files', exact: true }).click();
      const showFilesDialog = dmxPage.getByRole('dialog', { name: 'Show files' });
      await expect(showFilesDialog).toBeVisible();
      await showFilesDialog.getByLabel('Open show file').setInputFiles({
        name: 'HotBlinderImport.stageforge.show.json',
        mimeType: 'application/json',
        buffer: hotShowBuf,
      });
      await expect(showFilesDialog).toBeHidden();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toHaveCount(0);
      await expect(dmxPage.getByTestId('live-dmx-stopped-badge')).toContainText('Output stopped:');
      await assertBothUniversesTerminated(beforeOpenDoc);
      // Verify zero Strike 4 blinder bytes (U1 128..143) and zero ZR45 smoke bytes (U2 311..314) escaped during show open!
      for (const p of packets.slice(beforeOpenDoc).filter((pkt) => pkt.universe === 1)) {
        expect(p.slots.slice(128, 144).every((v) => v === 0)).toBe(true);
      }
      for (const p of packets.slice(beforeOpenDoc).filter((pkt) => pkt.universe === 2)) {
        expect(p.slots.slice(311, 315).every((v) => v === 0)).toBe(true);
      }
      await dmxPage.getByTestId('live-dmx-stopped-dismiss').click();
      await dmxPage.getByRole('button', { name: 'DMX monitor', exact: true }).click();

      // 5. Re-enable and forcibly crash the renderer: main process MUST still send blackout + terminate.
      // (Re-expand Advanced first; step 4 triggered a cue which may make pre-flight stale, so refresh if needed.)
      if ((await dmxPage.getByTestId('dmx-advanced-details').getAttribute('open')) === null) {
        await dmxPage.getByTestId('dmx-advanced-summary').click();
      }
      if (await dmxPage.getByTestId('dmx-output-arm').isDisabled()) {
        await dmxPage.getByTestId('dmx-open-preflight').click();
        const pf2 = dmxPage.getByTestId('preflight-panel');
        await pf2.getByTestId('preflight-run-check').click();
        const ack2 = pf2.locator('input[type="checkbox"][data-testid^="preflight-ack-"]');
        for (let i = 0; i < (await ack2.count()); i++) {
          if (!(await ack2.nth(i).isChecked())) await ack2.nth(i).check();
        }
        const las2 = pf2.locator('input[type="checkbox"][data-testid^="preflight-laser-inhibit-"]');
        for (let i = 0; i < (await las2.count()); i++) {
          if (!(await las2.nth(i).isChecked())) await las2.nth(i).check();
        }
        await pf2.getByRole('button', { name: 'Done', exact: true }).click();
      }
      const countBeforeCrashArm = packets.length;
      await expect(dmxPage.getByTestId('dmx-output-arm')).toBeEnabled();
      await dmxPage.getByTestId('dmx-output-arm').click();
      await expect(dmxPage.getByTestId('dmx-output-go-live')).toBeEnabled();
      await dmxPage.getByTestId('dmx-output-go-live').click();
      await expect(dmxPage.getByTestId('live-dmx-badge')).toBeVisible();
      await expect.poll(() => packets.length > countBeforeCrashArm + 2, { timeout: 5000 }).toBe(true);

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
    await expect(scPage.locator('.cue-list-row').nth(1)).toHaveAttribute('aria-pressed', 'true');
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
    await scPage.getByRole('button', { name: 'Play demo', exact: true }).click();
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

  // Switch to Rigging & power tab and verify .rigging-power.csv download passes main's suffix whitelist.
  await dialog.getByRole('tab', { name: /Rigging & power/ }).click();
  const rpPanel = dialog.getByRole('tabpanel', { name: /Rigging & power/ });
  await expect(rpPanel).toContainText('Simplified static guidance only');
  const rpTarget = path.join(tmp, 'rig-loads.rigging-power.csv');
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
  }, rpTarget);
  await rpPanel.getByRole('button', { name: 'Export CSV' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.__stageforgeTest.download.state), { timeout: 15_000 }).toBe('completed');
  const rpDl = await app.evaluate(() => globalThis.__stageforgeTest.download);
  expect(rpDl.filename).toMatch(/\.rigging-power\.csv$/);
  expect(rpDl.options.title).toBe('Export rigging and power report');
  const rpBody = await readFile(rpTarget, 'utf8');
  expect(rpBody.startsWith('\uFEFF')).toBe(true);
  expect(rpBody).toContain('section,pod_or_group,item');
  expect(rpBody).toContain('summary,');

  // Switch to Paperwork tab: verify all 4 paperwork CSV suffixes pass will-download with exact titles,
  // window.print() is reachable, window.open() remains denied, and an unknown .csv suffix is cancelled.
  await dialog.getByRole('tab', { name: /Paperwork/ }).click();
  const pwPanel = dialog.getByRole('tabpanel', { name: /Paperwork/ });
  await expect(pwPanel).toContainText('StageForge simulated channel map');

  await pwPanel.getByRole('button', { name: 'Print full book' }).click();
  expect(await page.evaluate(() => window.__desktopPrintCalls)).toBe(2);
  expect(await page.evaluate(() => window.open('https://example.com'))).toBeNull();

  // Verify Electron webContents.printToPDF() renders the full 6-sheet book (starting with A4 landscape plot plan).
  const pdfSummary = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const buf = await win.webContents.printToPDF({
      landscape: true,
      pageSize: 'A4',
      margins: { top: 0.3937, bottom: 0.3937, left: 0.3937, right: 0.3937 },
      preferCSSPageSize: true,
      printBackground: true,
    });
    const text = buf.toString('latin1');
    const mediaMatch = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    const pages = text.match(/\/Type\s*\/Page\b(?!s)/g) ?? [];
    return {
      headerOk: text.startsWith('%PDF-'),
      bytes: buf.length,
      pageCount: pages.length,
      mediaBox: mediaMatch ? mediaMatch.slice(1).map(Number) : null,
    };
  });
  expect(pdfSummary.headerOk).toBe(true);
  expect(pdfSummary.bytes).toBeGreaterThan(5000);
  expect(pdfSummary.pageCount).toBeGreaterThanOrEqual(6);
  expect(pdfSummary.mediaBox).not.toBeNull();
  expect(Math.abs(pdfSummary.mediaBox[2] - 841.9)).toBeLessThan(3);
  expect(Math.abs(pdfSummary.mediaBox[3] - 595.3)).toBeLessThan(3);

  const pwChecks = [
    { radio: 'Patch sheet', suffix: '.patch-sheet.csv', title: 'Export patch sheet', header: 'Universe,DMX Address' },
    { radio: 'Instrument schedule', suffix: '.instrument-schedule.csv', title: 'Export instrument schedule', header: 'Position,Mount #,Fixture #' },
    { radio: 'Channel hookup', suffix: '.channel-hookup.csv', title: 'Export channel hookup', header: 'Fixture #,Position,Unit #' },
    { radio: 'Cue sheet', suffix: '.cue-sheet.csv', title: 'Export cue sheet', header: 'Cue #,Name,Tag,Fade,Follow' },
    { radio: 'Commissioning record', suffix: '.commissioning-record.csv', title: 'Export commissioning record', header: 'Row ID,Category,Item,Location' },
  ];
  for (const check of pwChecks) {
    await pwPanel.getByRole('radio', { name: new RegExp(check.radio) }).click({ force: true });
    const target = path.join(tmp, `paperwork${check.suffix}`);
    await app.evaluate(({ session }, dest) => {
      const record = globalThis.__stageforgeTest.download = { state: 'waiting' };
      const listener = (_event, item) => {
        session.defaultSession.off('will-download', listener);
        record.filename = item.getFilename();
        record.options = item.getSaveDialogOptions();
        item.setSavePath(dest);
        item.once('done', (_e, state) => { record.state = state; });
      };
      session.defaultSession.on('will-download', listener);
    }, target);
    await pwPanel.getByRole('button', { name: 'Export CSV' }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__stageforgeTest.download.state), { timeout: 15_000 }).toBe('completed');
    const pwDl = await app.evaluate(() => globalThis.__stageforgeTest.download);
    expect(pwDl.filename.endsWith(check.suffix)).toBe(true);
    expect(pwDl.options.title).toBe(check.title);
    const pwBody = await readFile(target, 'utf8');
    expect(pwBody.startsWith('\uFEFF')).toBe(true);
    expect(pwBody).toContain(check.header);
  }

  // An unlisted .csv suffix triggered from renderer must still be cancelled by will-download.
  await app.evaluate(({ session }) => {
    const record = globalThis.__stageforgeTest.unknownDownload = { state: 'waiting' };
    const listener = (_event, item) => {
      session.defaultSession.off('will-download', listener);
      if (item.getState() === 'cancelled') {
        record.state = 'cancelled';
      } else {
        item.once('done', (_e, state) => { record.state = state; });
      }
    };
    session.defaultSession.on('will-download', listener);
  });
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }));
    a.download = 'unlisted.unknown.csv';
    document.body.append(a);
    a.click();
    a.remove();
  });
  await expect.poll(() => app.evaluate(() => globalThis.__stageforgeTest.unknownDownload.state), { timeout: 15_000 }).toBe('cancelled');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expectNoProblems();
});

test('File → Open in viewer… enters pitch viewer via openViewer IPC, disables mutating File menus, blocks DMX/show-control, and restores desk on Exit', async () => {
  const getMenuStates = () => app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const ids = [
      'file-open',
      'file-open-viewer',
      'file-save-show',
      'file-save-bundle',
      'file-export-rig',
      'file-export-submenu',
      'file-export-mvr',
      'file-export-dxf',
      'file-export-glb',
      'file-export-csv',
    ];
    return Object.fromEntries(ids.map((id) => [id, menu.getMenuItemById(id)?.enabled ?? null]));
  });

  // Before opening viewer, all File menu items are enabled.
  const beforeMenus = await getMenuStates();
  expect(Object.values(beforeMenus).every((v) => v === true)).toBe(true);

  const storageBefore = await page.evaluate(() => window.localStorage.getItem('stageforge.design.v1'));

  // Trigger File → Open in viewer… with the verified bundle.
  const bundlePath = path.join(tmp, 'viewer-bundle.stageforge.zip');
  const zip = await writeBundle(bundlePath);
  await watchRendererCommands();
  await app.evaluate((_electron, file) => { globalThis.__stageforgeTest.nextOpen = file; }, bundlePath);
  await clickFileMenu('Open in viewer');

  await expect.poll(received).toEqual([{
    command: 'openViewer', type: '[object Uint8Array]', mainWorldUint8Array: true, length: zip.length, sha256: sha256(zip),
  }]);
  await expect(page.getByText('VIEW ONLY', { exact: true })).toBeVisible();
  await expect(page.locator('header h1')).toHaveText(SHOW_NAME);
  await expect(page.getByRole('button', { name: 'Rig builder' })).toHaveCount(0);

  // Mutating File menu items must be disabled in main, while Open in viewer… stays enabled.
  await expect.poll(getMenuStates).toEqual({
    'file-open': false,
    'file-open-viewer': true,
    'file-save-show': false,
    'file-save-bundle': false,
    'file-export-rig': false,
    'file-export-submenu': false,
    'file-export-mvr': false,
    'file-export-dxf': false,
    'file-export-glb': false,
    'file-export-csv': false,
  });

  // Main-process DMX & show-control IPC must reject activation while the window is in viewer mode.
  const ipcErrors = await page.evaluate(async () => {
    let dmxErr = null;
    let scErr = null;
    try {
      await window.stageforgeDesktop.dmxControl({
        type: 'enable',
        config: { protocol: 'sacn', iface: '127.0.0.1', rateHz: 30, sacn: { mode: 'unicast', universes: [1, 2], priority: 100, ttl: 1, targets: ['127.0.0.1'] } },
      });
    } catch (e) {
      dmxErr = String(e?.message ?? e);
    }
    try {
      await window.stageforgeDesktop.showControl({
        type: 'configure',
        config: { oscRxEnabled: true, oscPort: 8000, oscAllowAllInterfaces: false, oscTxEnabled: false, oscTxHost: '127.0.0.1', oscTxPort: 9000, artnetTcRxEnabled: false, artnetTcTxEnabled: false, artnetTcTxHost: '127.0.0.1' },
      });
    } catch (e) {
      scErr = String(e?.message ?? e);
    }
    return { dmxErr, scErr };
  });
  expect(ipcErrors.dmxErr).toMatch(/pitch viewer/i);
  expect(ipcErrors.scErr).toMatch(/pitch viewer/i);

  // Also test opening a JSON show while already in viewer mode.
  await watchRendererCommands();
  await app.evaluate((_electron, file) => { globalThis.__stageforgeTest.nextOpen = file; }, examplePath);
  await clickFileMenu('Open in viewer');
  await expect.poll(received).toContainEqual(expect.objectContaining({
    command: 'openViewer', type: '[object String]', mainWorldUint8Array: false,
  }));
  await expect(page.locator('header h1')).toHaveText('Amber Walk-on');

  // Defense-in-depth: will-download cancels even a normally-whitelisted suffix while in viewer mode.
  await app.evaluate(({ session }) => {
    const record = globalThis.__stageforgeTest.viewerDownload = { state: 'waiting' };
    const listener = (_event, item) => {
      session.defaultSession.off('will-download', listener);
      if (item.getState() === 'cancelled') record.state = 'cancelled';
      else item.once('done', (_e, state) => { record.state = state; });
    };
    session.defaultSession.on('will-download', listener);
  });
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['{}'], { type: 'application/json' }));
    a.download = 'blocked.stageforge.json';
    document.body.append(a);
    a.click();
    a.remove();
  });
  await expect.poll(() => app.evaluate(() => globalThis.__stageforgeTest.viewerDownload.state), { timeout: 15_000 }).toBe('cancelled');

  // Exit viewer -> restores desk and re-enables all File menu items, leaving storage untouched.
  await page.getByRole('button', { name: 'Exit viewer' }).click();
  await expect(page.getByRole('button', { name: 'Show files', exact: true })).toBeVisible();
  await expect.poll(getMenuStates).toEqual(beforeMenus);
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.design.v1'))).toBe(storageBefore);
  expectNoProblems();
});

test('shipped demo track plays from stageforge://app/ under strict CSP and jumps sections cleanly', async () => {
  const demoTmp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-desktop-demo-'));
  const packaged = process.env.STAGEFORGE_DESKTOP_EXE;
  let demoApp;
  const demoProblems = [];
  try {
    const demoProfile = `--user-data-dir=${path.join(demoTmp, 'profile')}`;
    demoApp = await electron.launch(packaged
      ? { executablePath: path.resolve(packaged), args: [demoProfile] }
      : { executablePath: createRequire(import.meta.url)('electron'), args: [appDir, demoProfile] });
    demoApp.process().stderr?.on('data', chunk => {
      const text = String(chunk);
      if (/Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(text)) demoProblems.push('main: ' + text.trim());
    });
    const demoPage = await demoApp.firstWindow();
    demoPage.on('pageerror', err => demoProblems.push('pageerror: ' + err.message));
    demoPage.on('console', msg => {
      if (msg.type() === 'error') demoProblems.push('console: ' + msg.text());
    });
    await demoPage.waitForLoadState('domcontentloaded');
    await expect(demoPage).toHaveURL('stageforge://app/');

    // Idle discovery surfaces "Play demo track" from stageforge://app/demo/track.json without fetching track.mp3.
    const playTrackBtn = demoPage.getByRole('button', { name: 'Play demo track', exact: true });
    await expect(playTrackBtn).toBeVisible({ timeout: 15_000 });
    const preClickMp3 = await demoPage.evaluate(() =>
      performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/demo/track.mp3')).length
    );
    expect(preClickMp3).toBe(0);

    await playTrackBtn.click();

    // Playing fetches stageforge://app/demo/track.mp3 -> blob and drives the 158-bar section overlay.
    await expect(demoPage.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 15_000 });
    const progress = demoPage.locator('.demo-progress');
    await expect(progress).toHaveAttribute('data-section', 'intro');
    await expect(progress).toContainText('/ 158');

    // Open Audio settings and step across sections to prove seeking works on the real MP3 under strict CSP.
    await demoPage.getByRole('button', { name: 'Audio settings', exact: true }).click();
    await expect(demoPage.getByText('122.0 BPM · 96 ms')).toBeVisible();
    // During the count-in, Next starts the intro. Let the time source reach the first section.
    await expect(progress).toContainText('Walk-on');
    await demoPage.getByRole('button', { name: 'Next section', exact: true }).click();
    await expect(progress).toHaveAttribute('data-section', 'build');
    await expect(progress).toContainText('Rising');
    await demoPage.getByRole('button', { name: 'Next section', exact: true }).click();
    await expect(progress).toHaveAttribute('data-section', 'drop');
    await expect(progress).toContainText('Kick enters');

    expect(demoProblems, 'desktop demo-track errors').toEqual([]);
  } finally {
    await demoApp?.close().catch(() => {});
    await rm(demoTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('when renderer/demo is absent, stageforge://app/demo/track.json returns 204, hides Play demo track, and Play demo runs the synth', async () => {
  const absentTmp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-desktop-nodemo-'));
  let absentApp;
  const absentProblems = [];
  try {
    const tempAppDir = path.join(absentTmp, 'app');
    await cp(appDir, tempAppDir, { recursive: true });
    await rm(path.join(tempAppDir, 'renderer', 'demo'), { recursive: true, force: true });

    const absentProfile = `--user-data-dir=${path.join(absentTmp, 'profile')}`;
    absentApp = await electron.launch({
      executablePath: createRequire(import.meta.url)('electron'),
      args: [tempAppDir, absentProfile],
    });
    absentApp.process().stderr?.on('data', chunk => {
      const text = String(chunk);
      if (/Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(text)) absentProblems.push('main: ' + text.trim());
    });
    const absentPage = await absentApp.firstWindow();
    absentPage.on('pageerror', err => absentProblems.push('pageerror: ' + err.message));
    absentPage.on('console', msg => {
      if (msg.type() === 'error') absentProblems.push('console: ' + msg.text());
    });
    await absentPage.waitForLoadState('domcontentloaded');
    await expect(absentPage).toHaveURL('stageforge://app/');
    await expect(absentPage.getByRole('button', { name: 'Show files', exact: true })).toBeVisible();

    const absentRes = await absentPage.evaluate(async () => {
      const r = await fetch('stageforge://app/demo/track.json');
      return {
        status: r.status,
        csp: r.headers.get('content-security-policy'),
        cacheControl: r.headers.get('cache-control'),
      };
    });
    expect(absentRes.status).toBe(204);
    expect(absentRes.csp).toContain("script-src 'self'");
    expect(absentRes.cacheControl).toBe('no-store');
    await expect(absentPage.getByRole('button', { name: 'Play demo track', exact: true })).toHaveCount(0);

    // Built-in 64-bar synth demo still launches cleanly.
    await absentPage.getByRole('button', { name: 'Play demo', exact: true }).click();
    await expect(absentPage.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(absentPage.locator('.demo-progress')).toContainText('/ 64');

    expect(absentProblems, 'desktop absent-demo errors').toEqual([]);
  } finally {
    await absentApp?.close().catch(() => {});
    await rm(absentTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('AI bridge boots off, blocks live DMX arming, serves MCP tools/proposals/revert/capture_frame, and closes port on disable', async () => {
  const aiTmp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-ai-smoke-'));
  const packaged = process.env.STAGEFORGE_DESKTOP_EXE;
  const profile = `--user-data-dir=${path.join(aiTmp, 'profile')}`;
  const aiPort = 39000 + Math.floor(Math.random() * 8000);
  const aiProblems = [];

  const postMcp = (port, token, bodyObj, sid) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
        ...(sid ? { 'Mcp-Session-Id': sid } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  let aiApp;
  try {
    aiApp = await electron.launch(packaged
      ? { executablePath: path.resolve(packaged), args: [profile] }
      : { executablePath: createRequire(import.meta.url)('electron'), args: [appDir, profile] });
    aiApp.process().stderr?.on('data', (chunk) => {
      const text = String(chunk);
      if (/Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(text)) aiProblems.push('main: ' + text.trim());
    });
    const aiPage = await aiApp.firstWindow();
    aiPage.on('pageerror', (err) => aiProblems.push('pageerror: ' + err.message));
    await aiPage.waitForLoadState('domcontentloaded');
    await expect(aiPage.getByRole('button', { name: 'Show control', exact: true })).toBeVisible();

    // 1. Fresh boot has NO AI bridge listener.
    const initialStatus = await aiPage.evaluate(() => window.stageforgeDesktop.aiBridgeControl({ type: 'getStatus' }));
    expect(initialStatus.enabled).toBe(false);
    expect(initialStatus.port).toBe(null);

    // 2. Open Show Control drawer, set port, and enable AI bridge.
    await aiPage.getByRole('button', { name: 'Show control', exact: true }).click();
    const portInput = aiPage.getByTestId('ai-bridge-port');
    await portInput.fill(String(aiPort));
    await portInput.press('Enter');
    await aiPage.getByTestId('ai-bridge-enable').click();
    await expect(aiPage.getByTestId('ai-bridge-status')).toContainText(`ON · 127.0.0.1:${aiPort}`);
    const token = await aiPage.getByTestId('ai-bridge-token').getAttribute('data-token');
    expect(token).toBeTruthy();

    // 3. Mutual exclusion: live DMX Arm output is blocked while AI bridge is enabled.
    await aiPage.getByRole('button', { name: 'Close show control', exact: true }).click();
    await aiPage.getByRole('button', { name: 'DMX monitor', exact: true }).click();
    await aiPage.getByTestId('dmx-advanced-summary').click();
    await expect(aiPage.getByTestId('dmx-ai-bridge-blocked')).toBeVisible();
    await expect(aiPage.getByTestId('dmx-output-arm')).toBeDisabled();
    await aiPage.getByRole('button', { name: 'Close DMX monitor', exact: true }).click();

    // 4. Raw Streamable HTTP JSON-RPC client: initialize -> notifications/initialized -> tools/list -> get_state -> get_safety_report.
    const initRes = await postMcp(aiPort, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'desktop-smoke', version: '1.0' } },
    });
    expect(initRes.status).toBe(200);
    const sid = initRes.headers['mcp-session-id'];
    expect(sid).toBeTruthy();

    const notifRes = await postMcp(aiPort, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    expect(notifRes.status).toBe(202);

    const listRes = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid);
    expect(listRes.status).toBe(200);
    const names = listRes.json.result.tools.map((t) => t.name);
    expect(names).toHaveLength(26);
    expect(names).toContain('get_safety_report');
    expect(names).not.toContain('enable_dmx');

    const schemaRes = await postMcp(aiPort, token, {
      jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_schema', arguments: {} },
    }, sid);
    const packagedSchema = JSON.parse(schemaRes.json.result.content[0].text);
    expect(packagedSchema.$id).toBe('https://jbrick2070.github.io/stageforge/schemas/show-v14.schema.json');
    expect(packagedSchema.properties.version.const).toBe(14);

    const stateBefore = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, sid);
    const beforeObj = JSON.parse(stateBefore.json.result.content[0].text);
    const origColor = beforeObj.look.primaryColor;
    const targetColor = origColor.toLowerCase() === '#ff0066' ? '#00ff88' : '#ff0066';

    const safetyRes = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_safety_report', arguments: {} } }, sid);
    const safetyObj = JSON.parse(safetyRes.json.result.content[0].text);
    expect(safetyObj.readOnly).toBe(true);

    // 5. propose_look shows the banner -> Accept applies the look -> Revert restores byte-for-byte.
    const propRes = await postMcp(aiPort, token, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'propose_look', arguments: { summary: 'Smoke color change', patch: { primaryColor: targetColor } } },
    }, sid);
    const propObj = JSON.parse(propRes.json.result.content[0].text);
    expect(propObj.status).toBe('pending');
    await expect(aiPage.getByTestId('ai-proposal-banner')).toBeVisible();
    await expect(aiPage.getByTestId('ai-proposal-summary')).toContainText('Smoke color change');

    await aiPage.getByTestId('ai-proposal-accept').click();
    await expect(aiPage.getByTestId('ai-proposal-banner')).toHaveCount(0);

    const stateAfterAccept = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, sid);
    const afterAcceptObj = JSON.parse(stateAfterAccept.json.result.content[0].text);
    expect(afterAcceptObj.look.primaryColor.toLowerCase()).toBe(targetColor);

    // Revert AI changes restores the exact prior state.
    await aiPage.getByRole('button', { name: 'Show control', exact: true }).click();
    await aiPage.getByTestId('ai-bridge-revert').click();

    const stateAfterRevert = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, sid);
    const afterRevertObj = JSON.parse(stateAfterRevert.json.result.content[0].text);
    expect(afterRevertObj.look).toEqual(beforeObj.look);

    // 5b. Codex review-03 R3 & R4 regressions (using audienceScan-free cues so AI safety guards allow them):
    // - Accepting a cue edit after advancing activeCueId keeps the advanced activeCueId (R4).
    // - Calling MCP `stop` during an active cue follow countdown cancels the follow timer (R3).
    const cuesRes = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'get_cues', arguments: {} } }, sid);
    const initialCues = JSON.parse(cuesRes.json.result.content[0].text).cues;
    const safeCues = initialCues.filter((c) => c.state?.laser?.audienceScan !== true);
    expect(safeCues.length).toBeGreaterThanOrEqual(2);
    const safeA = safeCues[0];
    const safeB = safeCues[1];

    // Activate safeA, propose renaming safeB, then advance to safeB BEFORE accepting -> activeCueId must stay safeB (R4).
    const trigA = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'trigger_cue', arguments: { cueId: safeA.id } } }, sid);
    expect(trigA.json.result.isError).toBeUndefined();
    const editProp = await postMcp(aiPort, token, {
      jsonrpc: '2.0',
      id: 53,
      method: 'tools/call',
      params: { name: 'propose_cue', arguments: { action: 'edit', cueId: safeB.id, cue: { name: 'Smoke Renamed Safe' } } },
    }, sid);
    expect(editProp.json.result.isError).toBeUndefined();
    const trigB = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 54, method: 'tools/call', params: { name: 'trigger_cue', arguments: { cueId: safeB.id } } }, sid);
    expect(trigB.json.result.isError).toBeUndefined();
    await expect(aiPage.getByTestId('ai-proposal-banner')).toBeVisible();
    await aiPage.getByTestId('ai-proposal-accept').click();
    await expect(aiPage.getByTestId('ai-proposal-banner')).toHaveCount(0);
    const stateAfterCueEdit = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 55, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, sid);
    expect(JSON.parse(stateAfterCueEdit.json.result.content[0].text).cues.activeCueId).toBe(safeB.id);

    // Create two consecutive safe cues at the end of the stack (Follow A -> Follow B with followSeconds: 0.8),
    // trigger Follow A, immediately send MCP `stop`, wait 1.2 s -> Follow B MUST NOT fire (R3).
    const createA = await postMcp(aiPort, token, {
      jsonrpc: '2.0',
      id: 56,
      method: 'tools/call',
      params: { name: 'propose_cue', arguments: { action: 'create', cue: { id: 'smoke-follow-a', name: 'Smoke Follow A', tag: 'TEST', accent: '#38bdf8', followSeconds: 0.8, state: { masterDimmer: 0.5 } } } },
    }, sid);
    expect(createA.json.result.isError).toBeUndefined();
    await expect(aiPage.getByTestId('ai-proposal-banner')).toBeVisible();
    await aiPage.getByTestId('ai-proposal-accept').click();
    await expect(aiPage.getByTestId('ai-proposal-banner')).toHaveCount(0);

    const createB = await postMcp(aiPort, token, {
      jsonrpc: '2.0',
      id: 57,
      method: 'tools/call',
      params: { name: 'propose_cue', arguments: { action: 'create', cue: { id: 'smoke-follow-b', name: 'Smoke Follow B', tag: 'TEST', accent: '#fb7185', state: { masterDimmer: 0.7 } } } },
    }, sid);
    expect(createB.json.result.isError).toBeUndefined();
    await expect(aiPage.getByTestId('ai-proposal-banner')).toBeVisible();
    await aiPage.getByTestId('ai-proposal-accept').click();
    await expect(aiPage.getByTestId('ai-proposal-banner')).toHaveCount(0);

    const trigFollow = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 58, method: 'tools/call', params: { name: 'trigger_cue', arguments: { cueId: 'smoke-follow-a' } } }, sid);
    expect(trigFollow.json.result.isError).toBeUndefined();
    const stopRes = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 59, method: 'tools/call', params: { name: 'stop', arguments: {} } }, sid);
    expect(stopRes.json.result.isError).toBeUndefined();
    await aiPage.waitForTimeout(1200);
    const stateAfterStop = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, sid);
    expect(JSON.parse(stateAfterStop.json.result.content[0].text).cues.activeCueId).toBe('smoke-follow-a');

    // Codex review-04 R4 regression: start built-in demo (enables Auto-LD with no recorded take),
    // then send MCP `stop` -> audio stops AND Auto-LD is disarmed (button aria-pressed === 'false').
    await aiPage.getByRole('button', { name: 'Play demo', exact: true }).click();
    await expect.poll(async () => {
      const st = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, sid);
      return JSON.parse(st.json.result.content[0].text).audio?.playing === true;
    }, { timeout: 5000 }).toBe(true);
    const stopDemoRes = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'stop', arguments: {} } }, sid);
    expect(stopDemoRes.json.result.isError).toBeUndefined();
    await expect.poll(async () => {
      const st = await postMcp(aiPort, token, { jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'get_state', arguments: {} } }, sid);
      return JSON.parse(st.json.result.content[0].text).audio?.playing === false;
    }, { timeout: 5000 }).toBe(true);
    await expect(aiPage.getByRole('button', { name: /Auto-LD/i })).toHaveAttribute('aria-pressed', 'false');

    // 6. capture_frame returns a real decodable JPEG image block (SOI FF D8 FF).
    const capRes = await postMcp(aiPort, token, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'capture_frame', arguments: { maxWidth: 640 } },
    }, sid);
    expect(capRes.json.result.isError).toBeUndefined();
    const imgBlock = capRes.json.result.content[0];
    expect(imgBlock.type).toBe('image');
    expect(imgBlock.mimeType).toBe('image/jpeg');
    const jpegBytes = Buffer.from(imgBlock.data, 'base64');
    expect(jpegBytes.byteLength).toBeGreaterThan(256);
    expect(jpegBytes[0]).toBe(0xff);
    expect(jpegBytes[1]).toBe(0xd8);
    expect(jpegBytes[2]).toBe(0xff);

    // 7. Disabling the bridge closes the listening port cleanly.
    await aiPage.getByTestId('ai-bridge-disable').click();
    await expect(aiPage.getByTestId('ai-bridge-status')).toContainText('OFF');
    await expect(
      postMcp(aiPort, token, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, sid),
    ).rejects.toThrow();

    expect(aiProblems, 'desktop AI bridge errors').toEqual([]);
  } finally {
    await aiApp?.close().catch(() => {});
    await rm(aiTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
