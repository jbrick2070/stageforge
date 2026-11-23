import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const THREE = await compiler.ssrLoadModule('three');
const { buildVenueArchitecture } = await compiler.ssrLoadModule('/src/engine/geometryBuilders.ts');
const { RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { buildDmxPatch } = await compiler.ssrLoadModule('/src/data/dmxPatch.ts');

// The venue shell only needs plain materials; the canvas-textured ones are for the deck and PA.
const mats = new Proxy({}, { get: (cache, key) => (cache[key] ??= new THREE.MeshStandardMaterial()) });
const build = (rig) =>
  buildVenueArchitecture(rig.venue, rig.audioRig.crowdDensity, mats, rig.stageWidth, rig.stageDepth, rig.stageHeight);

test('every preset patches without DMX conflicts', () => {
  for (const [key, rig] of Object.entries(RIG_TEMPLATES)) {
    for (const row of buildDmxPatch(rig).rows) {
      assert.deepEqual(row.conflicts, [], `${key}: ${row.group.id} overlaps another fixture`);
      assert.ok(row.end <= 512, `${key}: ${row.group.id} runs past channel 512`);
    }
  }
});

test('the small theatre: electrics upstage of the proscenium, FOH bridge in the house, a seated rake', () => {
  const rig = RIG_TEMPLATES.small_theatre;
  const venue = build(rig);
  const front = rig.stageDepth / 2,
    prosZ = front - 1.5;
  assert.ok(venue.room && venue.seated);

  for (const pod of rig.trussPods) {
    if (pod.name === 'FOH Bridge') {
      assert.ok(pod.z > prosZ && pod.baseY < venue.room.ceilingY - 1, 'front light hangs in the house');
    } else {
      assert.ok(pod.z < prosZ && pod.baseY < 7.6, `${pod.name} is visible through the proscenium opening`);
    }
  }

  const audience = venue.crowdBaseTransforms;
  assert.ok(audience.length > 200, `expected a few hundred seated, got ${audience.length}`);
  assert.ok(audience.every((p) => p.z > front + 3 && Math.abs(p.x) < venue.room.halfWidth && p.y >= 0));
  // The stalls are raked: the back row sits higher than the front row.
  const ys = audience.map((p) => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1.5);
});

test('the club: everything fits under a low ceiling and the crowd stands inside the walls', () => {
  const rig = RIG_TEMPLATES.club_stage;
  const venue = build(rig);
  assert.ok(venue.room && !venue.seated);
  assert.ok(venue.room.ceilingY < 6, 'a club is a low room');
  for (const pod of rig.trussPods) assert.ok(pod.baseY <= venue.room.ceilingY - 0.8, `${pod.name} clears the soffit`);
  const ledTop = rig.stageHeight + 0.35 + rig.ledWall.height;
  assert.ok(ledTop < rig.trussPods[1].baseY - 0.5, 'the LED wall sits under the upstage truss');

  assert.equal(venue.crowdBaseTransforms.length, Math.floor(300 * rig.audioRig.crowdDensity));
  for (const p of venue.crowdBaseTransforms) {
    assert.ok(Math.abs(p.x) < venue.room.halfWidth && p.z > rig.stageDepth / 2 && p.z < venue.room.rearZ && p.y === 0);
  }
});

test('arena, warehouse and festival keep their open framing and standing crowd', () => {
  for (const key of ['arena_mainstage', 'warehouse_rave', 'festival_mega']) {
    const rig = RIG_TEMPLATES[key];
    const venue = build(rig);
    assert.equal(venue.room, null);
    assert.equal(venue.seated, false);
    assert.equal(venue.crowdBaseTransforms.length, Math.floor(680 * rig.audioRig.crowdDensity));
  }
});
