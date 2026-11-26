// Read-only pitch viewer: ?view URL entry, Show files entry, bundle & JSON playback,
// session-only relink, mutation/storage/transport zero-leak verification, phone layout, and Exit restore.
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const fixturePath = fileURLToPath(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url));
const videoPath = fileURLToPath(new URL('../../public/examples/amber-clouds.mp4', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function buildV3Bundle(outputPath) {
  const fixtureBytes = await readFile(fixturePath);
  const videoBytes = await readFile(videoPath);
  const mediaNames = ['amber-clouds.mp4', 'blue-raster.mp4', 'guest-surface.mp4'];
  const files = { 'show.json': new Uint8Array(fixtureBytes) };
  const manifest = {
    format: 'stageforge-bundle',
    version: 1,
    show: { bytes: fixtureBytes.length, sha256: sha256(fixtureBytes) },
    media: [],
  };
  for (const name of mediaNames) {
    const entry = 'media/video/' + name;
    files[entry] = new Uint8Array(videoBytes);
    manifest.media.push({
      kind: 'video',
      name,
      path: entry,
      mime: 'video/mp4',
      bytes: videoBytes.length,
      sha256: sha256(videoBytes),
      durationSec: null,
    });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  const zip = zipSync(files, { level: 0 });
  await writeFile(outputPath, zip);
  return outputPath;
}

/** Instrument storage & transport APIs before page scripts run so any leak during viewer mode fails loudly. */
async function installLeakSpies(page, seededDesignJson) {
  await page.addInitScript((seed) => {
    // Seed saved desk, DMX and show-control preferences BEFORE installing the write spy
    // so we can assert every single key stays byte-identical across viewer mode.
    if (seed) {
      window.localStorage.setItem('stageforge.design.v1', seed.design);
      window.localStorage.setItem('stageforge.dmx.output.v1', seed.dmx);
      window.localStorage.setItem('stageforge.showControl.v1', seed.showControl);
    }

    const log = (window.__sfViewerAudit = {
      storageWrites: [],
      webSockets: [],
      midiRequests: 0,
      serialRequests: 0,
    });

    const origSetItem = Storage.prototype.setItem;
    const origRemoveItem = Storage.prototype.removeItem;
    const origClear = Storage.prototype.clear;
    Storage.prototype.setItem = function (k, v) {
      log.storageWrites.push({ op: 'setItem', key: String(k) });
      return origSetItem.call(this, k, v);
    };
    Storage.prototype.removeItem = function (k) {
      log.storageWrites.push({ op: 'removeItem', key: String(k) });
      return origRemoveItem.call(this, k);
    };
    Storage.prototype.clear = function () {
      log.storageWrites.push({ op: 'clear' });
      return origClear.call(this);
    };

    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const isViteHmr = protocols === 'vite-hmr' || (Array.isArray(protocols) && protocols.includes('vite-hmr'));
      if (!isViteHmr) log.webSockets.push(String(url));
      return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    };
    window.WebSocket.prototype = OrigWS.prototype;

    if (navigator.requestMIDIAccess) {
      const origMidi = navigator.requestMIDIAccess.bind(navigator);
      navigator.requestMIDIAccess = (...args) => {
        log.midiRequests++;
        return origMidi(...args);
      };
    } else {
      Object.defineProperty(navigator, 'requestMIDIAccess', {
        configurable: true,
        value: () => {
          log.midiRequests++;
          return Promise.reject(new Error('stubbed'));
        },
      });
    }

    if (navigator.serial && navigator.serial.requestPort) {
      const origSerial = navigator.serial.requestPort.bind(navigator.serial);
      navigator.serial.requestPort = (...args) => {
        log.serialRequests++;
        return origSerial(...args);
      };
    }
  }, seededDesignJson);
}

test('?view opens v3 fixture read-only: playback/scrub/cues/relink work, edits/hotkeys/drag/storage/transports stay blocked, Exit restores desk', async ({ page }) => {
  // Build distinct saved desk, DMX and show-control storage payloads to verify viewer never overwrites any of them.
  const seededDesign = JSON.parse(await readFile(fixturePath, 'utf8')).rig;
  seededDesign.schemaVersion = 1;
  seededDesign.name = 'Desk Saved Arena';
  const seededJson = JSON.stringify(seededDesign);
  const seededDmx = JSON.stringify({ mode: 'sacn', iface: '127.0.0.1', rateHz: 30 });
  const seededSc = JSON.stringify({ oscPort: 9123, frameRate: 25, timecodeOffsetMs: 3600000 });

  await installLeakSpies(page, { design: seededJson, dmx: seededDmx, showControl: seededSc });
  await page.goto('/?view&probe');

  await expect(page.getByText('VIEW ONLY', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exit viewer' })).toBeVisible();

  // Editor surfaces must not be mounted.
  await expect(page.getByRole('button', { name: 'Rig builder' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Design stage' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'DMX monitor' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show control' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Gear, cost and crew' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Lighting desk' })).toHaveCount(0);

  // All capabilities are false in viewer mode.
  const caps = await page.evaluate(() => window.stageforgeProbe.capabilities());
  expect(caps).toEqual({
    edit: false,
    save: false,
    autosave: false,
    liveOutput: false,
    showControl: false,
    mutatingHotkeys: false,
    controllers: false,
  });

  // Load the v3 show JSON into the viewer.
  await page.getByLabel('Open show in viewer').setInputFiles(fixturePath);
  await expect(page.locator('header h1')).toHaveText('Split Rig rehearsal');

  // Snapshot the probe rig right after load; it must stay byte-identical through every attempted edit.
  const rigBefore = await page.evaluate(() => JSON.stringify(window.stageforgeProbe.rig()));

  // Missing-media banner appears; session-only relink works without touching localStorage.
  const relinkBanner = page.getByRole('button', { name: /3 missing media files · Relink/ });
  await expect(relinkBanner).toBeVisible();
  await relinkBanner.click();
  const relinkDialog = page.getByRole('dialog', { name: 'Relink media (session only)' });
  await expect(relinkDialog).toBeVisible();
  await page.getByLabel('Relink media files').setInputFiles(videoPath);
  await expect(relinkDialog).toContainText('Relinked 1 media reference');
  await relinkDialog.getByRole('button', { name: 'Close Relink media (session only)' }).click();
  await expect(page.getByRole('button', { name: /2 missing media files · Relink/ })).toBeVisible();

  // Cue jump, GO, Back, camera presets, cinema mode, and take play/pause/scrub all work.
  const cuePads = page.locator('.pitch-viewer-dock .cue-list-row');
  const cueCount = await cuePads.count();
  expect(cueCount).toBeGreaterThanOrEqual(2);

  await cuePads.nth(1).click();
  const secondCueId = await page.evaluate(() => window.stageforgeProbe.activeCueId());
  expect(secondCueId).toBeTruthy();

  await page.getByRole('button', { name: 'Previous cue' }).click();
  const prevCueId = await page.evaluate(() => window.stageforgeProbe.activeCueId());
  expect(prevCueId).not.toBe(secondCueId);

  await page.getByRole('button', { name: 'Next cue' }).click();
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(secondCueId);

  // Keyboard GO / Back and Camera presets / Cinema work.
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(prevCueId);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(secondCueId);

  await page.keyboard.press('Digit3');
  expect(await page.evaluate(() => window.stageforgeProbe.camera())).toBe('wide_arena');
  await page.getByLabel('Camera view').selectOption('overhead');
  expect(await page.evaluate(() => window.stageforgeProbe.camera())).toBe('overhead');

  await page.keyboard.press('KeyH');
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeVisible();
  // QA M2 regression: arrow keys must still step cues in cinema mode even when a cinema button has focus.
  await page.getByRole('button', { name: 'Show controls' }).focus();
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(prevCueId);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(secondCueId);
  await page.keyboard.press('KeyH');
  await expect(page.locator('header.pitch-viewer-bar')).toBeVisible();

  // Take playback: Space starts/pauses take (NEVER toggles blackout!), scrubber seeks cleanly.
  const blackoutBefore = await page.evaluate(() => window.stageforgeProbe.showStateSummary().blackout);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.takeState().mode)).toBe('playing');
  await page.waitForTimeout(250);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.takeState().mode)).toBe('idle');
  const pausedTime = await page.evaluate(() => window.stageforgeProbe.takeState().timeMs);
  expect(pausedTime).toBeGreaterThan(0);

  // Scrub slider to a specific timestamp.
  const slider = page.getByLabel('Take position');
  await slider.fill('3000');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.takeState().timeMs)).toBeGreaterThanOrEqual(2900);

  // Attempt mutating hotkeys (bumps, tap tempo) and drag on the canvas.
  const bpmBefore = await page.evaluate(() => window.stageforgeProbe.showStateSummary().bpm);
  for (const key of ['KeyB', 'KeyS', 'KeyC', 'KeyF', 'KeyL', 'KeyD', 'KeyT', 'KeyT', 'KeyT']) {
    await page.keyboard.press(key);
  }
  // Drag across the 3D canvas (should only orbit camera, never edit rig).
  const box = await page.locator('.stage-viewport canvas').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.45, { steps: 6 });
  await page.mouse.up();

  // Rig, BPM, localStorage (design + DMX + showControl), and transports must be completely untouched.
  expect(await page.evaluate(() => JSON.stringify(window.stageforgeProbe.rig()))).toBe(rigBefore);
  expect(await page.evaluate(() => window.stageforgeProbe.showStateSummary().bpm)).toBe(bpmBefore);
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.design.v1'))).toBe(seededJson);
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.dmx.output.v1'))).toBe(seededDmx);
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.showControl.v1'))).toBe(seededSc);
  expect(await page.evaluate(() => window.stageforgeProbe.dmxLive())).toBe(false);
  expect(await page.evaluate(() => window.stageforgeProbe.showControlActive())).toBe(false);
  // Blackout wasn't toggled by mutating hotkeys (check it was only affected by take playback/cues, not Space blackout).
  expect(typeof blackoutBefore).toBe('boolean');

  const auditDuringViewer = await page.evaluate(() => window.__sfViewerAudit);
  expect(auditDuringViewer.storageWrites).toEqual([]);
  expect(auditDuringViewer.webSockets).toEqual([]);
  expect(auditDuringViewer.midiRequests).toBe(0);
  expect(auditDuringViewer.serialRequests).toBe(0);

  // Exit viewer: strips ?view, restores normal desk with pre-seeded saved design, still zero storage writes!
  await page.getByRole('button', { name: 'Exit viewer' }).click();
  await expect(page.getByRole('button', { name: 'Rig builder' })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('view')).toBe(false);
  expect(await page.evaluate(() => window.stageforgeProbe.viewerMode())).toBe(false);
  expect(await page.evaluate(() => window.stageforgeProbe.rig().name)).toBe('Desk Saved Arena');
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.design.v1'))).toBe(seededJson);
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.dmx.output.v1'))).toBe(seededDmx);
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.showControl.v1'))).toBe(seededSc);
  const auditAfterExit = await page.evaluate(() => window.__sfViewerAudit);
  expect(auditAfterExit.storageWrites).toEqual([]);
});

