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
const { calculateProductionEstimate } = await compiler.ssrLoadModule('/src/data/productionEstimator.ts');
const { parseRigJson } = await compiler.ssrLoadModule('/src/data/rigImport.ts');
const { monitorPositions, ledPlacement } = await compiler.ssrLoadModule('/src/data/stageEquipment.ts');

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

test('floor-only venues and decks above the grid keep finite equipment positions', () => {
  const club = Object.values(RIG_TEMPLATES).find(r => r.venue === 'club');
  const rig = { ...club, platforms: [], audioRig: { ...club.audioRig, monitorCount: 1 } };
  assert.deepEqual(monitorPositions(rig).map(m => [m.x, m.y, m.rotationY]), [[0, 0, 0]]);
  assert.ok(ledPlacement(rig).height > 0);
  rig.platforms = [{ id: 'offset', name: 'Offset', x: 12, z: 3, width: 4, depth: 2, height: 5.3 }];
  const [monitor] = monitorPositions(rig);
  assert.equal(monitor.x, 12);
  assert.equal(monitor.rotationY, 0);
  const wall = ledPlacement(rig);
  assert.equal(wall.x, 12);
  assert.equal(wall.height, 0);
  const { wing, ...main } = wall;
  assert.ok([...Object.values(main), ...Object.values(wing)].every(Number.isFinite));
});

test('cabinet counts, pixel canvases and inventory follow the installed main wall and wings', () => {
  const club = Object.values(RIG_TEMPLATES).find(r => r.venue === 'club');
  const cabinets = { widthMm: 500, heightMm: 500, pixelsWide: 128, pixelsHigh: 96, columns: 24, rows: 15 };
  const rig = { ...club, stageWidth: 12, stageHeight: 1,
    ledWall: { enabled: true, width: 12, height: 7.5, curved: false, sideWings: true, cabinets } };
  const wall = ledPlacement(rig);
  assert.deepEqual([wall.columns, wall.rows, wall.width, wall.height], [24, 7, 12, 3.5]);
  assert.deepEqual([wall.pixelsWide, wall.pixelsHigh], [3072, 672]);
  assert.deepEqual([wall.wing.columns, wall.wing.rows, wall.wing.pixelsWide, wall.wing.pixelsHigh], [3, 6, 384, 576]);
  const inventory = calculateProductionEstimate(rig).equipmentItems.find(i => i.category === 'LED Video');
  assert.equal(inventory.qty, '204 cabinets · 51 m²');
  assert.equal(inventory.watts, 51 * 580);
  const opened = parseRigJson(JSON.stringify(rig));
  const handEdited = structuredClone(rig);
  handEdited.ledWall.cabinets.columns = 10;
  assert.equal(parseRigJson(JSON.stringify(handEdited)).ledWall.width, 5);
  const full = ledPlacement({ ...opened, venue: 'arena' });
  assert.deepEqual([full.columns, full.rows], [24, 15]);
  cabinets.rows = 1.5;
  assert.throws(() => parseRigJson(JSON.stringify(rig)), /ledWall.cabinets.rows/);
  cabinets.rows = 15;
  const aboveGrid = { ...rig, stageHeight: 6 };
  assert.equal(ledPlacement(aboveGrid).wing.columns, 0);
  assert.ok(!calculateProductionEstimate(aboveGrid).equipmentItems.some(i => i.category === 'LED Video'));

  const legacy = structuredClone(rig);
  delete legacy.ledWall.cabinets;
  const fitted = ledPlacement(legacy);
  assert.ok(Math.abs(fitted.width / fitted.height - 12 / 7.5) < 1e-9);
  const fittedArea = fitted.width * fitted.height + 2 * fitted.wing.width * fitted.wing.height;
  assert.equal(calculateProductionEstimate(legacy).equipmentItems.find(i => i.category === 'LED Video').watts,
    Math.round(fittedArea * 580));
});

test('a wide theatre plan keeps its dimensions and a bounded seating sample', () => {
  const rig = RIG_TEMPLATES.small_theatre;
  const venue = build({ ...rig, stageWidth: 240, audioRig: { ...rig.audioRig, crowdDensity: 1 } });
  assert.ok(venue.room.halfWidth >= 120);
  assert.ok(venue.crowdBaseTransforms.length > 300);
  assert.ok(venue.crowdBaseTransforms.length <= 14 * 96);
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
