import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'vite';

let server;
let atmosphere;
let settings;

before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  atmosphere = await server.ssrLoadModule('/src/engine/atmosphereLook.ts');
  settings = await server.ssrLoadModule('/src/engine/renderSettings.ts');
});

after(async () => {
  await server?.close();
});

const activePolicy = { requested: true, active: true, suppressedReason: null };

function activeController() {
  const controller = new atmosphere.AtmosphereLookController(0.001, 0.002, 0.004);
  controller.setPolicy(activePolicy);
  return controller;
}

describe('Sprint 23D: dark fixture-palette global atmosphere', () => {
  it('uses a frame-rate-independent two-second response and bounded dark linear colour', () => {
    const one = activeController();
    one.beginFrame(); one.addFixture(1, 0, 0, 1, 1); one.step(0.25, 1, 1, 1, false, false);
    const target = one.getStats().target;
    for (let i = 1; i < 8; i++) {
      one.beginFrame(); one.addFixture(1, 0, 0, 1, 1); one.step(0.25, 1, 1, 1, false, false);
    }
    const afterTwoSeconds = one.getStats();
    const expectedR = 0.001 + (target[0] - 0.001) * (1 - Math.exp(-1));
    assert.ok(Math.abs(afterTwoSeconds.current[0] - expectedR) < 1e-10);
    assert.equal(afterTwoSeconds.timeConstantSec, 2);
    assert.ok(Math.max(...afterTwoSeconds.target) <= atmosphere.ATMOSPHERE_MAX_CHANNEL + 1e-12);
    const luma = 0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2];
    assert.ok(luma <= atmosphere.ATMOSPHERE_MAX_LUMINANCE + 1e-12);
  });

  it('weights opposing authored palettes without strobe, preview or flux inputs', async () => {
    const controller = activeController();
    controller.beginFrame();
    controller.addFixture(1, 0, 0, 1, 1);
    controller.addFixture(0, 0, 1, 1, 1);
    controller.step(0.1, 1, 1, 1, false, false);
    const stats = controller.getStats();
    assert.deepEqual(stats.palette, [0.5, 0, 0.5]);
    assert.equal(stats.sumWeight, 2);
    assert.equal(stats.active, true);

    const source = await readFile(new URL('../src/engine/StageEngine.ts', import.meta.url), 'utf8');
    assert.match(source, /atmosphereLook\.addFixture\(tempCol\.r, tempCol\.g, tempCol\.b, dimmer, master\)/);
    assert.doesNotMatch(source, /atmosphereLook\.addFixture\([^\n]*(groupStrobeGate|preview|fluxRatio|groupGain)/);
  });

  it('snaps to neutral for zero haze, blackout, master zero, no active fixtures and accessibility fallbacks', () => {
    const controller = activeController();
    controller.beginFrame(); controller.addFixture(0, 1, 0, 1, 1);
    controller.step(0.25, 1, 1, 1, false, false);
    assert.equal(controller.getStats().active, true);

    for (const [reason, input, add] of [
      ['zero-haze', { haze: 0, master: 1, blackout: false, darkOpening: false }, true],
      ['blackout', { haze: 1, master: 0, blackout: true, darkOpening: false }, true],
      ['master-dimmer', { haze: 1, master: 0, blackout: false, darkOpening: false }, true],
      ['no-active-fixtures', { haze: 1, master: 1, blackout: false, darkOpening: false }, false],
    ]) {
      controller.beginFrame();
      if (add) controller.addFixture(0, 1, 0, 1, input.master);
      controller.step(0.1, input.haze, input.master, 0.5, input.blackout, input.darkOpening);
      const stats = controller.getStats();
      assert.equal(stats.suppressedReason, reason);
      assert.deepEqual(stats.current, [0.001, 0.002, 0.004]);
      assert.deepEqual(stats.applied, [0.0005, 0.001, 0.002]);
    }

    const base = { ...settings.DEFAULT_RENDER_SETTINGS, lookAtmosphere: true, lookOutput: true };
    assert.deepEqual(settings.resolveEffectiveAtmosphere(base, 'high', false), activePolicy);
    assert.equal(settings.resolveEffectiveAtmosphere({ ...base, trueColour: true }, 'high', false).suppressedReason, 'true-colour');
    assert.equal(settings.resolveEffectiveAtmosphere({ ...base, reducedEffects: true }, 'high', false).suppressedReason, 'reduced-effects');
    assert.equal(settings.resolveEffectiveAtmosphere(base, 'low', false).suppressedReason, 'reduced-effects');
    assert.equal(settings.resolveEffectiveAtmosphere(base, 'high', true).suppressedReason, 'reduced-effects');
  });

  it('keeps the flag device-local and reports zero GPU/draw/pass ownership', async () => {
    assert.equal(settings.DEFAULT_RENDER_SETTINGS.lookAtmosphere, true);
    assert.equal(settings.parseRenderSettings({ lookAtmosphere: true }).lookAtmosphere, true);
    assert.equal(settings.parseRenderSettings({ lookAtmosphere: 'yes' }).lookAtmosphere, true);
    const stats = activeController().getStats();
    assert.equal(stats.extraGpuBytes, 0);
    assert.equal(stats.addedDraws, 0);
    assert.equal(stats.addedPasses, 0);
    for (let version = 1; version <= 14; version++) {
      const schema = await readFile(new URL(`../src/schemas/show-v${version}.schema.json`, import.meta.url), 'utf8');
      assert.ok(!schema.includes('lookAtmosphere'));
    }
  });
});
