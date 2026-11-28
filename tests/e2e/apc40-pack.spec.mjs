import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { installApcMidiMock } from '../support/apc40-midi.mjs';
import { dragApcFaderTo } from '../support/apc40-surface.mjs';

const sourceShow = new URL('../../public/examples/deep-house.stageforge.show.json', import.meta.url);
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const panel = page => page.getByRole('complementary', { name: 'APC40 mkII Deep House performance' });
const fader = (page, name) => panel(page).getByRole('slider', { name, exact: true });
const files = page => page.getByRole('dialog', { name: 'Show files', exact: true });
const look = page => page.evaluate(() => window.stageforgeProbe.showStateSummary());
const emit = (page, bytes, id) => page.evaluate(([data, port]) => window.apcTest.emit(data, port), [bytes, id]);

async function openExample(page) {
  await button(page, 'Show files').click();
  await button(files(page), 'Open Deep House rehearsal').click();
  await expect(files(page)).toBeHidden();
  await expect(panel(page).getByRole('heading', { name: 'Deep House', exact: true })).toBeVisible();
}

async function openPorts(page) {
  await panel(page).getByText('APC40 mkII MIDI connection', { exact: true }).click();
  await button(panel(page), 'Enable MIDI access').click();
  await panel(page).getByRole('combobox', { name: 'APC40 MIDI input' }).selectOption('in-a');
  await panel(page).getByRole('combobox', { name: 'APC40 MIDI output' }).selectOption('out-a');
}

async function expectControllerGeometry(page, desk) {
  const geometry = await desk.evaluate(root => {
    const bounds = selector => Array.from(root.querySelectorAll(selector), element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2, width, height };
    });
    return {
      pads: bounds('.apc-row button'), scenes: bounds('.apc-scenes button'),
      faders: bounds('.apc-faders input'), stop: bounds('.apc-stop')[0],
      labelsFit: Array.from(root.querySelectorAll('.apc-faders label span'), element => element.scrollWidth <= element.clientWidth + 1),
      direction: getComputedStyle(root.querySelector('.apc-faders input')).direction,
      writingMode: getComputedStyle(root.querySelector('.apc-faders input')).writingMode,
    };
  });
  expect(geometry.pads).toHaveLength(40);
  expect(geometry.scenes).toHaveLength(5);
  expect(geometry.faders).toHaveLength(9);
  expect(geometry.direction).toBe('rtl');
  expect(geometry.writingMode).toBe('vertical-lr');
  expect(geometry.labelsFit.every(Boolean)).toBe(true);
  for (const [index, scene] of geometry.scenes.entries()) {
    const row = geometry.pads.slice(index * 8, index * 8 + 8);
    expect(Math.abs(scene.y - row[0].y)).toBeLessThan(2);
    expect(scene.x).toBeGreaterThan(row[7].x + row[7].width / 2);
    row.forEach((pad, column) => expect(Math.abs(pad.x - geometry.faders[column].x)).toBeLessThan(2));
  }
  expect(Math.abs(geometry.stop.x - geometry.scenes[4].x)).toBeLessThan(2);
  expect(geometry.stop.y).toBeGreaterThan(geometry.scenes[4].y);
  expect(Math.abs(geometry.faders[8].x - geometry.scenes[4].x)).toBeLessThan(2);
  expect(geometry.faders.every(fader => fader.height > fader.width && fader.y > geometry.stop.y)).toBe(true);
  await button(desk, 'Cue looks White Room').focus();
  await page.keyboard.press('Tab');
  await expect(button(desk.getByRole('group', { name: 'Scene buttons' }), 'Intro')).toBeFocused();
  await button(desk.getByRole('group', { name: 'Scene buttons' }), 'Close').focus();
  await page.keyboard.press('Tab');
  await expect(button(desk, 'Latch blackout')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(fader(page, 'Beam level')).toBeFocused();
}

async function readStage(page) {
  return page.evaluate(() => {
    const p = window.stageforgeProbe;
    for (let i = 0; i < 6; i++) p.stepAndReadLuminance(180);
    const unit = p.measureSnapshot().units.find(unit => unit.groupId === 'deep-house-beams');
    const beam = p.beamLevels().find(beam => beam.unitId === unit.unitId);
    return { beam, origin: unit.lensOrigin, laser: p.laserPreviewColors()[0],
      physical: p.physicalDmxSnapshot(), serial: p.serialDmxSnapshot(), simulated: p.simulatedDmxSnapshot()[3] };
  });
}