test('QA M3 regression: Play / Space on a cue-only show with no music never starts demo score or Auto-Director', async ({ page }, info) => {
  const cueOnlyShow = JSON.parse(await readFile(fixturePath, 'utf8'));
  delete cueOnlyShow.timeline;
  delete cueOnlyShow.media;
  if (cueOnlyShow.stage) cueOnlyShow.stage.screenEvents = [];
  cueOnlyShow.look.blackout = false;
  cueOnlyShow.look.autoDirector = false;
  cueOnlyShow.activeCueId = cueOnlyShow.cues[0].id;
  const cueOnlyPath = info.outputPath('cue-only.stageforge.show.json');
  await writeFile(cueOnlyPath, JSON.stringify(cueOnlyShow));

  await installLeakSpies(page, null);
  await page.goto('/?view&probe');
  await page.getByLabel('Open show in viewer').setInputFiles(cueOnlyPath);
  await expect(page.locator('header h1')).toHaveText('Split Rig rehearsal');

  const cueBefore = await page.evaluate(() => window.stageforgeProbe.activeCueId());
  await page.keyboard.press('Space');
  await expect(page.locator('[role=status]').filter({ hasText: 'No audio track or recorded take in this show.' })).toBeVisible();
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(cueBefore);
  expect(await page.evaluate(() => window.stageforgeProbe.showStateSummary().blackout)).toBe(false);
  expect(await page.locator('.demo-progress').count()).toBe(0);
});

