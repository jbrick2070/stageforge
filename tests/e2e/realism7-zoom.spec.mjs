import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const example = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));
const profile = { source: 'datasheet', manufacturer: 'Rehearsal', fixture: 'Custom', geometry: 'Narrow', beamAngle: 8, lumens: 7000 };
const moving = (id, type, modelName, catalogId, dmxMode, dmxChannels, dmxUniverse, dmxStartChannel, count) =>
  ({ id, type, modelName, catalogId, dmxMode, dmxChannels, dmxUniverse, dmxStartChannel, count });

function rehearsal() {
  const file = structuredClone(example);
  file.version = 9;
  file.$schema = 'https://jbrick2070.github.io/stageforge/schemas/show-v9.schema.json';
  file.rig.venue = 'theatre';
  file.rig.stageWidth = 13;
  file.rig.stageDepth = 11;
  file.rig.ledWall.enabled = false;
  file.rig.audioRig.crowdDensity = 0;
  const pod = file.rig.trussPods[0];
  Object.assign(pod, { baseY: 7.2, z: 0, rotationY: 0.3 });
  const robe = (id, type, universe, start, count) =>
    moving(id, type, 'MegaPointe', 'robe-megapointe', 'Mode 2 (Reduced 8-bit)', 34, universe, start, count);
  const etc = (id, universe, start) =>
    moving(id, 'wash', 'ColorSource PAR', 'etc-colorsource-par', 'RGB (3-Ch)', 3, universe, start, 1);
  pod.fixtures = [
    robe('robe', 'beam', 1, 1, 2),
    moving('rogue', 'wash', 'Rogue R1 BeamWash', 'chauvet-rogue-r1-beamwash', '19-Ch', 19, 2, 17, 2),
    { ...robe('authored', 'beam', 1, 110, 1), optics: { profile } },
    { id: 'generic', type: 'beam', modelName: 'Generic beam', count: 1, dmxUniverse: 1, dmxStartChannel: 195 },
    etc('etc-u1', 1, 180),
    etc('etc-u2', 2, 170),
  ];
  file.rig.floorFx = [{ ...robe('robe-floor', 'floor_beam', 2, 120, 1), x: -2, z: 0, spread: 0 }];
  Object.assign(file.look, {
    blackout: false, masterDimmer: 0.8, autoDirector: false, audioReactive: false, beamZoom: 0,
    beamIntensity: 0.65, washIntensity: 0.48, movementMode: 'manual', movementSpeed: 0,
    manualPan: 0, manualTilt: 0, focusMarkId: null, colorSplitMode: 'solid', goboPrism: false,
    primaryColor: '#d7f1ff', bloomStrength: 0, strobeRate: 0, blinderLevel: 0,
  });
  file.cues = [
    { id: 'start', name: 'Start', tag: 'SHOW', accent: '#ffffff', state: { beamZoom: 0 } },
    { id: 'wide', name: 'Widen', tag: 'SHOW', accent: '#ffffff', fadeSeconds: 4,
      state: { beamZoom: 1, beamIntensity: 0.85, washIntensity: 0.72 } },
    { id: 'middle', name: 'Interrupt', tag: 'SHOW', accent: '#ffffff', fadeSeconds: 1,
      state: { beamZoom: 0.5, beamIntensity: 0.34, washIntensity: 0.27 } },
  ];
  file.activeCueId = 'start';
  delete file.timeline;
  delete file.media;
  return file;
}

