import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const source = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url)));
const floor = { id: 'floor-lasers', type: 'floor_laser', modelName: 'Test RGB projector',
  count: 2, x: 0, z: 2, spread: 4, dmxUniverse: 2, dmxStartChannel: 1 };
const first = JSON.stringify([null, floor.id, 1]);
const second = JSON.stringify([null, floor.id, 2]);

test('per-projector beams, pattern resolution and two independent colors survive a saved cue', async ({ page }) => {
  const show = structuredClone(source);
  show.rig.floorFx = [floor];
  await page.goto('/');
  const button = name => page.getByRole('button', { name, exact: true });
  const files = page.getByRole('dialog', { name: 'Show files' });
  const open = async data => {
    await button('Show files').click();
    await files.getByLabel('Open show file').setInputFiles({ name: 'lasers.stageforge.show.json',
      mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
    await expect(files).toBeHidden();
  };
  await open(show);
  await button('Lasers').click();
  const target = page.getByLabel('Laser projector', { exact: true });
  const count = page.getByLabel('Beams per projector', { exact: true });
  const resolution = page.getByLabel('Laser pattern resolution');
  const mode = page.getByLabel('Laser color mode');
  await count.fill('9');
  await target.selectOption(first);
  await count.fill('1');
  await resolution.selectOption('8');
  await mode.selectOption('custom_dual');
  await page.getByLabel('Laser color A').fill('#44cc88');
  await page.getByLabel('Laser color B').fill('#cc4499');
  await target.selectOption(second);
  await expect(count).toHaveValue('9');
  await expect(resolution).toHaveValue('48');
  await button('Show cues').click();
  await button('Store cue').click();
  await page.locator('.cue-pad').last().click();
  await button('Show files').click();
  const saving = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const saved = JSON.parse(await readFile(await (await saving).path(), 'utf8'));
  await files.getByRole('button', { name: 'Close Show files' }).click();
  expect(saved.version).toBe(2);
  expect(saved.cues.at(-1).state.laser.projectors).toEqual({ [first]: {
    beamCount: 1, patternSegments: 8, colorMode: 'custom_dual', colorA: '#44cc88', colorB: '#cc4499',
  } });
  await open(saved);
  await button('Show cues').click();
  await page.locator('.cue-pad').last().click();
  await button('Lasers').click();
  await target.selectOption(first);
  await expect(count).toHaveValue('1');
  await expect(page.getByLabel('Laser color B')).toHaveValue('#cc4499');
  await button('Use all-projector defaults').click();
  await expect(count).toHaveValue('9');
  await expect(resolution).toHaveValue('48');
});

test('projector settings drive individual WebGL surfaces, color uniforms and simulated DMX counts', async ({ page }) => {
  await page.route('**/laser-check', route => route.fulfill({ contentType: 'text/html',
    body: '<div id="stage" style="width:240px;height:150px"></div>' }));
  await page.goto('/laser-check');
  const result = await page.evaluate(async ({ floor, first, second }) => {
    const { StageEngine } = await import('/src/engine/StageEngine.ts');
    const { INITIAL_SHOW_STATE, RIG_TEMPLATES } = await import('/src/data/presets.ts');
    const rig = structuredClone(RIG_TEMPLATES.club_stage);
    rig.floorFx = [floor]; rig.trussPods = []; rig.audioRig.crowdDensity = 0;
    const state = structuredClone(INITIAL_SHOW_STATE);
    state.autoDirector = false; state.blackout = false; state.masterDimmer = 1;
    Object.assign(state.laser, { enabled: true, intensity: 1, pattern: 'dual_cones', beamCount: 9,
      patternSegments: 96, colorMode: 'custom_dual', colorA: '#ee2288', colorB: '#6699cc',
      projectors: { [first]: { beamCount: 1, patternSegments: 8, colorMode: 'custom', colorA: '#11ee33' } } });
    const audio = { playing: false, source: 'none', trackName: '', energy: 0, bass: 0, mid: 0,
      high: 0, beat: false, beatPulse: 0, drop: false, spectrum: new Float32Array(32) };
    const engine = new StageEngine(document.querySelector('#stage'), rig, state, () => audio);
    engine.previewRig();
    function sample() {
      engine.updateScene(1/60, audio);
      return engine.laserUnits.map(l => ({ key: l.key, sheet: l.sheetMesh.geometry.parameters.widthSegments,
        cone: l.coneMesh.geometry.parameters.radialSegments, outerCount: l.coneMat.uniforms.uBeamCount.value,
        innerCount: l.innerConeMesh.visible ? l.innerConeMat.uniforms.uBeamCount.value : 0,
        a: l.sheetMat.uniforms.uColorA.value.getHexString(), b: l.sheetMat.uniforms.uColorB.value.getHexString(),
        intensity: l.sheetMat.uniforms.uIntensity.value, dmx: engine.dmxUniverse2[l.dmxStart + 5] }));
    }
    const dual = sample();
    engine.setShowState({ ...state, laser: { ...state.laser, pattern: 'wave',
      projectors: { ...state.laser.projectors, [second]: { patternSegments: 16 } } } });
    const wave = sample();
    engine.setShowState({ ...state, masterDimmer: 0.25 });
    const quarter = sample();
    engine.setShowState({ ...state, blackout: true });
    engine.setBumpState({ ...engine.currentBump, laser: true });
    const blackout = sample();
    const visible = engine.laserUnits.some(l => l.sheetMesh.visible || l.coneMesh.visible || l.innerConeMesh.visible);
    engine.dispose();
    return { dual, wave, quarter, blackout, visible };
  }, { floor, first, second });
  expect(result.dual).toMatchObject([
    { key: first, sheet: 8, cone: 8, outerCount: 1, innerCount: 0, a: '11ee33', b: '11ee33', dmx: 8 },
    { key: second, sheet: 96, cone: 96, outerCount: 5, innerCount: 4, a: 'ee2288', b: '6699cc', dmx: 72 },
  ]);
  expect(result.wave[1]).toMatchObject({ sheet: 16, cone: 16, a: 'ee2288', b: '6699cc',
    intensity: result.dual[1].intensity, dmx: 72 });
  expect(result.quarter.map(l => l.intensity)).toEqual([0.25, 0.25]);
  expect(result.blackout.map(l => l.intensity)).toEqual([0, 0]);
  expect(result.visible).toBe(false);
});
