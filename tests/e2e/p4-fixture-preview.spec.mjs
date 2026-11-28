import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { P4_CAMERA, p4Rehearsal } from '../support/p4-rehearsal.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const files = page => page.getByRole('dialog', { name: 'Show files', exact: true });
const monitor = page => page.getByRole('complementary', { name: 'DMX monitor', exact: true });
const source = page => page.getByRole('combobox', { name: 'Level source', exact: true });
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
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().bloomActive)).toBe(true);
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

function calibratedRoom(dark, lit) {
  const coordinates = sample => sample.room.map(({ x, y }) => [x, y]);
  expect(dark.room.length).toBeGreaterThan(0);
  expect(coordinates(lit)).toEqual(coordinates(dark));
  const deltas = lit.room.map((pixel, index) => pixel.luminance - dark.room[index].luminance);
  const span = Math.max(...deltas);
  const index = deltas.indexOf(span);
  expect(span, 'admitted blinder visibly lights the deck after bloom').toBeGreaterThan(0.004);
  return {
    span,
    read(sample) {
      expect(coordinates(sample)).toEqual(coordinates(dark));
      return sample.room[index].luminance - dark.room[index].luminance;
    },
  };
}

async function readPreview(page, steps = [20]) {
  return page.evaluate(durations => {
    const p = window.stageforgeProbe;
    for (const dt of durations) p.stepAndReadLuminance(dt);
    return p.blinderPreviewPixels();
  }, steps);
}
const lensPeak = unit => Math.max(...unit.lenses.map(pixel => pixel.luminance));

async function firstAdmitted(page, targetLevels) {
  const sample = await page.evaluate(expected => {
    const probe = window.stageforgeProbe;
    let sample;
    // Keep the packet deadline frozen and advance the real preview budget in small ticks.
    for (let i = 0; i < 30; i++) {
      probe.stepAndReadLuminance(80);
      sample = probe.blinderPreviewPixels();
      if (sample.lenses.length === expected.length &&
          sample.lenses.every((unit, j) => unit.deliveredLevel === expected[j])) break;
    }
    return sample;
  }, targetLevels);
  expect(sample.lenses.map(unit => unit.deliveredLevel), 'first admitted frame within 2400 ms of preview time').toEqual(targetLevels);
  return sample;
}

function roomRehearsal() {
  const show = p4Rehearsal();
  show.look.blinderLevel = 1;
  // Keep the projected deck samples free of booth and speaker geometry.
  Object.assign(show.rig.audioRig, { djBooth: false, subWall: false, monitorCount: 0 });
  return show;
}

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
  const reopened = await openInput(page);
  await emit(page, { 3: [0, 255] });
  const reconnected = await firstAdmitted(page, [0, 1]);
  expect(lensPeak(reconnected.lenses[1]) - lensPeak(reconnected.lenses[0])).toBeGreaterThan(contrast);
  await button(reopened, 'Stop listening').press('Enter');
  await expect(source(page)).toHaveValue('desk');
  const firstDeskFrame = await frame(page, 1, 1);
  expect(firstDeskFrame.pixels.map(unit => unit.deliveredLevel)).toEqual([0, 1]);
  firstDeskFrame.levels.forEach((value, index) => {
    expect(Math.abs(value - lensPeak(reconnected.lenses[index]))).toBeLessThan(contrast / 2);
  });
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
    expired: expired.pixels, reconnected: reconnected.lenses, firstDeskFrame: firstDeskFrame.pixels, settled: settled.pixels }), contentType: 'application/json' });
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

