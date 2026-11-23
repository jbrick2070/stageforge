import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true } });
after(() => vite.close());
const { INITIAL_SHOW_STATE, RIG_TEMPLATES } = await vite.ssrLoadModule('/src/data/presets.ts');
const { makeShowFile, parseShowFile } = await vite.ssrLoadModule('/src/data/showFile.ts');
const { cueLook } = await vite.ssrLoadModule('/src/data/cueLook.ts');
const { applyDemoLighting } = await vite.ssrLoadModule('/src/data/demoLighting.ts');
const { getDemoPosition } = await vite.ssrLoadModule('/src/data/demoShow.ts');
const { laserProjectors } = await vite.ssrLoadModule('/src/data/laserProjectors.ts');

test('an older cue with a complete laser look clears newer projector settings; an unrelated cue inherits them', () => {
  const rig = RIG_TEMPLATES.club_stage;
  const key = laserProjectors(rig)[0].key;
  const laser = { ...INITIAL_SHOW_STATE.laser, projectors: { [key]: { beamCount: 1, patternSegments: 8 } } };
  const live = { ...INITIAL_SHOW_STATE, laser };
  assert.deepEqual(cueLook(live, { state: { laser: INITIAL_SHOW_STATE.laser } }).laser, INITIAL_SHOW_STATE.laser);
  assert.equal(cueLook(live, { state: { primaryColor: '#ff4400' } }).laser, laser);
  const finale = applyDemoLighting(live, getDemoPosition(896));
  assert.equal(finale.laser.beamCount, 18);
  assert.equal(finale.laser.projectors, undefined);
  const cue = { id: 'mine', name: 'Lasers', tag: 'USER', accent: '#00ffff', state: { laser } };
  const edited = makeShowFile(rig, [cue], live, cue.id);
  assert.equal(edited.version, 2);
  assert.deepEqual(parseShowFile(JSON.stringify(edited)).cues[0].state.laser, laser);
  const invalid = structuredClone(edited);
  invalid.look.laser.projectors[key].patternSegments = 49;
  assert.throws(() => parseShowFile(JSON.stringify(invalid)), /unsupported/);
  const noLaser = { ...rig, trussPods: [], floorFx: [] };
  assert.throws(() => parseShowFile(JSON.stringify({ ...edited, rig: noLaser })), /unknown laser projector/);
  const pruned = makeShowFile(noLaser, [cue], live, cue.id);
  assert.equal(pruned.version, 1);
  assert.equal(pruned.look.laser.projectors, undefined);
  assert.equal(pruned.cues[0].state.laser.projectors, undefined);
});