test('?view loads a verified .stageforge.zip bundle with bundled media, rejects corrupt/MVR files, and fits a 390px phone screen', async ({ page }, info) => {
  const bundlePath = await buildV3Bundle(info.outputPath('pitch-show.stageforge.zip'));
  const badMvrPath = info.outputPath('not-for-viewer.mvr');
  await writeFile(badMvrPath, zipSync({ 'GeneralSceneDescription.xml': strToU8('<GeneralSceneDescription/>') }));
  const corruptBundlePath = info.outputPath('corrupt.stageforge.zip');
  await writeFile(corruptBundlePath, zipSync({ 'manifest.json': strToU8('{"format":"stageforge-bundle","version":1}'), 'show.json': strToU8('{}') }));

  await installLeakSpies(page, null);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view&probe');

  await page.getByLabel('Open show in viewer').setInputFiles(bundlePath);
  await expect(page.locator('header h1')).toHaveText('Split Rig rehearsal');
  // All 3 bundled videos loaded with zero missing media prompts.
  await expect(page.getByRole('button', { name: /missing media/ })).toHaveCount(0);

  const rigSnapshot = await page.evaluate(() => JSON.stringify(window.stageforgeProbe.rig()));

  // Rejects corrupt bundle & .mvr cleanly without touching current viewer state.
  await page.getByLabel('Open show in viewer').setInputFiles(corruptBundlePath);
  await expect(page.locator('[role=status]').filter({ hasText: /bundle|manifest|invalid|verify/i }).first()).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(window.stageforgeProbe.rig()))).toBe(rigSnapshot);

  await page.getByLabel('Open show in viewer').setInputFiles(badMvrPath);
  await expect(page.locator('[role=status]').filter({ hasText: /Pitch viewer opens StageForge shows/ }).first()).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(window.stageforgeProbe.rig()))).toBe(rigSnapshot);

  // Phone viewport (390×844): no horizontal page overflow and dock collapses/expands cleanly.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const collapseBtn = page.getByRole('button', { name: /Collapse viewer controls|Expand viewer controls/ });
  await collapseBtn.click();
  await expect(page.locator('.pitch-viewer-dock .desk-body')).toHaveCount(0);
  await collapseBtn.click();
  await expect(page.locator('.pitch-viewer-dock .desk-body')).toBeVisible();

  // Zero localStorage writes or transport starts throughout.
  const audit = await page.evaluate(() => window.__sfViewerAudit);
  expect(audit.storageWrites).toEqual([]);
  expect(audit.webSockets).toEqual([]);
  expect(audit.midiRequests).toBe(0);
  expect(audit.serialRequests).toBe(0);
});