async function openRehearsal(page, file = rehearsal()) {
  await page.getByRole('button', { name: 'Show files' }).press('Enter');
  const files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles({
    name: 'zoom.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(files).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.beamAxes().length)).toBe(9);
  await page.evaluate(() => window.stageforgeProbe.setCameraPose([11, 6, 14], [0, 4, 0]));
}

async function freeze(page) {
  const start = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto('/?probe');
}

// This test uses only baseline probe methods plus serialDmxSnapshot. Attach the complete
// six-buffer capture so the exact same test can be run on both sides of the optics change.
test('Realism 7 deterministic six-buffer DMX observation', async ({ page }, info) => {
  test.setTimeout(120_000);
  await freeze(page);
  await openRehearsal(page);
  const ticks = [];
  const tick = async (name, zoom, patch = {}) => {
    const buffers = await page.evaluate((patch) => {
      const p = window.stageforgeProbe;
      p.patchShowState(patch);
      p.stepAndReadLuminance(200);
      return { simulated: p.dmxSnapshot(), physical: p.physicalDmxSnapshot(), serial: p.serialDmxSnapshot() };
    }, patch);
    for (const output of Object.values(buffers)) {
      expect(output.u1).toHaveLength(512);
      expect(output.u2).toHaveLength(512);
    }
    expect(buffers.simulated.u1[6]).toBe(Math.round(zoom * 255));
    expect(buffers.simulated.u2[22]).toBe(Math.round(zoom * 255));
    expect(buffers.simulated.u2[125]).toBe(Math.round(zoom * 255));
    ticks.push({ name, ...buffers });
    return buffers;
  };
  const narrow = await tick('zoom-0', 0, { beamZoom: 0 });
  const middle = await tick('zoom-0.5', 0.5, { beamZoom: 0.5 });
  const wide = await tick('zoom-1', 1, { beamZoom: 1 });
  for (const { physical, serial } of [narrow, middle, wide]) {
    for (const output of [physical, serial]) {
      expect(output.u1.slice(179, 182).every((byte) => byte > 0)).toBe(true);
      expect(output.u2.slice(169, 172).every((byte) => byte > 0)).toBe(true);
    }
    expect(physical).toEqual(narrow.physical);
    expect(serial).toEqual(narrow.serial);
  }
  const focus = await tick('focus-mark', 1, { focusMarkId: 'platform:main-deck' });
  expect(focus.simulated.u1.slice(0, 2)).not.toEqual(wide.simulated.u1.slice(0, 2));
  const manual = await tick('manual-steer', 1, { focusMarkId: null, manualPan: 0.23, manualTilt: -0.4 });
  expect(manual.simulated.u1.slice(0, 2)).not.toEqual(focus.simulated.u1.slice(0, 2));
  const zero = await tick('zero-master', 1, { masterDimmer: 0 });
  expect(zero.simulated.u1[2]).toBe(0);
  const black = await tick('blackout', 1, { masterDimmer: 0.8, blackout: true });
  for (const output of [black.physical, black.serial]) {
    expect(output.u1.every((byte) => byte === 0)).toBe(true);
    expect(output.u2.every((byte) => byte === 0)).toBe(true);
  }
  await tick('ready', 1, { blackout: false });

  await page.getByRole('button', { name: 'Show cues', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Cue 2, Widen' }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.cuePreview())).not.toBeNull();
  await page.clock.runFor(160);
  await tick('fade-running', 1);
  await page.getByRole('button', { name: 'Cue 3, Interrupt' }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('middle');
  await tick('fade-interrupted', 0.5);
  await info.attach('realism7-dmx-bytes', { body: Buffer.from(JSON.stringify(ticks)), contentType: 'application/json' });
});

test('Realism 7 finite lens geometry, cold Measure, pool refill and batched rendering agree', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/THREE\.WebGLProgram/.test(message.text())) errors.push(message.text());
  });
  await page.clock.install();
  await page.goto('/?probe');
  const file = rehearsal();
  await openRehearsal(page, file);
  // The house wall at x = 9.9 m occludes a view from outside the Theatre.
  await page.evaluate(() => window.stageforgeProbe.setCameraPose([0, 5.4, 14], [0, 4, 0]));
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.beamAxes().filter((beam) => beam.optics.emitted > 0.001).length)).toBe(9);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  let previous;
  for (const zoom of [0, 0.5, 1]) {
    const result = await page.evaluate(async ({ look, zoom }) => {
      const { evaluateStaticHeadMeasures } = await import('/src/data/measure.ts');
      const p = window.stageforgeProbe;
      p.setRenderSettings({ bloom: 'off', litPuffs: false });
      p.patchShowState({ beamZoom: zoom });
      p.stepAndReadLuminance(200);
      const beams = p.beamFrusta();
      const live = p.measureSnapshot().units;
      const cold = evaluateStaticHeadMeasures(p.rig(), { ...look, beamZoom: zoom });
      const pools = p.poolFrusta();
      p.setBatching(true);
      const batched = p.redrawAndCapture();
      const stats = p.renderStats();
      const hidden = p.redrawAndCapture({ hideBeams: true });
      p.setBatching(false);
      const unbatched = p.redrawAndCapture();
      p.setBatching(true);

      const decode = async (source) => {
        const img = new Image();
        img.src = source;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [on, noBeams, off] = await Promise.all([batched, hidden, unbatched].map(decode));
      const diff = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / (a.length * 255);
      return { beams, live, cold, pools, stats, signal: diff(on, noBeams), parity: diff(on, off), batched, hidden, unbatched };
    }, { look: file.look, zoom });

    await info.attach(`zoom-${zoom}`, { body: Buffer.from(result.batched.split(',')[1], 'base64'), contentType: 'image/png' });
    const lit = result.live.filter((unit) => unit.calibratedOptics && unit.emittedVisible).length;
    if (result.signal <= 0.0001 || result.parity >= result.signal * 0.15) {
      await info.attach(`zoom-${zoom}-beams-hidden`, { body: Buffer.from(result.hidden.split(',')[1], 'base64'), contentType: 'image/png' });
      await info.attach(`zoom-${zoom}-unbatched`, { body: Buffer.from(result.unbatched.split(',')[1], 'base64'), contentType: 'image/png' });
    }
    expect(result.beams).toHaveLength(5);
    expect(lit).toBe(5);
    expect(result.stats.batching.proxied).toBe(6); // Two MegaPointes, two Rogues and two identical PARs.
    expect(result.stats.batching.released).toBe(0);
    if (previous) {
      expect(result.stats.calls).toBe(previous.calls);
      expect(result.stats.textures).toBe(previous.textures);
    }
    previous = result.stats;
    expect(result.signal, `${lit} emitting calibrated heads at zoom ${zoom}`).toBeGreaterThan(0.0001);
    expect(result.parity).toBeLessThan(result.signal * 0.15);

    for (const beam of result.beams) {
      const live = result.live.find((unit) => unit.unitId === beam.unitId);
      const cold = result.cold.find((unit) => unit.unitId === beam.unitId);
      const [narrow, wide, radius, offset, length] = live.type === 'wash'
        ? [4, 37.8, 0.0817, 0.0828, 21]
        : [1.8, 21, 0.102336, 0.1786, 30];
      const angle = narrow + zoom * (wide - narrow);
      const slope = Math.tan(angle * Math.PI / 360);
      const direction = live.isFloor ? 1 : -1;
      expect(beam.scale).toEqual([1, 1, 1]);
      expect(beam.frustum.beamAngleDeg).toBeCloseTo(angle, 9);
      expect(beam.frustum.nearRadius).toBeCloseTo(radius, 9);
      expect(beam.endRadiusDelta).toBeCloseTo(length * (Math.tan(wide * Math.PI / 360) - slope), 9);
      expect(beam.bounds.center[1]).toBeCloseTo(direction * (offset + length / 2), 9);
      for (let i = 0; i < beam.localUvs.length / 2; i++) {
        const reach = 1 - beam.localUvs[2 * i + 1];
        const [x, y, z] = beam.localPositions.slice(3 * i, 3 * i + 3);
        const emittedRadius = Math.hypot(x, z) - beam.endRadiusDelta * reach;
        expect(y).toBeCloseTo(direction * (offset + reach * length), 5);
        expect(emittedRadius).toBeCloseTo(radius + reach * length * slope, 5);
        expect(Math.hypot(x, y - beam.bounds.center[1], z)).toBeLessThanOrEqual(beam.bounds.radius + 1e-5);
      }
      expect(live.direction.y).toBeCloseTo(direction, 9);
      for (const coordinate of ['x', 'y', 'z']) expect(live.lensOrigin[coordinate]).toBeCloseTo(cold.lensOrigin[coordinate], 6);
      expect(live.beamAngleDeg).toBeCloseTo(cold.beamAngleDeg, 9);
      expect(live.throwM).toBeCloseTo(cold.throwM, 6);
      expect(live.footprint.normalDiameterM).toBeCloseTo(2 * (radius + live.throwM * slope), 6);
      expect(live.footprint.normalDiameterM).toBeCloseTo(cold.footprint.normalDiameterM, 6);
      expect(live.calibratedOptics).toEqual(cold.calibratedOptics);
      if (live.type === 'wash') {
        expect(live.calibratedOptics.fluxSource).toBe('preview fallback');
        expect(live.luxFullEst).toBeNull();
      } else {
        expect(live.calibratedOptics.fluxSource).toBe('catalogue');
        expect(live.luxFullEst).toBeGreaterThan(0);
      }
      if (!live.isFloor) {
        const { x, y, z } = live.lensOrigin;
        const pool = result.pools.find(({ lens }) => Math.hypot(lens[0] - x, lens[1] - y, lens[2] - z) < 1e-5);
        expect(pool).toBeDefined();
        expect(pool.optics[0]).toBeCloseTo(radius, 6);
        expect(pool.optics[1]).toBeCloseTo(slope, 6);
        expect(pool.optics[2]).toBe(length);
      }
    }

    const legacyScale = 0.42 + 1.35 * zoom;
    const authored = result.live.find(({ groupId }) => groupId === 'authored');
    const generic = result.live.find(({ groupId }) => groupId === 'generic');
    expect(authored.beamAngleDeg).toBeCloseTo(360 / Math.PI * Math.atan(legacyScale * Math.tan(4 * Math.PI / 180)), 8);
    expect(generic.beamAngleDeg).toBeCloseTo(360 / Math.PI * Math.atan(legacyScale * (1.75 - 0.12) / 30), 8);
    expect(authored.calibratedOptics).toBeUndefined();
    expect(generic.calibratedOptics).toBeUndefined();
  }

  const refill = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    const before = p.poolFrusta();
    p.simulateContextLoss(true);
    p.simulateContextLoss(false);
    return { before, after: p.poolFrusta() };
  });
  expect(refill.before.length).toBeGreaterThanOrEqual(4);
  expect(refill.after).toEqual(refill.before);
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: 'Show files' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Show files' });
  const saving = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save show JSON' }).press('Enter');
  const saved = JSON.parse(await readFile(await (await saving).path(), 'utf8'));
  expect(saved.rig.trussPods[0].fixtures.find((group) => group.id === 'authored').optics.profile).toEqual(profile);
  expect(saved.rig.trussPods[0].fixtures.find((group) => group.id === 'robe').optics).toBeUndefined();
  expect(saved.look.beamZoom).toBe(1);
  await dialog.getByRole('button', { name: 'Close Show files' }).press('Enter');
  await openRehearsal(page, saved);
  await page.evaluate(() => window.stageforgeProbe.stepAndReadLuminance(200));
  const reopened = await page.evaluate(() => window.stageforgeProbe.measureSnapshot().units);
  expect(reopened.find((unit) => unit.groupId === 'robe').beamAngleDeg).toBe(21);
  expect(reopened.find((unit) => unit.groupId === 'authored').calibratedOptics).toBeUndefined();
});

