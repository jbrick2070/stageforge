import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { p2Rehearsal, schema } from '../support/p2-rehearsal.mjs';

const key = 'stageforge.design.v1';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const files = page => page.getByRole('dialog', { name: 'Show files', exact: true });
const monitor = page => page.getByRole('complementary', { name: 'DMX monitor', exact: true });
const showPayload = show => ({ name: 'p2.stageforge.show.json', buffer: Buffer.from(JSON.stringify(show)), mimeType: 'application/json' });
const savedRaw = page => page.evaluate(storageKey => localStorage.getItem(storageKey), key);

async function exportOpenShow(page) {
  const downloading = page.waitForEvent('download');
  await button(files(page), 'Save show JSON').press('Enter');
  return JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
}

async function openShow(page, show, viewer = false) {
  await button(page, 'Show files').press('Enter');
  await files(page).getByLabel(viewer ? 'Open show in viewer' : 'Open show file').setInputFiles(showPayload(show));
  await expect(files(page)).toBeHidden();
}

async function openRigBuilder(page) {
  await button(page, 'Rig builder').press('Enter');
  return page.locator('aside').filter({ hasText: 'LOAD VENUE & RIG PRESET' });
}

function legacyShow() {
  const show = p2Rehearsal();
  show.version = 6;
  show.$schema = schema(6);
  show.rig.trussPods[0].fixtures = show.rig.trussPods[0].fixtures.slice(0, 2);
  show.rig.floorFx = [];
  return show;
}

test('P2 opens and saves three equal addresses, monitors extended SIM and clears it immediately on blackout', async ({ page }) => {
  await page.goto('/?probe');
  const show = p2Rehearsal();
  await openShow(page, show);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.simulatedDmxSnapshot()[3]?.[2])).toBeGreaterThan(5);
  const readBuffers = () => page.evaluate(() => {
    const p = window.stageforgeProbe;
    return { legacy: p.dmxSnapshot(), extended: p.simulatedDmxSnapshot(), physical: p.physicalDmxSnapshot() };
  });
  const initial = await readBuffers();
  expect(initial.extended[3][22]).toBeGreaterThan(5);
  expect(initial.extended[3][100]).toBeGreaterThan(5);
  expect(initial.extended[16][511]).toBeGreaterThan(5);
  expect(initial.physical.u2.slice(0, 3).some(Boolean)).toBe(true);

  await button(page, 'DMX monitor').press('Enter');
  const drawer = monitor(page);
  await drawer.getByLabel('Extended DMX universe').selectOption('3');
  await button(drawer, 'PATCH').press('Enter');
  const beams = drawer.locator('details').filter({ hasText: 'Sharpy Vector ×2' });
  await beams.locator('summary').press('Enter');
  await expect(beams.getByTestId('dmx-patch-unit')).toHaveText([
    '#1 · U3.001–020 · Patch valid', '#2 · U3.021–040 · Patch valid',
  ]);
  await drawer.getByTestId('dmx-monitor-mode-phys').press('Enter');
  await expect(drawer.getByText('U3 is unavailable on current physical transports.')).toBeVisible();
  await drawer.getByLabel('Extended DMX universe').selectOption('4');
  await expect(drawer.getByText('U4 has no patch.')).toBeVisible();
  await button(drawer, 'Close DMX monitor').press('Enter');

  const immediate = await page.evaluate(() => {
    document.body.focus();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    const p = window.stageforgeProbe;
    return { u1: p.dmxSnapshot().u1, extended: p.simulatedDmxSnapshot() };
  });
  expect(immediate.u1.some(Boolean)).toBe(false);
  expect(immediate.extended[3].some(Boolean)).toBe(false);
  expect(immediate.extended[16].some(Boolean)).toBe(false);
  const heldTick = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.stepAndReadLuminance(16);
    return [p.dmxSnapshot().u1, p.simulatedDmxSnapshot()[3]].map(bytes => bytes.slice(0, 3).map(Boolean));
  });
  expect(heldTick).toEqual([[true, true, false], [true, true, false]]);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await readBuffers()).extended[3][2]).toBeGreaterThan(5);

  const conflicting = structuredClone(show);
  conflicting.rig.trussPods[0].fixtures.push({ ...show.rig.trussPods[0].fixtures[2], id: 'conflict', count: 1 });
  await openShow(page, conflicting);
  await expect.poll(async () => (await readBuffers()).extended[3][22]).toBeGreaterThan(5);
  const afterConflict = await readBuffers();
  expect(afterConflict.extended[3].slice(0, 20).some(Boolean)).toBe(false);
  expect(afterConflict.legacy.u2.slice(0, 3)).toEqual(initial.legacy.u2.slice(0, 3));
  expect(afterConflict.physical.u2.slice(0, 3)).toEqual(initial.physical.u2.slice(0, 3));

  await openShow(page, show);
  await button(page, 'Show files').press('Enter');
  await expect(button(files(page), 'Rig only JSON')).toBeDisabled();
  await expect(files(page).getByText(/This design uses U3–U16/)).toBeVisible();
  const exported = await exportOpenShow(page);
  expect(exported.version).toBe(15);
  expect(exported.rig.trussPods[0].fixtures.map(item => [item.dmxUniverse, item.dmxStartChannel])).toEqual([[1, 1], [2, 1], [3, 1]]);
  await button(files(page), 'Close Show files').press('Enter');
  const storageBeforeViewer = await savedRaw(page);
  await openShow(page, exported, true);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.viewerMode())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.simulatedDmxSnapshot()[3]?.[2])).toBeGreaterThan(5);
  expect(await savedRaw(page)).toBe(storageBeforeViewer);
});

