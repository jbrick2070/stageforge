import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { P4_CAMERA, p4Rehearsal } from '../support/p4-rehearsal.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const files = page => page.getByRole('dialog', { name: 'Show files', exact: true });
const monitor = page => page.getByRole('complementary', { name: 'DMX monitor', exact: true });
const source = page => page.getByLabel('Level source', { exact: true });
const sourceStatus = page => page.getByTestId('level-source-status');

async function mockP3(page) {
  await page.addInitScript(() => {
    let statusListener, batchListener, session, older;
    let delay = 0;
    const ack = [];
    const commands = [];
    const drops = { invalid: 0, unselected: 0, unmapped: 0, sequence: 0 };
    const status = (phase, error = null) => ({
      authority: session.authority, anchorMs: session.anchor, phase, error, port: phase === 'listening' ? 6454 : null,
    });
    window.stageforgeDesktop = {
      onRigCommand: () => () => {},
      onArtNetInputStatus: listener => { statusListener = listener; return () => { statusListener = undefined; }; },
      onArtNetInputBatch: listener => { batchListener = listener; return () => { batchListener = undefined; }; },
      ackArtNetInput(payload) { ack.push(payload); return true; },
      async artNetInput(command) {
        commands.push(command.type);
        if (command.type === 'listInterfaces') return [];
        if (command.type === 'document' || command.type === 'stop') {
          if (session) {
            statusListener?.(status('stopping'));
            statusListener?.(status('off'));
            older = session;
            session = undefined;
          }
          return true;
        }
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const now = performance.now();
        session = { authority: command.authority, anchor: 50_000 + now, started: now,
          mappings: command.config.mappings, sequences: {}, id: 0 };
        statusListener?.(status('starting'));
        statusListener?.(status('listening'));
        return status('listening');
      },
    };
    window.p4Input = {
      ack, commands,
      setDelay(ms) { delay = ms; },
      fail() {
        if (!session) return;
        statusListener?.(status('off', 'test receiver error'));
        older = session;
        session = undefined;
      },
      emit(values, options = {}) {
        const active = options.older ? older : session;
        if (!active) throw new Error('No input session for test packet');
        const sentAtMs = active.anchor + (performance.now() - active.started);
        const rows = Object.entries(values).map(([key, slots]) => {
          const universe = Number(key);
          const data = new Uint8Array(512);
          data.set(slots);
          const row = active.mappings.find(item => item.universe === universe);
          active.sequences[universe] = (active.sequences[universe] ?? 0) + 1;
          const age = options.age ?? 0;
          return { ...row, state: 'active', data, sampleSeq: active.sequences[universe], received: 0xffffffff,
            lost: 0, ageMs: age, sampleAtMs: sentAtMs - age, ...options.override };
        });
        batchListener?.({ authority: active.authority, batchId: ++active.id, sentAtMs, rows, drops });
      },
    };
  });
}

async function openShow(page, show) {
  await button(page, 'Show files').press('Enter');
  await files(page).getByLabel('Open show file').setInputFiles({
    name: 'p4.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(show)),
  });
  await expect(files(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.rig().name)).toBe(show.rig.name);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.patchOccupancy('resolved').units.filter(unit => unit.groupId === 'preview-blinders').length)).toBe(2);
  await page.evaluate(camera => {
    window.stageforgeProbe.setRenderSettings({ bloom: 'half', trueColour: false });
    window.stageforgeProbe.setCameraPose(...camera);
  }, P4_CAMERA);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.renderStats().bloomActive)).toBe(true);
}

async function openInput(page) {
  await button(page, 'DMX monitor').press('Enter');
  await button(monitor(page), 'Art-Net input').press('Enter');
  return monitor(page).getByRole('region', { name: 'Art-Net input monitor', exact: true });
}

const emit = (page, values, options) => page.evaluate(([rows, args]) => window.p4Input.emit(rows, args), [values, options]);

async function frame(page, count = 1, dt = 20) {
  return page.evaluate(([count, dt]) => {
    const p = window.stageforgeProbe;
    for (let index = 0; index < count; index++) p.stepAndReadLuminance(dt);
    const lens = p.blinderLensPixels();
    const output = { legacy: p.dmxSnapshot(), extended: p.simulatedDmxSnapshot(), physical: p.physicalDmxSnapshot(), serial: p.serialDmxSnapshot() };
    return { pixels: lens, levels: lens.map(unit => Math.max(...unit.lenses.map(p => p.luminance))), output,
      cue: p.activeCueId(), take: p.takeState().mode, live: p.dmxLive(), showControl: p.showControlActive() };
  }, [count, dt]);
}

