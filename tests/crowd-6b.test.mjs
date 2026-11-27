import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const crowd = await compiler.ssrLoadModule('/src/data/crowdPlacement.ts');
const models = await compiler.ssrLoadModule('/src/data/crowdModels.ts');
const showFiles = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { RIG_TEMPLATES, INITIAL_SHOW_STATE } = await compiler.ssrLoadModule('/src/data/presets.ts');
const geometry = await compiler.ssrLoadModule('/src/engine/geometryBuilders.ts');
const lighting = await compiler.ssrLoadModule('/src/engine/crowdLighting.ts');

const arena = structuredClone(RIG_TEMPLATES.arena_mainstage);
const theatre = structuredClone(RIG_TEMPLATES.small_theatre);

function write(rig, layout) {
  return showFiles.makeShowFile(rig, [], structuredClone(INITIAL_SHOW_STATE), null,
    undefined, undefined, undefined, undefined, undefined, layout);
}

test('authored crowd generation is reproducible, bounded, and uses independent selection domains', () => {
  const layout = crowd.makeDefaultCrowd(arena);
  const first = crowd.resolveCrowdLayout(arena, layout);
  const second = crowd.resolveCrowdLayout(arena, structuredClone(layout));
  assert.deepEqual(second, first);
  assert.equal(first.placed, 640);
  assert.ok(first.placed <= models.CROWD_MAX_AUTHORED_OCCUPANTS);
  assert.equal(new Set(first.placements.map((person) => person.id)).size, first.placed);

  const low = structuredClone(layout);
  low.zones[0].occupancy = 0.2;
  const high = structuredClone(layout);
  high.zones[0].occupancy = 0.3;
  const lowIds = new Set(crowd.resolveCrowdLayout(arena, low).placements.map((person) => person.id));
  const highIds = new Set(crowd.resolveCrowdLayout(arena, high).placements.map((person) => person.id));
  assert.ok([...lowIds].every((id) => highIds.has(id)), 'increasing occupancy only adds generated IDs');

  const samples = ['location-x', 'location-z', 'occupancy', 'appearance', 'phone', 'palette', 'motion', 'scale']
    .map((domain) => crowd.crowdSelection(layout.seed, domain, 'floor:standing:1:1'));
  assert.equal(new Set(samples).size, samples.length, 'selection concerns have independent hash domains');
});

test('theatre seats have stable pivots, real IDs, raked heights, and aisle gaps', () => {
  const seats = crowd.theatreSeatAnchors(theatre);
  assert.ok(seats.length > 300);
  assert.equal(seats[0].id, `theatre:r1:c${seats[0].column + 1}`);
  assert.equal(new Set(seats.map((seat) => seat.id)).size, seats.length);
  assert.equal(new Set(seats.map((seat) => seat.row)).size, 14);
  assert.equal(seats.find((seat) => seat.row === 0).y, 0);
  assert.equal(seats.find((seat) => seat.row === 13).y, 13 * 0.17);
  for (let row = 0; row < 14; row++) {
    const xs = seats.filter((seat) => seat.row === row).map((seat) => seat.x).sort((a, b) => a - b);
    assert.ok(xs.some((x, index) => index && x - xs[index - 1] > 1), `row ${row + 1} keeps an aisle gap`);
  }

  const layout = crowd.makeDefaultCrowd(theatre);
  const result = crowd.resolveCrowdLayout(theatre, layout);
  assert.ok(result.placements.every((person) => person.pose === 'seated' && person.phone === false));
  const deliberate = structuredClone(layout);
  deliberate.placements.push({ id: 'director', modelId: 'stageforge-human-v1', pose: 'seated', seatId: seats.at(-1).id, yaw: 0 });
  const reopened = crowd.resolveCrowdLayout(theatre, deliberate);
  assert.ok(reopened.placements.some((person) => person.id === 'explicit:director' && person.source === 'explicit'));
});

test('exclusions and explicit placements win deterministically and hostile layouts fail readably', () => {
  const layout = crowd.makeDefaultCrowd(arena);
  layout.zones[0].occupancy = 0.15;
  const baseline = crowd.resolveCrowdLayout(arena, layout);
  const target = baseline.placements.find((person) => person.pose === 'standing');
  const explicit = structuredClone(layout);
  explicit.placements.push({
    id: 'camera-op', modelId: 'stageforge-human-v1', pose: 'standing', yaw: 15,
    position: { x: target.x, y: 0, z: target.z },
  });
  const withExplicit = crowd.resolveCrowdLayout(arena, explicit);
  assert.ok(withExplicit.placements.some((person) => person.id === 'explicit:camera-op'));
  assert.equal(withExplicit.placements.filter((person) => Math.hypot(person.x - target.x, person.z - target.z) < 0.9).length, 1);

  const excluded = structuredClone(layout);
  excluded.exclusions.push({ id: 'camera-lane', rect: {
    minX: target.x - 0.2, minZ: target.z - 0.2, maxX: target.x + 0.2, maxZ: target.z + 0.2,
  } });
  const withExclusion = crowd.resolveCrowdLayout(arena, excluded);
  assert.ok(!withExclusion.placements.some((person) => Math.abs(person.x - target.x) < 0.2 && Math.abs(person.z - target.z) < 0.2));

  const outside = structuredClone(layout);
  outside.placements.push({ id: 'outside', modelId: 'stageforge-human-v1', pose: 'standing', yaw: 0, position: { x: 999, y: 0, z: 999 } });
  assert.throws(() => crowd.resolveCrowdLayout(arena, outside), /outside.*venue audience bounds/i);
  const missingPosition = structuredClone(layout);
  missingPosition.placements.push({ id: 'missing-position', modelId: 'stageforge-human-v1', pose: 'standing', yaw: 0 });
  assert.throws(() => crowd.resolveCrowdLayout(arena, missingPosition), /floor position/i);
  const badSeat = crowd.makeDefaultCrowd(theatre);
  badSeat.placements.push({ id: 'bad-seat', modelId: 'stageforge-human-v1', pose: 'seated', seatId: 'seat:invented', yaw: 0 });
  assert.throws(() => crowd.resolveCrowdLayout(theatre, badSeat), /real theatre seat/i);
});