test('APC40 Deep House opens silently and plays independent rendered lighting, laser and lift with keyboard and mouse', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => !!window.stageforgeProbe)).toBe(true);
  const fetched = [];
  const record = request => { if (/\/examples\/|\.(?:mp3|mp4|webm)(?:$|\?)/.test(request.url())) fetched.push(new URL(request.url()).pathname); };
  page.on('request', record);
  await openExample(page);
  page.off('request', record);
  expect(fetched).toEqual([expect.stringMatching(/\/examples\/deep-house\.stageforge\.show\.json$/)]);
  expect(await page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBe(0);
  expect(await page.evaluate(() => window.stageforgeProbe.takeState().mode)).toBe('idle');
  const desk = panel(page);
  for (const name of ['Lighting color', 'Virtual laser color', 'Lighting palettes', 'Wall and movement', 'Cue looks']) {
    await expect(desk.getByRole('group', { name, exact: true }).getByRole('button')).toHaveCount(8);
  }
  await expect(desk.getByRole('group', { name: 'Performance faders' }).getByRole('slider')).toHaveCount(9);
  await expectControllerGeometry(page, desk);
  await page.setViewportSize({ width: 1280, height: 1050 });
  await expectControllerGeometry(page, desk);
  await page.setViewportSize({ width: 1440, height: 1050 });
  const early = await readStage(page);
  expect(early.laser.visible).toBe(true);
  expect(early.laser.intensity).toBeGreaterThan(0.1);
  expect(early.beam.preview).toBeGreaterThan(0.1);
  const red = button(desk, 'Lighting color Red');
  await red.press('Enter');
  await expect(red).toHaveAttribute('aria-pressed', 'true');
  const redFrame = await readStage(page);
  expect(redFrame.beam.lens[0]).toBeGreaterThan(redFrame.beam.lens[2] + 0.1);
  expect(redFrame.laser.color).toEqual(early.laser.color);
  const green = button(desk, 'Virtual laser color Green');
  await green.click();
  await expect(green).toHaveAttribute('aria-pressed', 'true');
  const greenFrame = await readStage(page);
  expect(greenFrame.laser.color[1]).toBeGreaterThan(greenFrame.laser.color[0] + 0.2);
  expect(greenFrame.laser.color).not.toEqual(redFrame.laser.color);
  expect(greenFrame.beam.lens).toEqual(redFrame.beam.lens);
  const lift = fader(page, 'Simulated lift height');
  await lift.press('Home');
  await expect(lift).toHaveValue('0');
  await lift.press('ArrowUp');
  await expect(lift).toHaveValue('0.01');
  await lift.press('ArrowDown');
  await expect(lift).toHaveValue('0');
  await lift.press('End');
  await expect(lift).toHaveValue('1');
  await dragApcFaderTo(page, lift, 'bottom');
  await expect(lift).toHaveValue('0');
  await dragApcFaderTo(page, lift, 'top');
  await expect(lift).toHaveValue('1');
  const high = await readStage(page);
  expect(high.origin.y).toBeGreaterThan(greenFrame.origin.y + 1);
  expect(high.physical.u1.every(byte => byte === 0) && high.physical.u2.every(byte => byte === 0)).toBe(true);
  expect(high.serial.u1.every(byte => byte === 0) && high.serial.u2.every(byte => byte === 0)).toBe(true);
  expect(high.simulated.some(Boolean)).toBe(true);
  const scenes = desk.getByRole('group', { name: 'Scene buttons' });
  await button(scenes, 'Groove').click();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('deep-house-groove');
  await expect(button(scenes, 'Groove')).toHaveAttribute('aria-pressed', 'true');
  await button(desk, 'Wall and movement Wall Plasma').press('Enter');
  await expect(button(desk, 'Wall and movement Wall Plasma')).toHaveAttribute('aria-pressed', 'true');
  const wallLevel = fader(page, 'LED wall brightness');
  await wallLevel.press('End');
  await expect(wallLevel).toHaveValue('1');
  const layout = button(desk, 'Compact view');
  const existingFader = await wallLevel.elementHandle();
  await layout.evaluate(element => element.click());
  await expect(layout).toHaveAttribute('aria-pressed', 'true');
  await expect(wallLevel).toBeFocused();
  await expect(wallLevel).toHaveValue('1');
  expect(await wallLevel.evaluate((element, before) => element === before, existingFader)).toBe(true);
  await expect(button(scenes, 'Groove')).toHaveAttribute('aria-pressed', 'true');
  await layout.evaluate(element => element.click());
  await expect(layout).toHaveAttribute('aria-pressed', 'false');
  await expect(wallLevel).toBeFocused();
  await readStage(page);
  await desk.locator('.apc-desk').evaluate(element => { element.scrollTop = 0; });
  const imagePath = info.outputPath('deep-house-signal-room.png');
  await page.screenshot({ path: imagePath });
  await info.attach('Deep House stage and APC40 performance desk', { path: imagePath, contentType: 'image/png' });

  await button(page, 'Show files').click();
  const download = page.waitForEvent('download');
  await button(files(page), 'Save show JSON').click();
  const saved = await readFile(await (await download).path(), 'utf8');
  const show = JSON.parse(saved);
  expect(show.look.laser.colorMode).toBe('custom');
  expect(show.look.motors.mode).toBe('manual');
  expect(show.look.led).toMatchObject({ visualMode: 'plasma', brightness: 1 });
  expect(show.activeCueId).toBe('deep-house-groove');
  await files(page).getByLabel('Open show file').setInputFiles({
    name: 'reopen.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(saved),
  });
  await expect(files(page)).toBeHidden();
  await expect(button(desk, 'Wall and movement Wall Plasma')).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(layout).toBeHidden();
  await expect(wallLevel).toHaveValue('1');
  expect(await wallLevel.evaluate(element => getComputedStyle(element).writingMode)).toBe('horizontal-tb');
  const narrowFit = await desk.evaluate(root => {
    const { left, right } = root.getBoundingClientRect();
    return left >= 0 && right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
  });
  expect(narrowFit).toBe(true);
});

