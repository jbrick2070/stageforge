import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const template = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));

function rehearsal() {
  const file = structuredClone(template);
  file.version = 9;
  file.$schema = 'https://jbrick2070.github.io/stageforge/schemas/show-v9.schema.json';
  const pod = file.rig.trussPods[0];
  const etc = (id, modelName, dmxUniverse, dmxStartChannel) => ({
    id, modelName, dmxUniverse, dmxStartChannel, type: 'wash', count: 1,
    catalogId: 'etc-colorsource-par', dmxMode: 'RGB (3-Ch)', dmxChannels: 3,
  });
  file.rig.trussPods = [
    { ...pod, id: 'floor', name: 'Red truss', z: 0, fixtures: [etc('x:y', 'Red ETC', 1, 101)] },
    { ...pod, id: 'floor:x', name: 'Cyan truss', z: -1, fixtures: [etc('y', 'Cyan ETC', 2, 41)] },
  ];
  file.rig.floorFx = [{ id: 'x:y', type: 'floor_beam', modelName: 'Floor pair', count: 2,
    dmxUniverse: 2, dmxStartChannel: 488, x: 0, z: -1, spread: 1 }];
  file.rig.ledWall.enabled = false;
  file.rig.audioRig.crowdDensity = 0;
  Object.assign(file.look, {
    autoDirector: false, audioReactive: false, masterDimmer: 0.8, washIntensity: 0.75, beamIntensity: 0.5,
    blackout: false, movementMode: 'manual', movementSpeed: 0, manualPan: 0, manualTilt: 0, focusMarkId: null,
    colorSplitMode: 'alternate', primaryColor: '#ff0000', accentColor: '#00ffff', strobeRate: 0,
  });
  file.cues = [{ id: 'look', name: 'Steady', tag: 'SHOW', accent: '#ffffff', state: { beamIntensity: 0.5 } }];
  file.activeCueId = 'look';
  delete file.timeline;
  delete file.media;
  return file;
}

async function openShow(page, show) {
  await page.getByRole('button', { name: 'Show files', exact: true }).press('Enter');
  const files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles({
    name: 'scoped.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(show)),
  });
  await expect(files).toBeHidden();
}

test('P1 Patch view and both Measure paths distinguish scoped fixtures and valid siblings', async ({ page }) => {
  await page.goto('/?probe');
  const show = rehearsal();
  await openShow(page, show);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe?.beamAxes().length)).toBe(4);
  const records = await page.evaluate(async (look) => {
    const { evaluateStaticHeadMeasures } = await import('/src/data/measure.ts');
    const p = window.stageforgeProbe;
    const live = p.measureSnapshot().units;
    const cold = evaluateStaticHeadMeasures(p.rig(), look);
    return { authored: p.patchOccupancy(), resolved: p.patchOccupancy('resolved'), live, cold };
  }, show.look);
  expect(records.authored.context).toBe('authored');
  expect(records.resolved.context).toBe('resolved');
  expect(records.resolved.units.every(({ placed }) => placed)).toBe(true);
  expect(records.authored.units).toEqual(records.resolved.units.map(({ placed, ...unit }) => unit));
  expect(records.resolved.units.map(({ unitId, effectiveStart }) => [JSON.parse(unitId), effectiveStart])).toEqual([
    [['pod', 'floor', 'x:y', 0], 101], [['pod', 'floor:x', 'y', 0], 41],
    [['floor', 'x:y', 0], 488], [['floor', 'x:y', 1], 0],
  ]);
  for (const measure of [records.live, records.cold]) {
    expect(measure.map(({ unitId, groupKey }) => [unitId, groupKey])).toEqual(
      records.resolved.units.map(({ unitId, groupKey }) => [unitId, groupKey]),
    );
  }

  await page.getByRole('button', { name: 'DMX monitor', exact: true }).click();
  const drawer = page.getByRole('complementary', { name: 'DMX monitor', exact: true });
  await drawer.getByRole('button', { name: 'UNIVERSE 2', exact: true }).click();
  await drawer.getByRole('button', { name: 'PATCH', exact: true }).click();
  const floor = drawer.locator('details').filter({ hasText: 'Floor pair ×2' });
  await floor.locator('summary').click();
  await expect(floor.getByTestId('dmx-patch-unit')).toHaveText([
    '#1 · U2.488–503 · Patch valid', '#2 · U2.504–519 · Overflow · Output disabled',
  ]);
  await drawer.getByRole('button', { name: 'Close DMX monitor' }).click();

  // Replacing the native layout clears installed fixtures and keeps the authored occupancy visible.
  show.stage = { format: 'stageforge-native-stage', version: 1, walls: [], screenEvents: [], layout: { replace: true } };
  await openShow(page, show);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.patchOccupancy('resolved').units.length)).toBe(0);
  expect(await page.evaluate(() => window.stageforgeProbe.patchOccupancy().units.length)).toBe(4);
});

test('P1 valid scoped ETC heads sustain independent preview and delivered RGB governor history', async ({ page }) => {
  const time = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1000));
  await page.goto('/?probe');
  await openShow(page, rehearsal());
  const frames = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    p.setCameraPose([0, 4, 12], [0, 2, 0]);
    for (let i = 0; i < 3; i++) p.stepAndReadLuminance(200);
    return Array.from({ length: 12 }, () => {
      p.stepAndReadLuminance(16);
      const physical = p.physicalDmxSnapshot();
      const serial = p.serialDmxSnapshot();
      const sim = p.dmxSnapshot();
      return {
        colors: p.beamAxes().slice(0, 2).map(({ rgb }) => rgb),
        physical: [physical.u1.slice(100, 103), physical.u2.slice(40, 43)],
        serial: [serial.u1.slice(100, 103), serial.u2.slice(40, 43)],
        simulated: [sim.u1[102], sim.u2[42]],
        validFloor: sim.u2[489],
        invalidFloor: sim.u2.slice(503),
      };
    });
  });
  for (const frame of frames) {
    expect(frame.colors).toEqual(['ff0000', '00ffff']);
    expect(frame.physical).toEqual([[153, 0, 0], [0, 153, 153]]);
    expect(frame.serial).toEqual(frame.physical);
    expect(frame.simulated).toEqual([153, 153]);
    expect(frame.validFloor).toBeGreaterThan(0);
    expect(frame.invalidFloor).toEqual(Array(9).fill(0));
  }
});