async function freezeAfterFirstFrame(page, show) {
  await page.clock.install();
  await page.goto('/?probe');
  await openShow(page, show);
  await expect.poll(async () => (await frame(page)).pixels.filter(unit => unit.lenses.length > 0).length).toBe(show.rig.trussPods[0].fixtures.reduce((n, group) => n + group.count, 0));
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 500);
}
const contrast = 0.07;

test('P4 Art-Net External Levels renders independently while Desk buffers and cue ownership remain separate', async ({ page }, info) => {
  test.setTimeout(120_000);
  await mockP3(page);
  const show = p4Rehearsal();
  await freezeAfterFirstFrame(page, show);
  const initial = await frame(page, 4, 250);
  expect(initial.take).toBe('idle');
  expect(initial.pixels.map(unit => unit.address)).toEqual([{ universe: 3, start: 1 }, { universe: 3, start: 2 }]);
  expect(initial.output.physical.u1.slice(0, 3).some(Boolean)).toBe(true);
  expect(initial.output.serial.u2.slice(0, 3).some(Boolean)).toBe(true);
  await expect(source(page)).toHaveValue('desk');
  await expect(source(page).locator('option[value="external"]')).toBeDisabled();
  const rx = await openInput(page);
  await button(rx, 'Start listening').press('Enter');
  await page.clock.runFor(20);
  await emit(page, { 3: [0, 255] });
  await expect(rx.getByTestId('artnet-input-slot-1')).toHaveAttribute('aria-label', 'U3.001: 0');
  await expect(rx.getByTestId('artnet-input-slot-2')).toHaveAttribute('aria-label', 'U3.002: 255');
  const monitorOnly = await frame(page, 3, 250);
  monitorOnly.levels.forEach((level, index) => expect(Math.abs(level - initial.levels[index])).toBeLessThan(0.01));
  expect(monitorOnly.output).toEqual(initial.output);

  await source(page).selectOption('external');
  const right = await frame(page, 3, 250);
  expect(right.levels[1] - right.levels[0]).toBeGreaterThan(contrast);
  expect(right.output).toEqual(initial.output);
  await emit(page, { 3: [255, 0] });
  const left = await frame(page, 3, 250);
  expect(left.levels[0] - left.levels[1]).toBeGreaterThan(contrast);
  expect(left.output).toEqual(initial.output);

  await button(monitor(page), 'Close DMX monitor').press('Enter');
  await expect(sourceStatus(page)).toContainText('receiving');
  await button(page, 'Show cues').press('Enter');
  await page.getByRole('button', { name: /^Cue 2, Desk full,/ }).press('Enter');
  const cued = await frame(page, 3, 250);
  expect(cued.cue).toBe('warm');
  expect(cued.take).toBe('idle');
  expect(cued.showControl).toBe(initial.showControl);
  expect(cued.levels[0] - cued.levels[1]).toBeGreaterThan(contrast);
  expect(cued.output.extended[3].slice(0, 2)).toEqual([255, 255]);
  await page.clock.fastForward(3001);
  await expect(sourceStatus(page)).toContainText('stale');
  const expired = await frame(page);
  expect(expired.levels[0]).toBeLessThan(cued.levels[0] - contrast);
  expect(expired.output).toEqual(cued.output);
  await emit(page, { 3: [0, 255] });
  await frame(page, 3, 250);
  const reconnected = await frame(page);
  expect(reconnected.levels[1] - reconnected.levels[0]).toBeGreaterThan(contrast);
  const reopened = await openInput(page);
  await button(reopened, 'Stop listening').press('Enter');
  await expect(source(page)).toHaveValue('desk');
  const firstDeskFrame = await frame(page, 1, 1);
  expect(firstDeskFrame.levels[1]).toBeGreaterThan(reconnected.levels[1] - contrast / 2);
  expect(firstDeskFrame.levels[0]).toBeLessThan(firstDeskFrame.levels[1] - contrast);
  const settled = await frame(page, 7, 250);
  expect(settled.levels[0]).toBeGreaterThan(firstDeskFrame.levels[0] + contrast);
  expect(settled.output).toEqual(cued.output);
  expect(settled.live).toBe(false);
  await button(monitor(page), 'Close DMX monitor').press('Enter');

  await button(page, 'Show files').press('Enter');
  const downloadPromise = page.waitForEvent('download');
  await button(files(page), 'Save show JSON').press('Enter');
  const saved = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
  expect(saved.cues).toEqual(show.cues);
  expect(saved.rig.trussPods[0].fixtures).toEqual(show.rig.trussPods[0].fixtures);
  expect(saved.look.blinderLevel).toBe(1);
  expect(saved.activeCueId).toBe('warm');
  expect(saved).not.toHaveProperty('artNetInput');
  expect(saved).not.toHaveProperty('levelSource');
  await button(files(page), 'Close Show files').press('Enter');
  await openShow(page, saved);
  await expect(source(page)).toHaveValue('desk');
  await expect(sourceStatus(page)).toContainText('off');
  expect(await page.evaluate(() => window.p4Input.commands.filter(type => type === 'start').length)).toBe(1);
  await info.attach('p4-post-bloom-lenses', { body: JSON.stringify({ initial: initial.pixels, right: right.pixels, left: left.pixels,
    expired: expired.pixels, firstDeskFrame: firstDeskFrame.pixels, settled: settled.pixels }), contentType: 'application/json' });
});