test('APC40 mocked MIDI shares cue and pickup paths, latches blackout and suspends in Chase', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(installApcMidiMock);
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('/?probe');
  await openExample(page);
  expect(await page.evaluate(() => window.apcTest.calls)).toEqual([]);
  await openPorts(page);
  await button(panel(page), 'Connect APC40 mkII').click();
  await expect(panel(page).getByText('APC40 mkII ready', { exact: true })).toBeVisible();
  const midiCalls = () => page.evaluate(() => window.apcTest.calls);
  await expect.poll(async () => (await midiCalls()).filter(([type]) => type === 'send').length).toBe(47);
  const beforeLayout = await midiCalls();
  const layout = button(panel(page), 'Compact view');
  await layout.click();
  await expect(layout).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).getByText('APC40 mkII ready', { exact: true })).toBeVisible();
  await layout.click();
  await expect(layout).toHaveAttribute('aria-pressed', 'false');
  await page.clock.runFor(70);
  expect(await midiCalls()).toEqual(beforeLayout);
  await emit(page, [0x90, 32, 127], 'in-other');
  expect((await look(page)).primaryColor).not.toBe('#ff243f');
  await emit(page, [0x90, 32, 127]);
  await expect.poll(async () => (await look(page)).primaryColor).toBe('#ff243f');
  await expect(button(panel(page), 'Lighting color Red')).toHaveAttribute('aria-pressed', 'true');
  await emit(page, [0x90, 32, 0]);
  await emit(page, [0x90, 0x53, 127]);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('deep-house-groove');
  await emit(page, [0xb0, 7, 10]);
  await expect(fader(page, 'Beam level')).toHaveValue('0.66');
  await emit(page, [0xb0, 7, 110]);
  await expect.poll(async () => (await look(page)).beamIntensity).toBeCloseTo(110 / 127);
  await expect.poll(async () => Number(await fader(page, 'Beam level').inputValue())).toBeCloseTo(110 / 127, 2);
  await fader(page, 'Beam level').press('End');
  await emit(page, [0xb0, 7, 40]);
  await expect.poll(async () => (await look(page)).beamIntensity).toBe(1);
  await button(page, 'Show control').click();
  await page.getByTestId('clock-mode-chase').click();
  await button(page.getByRole('complementary', { name: 'Show control', exact: true }), 'Close show control').press('Enter');
  await expect(fader(page, 'Master dimmer')).toBeDisabled();
  await expect(button(panel(page), 'Latch blackout')).toBeEnabled();
  const before = await look(page);
  await emit(page, [0xb0, 14, 114]);
  await emit(page, [0x90, 0x54, 127]);
  expect((await look(page)).masterDimmer).toBe(before.masterDimmer);
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('deep-house-groove');
  await emit(page, [0x90, 0x51, 127]);
  await expect.poll(async () => (await look(page)).operatorBlackout).toBe(true);
  await emit(page, [0x80, 0x51, 127]);
  await expect.poll(async () => (await look(page)).operatorBlackout).toBe(true);
  await button(page, 'Operator blackout hold').press('Enter');
  await expect.poll(async () => (await look(page)).operatorBlackout).toBe(false);

  await button(page, 'Show control').click();
  await page.getByTestId('clock-mode-master').click();
  await button(page.getByRole('complementary', { name: 'Show control', exact: true }), 'Close show control').press('Enter');
  await button(page, 'Show cues').press('Enter');
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await button(page, 'Record take').press('Enter');
  await page.clock.runFor(1600);
  await button(page, 'Stop recording').press('Enter');
  await button(page, 'Replay take').press('Enter');
  await expect(fader(page, 'Master dimmer')).toBeDisabled();
  await emit(page, [0x80, 0x54, 127]);
  await emit(page, [0x90, 0x54, 127]);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('deep-house-groove');
  await emit(page, [0x90, 0x51, 127]);
  await expect.poll(async () => (await look(page)).operatorBlackout).toBe(true);
  await button(page, 'Stop replay').press('Enter');
  await button(page, 'Operator blackout hold').press('Enter');
  await expect.poll(async () => (await look(page)).operatorBlackout).toBe(false);
  await expect(fader(page, 'Master dimmer')).toBeEnabled();
  await page.evaluate(() => window.apcTest.unplug());
  await expect(panel(page).getByText(/APC40 mkII disconnected/)).toBeVisible();
  await page.evaluate(() => window.apcTest.replug());
  await emit(page, [0x90, 0x51, 127]);
  expect((await look(page)).operatorBlackout).toBe(false);
  expect(await page.evaluate(() => window.apcTest.priorSync.events)).toBe(1);
  const traffic = await page.evaluate(() => window.apcTest.calls.filter(([type]) => type === 'send'));
  expect(traffic.every(([, port, bytes]) => port === 'out-a' && (bytes[0] === 0x90 || bytes[0] === 0xf0))).toBe(true);
});