test('v10 is additive, round-trips crowd data, and leaves crowd-free legacy writer selection alone', () => {
  const layout = crowd.makeDefaultCrowd(arena);
  const file = write(arena, layout);
  assert.equal(file.version, 10);
  assert.equal(file.$schema, showFiles.V10_SCHEMA_URL);
  const parsed = showFiles.parseShowFile(JSON.stringify(file));
  assert.deepEqual(parsed.crowd, layout);
  assert.deepEqual(crowd.resolveCrowdLayout(parsed.rig, parsed.crowd), crowd.resolveCrowdLayout(arena, layout));

  const legacy = write(arena, undefined);
  assert.equal(legacy.version, 1);
  assert.equal('crowd' in legacy, false);
  const hostile = structuredClone(file);
  hostile.crowd.zones[0].occupancy = 2;
  assert.throws(() => showFiles.parseShowFile(JSON.stringify(hostile)), /crowd|occupancy/i);

  const mixed = crowd.withCrowdModelMix(layout, 'original-trio');
  const v11 = write(arena, mixed);
  assert.equal(v11.version, 11);
  assert.equal(v11.$schema, showFiles.V11_SCHEMA_URL);
  assert.deepEqual(showFiles.parseShowFile(JSON.stringify(v11)).crowd, mixed);
  const humanAgain = crowd.withCrowdModelMix(mixed, 'human-only');
  assert.equal(humanAgain.generatorVersion, 2, 'model mix changes never silently downgrade generator semantics');
  assert.equal(write(arena, humanAgain).version, 11);
});

test('the validated built-in model contract is measurable and preserves legacy pivots and budgets', () => {
  const human = models.STAGEFORGE_HUMAN_V1;
  assert.deepEqual(Object.keys(models.CROWD_MODEL_REGISTRY), [...models.CROWD_MODEL_IDS].sort());
  assert.deepEqual([...models.CROWD_MODEL_IDS_V13].sort(), [
    'stageforge-alien-v1', 'stageforge-fox-v1', 'stageforge-human-v1', 'stageforge-human-v2',
    'stageforge-moth-v1', 'stageforge-robot-v1', 'stageforge-ticket-taker-v1',
  ]);
  assert.equal(human.id, 'stageforge-human-v1');
  assert.deepEqual(human.poses.standing.pivot, [0, 0, 0]);
  assert.deepEqual(human.poses.seated.pivot, [0, 0, 0]);
  assert.equal(human.poses.standing.maxHeightM, 2.15);
  assert.equal(human.poses.standing.clearanceRadiusM, 0.47);
  assert.equal(human.poses.standing.submittedHeightM, 1.965);
  assert.deepEqual(human.poses.standing.handset.translation, [0.37, 1.9, 0.145]);
  assert.equal(human.poses.seated.handset, null);
  for (const tier of ['low', 'high', 'xr']) {
    assert.deepEqual(human.budgets[tier], {
      trianglesPerInstance: 264, materialSlots: 1, materialTextures: 0, morphTextures: 1, figureBatches: 1,
    });
    assert.equal(models.STAGEFORGE_ROBOT_V1.budgets[tier].trianglesPerInstance, 168);
    assert.equal(models.STAGEFORGE_ALIEN_V1.budgets[tier].trianglesPerInstance, 200);
  }
  const hostile = structuredClone(models.STAGEFORGE_ROBOT_V1);
  hostile.poses.standing.maxHeightM = 99;
  assert.throws(() => models.validateCrowdModelSpec(hostile), /shared envelope/);
});

test('generator v1 is frozen, human-only, and v2 closes the zone-edge jitter defect', () => {
  const legacy = crowd.makeDefaultCrowd(arena);
  legacy.zones[0].occupancy = 0.01;
  const normalized = crowd.resolveCrowdLayout(arena, legacy).placements.map(
    ({ id, x, y, z, phase, phone, scaleY, paletteIndex, gesture, modelId, pose }) =>
      ({ id, x, y, z, phase, phone, scaleY, paletteIndex, gesture, modelId, pose }),
  );
  assert.equal(createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    'f425935a2a8174c451acb48337eb54e188fd8a5d02517c90577b01086119ea71');

  const invalid = structuredClone(legacy);
  invalid.zones[0].modelWeights = [{ modelId: 'stageforge-robot-v1', weight: 1 }];
  assert.throws(() => crowd.resolveCrowdLayout(arena, invalid), /version 1 only supports stageforge-human-v1/);

  const edge = {
    generatorVersion: 1, seed: 249057,
    zones: [{
      id: 'edge', kind: 'standing', rect: { minX: -0.475, minZ: 9.325, maxX: 0.475, maxZ: 10.275 },
      occupancy: 1, modelWeights: [{ modelId: 'stageforge-human-v1', weight: 1 }],
    }],
    exclusions: [], placements: [],
  };
  const v1 = crowd.resolveCrowdLayout(arena, edge).placements[0];
  assert.ok(v1.x - models.CROWD_PLACEMENT_ENVELOPE.standing.clearanceRadiusM < edge.zones[0].rect.minX);
  edge.generatorVersion = 2;
  const v2 = crowd.resolveCrowdLayout(arena, edge).placements[0];
  assert.equal(v2.x - models.CROWD_PLACEMENT_ENVELOPE.standing.clearanceRadiusM, edge.zones[0].rect.minX);
  assert.equal(v2.id, v1.id);
  assert.equal(v2.phase, v1.phase);
});

test('generator v2 applies the shared seated envelope at authored zone edges', () => {
  const seat = crowd.theatreSeatAnchors(theatre).find((item) => item.row === 4 && item.x > 0);
  const layout = {
    generatorVersion: 1, seed: 249057,
    zones: [{
      id: 'edge-seat', kind: 'seated',
      rect: { minX: seat.x, minZ: seat.z, maxX: seat.x + 1, maxZ: seat.z + 1 },
      occupancy: 1, modelWeights: [{ modelId: 'stageforge-human-v1', weight: 1 }],
    }],
    exclusions: [], placements: [],
  };
  const legacy = crowd.resolveCrowdLayout(theatre, layout);
  assert.ok(legacy.placements.some((person) => person.candidateId === seat.id), 'v1 seat-center behavior remains frozen');
  layout.generatorVersion = 2;
  const safe = crowd.resolveCrowdLayout(theatre, layout);
  assert.ok(!safe.placements.some((person) => person.candidateId === seat.id));
  const radius = models.CROWD_PLACEMENT_ENVELOPE.seated.clearanceRadiusM;
  assert.ok(safe.placements.every((person) =>
    person.x - radius >= layout.zones[0].rect.minX && person.x + radius <= layout.zones[0].rect.maxX
    && person.z - radius >= layout.zones[0].rect.minZ && person.z + radius <= layout.zones[0].rect.maxZ));
});

