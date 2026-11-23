import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { createBlankDesign, getPlatforms, makeTrussPath, podWorldPoint, stageSurfaceHeight, withPlatforms } =
  await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { parseRigJson } = await compiler.ssrLoadModule('/src/data/rigImport.ts');
const { RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { buildDmxPatch } = await compiler.ssrLoadModule('/src/data/dmxPatch.ts');

test('existing rigs round-trip, and an empty design has no deck', () => {
  for (const rig of Object.values(RIG_TEMPLATES)) {
    assert.deepEqual(parseRigJson(JSON.stringify(rig)), rig);
    assert.equal(getPlatforms(rig).length, 1);
    assert.equal(stageSurfaceHeight(rig, 0, 0), rig.stageHeight);
    const blankRoom = createBlankDesign(rig);
    assert.deepEqual([blankRoom.venue, blankRoom.stageWidth, blankRoom.stageDepth], [rig.venue, rig.stageWidth, rig.stageDepth]);
    assert.deepEqual(getPlatforms(blankRoom), []);
  }
  const blank = createBlankDesign();
  assert.deepEqual(getPlatforms(blank), []);
  assert.equal(stageSurfaceHeight(blank, 0, 0), 0);
});

test('the deck surface follows module heights, overlap and gaps', () => {
  const rig = withPlatforms(createBlankDesign(), [
    { id: 'main', name: 'Main', x: 0, z: 0, width: 8, depth: 4, height: 1 },
    { id: 'wing', name: 'Wing', x: 3, z: 1, width: 4, depth: 2, height: 2 },
  ]);
  assert.equal(stageSurfaceHeight(rig, -3, 1), 1);
  assert.equal(stageSurfaceHeight(rig, 3, 1), 2);
  assert.equal(stageSurfaceHeight(rig, 4.5, -1), 0);
  assert.equal(stageSurfaceHeight(rig, 4.5, 1), 2);
  assert.deepEqual(parseRigJson(JSON.stringify(rig)), rig);
});

test('a bent truss preserves its drawing and fixture patch through save and reload', () => {
  const points = [{ x: 2, z: -4 }, { x: 7, z: -4 }, { x: 7, z: -1 }];
  const pod = makeTrussPath(points, 6);
  pod.fixtures.push({ id: 'spots', type: 'beam', modelName: 'Spots', count: 2, dmxUniverse: 2, dmxStartChannel: 481 });
  const rig = createBlankDesign();
  rig.trussPods = [pod];
  const restored = parseRigJson(JSON.stringify(rig));
  const saved = restored.trussPods[0];
  assert.equal(saved.id, pod.id);
  assert.equal(saved.width, 8);
  assert.deepEqual(saved.path.map(point => podWorldPoint(saved, point)), points);
  const patch = buildDmxPatch(restored);
  assert.equal(patch.unitStart(saved.fixtures[0], 1), 497);
  assert.equal(patch.rows[0].end, 512);
});