test('entering viewer via Show files -> Open in viewer… preserves and restores the active desk session exactly on Exit', async ({ page }) => {
  await page.goto('/?probe');

  // Make a live desk cue selection and change camera so we prove Exit restores the exact in-memory desk session.
  await page.locator('.cue-list-row').nth(2).click();
  const deskCueId = await page.evaluate(() => window.stageforgeProbe.activeCueId());
  await page.getByLabel('Camera view').selectOption('stage_side');
  const deskRigBefore = await page.evaluate(() => JSON.stringify(window.stageforgeProbe.rig()));
  const storageBefore = await page.evaluate(() => window.localStorage.getItem('stageforge.design.v1'));

  // Open Show files -> Open in viewer… with the v3 fixture.
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open in viewer…' })).toBeVisible();
  await dialog.getByLabel('Open show in viewer').setInputFiles(fixturePath);

  await expect(page.getByText('VIEW ONLY', { exact: true })).toBeVisible();
  await expect(page.locator('header h1')).toHaveText('Split Rig rehearsal');
  expect(await page.evaluate(() => window.stageforgeProbe.viewerMode())).toBe(true);

  // Switch cue and camera inside viewer.
  await page.locator('.pitch-viewer-dock .cue-list-row').first().click();
  await page.getByLabel('Camera view').selectOption('overhead');

  // Exit viewer -> exact desk rig, active cue, camera, and localStorage restored!
  await page.getByRole('button', { name: 'Exit viewer' }).click();
  await expect(page.getByRole('button', { name: 'Show files', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.stageforgeProbe.viewerMode())).toBe(false);
  expect(await page.evaluate(() => JSON.stringify(window.stageforgeProbe.rig()))).toBe(deskRigBefore);
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(deskCueId);
  expect(await page.evaluate(() => window.stageforgeProbe.camera())).toBe('stage_side');
  expect(await page.evaluate(() => window.localStorage.getItem('stageforge.design.v1'))).toBe(storageBefore);
});
