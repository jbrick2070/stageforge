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
  await freeze(page);
  const file = rehearsal();
  await openRehearsal(page, file);
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
      return { beams, live, cold, pools, stats, signal: diff(on, noBeams), parity: diff(on, off), batched };
    }, { look: file.look, zoom });

    expect(result.beams).toHaveLength(5);
    expect(result.stats.batching.proxied).toBe(6); // Two MegaPointes, two Rogues and two identical PARs.
    expect(result.stats.batching.released).toBe(0);
    if (previous) {
      expect(result.stats.calls).toBe(previous.calls);
      expect(result.stats.textures).toBe(previous.textures);
    }
    previous = result.stats;
    expect(result.signal).toBeGreaterThan(0.0001);
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
    await info.attach(`zoom-${zoom}`, { body: Buffer.from(result.batched.split(',')[1], 'base64'), contentType: 'image/png' });
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