function prismRehearsal() {
  const file = rehearsal();
  file.cues = [
    { id: 'plain', name: 'Plain beam', tag: 'SHOW', accent: '#ffffff', state: { goboPrism: false } },
    { id: 'prism', name: 'Apply prism', tag: 'SHOW', accent: '#ffffff', state: { goboPrism: true } },
  ];
  file.activeCueId = 'plain';
  return file;
}

// This case uses baseline probe fields only. The same file and case run on both revisions.
test('Realism 7 deterministic six-buffer prism DMX observation', async ({ page }, info) => {
  test.setTimeout(120_000);
  await freeze(page);
  await openRehearsal(page, prismRehearsal());
  await page.getByRole('button', { name: 'Show cues', exact: true }).press('Enter');
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ prismPools: true }));
  const ticks = [];
  const tick = async (name, cueId, zoom, prism) => {
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(cueId);
    const { buffers, active } = await page.evaluate((beamZoom) => {
      const p = window.stageforgeProbe;
      p.patchShowState({ beamZoom });
      for (let i = 0; i < 3; i++) p.stepAndReadLuminance(200);
      return {
        buffers: { simulated: p.dmxSnapshot(), physical: p.physicalDmxSnapshot(), serial: p.serialDmxSnapshot() },
        active: p.graphicsProbe().prismPools.activePrismInstances,
      };
    }, zoom);
    expect(active > 0).toBe(prism);
    for (const output of Object.values(buffers)) {
      expect(output.u1).toHaveLength(512);
      expect(output.u2).toHaveLength(512);
    }
    for (const output of [buffers.physical, buffers.serial]) {
      expect(output.u1.slice(179, 182).every((byte) => byte > 0)).toBe(true);
      expect(output.u2.slice(169, 172).every((byte) => byte > 0)).toBe(true);
    }
    ticks.push({ name, ...buffers });
    return buffers;
  };
  for (const zoom of [0, 0.5, 1]) {
    const before = await tick(`zoom-${zoom}-plain`, 'plain', zoom, false);
    await page.getByRole('button', { name: 'Cue 2, Apply prism' }).press('Enter');
    const on = await tick(`zoom-${zoom}-prism`, 'prism', zoom, true);
    await page.getByRole('button', { name: 'Cue 1, Plain beam' }).press('Enter');
    const after = await tick(`zoom-${zoom}-released`, 'plain', zoom, false);
    expect(on).toEqual(before);
    expect(after).toEqual(before);
  }
  await info.attach('realism7-dmx-bytes', { body: Buffer.from(JSON.stringify(ticks)), contentType: 'application/json' });
});