test('v1 animation keeps released roll and the v2 motion helper is allocation-free', () => {
  const object = new THREE.Object3D();
  const legacy = {
    x: 1, y: 0, z: 2, scaleY: 1.12, phase: 0, rotY: 0.2,
    modelId: 'stageforge-human-v1', pose: 'standing', pivot: [0, 0, 0], generatorVersion: 1,
  };
  geometry.setCrowdObjectMatrix(object, legacy, 0.045, 0.05);
  assert.equal(object.rotation.y, legacy.rotY);
  assert.equal(object.rotation.z, 0.05);
  assert.equal(object.scale.y, legacy.scaleY + 0.045 * 0.25);
  assert.equal(object.scale.x, 1, 'generator v1 retains its released horizontal scale');

  assert.equal(typeof models.crowdMotionScaleY(
    'stageforge-human-v1', 'standing', 1.12, 0.22, 0.05, true,
  ), 'number', 'the hot motion helper returns a scalar instead of allocating a result object');
  assert.equal(typeof models.crowdMotionScaleXZ(
    'stageforge-human-v1', 'standing', 1.08, 0.05, true,
  ), 'number', 'the horizontal hot motion helper also returns a scalar');
});

test('generator v2 keeps placement identity and motion stable across deterministic model mixes', () => {
  const a = crowd.withCrowdModelMix(crowd.makeDefaultCrowd(arena), 'original-trio');
  a.zones[0].occupancy = 0.04;
  const b = structuredClone(a);
  b.zones[0].modelWeights.reverse();
  const c = structuredClone(a);
  c.zones[0].modelWeights = c.zones[0].modelWeights.map((item) => ({ ...item, weight: item.weight + 3 }));
  const stable = layout => crowd.resolveCrowdLayout(arena, layout).placements.map(({ id, x, y, z, phase }) => ({ id, x, y, z, phase }));
  assert.deepEqual(stable(b), stable(a), 'weight declaration order is canonical');
  assert.deepEqual(stable(c), stable(a), 'model weight changes do not move or re-phase occupants');
});