test('P4 delayed Start and malformed preview timing leave monitor ACKs intact and recover only on a fresh authority', async ({ page }) => {
  await mockP3(page);
  await freezeAfterFirstFrame(page, p4Rehearsal());
  const rx = await openInput(page);
  await page.evaluate(() => window.p4Input.setDelay(3100));
  await button(rx, 'Start listening').press('Enter');
  await source(page).selectOption('external');
  await page.clock.fastForward(3100);
  await expect(sourceStatus(page)).toHaveText('Preview timing unavailable. Stop and restart Art-Net input.');
  await emit(page, { 3: [0, 255] });
  await expect(rx.getByTestId('artnet-input-slot-2')).toHaveAttribute('aria-label', 'U3.002: 255');
  const denied = await frame(page, 3, 250);
  expect(Math.abs(denied.levels[0] - denied.levels[1])).toBeLessThan(contrast);
  expect(await page.evaluate(() => window.p4Input.ack.length)).toBe(1);
  await source(page).selectOption('desk');
  await expect(source(page).locator('option[value="external"]')).toBeDisabled();
  await button(rx, 'Stop listening').press('Enter');
  await page.evaluate(() => window.p4Input.setDelay(0));
  await button(rx, 'Start listening').press('Enter');
  await source(page).selectOption('external');
  await page.clock.runFor(30);
  await emit(page, { 3: [0, 255] }, { older: true });
  expect(await page.evaluate(() => window.p4Input.ack.length)).toBe(1);
  await emit(page, { 3: [0, 255] }, { override: { sampleAtMs: null } });
  expect(await page.evaluate(() => window.p4Input.ack.length)).toBe(2);
  const invalid = await frame(page, 3, 250);
  expect(Math.abs(invalid.levels[0] - invalid.levels[1])).toBeLessThan(contrast);
  await emit(page, { 3: [0, 255] });
  const recovered = await frame(page, 3, 250);
  expect(recovered.levels[1] - recovered.levels[0]).toBeGreaterThan(contrast);
  await page.evaluate(() => window.p4Input.fail());
  await expect(source(page)).toHaveValue('external');
  await expect(sourceStatus(page)).toContainText('receiver error');
  const failed = await frame(page);
  expect(failed.levels[1]).toBeLessThan(recovered.levels[1] - contrast);
});