test('Realism 7 MegaPointe linear prism agrees in aerial, receiver and restored preview', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/THREE\.WebGLProgram/.test(message.text())) errors.push(message.text());
  });
  await page.clock.install();
  await page.goto('/?probe');
  await openRehearsal(page, prismRehearsal());
  await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.setCameraPose([0, 5.4, 14], [0, 4, 0]);
    p.setRenderSettings({ bloom: 'off', prismPools: true, litPuffs: false });
    p.patchShowState({ focusMarkId: 'platform:main-deck' });
  });
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.beamAxes().filter((beam) => beam.optics.emitted > 0.001).length)).toBe(9);
  const plain = await page.evaluate(() => window.stageforgeProbe.poolFrusta());
  expect(plain.length).toBeGreaterThan(0);
  expect(plain.every(({ prism }) => prism.signedMix === 0)).toBe(true);
  await page.getByRole('button', { name: 'Show cues', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Cue 2, Apply prism' }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('prism');
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);

  for (const zoom of [0, 0.5, 1]) {
    const state = await page.evaluate((beamZoom) => {
      const p = window.stageforgeProbe;
      p.patchShowState({ beamZoom });
      p.stepAndReadLuminance(200);
      return { units: p.measureSnapshot().units, beams: p.beamPrisms(), pools: p.poolFrusta() };
    }, zoom);
    expect(state.beams.filter(({ topology }) => topology === 1)).toHaveLength(4);
    const [named] = state.units.filter(({ groupId }) => groupId === 'robe');
    expect(named.beamAngleDeg).toBeCloseTo(1.8 + zoom * (21 - 1.8), 8);
    for (const unit of state.units.filter(({ type }) => type === 'beam')) {
      const beam = state.beams.find(({ unitId }) => unitId === unit.unitId);
      // An explicit profile keeps its authored angle and still uses the catalogue prism.
      const isMegaPointe = ['robe', 'authored', 'robe-floor'].includes(unit.groupId);
      expect(beam.topology).toBe(isMegaPointe ? 1 : 0);
      expect(beam.mix).toBe(1);
      const { x, y, z } = unit.lensOrigin;
      const received = state.pools.find(({ lens }) => Math.hypot(lens[0] - x, lens[1] - y, lens[2] - z) < 1e-5);
      expect(received, `${unit.groupId} has a receiver at zoom ${zoom}`).toBeDefined();
      expect(received.prism.signedMix).toBe(isMegaPointe ? -1 : 1);
      expect(received.prism.phase).toBeCloseTo(beam.phase, 6);
    }
  }

  const images = await page.evaluate(async () => {
    const p = window.stageforgeProbe;
    p.setBatching(true);
    const batched = p.redrawAndCapture();
    const on = p.renderStats();
    const pools = p.redrawAndCapture({ hideBeams: true });
    p.setBatching(false);
    const ordinary = p.redrawAndCapture();
    p.setBatching(true);
    p.setRenderSettings({ prismPools: false });
    const withoutPrismPools = p.redrawAndCapture({ hideBeams: true });
    p.redrawAndCapture();
    const off = p.renderStats();
    const disabled = p.graphicsProbe().prismPools;
    p.setRenderSettings({ prismPools: true });
    const refilled = p.poolFrusta();
    p.simulateContextLoss(true);
    p.simulateContextLoss(false);
    const restored = p.poolFrusta();

    const decode = async (source) => {
      const img = new Image();
      img.src = source;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const diff = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / (a.length * 255);
    const [batchedPixels, ordinaryPixels, poolsPixels, noPrismPixels] = await Promise.all(
      [batched, ordinary, pools, withoutPrismPools].map(decode),
    );
    return { on, off, disabled, refilled, restored, batched, pools,
      aerialSignal: diff(batchedPixels, poolsPixels),
      poolSignal: diff(poolsPixels, noPrismPixels),
      parity: diff(batchedPixels, ordinaryPixels),
    };
  });
  await info.attach('linear-prism-preview', { body: Buffer.from(images.batched.split(',')[1], 'base64'), contentType: 'image/png' });
  await info.attach('linear-prism-receiver', { body: Buffer.from(images.pools.split(',')[1], 'base64'), contentType: 'image/png' });
  expect(images.aerialSignal).toBeGreaterThan(0.0001);
  expect(images.poolSignal).toBeGreaterThan(0.00001);
  expect(images.parity).toBeLessThan(images.aerialSignal * 0.15);
  expect(images.on.calls).toBe(images.off.calls);
  expect(images.on.textures).toBe(images.off.textures);
  expect(images.on.batching.proxied).toBe(6);
  expect(images.disabled.extraBufferBytes).toBe(0);
  expect(images.refilled.some(({ prism }) => prism.signedMix === -1)).toBe(true);
  expect(images.restored).toEqual(images.refilled);
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: 'Show files' }).press('Enter');
  const files = page.getByRole('dialog', { name: 'Show files' });
  const saving = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).press('Enter');
  const saved = JSON.parse(await readFile(await (await saving).path(), 'utf8'));
  expect(saved.cues.find(({ id }) => id === 'prism').state).toEqual({ goboPrism: true });
  expect(saved.look.goboPrism).toBe(true);
  await files.getByRole('button', { name: 'Close Show files' }).press('Enter');
  await openRehearsal(page, saved);
  const reopened = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    for (let i = 0; i < 3; i++) p.stepAndReadLuminance(200);
    const linear = p.beamPrisms().filter(({ topology, mix }) => topology === 1 && mix === 1).length;
    p.patchShowState({ blackout: true });
    p.stepAndReadLuminance(200);
    return { linear, beams: p.beamAxes().filter(({ optics }) => optics.emitted > 0).length, pools: p.poolFrusta().length };
  });
  expect(reopened).toEqual({ linear: 4, beams: 0, pools: 0 });
});