test('the current venue builder renders authored placements with the existing figure and preserves legacy repeatability', () => {
  const mats = geometry.createSharedMaterials({ tier: 'high' });
  const legacyA = geometry.buildVenueArchitecture('arena', 0.4, mats, arena.stageWidth, arena.stageDepth, arena.stageHeight);
  const legacyB = geometry.buildVenueArchitecture('arena', 0.4, mats, arena.stageWidth, arena.stageDepth, arena.stageHeight);
  assert.deepEqual(legacyB.crowdBaseTransforms, legacyA.crowdBaseTransforms);
  assert.equal(legacyA.crowdMesh.geometry.index.count / 3, 264);
  assert.equal(legacyA.crowdMesh.geometry.morphAttributes.position.length, 2);

  const layout = crowd.makeDefaultCrowd(arena);
  layout.zones[0].occupancy = 0.1;
  const resolved = crowd.resolveCrowdLayout(arena, layout);
  const authored = geometry.buildVenueArchitecture('arena', 0, mats, arena.stageWidth, arena.stageDepth, arena.stageHeight, resolved);
  assert.equal(authored.crowdMesh.count, resolved.placed);
  assert.equal(authored.crowdBaseTransforms.length, resolved.placed);
  assert.equal(authored.crowdMesh.geometry.index.count / 3, 264, 'authored mode reuses the legacy procedural figure');
  const positions = new Set(authored.crowdBaseTransforms.map((item) => `${item.x}:${item.y}:${item.z}`));
  assert.ok(resolved.placements.every((person) => positions.has(`${person.x}:${person.y}:${person.z}`)));
  assert.equal(authored.phonesMesh?.count ?? 0, resolved.placements.filter((person) => person.phone).length);

  const mixedLayout = crowd.withCrowdModelMix(crowd.makeDefaultCrowd(arena), 'original-trio');
  mixedLayout.zones[0].occupancy = 0.01;
  const mixedResolved = crowd.resolveCrowdLayout(arena, mixedLayout);
  const mixed = geometry.buildVenueArchitecture('arena', 0, mats, arena.stageWidth, arena.stageDepth, arena.stageHeight, mixedResolved);
  assert.deepEqual(mixed.crowdBatches.map((batch) => [batch.modelId, batch.mesh.geometry.index.count / 3]), [
    ['stageforge-alien-v1', 200], ['stageforge-human-v1', 264], ['stageforge-robot-v1', 168],
  ]);
  assert.equal(mixed.placementBindings.length, mixedResolved.placed);
  assert.equal(new Set(mixed.placementBindings.map((binding) => binding.placementId)).size, mixedResolved.placed);
  assert.deepEqual(mixed.resourceAdmission.arenaDelta, { draws: 4, triangles: 0, textures: 0 });
  const phoneCount = mixedResolved.placements.filter((person) => person.phone).length;
  const expectedSceneTriangles = 3880
    + mixedResolved.placed * models.CROWD_FOOTPRINT_TRIANGLES
    + phoneCount * models.CROWD_HANDSET_TRIANGLES;
  assert.equal(mixed.resourceAdmission.sceneTriangles, expectedSceneTriangles);
  assert.equal(mixed.resourceAdmission.submittedTriangles, expectedSceneTriangles * 2,
    'resource accounting includes figures, contact patches, handsets, and both submitted eye views');
  assert.equal(mixed.resourceAdmission.admitted, true);
  for (const batch of mixed.crowdBatches) {
    const measured = geometry.validateCrowdGeometryAdmission(batch.modelId, 'high', batch.mesh.geometry, batch.mesh.material);
    assert.ok(measured.standingHeightM <= models.crowdModel(batch.modelId).poses.standing.maxHeightM);
    assert.ok(measured.seatedHeightM <= models.crowdModel(batch.modelId).poses.seated.maxHeightM);
    assert.ok(measured.floorMinY >= -0.01);
    for (const pose of ['standing', 'seated']) for (const sway of [-0.05, 0.05]) {
      const transform = {
        x: 0, y: 0, z: 0, scaleY: models.CROWD_POSE_MAX_SCALE[pose], phase: 0, rotY: 0.7,
        modelId: batch.modelId, pose, pivot: models.crowdModel(batch.modelId).poses[pose].pivot,
        generatorVersion: 2,
      };
      const object = new THREE.Object3D();
      geometry.setCrowdObjectMatrix(object, transform, 0.22, sway);
      let worldMaxY = -Infinity;
      let worldMaxRadius = 0;
      const point = new THREE.Vector3();
      const positions = [
        batch.mesh.geometry.getAttribute('position'),
        ...(batch.mesh.geometry.morphAttributes.position ?? []),
        ...(pose === 'standing' && batch.phonesMesh ? [batch.phonesMesh.geometry.getAttribute('position')] : []),
      ];
      for (const position of positions) for (let index = 0; index < position.count; index++) {
        point.fromBufferAttribute(position, index).applyMatrix4(object.matrix);
        worldMaxY = Math.max(worldMaxY, point.y);
        worldMaxRadius = Math.max(worldMaxRadius, Math.hypot(point.x, point.z));
      }
      assert.ok(worldMaxY <= models.crowdModel(batch.modelId).poses[pose].maxHeightM + 1e-6,
        `${batch.modelId} ${pose} transformed vertices fit at sway ${sway}`);
      assert.ok(worldMaxRadius <= models.crowdModel(batch.modelId).poses[pose].clearanceRadiusM + 1e-6,
        `${batch.modelId} ${pose} transformed figure and accessories fit their XZ clearance at sway ${sway}`);
    }
  }
  const humanBatch = mixed.crowdBatches.find((batch) => batch.modelId === 'stageforge-human-v1');
  const expectedPhones = mixedResolved.placements.filter((person) => person.modelId === humanBatch.modelId && person.phone)
    .map((person) => person.id).sort();
  assert.deepEqual(humanBatch.placementIds.slice(0, expectedPhones.length), expectedPhones, 'phone owners occupy the sorted shared prefix');
  assert.equal(humanBatch.phonesMesh.instanceMatrix, humanBatch.mesh.instanceMatrix);
  const baseMaterials = mixed.crowdBatches.map((batch) => batch.mesh.material);
  const controller = new lighting.CrowdLightingController('high');
  controller.bindVenue({
    crowdMesh: mixed.crowdMesh, phonesMesh: mixed.phonesMesh, batches: mixed.crowdBatches,
    transforms: mixed.crowdBaseTransforms, seated: false, stageDepth: arena.stageDepth,
  });
  controller.setEnabled(true);
  assert.equal(controller.getStats().spectatorCount, mixedResolved.placed);
  assert.equal(controller.getStats().phoneCount, expectedPhones.length);
  assert.ok(mixed.crowdBatches.every((batch, index) => batch.mesh.material !== baseMaterials[index]));
  const firstLitMaterials = mixed.crowdBatches.map((batch) => batch.mesh.material);
  const versions = firstLitMaterials.map((material) => material.version);
  controller.onContextRestored();
  assert.deepEqual(firstLitMaterials.map((material) => material.version), versions.map((version) => version + 1));
  let disposedLitMaterials = 0;
  firstLitMaterials.forEach((material) => material.addEventListener('dispose', () => disposedLitMaterials++));
  controller.bindVenue({
    crowdMesh: mixed.crowdMesh, phonesMesh: mixed.phonesMesh, batches: mixed.crowdBatches,
    transforms: mixed.crowdBaseTransforms, seated: false, stageDepth: arena.stageDepth,
  });
  assert.equal(disposedLitMaterials, firstLitMaterials.length, 'rig rebuild disposes every prior lit batch material');
  assert.ok(mixed.crowdBatches.every((batch, index) => batch.mesh.material !== baseMaterials[index]));
  const secondLitMaterials = mixed.crowdBatches.map((batch) => batch.mesh.material);
  let teardownDisposals = 0;
  secondLitMaterials.forEach((material) => material.addEventListener('dispose', () => teardownDisposals++));
  controller.dispose();
  assert.equal(teardownDisposals, secondLitMaterials.length, 'active teardown disposes every lit batch material');
  assert.ok(mixed.crowdBatches.every((batch, index) => batch.mesh.material === baseMaterials[index]));

  geometry.disposeSharedMaterials(mats);
});

test('v2 seated contact patches fit the model clearance at their saved anchors', () => {
  const layout = crowd.makeDefaultCrowd(theatre);
  const seats = crowd.theatreSeatAnchors(theatre).filter((seat) => seat.row === 5).slice(5, 8);
  layout.generatorVersion = 2;
  layout.zones = [];
  layout.placements = ['stageforge-robot-v1', 'stageforge-alien-v1', 'stageforge-human-v1']
    .map((modelId, index) => ({
      id: 'contact-' + index, modelId, pose: 'seated', seatId: seats[index].id, yaw: index * 37,
    }));

  const resolved = crowd.resolveCrowdLayout(theatre, layout);
  const mats = geometry.createSharedMaterials({ tier: 'high' });
  const venue = geometry.buildVenueArchitecture('theatre', 0, mats, theatre.stageWidth, theatre.stageDepth, theatre.stageHeight, resolved);
  const footprints = venue.group.children.find((child) => child.isInstancedMesh && child.geometry.type === 'CircleGeometry');
  assert.ok(footprints, 'the authored crowd has a shared contact-patch mesh');
  assert.equal(footprints.count, 3);

  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const positions = footprints.geometry.getAttribute('position');
  const placements = [...resolved.placements].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, person] of placements.entries()) {
    footprints.getMatrixAt(index, matrix);
    const radius = models.crowdModel(person.modelId).poses.seated.clearanceRadiusM;
    for (let vertex = 0; vertex < positions.count; vertex++) {
      point.fromBufferAttribute(positions, vertex).applyMatrix4(matrix);
      assert.ok(Math.hypot(point.x - person.x, point.z - person.z) <= radius + 1e-6,
        person.modelId + ' contact patch must stay inside its seated radius');
    }
  }
  geometry.disposeSharedMaterials(mats);
});