test('P4 Reduced renders anti-phase input within the shared flash ceiling and honors blackout', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockP3(page);
  await freezeAfterFirstFrame(page, p4Rehearsal());
  const rx = await openInput(page);
  await button(rx, 'Start listening').press('Enter');
  await source(page).selectOption('external');
  await page.clock.runFor(20);
  const wins = [];
  let last = [false, false];
  for (let i = 0; i < 39; i++) {
    await emit(page, { 3: i % 2 ? [0, 255] : [255, 0] });
    const sample = await frame(page, 1, 50);
    const visible = sample.levels.map((value, j) => value - sample.levels[1 - j] > contrast);
    if (visible.some((value, j) => value && !last[j])) wins.push({ at: i * 50, visible });
    last = visible;
  }
  expect(wins.length).toBeGreaterThanOrEqual(2);
  expect(wins.every(hit => wins.filter(other => other.at >= hit.at && other.at < hit.at + 1000).length <= 3)).toBe(true);
  await button(monitor(page), 'Close DMX monitor').press('Enter');
  await emit(page, { 3: [0, 255] });
  const lit = await frame(page, 4, 250);
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })));
  const blackout = await frame(page, 1, 1);
  expect(blackout.levels[1]).toBeLessThan(lit.levels[1] - contrast);
  await info.attach('p4-reduced-lens-edges', { body: JSON.stringify(wins), contentType: 'application/json' });
});

test('P4 a co-timed full-rate Desk sibling cannot exempt a newly External lens from its local history', async ({ page }) => {
  await mockP3(page);
  await freezeAfterFirstFrame(page, p4Rehearsal({ sibling: true }));
  const rx = await openInput(page);
  await button(rx, 'Start listening').press('Enter');
  await page.clock.runFor(25);
  const desk = level => page.evaluate(value => {
    window.stageforgeProbe.setFullRateStrobePreview(true);
    window.stageforgeProbe.patchShowState({ blinderLevel: value });
  }, level);
  await desk(1);
  const full = await frame(page);
  await desk(0);
  const dark = await frame(page);
  expect(full.levels[0] - dark.levels[0]).toBeGreaterThan(contrast);
  const stock = full.pixels.findIndex(unit => unit.address === null);
  expect(stock).toBeGreaterThanOrEqual(0);
  await source(page).selectOption('external');
  await emit(page, { 3: [255, 0] });
  await desk(1);
  const coTimed = await frame(page);
  expect(coTimed.levels[stock] - dark.levels[stock]).toBeGreaterThan(contrast);
  expect(coTimed.levels[0] - dark.levels[0]).toBeLessThan(contrast);
  const permitted = await frame(page, 3, 250);
  expect(permitted.levels[0] - coTimed.levels[0]).toBeGreaterThan(contrast);
});

test('P4 a live patch and its reversal wait for a fresh frame at the resolved address', async ({ page }) => {
  await mockP3(page);
  await freezeAfterFirstFrame(page, p4Rehearsal());
  const rx = await openInput(page);
  await button(rx, 'Add mapping').press('Enter');
  await rx.getByLabel('Universe mapping 3').selectOption('4');
  await rx.getByLabel('Port-Address mapping 3').fill('3');
  await button(rx, 'Start listening').press('Enter');
  await source(page).selectOption('external');
  await page.clock.runFor(20);
  await emit(page, { 3: [255, 0], 4: [0, 255] });
  const before = await frame(page, 3, 250);
  expect(before.levels[0] - before.levels[1]).toBeGreaterThan(contrast);
  await button(monitor(page), 'Close DMX monitor').press('Enter');
  await button(page, 'Rig builder').press('Enter');
  const universe = page.getByLabel('DMX universe for Preview blinders on Preview truss', { exact: true });
  await universe.selectOption('4');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.patchOccupancy('resolved').units
    .find(unit => unit.groupId === 'preview-blinders').universe)).toBe(4);
  const waiting = await frame(page, 2, 250);
  expect(Math.abs(waiting.levels[0] - waiting.levels[1])).toBeLessThan(contrast);
  await page.clock.runFor(20);
  await emit(page, { 4: [0, 255] });
  const moved = await frame(page, 3, 250);
  expect(moved.levels[1] - moved.levels[0]).toBeGreaterThan(contrast);
  await universe.selectOption('3');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.patchOccupancy('resolved').units
    .find(unit => unit.groupId === 'preview-blinders').universe)).toBe(3);
  const returned = await frame(page, 2, 250);
  expect(Math.abs(returned.levels[0] - returned.levels[1])).toBeLessThan(contrast);
  await page.clock.runFor(20);
  await emit(page, { 3: [255, 0] });
  const fresh = await frame(page, 3, 250);
  expect(fresh.levels[0] - fresh.levels[1]).toBeGreaterThan(contrast);
});