function dimmerRehearsal() {
  const file = rehearsal();
  const fixtures = file.rig.trussPods[0].fixtures;
  Object.assign(fixtures.find(({ id }) => id === 'robe'), { dmxMode: 'Mode 1 (Standard 16-bit)', dmxChannels: 39 });
  fixtures.find(({ id }) => id === 'generic').modelName = 'Robe MegaPointe';
  Object.assign(file.look, { masterDimmer: 1, beamZoom: 1, beamIntensity: 1, washIntensity: 0.65 });
  return file;
}

// Baseline-compatible: only established probe methods and legal show settings are used here.
test('Realism 7 deterministic six-buffer dimmer DMX observation', async ({ page }, info) => {
  test.setTimeout(120_000);
  await freeze(page);
  await openRehearsal(page, dimmerRehearsal());
  const ticks = [];
  const tick = async (name, beamIntensity, masterDimmer, blackout = false) => {
    const buffers = await page.evaluate(({ beamIntensity, masterDimmer, blackout }) => {
      const p = window.stageforgeProbe;
      p.patchShowState({ beamIntensity, masterDimmer, blackout });
      for (let i = 0; i < 3; i++) p.stepAndReadLuminance(200);
      return { simulated: p.dmxSnapshot(), physical: p.physicalDmxSnapshot(), serial: p.serialDmxSnapshot() };
    }, { beamIntensity, masterDimmer, blackout });
    for (const output of Object.values(buffers)) {
      expect(output.u1).toHaveLength(512);
      expect(output.u2).toHaveLength(512);
    }
    const byte = Math.round((blackout ? 0 : beamIntensity * masterDimmer) * 255);
    expect(buffers.simulated.u1[2]).toBe(byte);
    expect(buffers.simulated.u1[41]).toBe(byte);
    expect(buffers.simulated.u2[121]).toBe(byte);
    for (const output of [buffers.physical, buffers.serial]) {
      if (blackout || masterDimmer === 0) {
        expect(output.u1.every((x) => x === 0)).toBe(true);
        expect(output.u2.every((x) => x === 0)).toBe(true);
      } else {
        expect(output.u1.slice(179, 182).every((x) => x > 0)).toBe(true);
        expect(output.u2.slice(169, 172).every((x) => x > 0)).toBe(true);
      }
    }
    ticks.push({ name, ...buffers });
  };
  for (const level of [0, 0.25, 0.5, 0.75, 1]) await tick(`dimmer-${level}`, level, 1);
  await tick('half-master', 1, 0.5);
  await tick('zero-master', 1, 0);
  await tick('blackout', 1, 1, true);
  await tick('restore', 1, 1);
  await info.attach('realism7-dmx-bytes', { body: Buffer.from(JSON.stringify(ticks)), contentType: 'application/json' });
});

