import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Sprint 22 near-eye fade is per-eye shader data on beams, procedural lasers, and ILDA ribbons', async () => {
  const shaders = await readFile(new URL('../src/engine/shaders.ts', import.meta.url), 'utf8');
  const ilda = await readFile(new URL('../src/engine/ildaScanEnergy.ts', import.meta.url), 'utf8');
  assert.equal((shaders.match(/smoothstep\(0\.30, 1\.00, length\(cameraPosition - vWorld\)\)/g) ?? []).length, 3);
  assert.match(ilda, /ILDA_SCAN_ENERGY_NEAR_FADE_START_M = 0\.30/);
  assert.match(ilda, /ILDA_SCAN_ENERGY_NEAR_FADE_END_M = 1\.0/);
});

test('WebXR remains device-local, default off, lazy, browser-only, and outside show schemas', async () => {
  const settings = await readFile(new URL('../src/engine/renderSettings.ts', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(settings, /webxrAudience: false/);
  assert.match(app, /import\('\.\/xr\/webXrAudience'\)/);
  assert.match(app, /!window\.stageforgeDesktop/);
  assert.match(app, /isSessionSupported\('immersive-vr'\)/);
  assert.equal(Object.keys(packageJson.dependencies).some((name) => /iwer|webxr/i.test(name)), false);
});

test('WebXR physical-output interlocks use both UI phase and renderer lease authority', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const engine = await readFile(new URL('../src/engine/StageEngine.ts', import.meta.url), 'utf8');
  assert.match(app, /webXrBlocksPhysicalOutput\(webXrPhaseRef\.current\)[\s\S]{0,120}engineRef\.current\?\.isWebXrPhysicalOutputInterlocked\(\)/);
  assert.match(engine, /if \(listener && \(this\.disposed \|\| this\.webXrLease \|\| this\.webXrPhysicalOutputInterlock\)\)/);
});