test('P4 preheated External lamps and Desk handoff govern the post-bloom lenses and room spill', async ({ page }, info) => {
  test.setTimeout(120_000);
  await mockP3(page);
  await freezeAfterFirstFrame(page, roomRehearsal());
  const rx = await openInput(page);
  await button(rx, 'Start listening').press('Enter');
  await source(page).selectOption('external');
  await page.clock.runFor(20);
  const settle = [250, 250, 250, 250, 250];
  const dark = await readPreview(page, settle);
  await emit(page, { 3: [255, 0] });
  const lit = await readPreview(page, settle);
  expect(lensPeak(lit.lenses[0]) - lensPeak(dark.lenses[0])).toBeGreaterThan(contrast);
  const room = calibratedRoom(dark, lit);
  await emit(page, { 3: [0, 0] });
  await readPreview(page, settle);

  const pulse = [[1, [7, 7]], [21, [255, 7]], [61, [7, 7]], [101, [7, 255]], [141, [7, 7]], [161, [0, 0]]];
  const preheatLevels = [7 / 255, 7 / 255];
  await emit(page, { 3: pulse[0][1] });
  const preheated = await firstAdmitted(page, preheatLevels);
  const trace = await page.evaluate(([program, initial]) => {
    const p = window.stageforgeProbe;
    const result = [{ at: program[0][0], sample: initial }];
    let previousAt = program[0][0];
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const [offset, values] of program.slice(cycle === 0 ? 1 : 0)) {
        const at = cycle * 480 + offset;
        let dt = at - previousAt;
        while (dt > 250) { p.stepAndReadLuminance(250); dt -= 250; }
        window.p4Input.emit({ 3: values });
        p.stepAndReadLuminance(dt);
        result.push({ at, sample: p.blinderPreviewPixels() });
        previousAt = at;
      }
    }
    return result;
  }, [pulse, preheated]);
  const fullRises = trace.filter(({ sample }, index) => {
    const now = room.read(sample);
    const prior = index ? room.read(trace[index - 1].sample) : 0;
    return now - prior > room.span / 2;
  });
  for (const { sample } of [trace[1], trace[3]]) {
    expect(sample.spillLevel).toBeCloseTo(7 / 255);
    expect(sample.lenses.map(unit => unit.deliveredLevel)).toEqual(preheatLevels);
    expect(Math.abs(room.read(sample) - room.read(preheated))).toBeLessThan(room.span / 2);
    sample.lenses.forEach((unit, index) => {
      expect(Math.abs(lensPeak(unit) - lensPeak(preheated.lenses[index]))).toBeLessThan(contrast);
    });
  }
  expect(fullRises.every(({ at }) => fullRises.filter(other => other.at >= at && other.at < at + 1000).length <= 3)).toBe(true);

  await emit(page, { 3: [0, 0] });
  await readPreview(page, settle);
  await emit(page, { 3: [7, 7] });
  const warm = await firstAdmitted(page, preheatLevels);
  await button(rx, 'Stop listening').press('Enter');
  await expect(source(page)).toHaveValue('desk');
  const handoff = await readPreview(page, [20]);
  expect(handoff.spillLevel).toBeCloseTo(7 / 255);
  expect(handoff.lenses.map(unit => unit.deliveredLevel)).toEqual(preheatLevels);
  expect(Math.abs(room.read(handoff) - room.read(warm))).toBeLessThan(room.span / 2);
  handoff.lenses.forEach((unit, index) => expect(Math.abs(lensPeak(unit) - lensPeak(warm.lenses[index]))).toBeLessThan(contrast));
  const steadyDesk = await firstAdmitted(page, [1, 1]);
  expect(room.read(steadyDesk)).toBeGreaterThan(room.span / 2);
  steadyDesk.lenses.forEach((unit, index) => expect(lensPeak(unit) - lensPeak(handoff.lenses[index])).toBeGreaterThan(contrast));
  await info.attach('p4-preheated-post-bloom', { body: JSON.stringify({ dark, lit, trace, warm, handoff, steadyDesk }), contentType: 'application/json' });
});

