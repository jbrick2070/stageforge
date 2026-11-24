// Boots the built desktop app (run `npm run desktop:prepare` first) and drives the real
// File menu: main process -> IPC -> sandboxed preload -> contextBridge -> renderer.
import { _electron as electron, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
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
    const item = file?.submenu.items.find(entry => entry.label.startsWith(prefix));
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
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(path.join(tmp, 'profile'));
  await expect(page).toHaveURL('stageforge://app/');
  await expect(page.getByRole('button', { name: 'Show files', exact: true })).toBeVisible();
  const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
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
  expect(world).toEqual({ bridge: ['onRigCommand'], node: 'undefined/undefined', secure: true, inlineScript: 'script-src-elem', webgl2: true });
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
  expect(options.filters[0].extensions).toEqual(['json', 'zip']);
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