const seatedHumanId = 'stageforge-human-v2';
const chairAnchors = crowd.theatreSeatAnchors(theatre);
const supportedChair = chairAnchors.find(seat => seat.row === 8);
const seatEntry = { id: 'a-chair', modelId: seatedHumanId, pose: 'seated', seatId: supportedChair.id, yaw: 150 };
const floorEntry = { id: 'z-floor', modelId: seatedHumanId, pose: 'standing', yaw: 15,
  position: { x: -1, y: 0, z: theatre.stageDepth / 2 + 1.4 } };
const mothEntry = { ...floorEntry, id: 'm-moth', modelId: 'stageforge-moth-v1',
  position: { ...floorEntry.position, x: 1 } };

function buildSeatedFixture(t, entries) {
  const layout = { generatorVersion: 2, seed: 249057, zones: [], exclusions: [], placements: entries };
  const resolved = crowd.resolveCrowdLayout(theatre, layout);
  const before = structuredClone(resolved);
  const mats = geometry.createSharedMaterials({ tier: 'high' });
  const venue = geometry.buildVenueArchitecture('theatre', 0, mats, theatre.stageWidth, theatre.stageDepth, theatre.stageHeight, resolved);
  assert.deepEqual(resolved, before, 'rendering preserves original placement records and their order');
  assert.equal(venue.crowdBatches.length, 1);
  const [batch] = venue.crowdBatches;
  assert.equal(venue.resourceAdmission.figureBatches, 1);
  assert.equal(venue.resourceAdmission.submittedDraws, 4, 'one body batch and one footprint batch, in two eyes');
  assert.deepEqual(venue.placementBindings.map(b => [b.placementId, b.modelId, b.pose, b.batchIndex, b.instanceIndex, b.phase]),
    [...before.placements].sort((a, b) => a.id.localeCompare(b.id)).map((p, index) => [p.id, p.modelId, p.pose, 0, index, p.phase]));
  t.after(() => {
    const materials = new Set();
    const shared = new Set(Object.values(mats));
    venue.group.traverse(obj => {
      if (obj.isInstancedMesh) obj.dispose();
      obj.geometry?.dispose();
      for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        if (material && !shared.has(material)) materials.add(material);
      }
    });
    for (const material of materials) material.dispose();
    geometry.disposeSharedMaterials(mats);
  });
  return { venue, batch };
}

function baseCrowdShader(mesh) {
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  mesh.material.onBeforeCompile(shader);
  return shader;
}

test('a seated human bears on the actual cushion and row, clear of the chair through a beat', t => {
  const { venue, batch } = buildSeatedFixture(t, [seatEntry]);
  const { mesh } = batch;
  assert.equal(batch.packed, false);
  assert.equal(venue.resourceAdmission.rendererTextures, 0);
  assert.equal(mesh.geometry.index.count, 260 * 3);
  assert.equal(mesh.geometry.hasAttribute('crowdSeatPosition'), false, 'single-pose direct needs no alternate carrier');
  const close = (a, b) => Math.abs(a - b) < 1e-5;
  const seats = venue.group.children.find(child =>
    !child.isInstancedMesh && child.material?.color?.getHex() === 0x4b1a21);
  assert.ok(seats, 'theatre chair geometry is merged by its shared material');
  const positions = seats.geometry.getAttribute('position');
  const boxVertices = 24;
  assert.equal(positions.count, chairAnchors.length * 2 * boxVertices);
  const point = new THREE.Vector3();
  const centreOfBox = new THREE.Vector3();
  const size = new THREE.Vector3();
  const chairBox = (seat, height) => {
    const box = new THREE.Box3();
    for (let i = 0; i < positions.count; i += boxVertices) {
      box.makeEmpty();
      for (let corner = 0; corner < boxVertices; corner++) box.expandByPoint(point.fromBufferAttribute(positions, i + corner));
      box.getCenter(centreOfBox);
      if (close(box.getSize(size).y, height) && close(centreOfBox.x, seat.x) &&
          close(centreOfBox.y, seat.y + (height === 0.1 ? 0.42 : 0.72)) &&
          Math.abs(centreOfBox.z - seat.z) < 0.3) return box;
    }
    assert.fail('actual theatre chair box exists in the merged geometry');
  };
  const cushion = chairBox(supportedChair, 0.1);
  const back = chairBox(supportedChair, 0.6);
  const neighbour = chairBox(chairAnchors.find(s => s.row === supportedChair.row && s.id !== supportedChair.id), 0.1);
  assert.ok(close(cushion.max.y, supportedChair.y + 0.47) && close(cushion.min.z, supportedChair.z - 0.11));
  assert.ok(close(cushion.max.z, supportedChair.z + 0.18) && close(neighbour.max.z - neighbour.min.z, 0.46));
  const interiors = [cushion, back].map(box => box.clone().expandByScalar(-0.0001));
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  const object = new THREE.Object3D();
  geometry.setCrowdObjectMatrix(object, batch.transforms[0], 0.22, -0.05);
  assert.ok(object.matrix.elements.every((value, i) => close(value, matrix.elements[i])), 'no hop or roll at the chair');
  const footprint = venue.group.children.find(child => child.isInstancedMesh && child.geometry.type === 'CircleGeometry');
  const patchMatrix = new THREE.Matrix4();
  footprint.getMatrixAt(0, patchMatrix);
  const patch = new THREE.Vector3().fromBufferAttribute(footprint.geometry.getAttribute('position'), 0).applyMatrix4(patchMatrix);
  assert.ok(close(patch.x, supportedChair.x) && close(patch.y, supportedChair.y + 0.012) &&
    close(patch.z, supportedChair.z - 0.149), 'shared footprint follows the two shoes');
  const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
  const triangle = new THREE.Triangle(), centre = new THREE.Vector3();
  const headTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0),
    mesh.geometry.getAttribute('crowdSeatTurn').getX(0));
  let hips = 0, leftSole = 0, rightSole = 0;
  for (let i = 0; i < index.count; i += 3) {
    [triangle.a, triangle.b, triangle.c].forEach((point, corner) => {
      point.fromBufferAttribute(position, index.getX(i + corner));
      if (point.y > 0.98) point.applyQuaternion(headTurn);
      point.applyMatrix4(matrix);
    });
    assert.ok(interiors.every(box => !box.intersectsTriangle(triangle)), 'whole triangles clear both chair interiors');
    const vertices = [triangle.a, triangle.b, triangle.c];
    assert.ok(vertices.every(point => point.y >= supportedChair.y - 1e-5));
    triangle.getMidpoint(centre);
    if (vertices.every(p => close(p.y, cushion.max.y)) &&
        centre.x >= cushion.min.x && centre.x <= cushion.max.x && centre.z >= cushion.min.z && centre.z <= cushion.max.z) {
      hips += triangle.getArea();
    }
    if (vertices.every(p => close(p.y, supportedChair.y))) {
      if (centre.x < supportedChair.x) leftSole += triangle.getArea();
      else rightSole += triangle.getArea();
    }
  }
  assert.ok(hips > 0.02 && leftSole > 0.008 && rightSole > 0.008, 'positive support area in square metres');
});