test('P2 adopts fixture edits after a protected Show open and atomically recovers a local draft after a failed pagehide save', async ({ page }) => {
  const legacy = legacyShow().rig;
  await page.addInitScript(({ key, legacy }) => {
    if (!sessionStorage.getItem('seeded-p2')) {
      localStorage.setItem(key, JSON.stringify(legacy));
      sessionStorage.setItem('seeded-p2', '1');
    }
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key && window.failP2Write) throw new DOMException('Quota', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  }, { key, legacy });
  await page.goto('/?probe');
  const before = await savedRaw(page);
  const show = p2Rehearsal();
  const authored = JSON.parse(await readFile(new URL('../fixtures/native-authoring-v3.stageforge.show.json', import.meta.url), 'utf8'));
  show.rig.name = 'Edited local draft';
  show.stage = authored.stage;
  show.timeline = { durationMs: 16000, events: [{ ...authored.timeline.events[0], cueId: 'steady', look: show.look }] };
  show.media = authored.media;
  await openShow(page, show);
  expect(await savedRaw(page)).toBe(before);
  const builder = await openRigBuilder(page);
  await button(builder, 'Open saved design').press('Enter');
  const plan = page.getByRole('dialog', { name: 'Stage designer', exact: true });
  await button(plan, 'Cancel').press('Enter');
  await expect(plan).toBeHidden();
  await expect(builder.getByText('Edited local draft', { exact: true })).toBeVisible();
  expect(await savedRaw(page)).toBe(before);
  await page.evaluate(() => { window.failP2Write = true; });
  await builder.getByLabel('DMX universe for Wash One on Main truss').selectOption('4');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await savedRaw(page)).toBe(before);
  await button(builder, 'Close Rig Builder').press('Enter');
  await button(page, 'Show files').press('Enter');
  await expect(files(page).getByText(/previous save remains intact/)).toBeVisible();
  const beforeDecline = await exportOpenShow(page);
  expect(beforeDecline.cues).toHaveLength(1);
  expect(beforeDecline.timeline.events).toHaveLength(1);
  expect(beforeDecline.media.music.name).toBe('Arena Anthem');
  const confirmation = page.waitForEvent('dialog');
  const attemptingRestore = button(files(page), 'Restore saved design').press('Enter');
  const dialog = await confirmation;
  const declinedMessage = dialog.message();
  await dialog.dismiss();
  await attemptingRestore;
  expect(declinedMessage).toContain('clears the current cue list, take and show media assignments');
  expect(declinedMessage).toContain('The unsaved local design waiting to be saved will be discarded.');
  await expect(button(files(page), 'Retry local design save')).toBeEnabled();
  expect(await savedRaw(page)).toBe(before);
  expect(await exportOpenShow(page)).toEqual(beforeDecline);
  await page.evaluate(() => { window.failP2Write = false; });
  await button(files(page), 'Retry local design save').press('Enter');
  const record = JSON.parse(await savedRaw(page));
  expect(record.current.rig.trussPods[0].fixtures[0].dmxUniverse).toBe(4);
  expect(record.current.stage.screenEvents).toEqual(show.stage.screenEvents);
  expect(record.previous.rig).toEqual(legacy);

  await page.reload();
  await button(page, 'Show files').press('Enter');
  await expect(files(page).getByText('Edited local draft', { exact: true })).toBeVisible();
  await expect(files(page).getByText(/Files to relink:.*blue-raster\.mp4/)).toBeVisible();
  await expect(files(page).getByText(/Recorded actions.*5 events/)).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await button(files(page), 'Restore previous design').press('Enter');
  await expect(files(page)).toBeHidden();
  const restored = JSON.parse(await savedRaw(page));
  expect(restored.current.rig.name).toBe(legacy.name);
  expect(restored.previous.rig.name).toBe('Edited local draft');
});