test('APC40 drops a pending identity on a mixed U1 show and Viewer entry and leaves the pack unavailable', async ({ page }) => {
  await page.addInitScript(installApcMidiMock);
  await page.goto('/?probe');
  await openExample(page);
  await page.evaluate(() => { window.apcTest.deferIdentity = true; });
  await openPorts(page);
  await button(panel(page), 'Connect APC40 mkII').click();
  await expect.poll(() => page.evaluate(() => window.apcTest.calls.filter(([type]) => type === 'send').length)).toBe(1);
  await button(page, 'Show files').click();
  const show = JSON.parse(await readFile(sourceShow, 'utf8'));
  show.rig.floorFx[0].dmxUniverse = 1;
  const payload = {
    name: 'mixed-u1.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(show)),
  };
  await files(page).getByLabel('Open show file').setInputFiles(payload);
  await expect(files(page)).toBeHidden();
  await expect(button(panel(page), 'Latch blackout')).toBeDisabled();
  await page.evaluate(() => { window.apcTest.identity(); window.apcTest.emit([0x90, 0x51, 127]); });
  expect((await look(page)).operatorBlackout).toBe(false);
  expect(await page.evaluate(() => window.apcTest.calls.filter(([type]) => type === 'send').length)).toBe(1);
  await button(page, 'Show files').click();
  await files(page).getByLabel('Open show in viewer').setInputFiles(payload);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.viewerMode())).toBe(true);
  await expect(panel(page)).toHaveCount(0);
});