test('mixed direct humans share geometry and select complete seated vertices, normals and palette regions', async t => {
  const { venue, batch } = buildSeatedFixture(t, [floorEntry, seatEntry]);
  assert.equal(batch.packed, false);
  assert.equal(venue.resourceAdmission.rendererTextures, 0);
  assert.equal(batch.mesh.count, 2);
  assert.equal(batch.mesh.morphTexture, null);
  const g = batch.mesh.geometry, turns = g.getAttribute('crowdSeatTurn');
  assert.ok(Math.abs(turns.getX(0) + Math.PI / 6) < 1e-6);
  assert.equal(turns.getX(1), 4, 'standing person retains the ordinary pose');
  const originals = await compiler.ssrLoadModule('/src/engine/originalCrowdGeometry.ts');
  const seated = originals.makeSeatedOriginalHumanGeometry();
  t.after(() => seated.dispose());
  assert.equal(g.index.count, 780);
  for (let i = 0; i < g.index.count; i++) {
    const source = seated.index.getX(i);
    assert.equal(g.index.getX(i), i);
    for (const [base, alternate] of [['position', 'crowdSeatPosition'], ['normal', 'crowdSeatNormal'], ['color', 'crowdSeatColorRegion']]) {
      for (const get of ['getX', 'getY', 'getZ']) {
        assert.equal(g.getAttribute(alternate)[get](i), seated.getAttribute(base)[get](source));
      }
    }
    assert.equal(g.getAttribute('crowdSeatColorRegion').getW(i), seated.getAttribute('crowdColorRegion').getX(source));
  }
  const shader = baseCrowdShader(batch.mesh).vertexShader;
  assert.match(shader, /crowdSeatTurn < 3\.0 \? crowdSeatPosition : position/);
  assert.match(shader, /crowdSeatTurn < 3\.0 \? crowdSeatNormal : normal/);
  assert.match(shader, /crowdActiveRegion = crowdSeatColorRegion\.a/);
  assert.match(shader, /objectNormal = crowdSeatFacing/);
  assert.match(shader, /#include <morphtarget_vertex>/);
});

test('one packed texture reuses the human slot when seated-only and appends only a second human pose', t => {
  for (const mixed of [false, true]) {
    const { venue, batch } = buildSeatedFixture(t, mixed ? [floorEntry, mothEntry, seatEntry] : [mothEntry, seatEntry]);
    assert.equal(batch.packed, true);
    assert.equal(venue.resourceAdmission.packedVertexTextures, 1);
    assert.equal(venue.resourceAdmission.rendererTextures, 1);
    assert.deepEqual(batch.modelIds, [seatedHumanId, mothEntry.modelId]);
    const texture = baseCrowdShader(batch.mesh).uniforms.uPackedCrowdVertices.value;
    const { width, height, data } = texture.image;
    assert.equal(height, 3 * (mixed ? 3 : 2));
    const slots = batch.mesh.geometry.getAttribute('crowdGeometrySlot');
    const turns = batch.mesh.geometry.getAttribute('crowdSeatTurn');
    const slotOf = id => slots.getX(batch.placementIds.indexOf('explicit:' + id));
    assert.equal(slotOf('m-moth'), 1);
    assert.equal(slotOf('a-chair'), mixed ? 2 : 0);
    assert.ok(Math.abs(turns.getX(batch.placementIds.indexOf('explicit:a-chair')) + Math.PI / 6) < 1e-6);
    const maxY = slot => {
      let top = -Infinity;
      for (let corner = 0; corner < width; corner++) top = Math.max(top, data[(slot * 3 * width + corner) * 4 + 1]);
      return top;
    };
    assert.ok(Math.abs(maxY(slotOf('a-chair')) - 1.328623) < 1e-5, 'slot contains the seated source');
    if (mixed) {
      assert.equal(slotOf('z-floor'), 0);
      assert.ok(Math.abs(maxY(0) - 1.773623) < 1e-5, 'standing source survives alongside the chair pose');
    }
  }
});

test('v12 preserves original model choices in saved JSON and an offline Pitch Viewer bundle', async () => {
  const layout = crowd.withCrowdModelMix(crowd.makeDefaultCrowd(arena), 'original-library');
  assert.equal(crowd.crowdModelMix(layout), 'original-library');
  const scaledWeights = structuredClone(layout);
  scaledWeights.zones[0].modelWeights.reverse().forEach((item) => { item.weight *= 2; });
  assert.equal(crowd.crowdModelMix(scaledWeights), 'original-library');
  scaledWeights.zones[0].modelWeights[0].weight++;
  assert.equal(crowd.crowdModelMix(scaledWeights), 'custom');

  const show = write(arena, layout);
  assert.equal(show.version, 12);
  assert.equal(show.$schema, showFiles.V12_SCHEMA_URL);
  assert.deepEqual(showFiles.parseShowFile(JSON.stringify(show)).crowd, layout);
  const v11 = { ...show, version: 11, $schema: showFiles.V11_SCHEMA_URL };
  assert.throws(() => showFiles.parseShowFile(JSON.stringify(v11)), /modelWeights/i);

  const { createShowBundle } = await compiler.ssrLoadModule('/src/data/showBundle.ts');
  const { parseViewerSource } = await compiler.ssrLoadModule('/src/viewer/parseViewer.ts');
  const archive = await createShowBundle(show, new Map());
  const viewer = await parseViewerSource(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(viewer.kind, 'show');
  assert.equal(viewer.file.version, 12);
  assert.deepEqual(viewer.file.crowd, layout);
  assert.deepEqual(viewer.bundledMedia, []);

  const base = crowd.withCrowdModelMix(crowd.makeDefaultCrowd(theatre), 'original-trio');
  const deliberate = {
    ...base,
    zones: [],
    placements: [{
      id: 'fox-at-theatre',
      modelId: 'stageforge-fox-v1',
      pose: 'seated',
      seatId: crowd.theatreSeatAnchors(theatre)[0].id,
      yaw: 0,
    }],
  };
  assert.equal(crowd.crowdModelMix(deliberate), 'custom');
  assert.deepEqual(crowd.withCrowdModelMix(deliberate, 'human-only'), deliberate);
  assert.equal(write(theatre, deliberate).version, 12);
  assert.equal(write(theatre, { ...deliberate, placements: [] }).version, 11);
  assert.throws(() => write(theatre, { ...deliberate, generatorVersion: 1 }), /version 1 only supports/i);
});

test('new human tints and original fox geometry stay inside the five-batch stereo budget', () => {
  const layout = crowd.withCrowdModelMix(crowd.makeDefaultCrowd(arena), 'original-library');
  const resolved = crowd.resolveCrowdLayout(arena, layout);
  const humans = resolved.placements.filter((person) => person.modelId === 'stageforge-human-v2');
  assert.ok(humans.length > 30);
  assert.ok(new Set(humans.map((person) => JSON.stringify(person.humanColors))).size > 7,
    'skin and outfit are independently seeded');
  assert.deepEqual(crowd.resolveCrowdLayout(arena, structuredClone(layout)), resolved);

  const mats = geometry.createSharedMaterials({ tier: 'high' });
  const built = geometry.buildVenueArchitecture('arena', 0, mats, arena.stageWidth, arena.stageDepth, arena.stageHeight, resolved);
  assert.deepEqual(built.crowdBatches.map((batch) => [batch.modelId, batch.mesh.geometry.index.count / 3]), [
    ['stageforge-alien-v1', 200],
    ['stageforge-fox-v1', 262],
    ['stageforge-human-v1', 264],
    ['stageforge-human-v2', 260],
    ['stageforge-robot-v1', 168],
  ]);
  assert.deepEqual(built.resourceAdmission.arenaDelta, { draws: 8, triangles: 0, textures: 0 });
  assert.equal(built.resourceAdmission.admitted, true);
  const human = built.crowdBatches.find((batch) => batch.modelId === 'stageforge-human-v2');
  const fox = built.crowdBatches.find((batch) => batch.modelId === 'stageforge-fox-v1');
  assert.equal(human.mesh.geometry.getAttribute('crowdSkinColor').count, human.mesh.count);
  assert.equal(human.mesh.geometry.getAttribute('crowdClothingColor').count, human.mesh.count);
  assert.equal(human.mesh.instanceColor, null);
  assert.equal(fox.mesh.instanceColor, null);
  assert.equal(human.phonesMesh, null);
  assert.equal(fox.phonesMesh, null);
  assert.equal(human.mesh.material.customProgramCacheKey(), 'crowd-human-tint-regions-v1');
  geometry.disposeSharedMaterials(mats);
});

test('packed monochrome models retain individual IDs, exact padded admission and one owned texture', () => {
  const layout = crowd.withCrowdModelMix(crowd.makeDefaultCrowd(arena), 'original-with-cartoons');
  const resolved = crowd.resolveCrowdLayout(arena, layout);
  const stored = write(arena, layout);
  assert.equal(stored.version, 13);
  assert.equal(stored.$schema, showFiles.V13_SCHEMA_URL);
  assert.deepEqual(showFiles.parseShowFile(JSON.stringify(stored)).crowd, layout);
  const oldVersion = { ...stored, version: 12, $schema: showFiles.V12_SCHEMA_URL };
  assert.throws(() => showFiles.parseShowFile(JSON.stringify(oldVersion)), /modelWeights/i);

  const mats = geometry.createSharedMaterials({ tier: 'high' });
  const built = geometry.buildVenueArchitecture('arena', 0, mats, arena.stageWidth, arena.stageDepth, arena.stageHeight, resolved);
  const packed = built.crowdBatches.find(batch => batch.packed);
  assert.deepEqual(packed.modelIds, ['stageforge-fox-v1', 'stageforge-human-v2', 'stageforge-moth-v1', 'stageforge-ticket-taker-v1']);
  assert.equal(built.crowdBatches.length, 4);
  assert.equal(built.resourceAdmission.packedVertexTextures, 1);
  assert.deepEqual(built.resourceAdmission.arenaDelta, { draws: 6, triangles: 0, textures: 1 });
  assert.equal(built.resourceAdmission.admitted, true);
  let actualTriangles = 0;
  for (const batch of built.crowdBatches) {
    actualTriangles += batch.mesh.geometry.index.count / 3 * batch.mesh.count;
  }
  assert.equal(built.resourceAdmission.instanceTriangles, actualTriangles);

  assert.equal(packed.mesh.geometry.getAttribute('normal').count, packed.mesh.geometry.index.count,
    'the indexed carrier preserves Three smooth shading for the fetched source normals');
  const slots = packed.mesh.geometry.getAttribute('crowdGeometrySlot');
  for (const binding of built.placementBindings.filter(item => item.batchIndex === packed.batchIndex)) {
    assert.equal(packed.placementIds[binding.instanceIndex], binding.placementId);
    assert.equal(slots.getX(binding.instanceIndex), packed.modelIds.indexOf(binding.modelId));
    assert.equal(packed.transforms[binding.instanceIndex].modelId, binding.modelId);
    const transform = packed.transforms[binding.instanceIndex];
    const bounds = packed.mesh.boundingBox;
    assert.ok(bounds.containsPoint(new THREE.Vector3(transform.x, transform.y, transform.z)));
  }
  assert.equal(packed.phonesMesh, null);
  const human = built.crowdBatches.find(batch => batch.modelId === 'stageforge-human-v1');
  assert.equal(human.phonesMesh.instanceMatrix, human.mesh.instanceMatrix);

  const shaderInput = () => ({
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    uniforms: {},
  });
  const baseMaterial = packed.mesh.material;
  const baseShader = shaderInput();
  baseMaterial.onBeforeCompile(baseShader);
  const texture = baseShader.uniforms.uPackedCrowdVertices.value;
  assert.equal(texture.image.width, 262 * 3);
  assert.equal(texture.image.height, 12);
  assert.match(baseShader.vertexShader, /texelFetch\(uPackedCrowdVertices/);
  assert.match(baseShader.vertexShader, /#include <morphtarget_vertex>/);

  for (const slot of [2, 3]) {
    const offset = (slot * 3 + 2) * texture.image.width * 4;
    const values = texture.image.data.subarray(offset, offset + texture.image.width * 4);
    for (let column = 0; column < values.length; column += 4) {
      assert.equal(values[column], values[column + 1]);
      assert.equal(values[column], values[column + 2]);
    }
  }

  let disposals = 0;
  texture.addEventListener('dispose', () => disposals++);
  const controller = new lighting.CrowdLightingController('high');
  controller.bindVenue({
    crowdMesh: built.crowdMesh, phonesMesh: built.phonesMesh, batches: built.crowdBatches,
    transforms: built.crowdBaseTransforms, seated: false, stageDepth: arena.stageDepth,
  });
  controller.setEnabled(true);
  const litShader = shaderInput();
  packed.mesh.material.onBeforeCompile(litShader);
  assert.equal(litShader.uniforms.uPackedCrowdVertices.value, texture);
  assert.match(litShader.vertexShader, /texelFetch\(uPackedCrowdVertices/);
  assert.ok(litShader.uniforms.uCrowdLightDir0);
  controller.dispose();
  assert.equal(packed.mesh.material, baseMaterial);
  assert.equal(disposals, 0, 'lighting variants do not own the geometry texture');
  packed.mesh.dispose();
  assert.equal(disposals, 1, 'the packed mesh owns the geometry texture');
  geometry.disposeSharedMaterials(mats);
});


test('the 1928 cast places atomically, preserves existing people, and uses measured film models', async () => {
  const film = await compiler.ssrLoadModule('/src/data/crowdFilmCast.ts');
  const layout = crowd.makeDefaultCrowd(arena);
  layout.zones[0].occupancy = 0.04;
  const request = { kind: 'cast', pose: 'standing', anchor: { x: 0, z: arena.stageDepth / 2 + 4 } };
  const preview = crowd.planCrowdPlacement(arena, layout, request);
  assert.equal(preview.status, 'needs-v1-approval', preview.message);
  assert.ok(preview.preview.generatedBefore > 0);
  assert.equal(layout.generatorVersion, 1);
  assert.equal(layout.placements.length, 0);

  const upgraded = { ...layout, generatorVersion: 2 };
  const before = crowd.resolveCrowdLayout(arena, upgraded);
  const result = crowd.planCrowdPlacement(arena, layout, { ...request, approveV1Upgrade: true });
  assert.equal(result.status, 'added', result.message);
  assert.equal(result.upgradedFromV1, true);
  assert.deepEqual(result.layout.placements.map(person => person.modelId), film.STEAMBOAT_DEFAULT_PLACEMENT_MODEL_IDS);
  const resolved = crowd.resolveCrowdLayout(arena, result.layout);
  assert.deepEqual(resolved.placements.filter(person => person.source === 'generated'), before.placements);
  assert.deepEqual(crowd.planCrowdPlacement(arena, result.layout, { ...request, anchor: { x: 2, z: request.anchor.z } }).status, 'unchanged');
  assert.deepEqual(crowd.planCrowdPlacement(arena, layout, { ...request, approveV1Upgrade: true }), result,
    'identical inputs produce identical IDs, coordinates and assignments');

  const filled = structuredClone(upgraded);
  filled.zones[0].occupancy = 0;
  filled.placements = before.placements.slice(0, 51).map(({ x, z }, index) => ({
    id: `already-placed-${index}`, modelId: 'stageforge-human-v1', pose: 'standing', position: { x, y: 0, z }, yaw: 180,
  }));
  const atLimit = structuredClone(filled);
  assert.equal(crowd.planCrowdPlacement(arena, filled, request).reason, 'explicit-capacity');
  assert.deepEqual(filled, atLimit, 'a rejected cast leaves the authored layout untouched');

  const seatedLayout = crowd.makeDefaultCrowd(theatre);
  seatedLayout.zones[0].occupancy = 0;
  const seat = crowd.theatreSeatAnchors(theatre).find(anchor => anchor.row === 3);
  const pick = crowd.pickCrowdTheatreSeat(theatre, { x: seat.x, z: seat.z });
  assert.equal(pick.id, seat.id);
  const duck = 'stageforge-steamboat-1928-waterfowl';
  const single = { kind: 'single', modelId: duck, target: { pose: 'seated', seatId: seat.id } };
  const seating = crowd.planCrowdPlacement(theatre, seatedLayout, single);
  assert.equal(seating.status, 'added', seating.message);
  const reopened = showFiles.parseShowFile(JSON.stringify(write(theatre, seating.layout)));
  assert.equal(reopened.version, 14);
  const actor = crowd.resolveCrowdLayout(theatre, reopened.crowd).placements[0];
  assert.equal(actor.y, seat.y);
  assert.equal(actor.modelId, duck);
  assert.equal(crowd.planCrowdPlacement(theatre, reopened.crowd, single).reason, 'spot-unavailable');

  const casts = structuredClone(result.layout);
  const fixedIds = new Set(casts.placements.map(person => person.modelId));
  for (const modelId of film.STEAMBOAT_MODEL_IDS.filter(id => !fixedIds.has(id))) {
    const addition = before.placements.pop();
    casts.placements.push({
      id: `extra-${modelId}`, modelId, pose: 'standing', position: { x: addition.x, y: 0, z: addition.z }, yaw: 180,
    });
  }
  casts.zones[0].occupancy = 0;
  const mats = geometry.createSharedMaterials({ tier: 'high' });
  const packedScene = geometry.buildVenueArchitecture('arena', 0, mats, arena.stageWidth, arena.stageDepth, arena.stageHeight,
    crowd.resolveCrowdLayout(arena, casts));
  const packed = packedScene.crowdBatches.find(batch => batch.packed);
  assert.deepEqual(packed.modelIds, [...film.STEAMBOAT_MODEL_IDS].sort());
  assert.equal(packed.mesh.geometry.getIndex().count / 3, 264);
  assert.equal(packedScene.resourceAdmission.packedVertexTextures, 1);
  assert.equal(packed.phonesMesh, null);
  for (const id of packed.modelIds) assert.equal(models.crowdModel(id).filmReference.year, 1928);
  packed.mesh.dispose();
  geometry.disposeSharedMaterials(mats);
});