async function installMockDmx(page, order) {
  await page.addInitScript(order => {
    let listener;
    let running;
    let resolveGo;
    let resolveScan;
    const idle = { state: 'idle', enabled: false, protocol: 'sacn', iface: '127.0.0.1', rateHz: 40, measuredHz: 0,
      packetsSent: 0, degraded: false, lastError: null, universes: [3, 4], nodes: [] };
    const audit = { actions: [], frames: 0 };
    window.p2Output = {
      audit,
      publish: () => listener?.(running),
      reply: () => resolveGo?.(running),
      publishStarting: () => listener?.({ ...idle, state: 'starting', authority: running.authority }),
      finishScan: () => {
        listener?.({ ...idle, state: 'starting', authority: running.authority });
        resolveScan?.({ nodes: [], warning: null });
      },
    };
    window.stageforgeDesktop = {
      onRigCommand: () => () => {},
      onDmxStatus: callback => { listener = callback; return () => { listener = undefined; }; },
      setDmxEligibility: async ({ authority, eligible }) => { audit.actions.push({ type: 'eligibility', authority, eligible }); return true; },
      outputClaim: async action => { audit.actions.push(action); return { ok: true, reason: null }; },
      sendDmxFrame: () => { audit.frames++; return true; },
      sendDmxHeartbeat: () => true,
      dmxControl: async ({ type, authority }) => {
        if (type === 'listInterfaces') return [{ name: 'Loopback', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: null, internal: true }];
        if (type === 'getStatus') return idle;
        audit.actions.push({ type, authority });
        if (type === 'disable') return { ...idle, authority: running?.authority };
        if (type === 'discover') return new Promise(resolve => { resolveScan = resolve; });
        running = { ...idle, state: 'running', enabled: true, authority };
        if (order === 'reply-first') return running;
        return new Promise(resolve => { resolveGo = resolve; });
      },
    };
  }, order);
}

async function openPreflight(page, transport = 'sacn') {
  await button(page, 'DMX monitor').press('Enter');
  await page.getByTestId('dmx-advanced-summary').press('Enter');
  await page.getByTestId(`dmx-output-mode-${transport}`).press('Enter');
  await page.getByTestId('topbar-preflight-badge').press('Enter');
  const panel = page.getByTestId('preflight-panel');
  await panel.getByTestId('preflight-run-check').press('Enter');
  for (const box of await panel.locator('input[data-testid^="preflight-ack-"]').all()) if (!await box.isChecked()) await box.check();
  return panel;
}

test('P2 authored extended patch hard-blocks both existing transports before their mock claim or chooser', async ({ page }) => {
  await installMockDmx(page, 'reply-first');
  await page.goto('/?probe');
  await openShow(page, p2Rehearsal());
  const panel = await openPreflight(page);
  await expect(panel.getByText(/Logical U3 is unsupported/).first()).toBeVisible();
  await button(panel, 'Done').press('Enter');
  await expect(page.getByTestId('dmx-output-arm')).toBeDisabled();
  await page.getByTestId('dmx-output-mode-serial').press('Enter');
  await expect(page.getByTestId('dmx-output-arm')).toBeDisabled();
  expect(await page.evaluate(() => window.p2Output.audit.actions)).toEqual([]);
});

