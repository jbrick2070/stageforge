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
  assert.deepEqual(Object.keys(models.CROWD_MODEL_REGISTRY), [
    'stageforge-alien-v1', 'stageforge-fox-v1', 'stageforge-human-v1', 'stageforge-human-v2', 'stageforge-robot-v1',
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