async function openDimmerPreview(page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.goto('/?probe');
  const file = dimmerRehearsal();
  file.look.focusMarkId = 'platform:main-deck';
  await openRehearsal(page, file);
  await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.setCameraPose([0, 5.4, 14], [0, 4, 0]);
    p.setRenderSettings({ bloom: 'off', litPuffs: false });
    p.setFullRateStrobePreview(true);
  });
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.beamAxes().filter((beam) => beam.optics.emitted > 0.001).length)).toBe(9);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  return file;
}

test('Realism 7 MegaPointe square-law preview reaches aerial, lens and receiver without changing Measure intent', async ({ page }, info) => {
  test.setTimeout(120_000);
  const file = await openDimmerPreview(page);
  const read = (level, master = 1) => page.evaluate(async ({ level, master, look }) => {
    const { evaluateStaticHeadMeasures } = await import('/src/data/measure.ts');
    const p = window.stageforgeProbe;
    const patch = { beamIntensity: level, washIntensity: level, masterDimmer: master };
    p.patchShowState(patch);
    p.stepAndReadLuminance(200);
    return { levels: p.beamLevels(), units: p.measureSnapshot().units, pools: p.poolFrusta(),
      cold: evaluateStaticHeadMeasures(p.rig(), { ...look, ...patch }) };
  }, { level, master, look: file.look });
  const catalogued = ['robe', 'robe-floor', 'authored'];
  const poolAt = (pools, { x, y, z }) => pools.find(({ lens }) => Math.hypot(lens[0] - x, lens[1] - y, lens[2] - z) < 1e-5);
  const full = await read(1);
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    const frame = await read(level);
    for (const unit of frame.units) {
      const isMegaPointe = catalogued.includes(unit.groupId);
      const expected = isMegaPointe ? level ** 2 : level;
      const actual = frame.levels.find(({ unitId }) => unitId === unit.unitId);
      const reference = full.levels.find(({ unitId }) => unitId === unit.unitId);
      expect(actual.squareLaw).toBe(isMegaPointe);
      expect(actual.preview).toBeCloseTo(expected, 8);
      expect(actual.aerial).toBeCloseTo(reference.aerial * expected, 7);
      expect(actual.pool).toBeCloseTo(reference.pool * expected, 7);
      for (const [i, channel] of actual.lens.entries()) expect(channel).toBeCloseTo(reference.lens[i] * expected, 7);
      const received = poolAt(frame.pools, unit.lensOrigin);
      const referencePool = poolAt(full.pools, unit.lensOrigin);
      if (level === 0) {
        expect(actual.visible).toBe(false);
        expect(received).toBeUndefined();
      } else if (unit.type === 'beam') {
        expect(received).toBeDefined();
        for (const [i, channel] of received.tint.entries()) expect(channel).toBeCloseTo(referencePool.tint[i] * expected, 6);
      }
      if (isMegaPointe) {
        const cold = frame.cold.find(({ unitId }) => unitId === unit.unitId);
        const fullLive = full.units.find(({ unitId }) => unitId === unit.unitId);
        const fullCold = full.cold.find(({ unitId }) => unitId === unit.unitId);
        expect(unit.luxLiveEst).toBeCloseTo(unit.luxFullEst * level, 6);
        expect(cold.luxLiveEst).toBeCloseTo(cold.luxFullEst * level, 6);
        expect(unit.warnings).toEqual(fullLive.warnings);
        expect(cold.warnings).toEqual(fullCold.warnings);
        // The saved optical override keeps its legacy lens estimate in cold Measure.
        if (unit.groupId !== 'authored') {
          expect(unit.luxLiveEst).toBeCloseTo(cold.luxLiveEst, 6);
          expect(unit.warnings).toEqual(cold.warnings);
        }
      }
    }
  }
  const halfDimmer = await read(0.5);
  const halfMaster = await read(1, 0.5);
  expect(halfMaster.levels).toEqual(halfDimmer.levels);
  expect(halfMaster.pools).toEqual(halfDimmer.pools);
  const zeroMaster = await read(1, 0);
  expect(zeroMaster.levels.every(({ preview, visible }) => preview === 0 && !visible)).toBe(true);
  expect(zeroMaster.pools).toEqual([]);

  const pixels = await page.evaluate(async () => {
    const p = window.stageforgeProbe;
    const decode = async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const captures = [];
    for (const level of [0.5, 1]) {
      p.patchShowState({ masterDimmer: 1, beamIntensity: level, washIntensity: level });
      p.stepAndReadLuminance(200);
      p.setBatching(true);
      const batched = p.redrawAndCapture();
      const on = p.renderStats();
      const hidden = p.redrawAndCapture({ hideBeams: true });
      p.setBatching(false);
      const ordinary = p.redrawAndCapture();
      p.setBatching(true);
      const [a, b, c] = await Promise.all([batched, hidden, ordinary].map(decode));
      const diff = (x, y) => x.reduce((sum, value, i) => sum + Math.abs(value - y[i]), 0) / (x.length * 255);
      captures.push({ level, batched, on, signal: diff(a, b), parity: diff(a, c) });
    }
    return captures;
  });
  for (const { level, batched, on, signal, parity } of pixels) {
    await info.attach(`square-law-${level}`, { body: Buffer.from(batched.split(',')[1], 'base64'), contentType: 'image/png' });
    expect(signal).toBeGreaterThan(0.0001);
    expect(parity).toBeLessThan(signal * 0.15);
    expect(on.batching.proxied).toBe(6);
    expect(on.batching.released).toBe(0);
  }
  expect(pixels[0].on.calls).toBe(pixels[1].on.calls);
  expect(pixels[0].on.textures).toBe(pixels[1].on.textures);

  const cache = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    const restore = () => {
      p.simulateContextLoss(true);
      p.simulateContextLoss(false);
      return p.poolFrusta();
    };
    const before = p.poolFrusta();
    p.setRenderSettings({ prismPools: true });
    const rebuilt = p.poolFrusta();
    const after = restore();
    p.patchShowState({ beamIntensity: 0.01, washIntensity: 0 });
    p.stepAndReadLuminance(200);
    const lowLevels = p.beamLevels().filter(({ squareLaw }) => squareLaw);
    const lowPools = p.poolFrusta();
    const lowRestored = restore();
    p.patchShowState({ beamIntensity: 1, washIntensity: 1, blackout: true });
    p.stepAndReadLuminance(200);
    const dark = p.beamLevels();
    const darkPools = restore();
    return { before, rebuilt, after, lowLevels, lowPools, lowRestored, dark, darkPools };
  });
  expect(cache.rebuilt.map(({ prism, ...entry }) => entry)).toEqual(cache.before);
  expect(cache.after).toEqual(cache.rebuilt);
  expect(cache.lowLevels).toHaveLength(4);
  for (const unit of cache.lowLevels) {
    expect(unit.preview).toBeCloseTo(0.0001, 8);
    expect(unit.visible).toBe(false);
    expect(unit.pool).toBeLessThan(0.001);
  }
  expect(cache.lowPools).toHaveLength(1);
  expect(cache.lowRestored).toEqual(cache.lowPools);
  expect(cache.dark.every(({ preview, aerial, pool, lens, visible }) =>
    preview === 0 && aerial === 0 && pool === 0 && lens.every((x) => x === 0) && !visible)).toBe(true);
  expect(cache.darkPools).toEqual([]);
});