for (const order of ['push-first', 'reply-first', 'pending-revocation']) {
  test(`P2 network authority survives ${order} only while its exact Go claim is current`, async ({ page }) => {
    await installMockDmx(page, order);
    await page.goto('/?probe');
    await openShow(page, legacyShow());
    const panel = await openPreflight(page, order === 'push-first' ? 'artnet' : 'sacn');
    await expect(panel.getByTestId('preflight-eligibility')).toContainText('Eligible to arm');
    await button(panel, 'Done').press('Enter');
    if (order === 'push-first') {
      await button(monitor(page), 'Scan').press('Enter');
      await expect(button(monitor(page), 'Scanning…')).toBeVisible();
    }
    await page.getByTestId('dmx-output-arm').press('Enter');
    await page.getByTestId('dmx-output-go-live').press('Enter');
    const audit = () => page.evaluate(() => window.p2Output.audit);
    await expect.poll(async () => (await audit()).actions.some(action => action.type === 'enable')).toBe(true);
    if (order === 'pending-revocation') {
      expect((await audit()).frames).toBe(0);
      const builder = await openRigBuilder(page);
      await builder.getByLabel('DMX universe for Wash One on Main truss').selectOption('3');
      await expect.poll(async () => (await audit()).actions.some(action => action.type === 'disable')).toBe(true);
      await page.evaluate(() => { window.p2Output.publish(); window.p2Output.reply(); });
      await expect(page.getByTestId('live-dmx-badge')).toHaveCount(0);
      expect((await audit()).frames).toBe(0);
      expect((await audit()).actions.some(action => action.type === 'eligibility' && !action.eligible)).toBe(true);
      return;
    }
    if (order === 'push-first') {
      await page.evaluate(() => window.p2Output.finishScan());
      await expect(button(monitor(page), 'Scan')).toBeVisible();
      await expect(page.getByTestId('live-dmx-badge')).toHaveCount(0);
      await page.evaluate(() => window.p2Output.publish());
      await expect(page.getByTestId('live-dmx-badge')).toBeVisible();
      await page.evaluate(() => window.p2Output.publishStarting());
      await expect(page.getByTestId('live-dmx-badge')).toBeVisible();
      await page.evaluate(() => window.p2Output.reply());
    } else {
      await expect(page.getByTestId('live-dmx-badge')).toBeVisible();
      await page.evaluate(() => window.p2Output.publish());
    }
    await expect.poll(async () => (await audit()).actions.some(action => action.type === 'release')).toBe(true);
    const { actions } = await audit();
    const sent = actions.find(action => action.type === 'enable');
    expect(actions.find(action => action.type === 'claim').authority).toEqual(sent.authority);
    expect(actions.find(action => action.type === 'release').authority).toEqual(sent.authority);
    expect(actions.filter(action => action.type === 'disable' || action.eligible === false)).toEqual([]);
    await page.getByTestId('dmx-advanced-summary').press('Enter');
    await expect(page.getByTestId('live-dmx-badge')).toBeVisible();
    expect((await audit()).actions.filter(action => action.type === 'disable' || action.eligible === false)).toEqual([]);
    await page.getByTestId('dmx-output-stop').press('Enter');
    await expect.poll(async () => (await audit()).actions.filter(action => action.type === 'disable').length).toBe(1);
  });
}

test('P2 browser Web Serial keeps the live lease when Advanced collapses and stops with the final black frame', async ({ page }) => {
  await page.addInitScript(() => {
    const audit = { bytes: [], chooser: 0, opened: 0, closed: 0 };
    window.p2Serial = audit;
    const port = {
      writable: new WritableStream({ write: bytes => audit.bytes.push(Array.from(bytes.slice(5, 8))) }),
      open: async () => { audit.opened++; }, close: async () => { audit.closed++; },
    };
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => { audit.chooser++; return port; } } });
  });
  await page.goto('/?probe');
  await openShow(page, legacyShow());
  const panel = await openPreflight(page, 'serial');
  await expect(panel.getByTestId('preflight-eligibility')).toContainText('Eligible to arm');
  await button(panel, 'Done').press('Enter');
  await page.getByTestId('dmx-output-arm').press('Enter');
  await page.getByTestId('dmx-output-go-live').press('Enter');
  const read = () => page.evaluate(() => window.p2Serial);
  await expect.poll(async () => (await read()).bytes.find(sample => sample.some(Boolean))).toBeTruthy();
  const lit = (await read()).bytes.at(-1);
  await page.getByTestId('dmx-advanced-summary').press('Enter');
  await expect(page.getByTestId('live-dmx-badge')).toBeVisible();
  await page.evaluate(() => window.stageforgeProbe.patchShowState({ masterDimmer: 0.25 }));
  await expect.poll(async () => (await read()).bytes.at(-1)).not.toEqual(lit);
  expect(await read()).toMatchObject({ chooser: 1, opened: 1, closed: 0 });
  await page.getByTestId('dmx-output-stop').press('Enter');
  await expect.poll(async () => (await read()).closed).toBe(1);
  expect((await read()).bytes.at(-1)).toEqual([0, 0, 0]);
});

test('P2 preserves corrupt and newer local drafts through editing and pagehide', async ({ page }) => {
  for (const [raw, notice] of [
    ['broken draft JSON', /local design is unreadable/],
    [JSON.stringify({ format: 'stageforge-local-design', version: 91 }), /saved by a newer version/],
  ]) {
    await page.goto('/?probe');
    await page.evaluate(([raw, key]) => localStorage.setItem(key, raw), [raw, key]);
    await page.reload();
    await openShow(page, p2Rehearsal());
    const builder = await openRigBuilder(page);
    await builder.getByLabel('DMX universe for Wash One on Main truss').selectOption('4');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(await savedRaw(page)).toBe(raw);
    await button(builder, 'Close Rig Builder').press('Enter');
    await button(page, 'Show files').press('Enter');
    await expect(files(page).getByText(notice)).toBeVisible();
  }
});