test('P4 adding a stock Desk bank cannot relight a dark room during External refractory', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockP3(page);
  const show = roomRehearsal();
  show.rig.trussPods[1].baseY = 3.8; // Place new rear banks below the existing lamps in the camera.
  await freezeAfterFirstFrame(page, show);
  const desk = await readPreview(page, [250, 250, 250]);
  expect(desk.spillLevel).toBe(1);
  const rx = await openInput(page);
  await button(rx, 'Start listening').press('Enter');
  await source(page).selectOption('external');
  await page.clock.runFor(20);
  const externalDark = await readPreview(page, [250, 250, 250]);
  await emit(page, { 3: [255, 0] });
  const externalLit = await firstAdmitted(page, [1, 0]);
  expect(lensPeak(externalLit.lenses[0]) - lensPeak(externalDark.lenses[0])).toBeGreaterThan(contrast);
  const room = calibratedRoom(externalDark, externalLit);
  await emit(page, { 3: [0, 0] });
  const fell = await readPreview(page, [20]);
  expect(fell.spillLevel).toBe(0);

  await button(monitor(page), 'Close DMX monitor').click();
  await button(page, 'Rig builder').click();
  const rig = page.getByRole('complementary', { name: 'Rig Builder', exact: true });
  const add = rig.getByRole('button', { name: '+blinder', exact: true });
  await expect(add).toHaveCount(2);
  await add.nth(1).click(); // The Control truss has no existing blinder group to extend.
  await expect.poll(() => page.evaluate(() => {
    const probe = window.stageforgeProbe;
    const stock = probe.rig().trussPods.find(pod => pod.id === 'controls')?.fixtures.find(group => group.type === 'blinder');
    return probe.patchOccupancy('resolved').units.filter(unit => unit.groupId === stock?.id).map(unit => unit.width);
  })).toEqual([4, 4, 4, 4]);
  await button(rig, 'Close Rig Builder').click();
  await expect(source(page)).toHaveValue('external');
  const blocked = await readPreview(page, [20]);
  const stock = blocked.lenses.filter(unit => unit.address === null);
  expect(stock).toHaveLength(4);
  expect(blocked.spillLevel).toBe(0);
  const resumed = await firstAdmitted(page, blocked.lenses.map(unit => unit.address === null ? 1 : 0));
  expect(resumed.spillLevel).toBe(1);
  const rebuiltRoom = calibratedRoom(blocked, resumed);
  const steadyStock = resumed.lenses.filter(unit => unit.address === null);
  stock.forEach((unit, index) => expect(lensPeak(steadyStock[index]) - lensPeak(unit)).toBeGreaterThan(contrast));
  expect(rebuiltRoom.read(resumed)).toBeGreaterThan(room.span / 2);
  await info.attach('p4-new-stock-post-bloom', { body: JSON.stringify({ desk, externalDark, externalLit, fell, blocked, resumed }), contentType: 'application/json' });
});

test('P4 a co-timed full-rate Desk sibling cannot exempt a newly External lens from its local history', async ({ page }, info) => {
  test.setTimeout(120_000);
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
  const full = await readPreview(page);
  await desk(0);
  const dark = await readPreview(page);
  expect(lensPeak(full.lenses[0]) - lensPeak(dark.lenses[0])).toBeGreaterThan(contrast);
  const stock = full.lenses.findIndex(unit => unit.address === null);
  expect(stock).toBeGreaterThanOrEqual(0);
  await source(page).selectOption('external');
  await emit(page, { 3: [255, 0] });
  await desk(1);
  const coTimed = await readPreview(page);
  expect(coTimed.lenses[stock].deliveredLevel).toBe(1);
  expect(coTimed.lenses[0].deliveredLevel).toBe(0);
  expect(lensPeak(coTimed.lenses[stock]) - lensPeak(dark.lenses[stock])).toBeGreaterThan(contrast);

  await emit(page, { 3: [0, 0] });
  const sameSpill = await readPreview(page, [1]);
  expect(sameSpill.spillLevel).toBe(coTimed.spillLevel);
  expect(sameSpill.lenses[stock].deliveredLevel).toBe(1);
  expect(Math.abs(lensPeak(coTimed.lenses[0]) - lensPeak(sameSpill.lenses[0]))).toBeLessThan(contrast);

  await emit(page, { 3: [255, 0] });
  const permitted = await firstAdmitted(page, coTimed.lenses.map((_, index) => index === 0 || index === stock ? 1 : 0));
  expect(permitted.spillLevel).toBe(sameSpill.spillLevel);
  expect(lensPeak(permitted.lenses[0]) - lensPeak(sameSpill.lenses[0])).toBeGreaterThan(contrast);
  await info.attach('p4-co-timed-same-spill', { body: JSON.stringify({ dark, coTimed, sameSpill, permitted }), contentType: 'application/json' });
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