test('Realism 7 MegaPointe square-law preview keeps mapped audio, demo and flash composition in order', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1000, height: 700 });
  await openDimmerPreview(page);
  const effects = await page.evaluate(async () => {
    const { getDemoPosition } = await import('/src/data/demoShow.ts');
    const p = window.stageforgeProbe;
    const audio = { playing: true, source: 'synth', trackName: 'Deterministic audio frame', energy: 1, bass: 1,
      mid: 0, high: 0, beat: true, beatPulse: 1, drop: false, spectrum: new Float32Array(32) };
    const id = p.measureSnapshot().units.find(({ groupId }) => groupId === 'robe').unitId;
    const preview = () => p.beamLevels().find(({ unitId }) => unitId === id).preview;
    const level = () => p.fixtureParams().beam.dimmer;
    p.patchShowState({ beamIntensity: 0.5, audioReactive: false, movingGroups: { beam: { primaryColor: '#00ffff' } } });
    p.stepAndReadLuminance(200);
    const addressed = { level: preview(), color: p.beamAxes()[p.measureSnapshot().units.findIndex(({ unitId }) => unitId === id)].rgb };
    p.patchShowState({ audioReactive: true, audioMap: { mappings: [] } });
    p.stepAndReadLuminance(200, audio);
    const amplified = { preview: preview(), boost: p.fixtureParams().legacyBoost };

    const strobePeak = (beamIntensity) => {
      p.patchShowState({ beamIntensity, strobeRate: 0.2 });
      let max = 0;
      for (let i = 0; i < 16; i++) {
        p.stepAndReadLuminance(16, audio);
        max = Math.max(max, preview());
      }
      return max;
    };
    const halfStrobe = strobePeak(0.5);
    const fullStrobe = strobePeak(1);
    p.patchShowState({ beamIntensity: 0.25, strobeRate: 0, audioMap: { mappings: [{
      id: 'test-energy', name: 'Energy', enabled: true, source: 'energy', target: { group: 'beam', param: 'dimmer' },
      amount: 0.25, attackMs: 10, releaseMs: 10, threshold: 0, curve: 'linear',
    }] } });
    p.stepAndReadLuminance(220, audio);
    p.stepAndReadLuminance(220, audio);
    const mapped = { command: level(), preview: preview(), active: p.audioModulation().active, boost: p.fixtureParams().legacyBoost };
    p.patchShowState({ beamIntensity: 0.05, audioReactive: false, autoDirector: true });
    p.stepAndReadLuminance(200, { ...audio, demo: getDemoPosition(192) });
    const directed = { command: level(), preview: preview() };

    p.setFullRateStrobePreview(false);
    p.setRenderSettings({ reducedEffects: true });
    p.patchShowState({ autoDirector: false, beamIntensity: 0.7 });
    for (let i = 0; i < 6; i++) p.stepAndReadLuminance(250);
    const reducedSteady = preview();
    const rises = [];
    let limited = false;
    let prev = preview();
    for (let i = 0; i < 40; i++) {
      p.patchShowState({ beamIntensity: i % 2 === 0 ? 1 : 0.7 });
      const frame = p.stepAndReadLuminance(50);
      const next = preview();
      if (next - prev > 0.1) rises.push(frame.elapsedMs);
      prev = next;
      limited ||= frame.previewFlashLimiting;
    }
    return { addressed, amplified, halfStrobe, fullStrobe, mapped, directed, reducedSteady, limited, rises };
  });
  expect(effects.addressed.color).toBe('00ffff');
  expect(effects.addressed.level).toBeCloseTo(0.25, 8);
  expect(effects.amplified.boost).toBeCloseTo(0.8, 8);
  const gain = 1 + 0.48 * effects.amplified.boost;
  expect(effects.amplified.preview).toBeCloseTo(0.25 * gain, 8);
  expect(effects.halfStrobe).toBeCloseTo(0.25 * 1.35 * gain, 8);
  expect(effects.fullStrobe).toBeCloseTo(1.6, 8);
  expect(effects.mapped.active).toBe(true);
  expect(effects.mapped.boost).toBe(0);
  expect(effects.mapped.command).toBeCloseTo(0.5, 7);
  expect(effects.mapped.preview).toBeCloseTo(effects.mapped.command ** 2, 7);
  expect(effects.directed.command).toBeGreaterThan(0.3);
  expect(effects.directed.preview).toBeCloseTo(effects.directed.command ** 2, 7);
  expect(effects.reducedSteady).toBeCloseTo(0.49, 7);
  expect(effects.limited).toBe(true);
  expect(effects.rises.length).toBeGreaterThan(0);
  for (const rise of effects.rises) {
    expect(effects.rises.filter((time) => time >= rise && time < rise + 1000).length).toBeLessThanOrEqual(3);
  }
});
