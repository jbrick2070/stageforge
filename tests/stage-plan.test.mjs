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
const plan = await compiler.ssrLoadModule('/src/data/stagePlan.ts');
const { resolveStudioGeometry, resolveWallFrame, isCustomMainWall } = await compiler.ssrLoadModule('/src/data/studioGeometry.ts');
const { makeShowFile, parseShowFile } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { RIG_TEMPLATES, INITIAL_SHOW_STATE } = await compiler.ssrLoadModule('/src/data/presets.ts');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const arena = () => structuredClone(RIG_TEMPLATES.arena_mainstage);
const stageWith = (extra = {}) => ({ format: 'stageforge-native-stage', version: 1, walls: [{ id: 'main-led' }], screenEvents: [], ...extra });

test('plan yaw matches the three.js rotation about +Y (front = +Z, width = +X)', () => {
  for (const yaw of [-170, -90, -18, 0, 23, 90, 135, 270]) {
    const o = new THREE.Object3D();
    o.rotation.y = THREE.MathUtils.degToRad(yaw);
    o.updateMatrixWorld();
    const front = new THREE.Vector3(0, 0, 1).transformDirection(o.matrixWorld);
    const right = new THREE.Vector3(1, 0, 0).transformDirection(o.matrixWorld);
    close(plan.facing(yaw).x, front.x); close(plan.facing(yaw).z, front.z);
    close(plan.widthAxis(yaw).x, right.x); close(plan.widthAxis(yaw).z, right.z);
    // v3 files authored by the retired native-v0.1.0 prototype drew the aim as (sin(yaw), cos(yaw)).
    close(plan.facing(yaw).x, Math.sin(yaw * Math.PI / 180)); close(plan.facing(yaw).z, Math.cos(yaw * Math.PI / 180));
  }
  assert.equal(plan.yawToward({ x: 0, z: 0 }, { x: 0, z: 5 }), 0); // toward the audience
  assert.equal(plan.yawToward({ x: 0, z: 0 }, { x: 3, z: 0 }), 90);
  assert.equal(plan.yawToward({ x: 0, z: 0 }, { x: 0, z: -2 }), 180);
  assert.equal(plan.yawToward({ x: 0, z: 0 }, { x: 1, z: 1.05 }, 5), 45);
  assert.equal(plan.wrapDegrees(370), 10);
  assert.equal(plan.wrapDegrees(-190), 170);
});

test('the plan shows the stock main wall, custom main walls and secondary screens', () => {
  const rig = arena();
  const stock = plan.planWalls(rig, undefined);
  assert.equal(stock.length, 1);
  assert.ok(stock[0].primary && stock[0].stock);
  const off = { ...rig, ledWall: { ...rig.ledWall, enabled: false } };
  assert.equal(plan.planWalls(off, undefined).length, 0);
  const custom = stageWith({ walls: [{ id: 'main-led', x: 1 }, { id: 'side-led', label: 'Stage right', x: 9, z: 2, yaw: -18 }] });
  const walls = plan.planWalls(off, custom);
  assert.deepEqual(walls.map(w => [w.wall.id, w.primary, w.stock]), [['main-led', true, false], ['side-led', false, false]]);
});

test('dragging a wall moves it, its width handle resizes about the centre and its arrow aims it', () => {
  const rig = arena();
  const stage = stageWith({ walls: [{ id: 'main-led' }, { id: 'side-led', x: 8, y: 3, z: 1, width: 2, height: 1.5, yaw: 0 }] });
  const item = { kind: 'wall', id: 'side-led' };
  const moved = plan.moveStageItem(rig, stage, item, { x: 8, z: 1 }, { x: 9.5, z: 0 });
  assert.deepEqual(moved.walls[1], { id: 'side-led', x: 9.5, y: 3, z: 0, width: 2, height: 1.5, yaw: 0 });
  const wide = plan.moveStageItem(rig, stage, { ...item, node: 0 }, { x: 9, z: 1 }, { x: 10, z: 1.4 });
  assert.equal(wide.walls[1].width, 4); // projected onto the width axis, both sides grow
  // Aiming is measured from the wall's centre (8, 1), not from where the drag started.
  const aimed = plan.moveStageItem(rig, stage, { ...item, node: 1 }, { x: 8, z: 2 }, { x: 7, z: 1 }, 5);
  assert.equal(aimed.walls[1].yaw, -90); // now faces −X
  assert.equal(plan.moveStageItem(rig, stage, { ...item, node: 1 }, { x: 8, z: 2 }, { x: 7, z: 2 }).walls[1].yaw, -45);
  assert.deepEqual(stage.walls[1].x, 8, 'the source stage is never mutated');
});

test('authoring the stock main wall pins its whole frame', () => {
  const rig = arena();
  const frame = resolveWallFrame(rig, { id: 'main-led' });
  const stage = plan.moveStageItem(rig, undefined, { kind: 'wall', id: 'main-led' }, frame, { x: frame.x + 1, z: frame.z });
  const main = stage.walls.find(w => w.id === 'main-led');
  assert.deepEqual(main, { id: 'main-led', x: frame.x + 1, y: frame.y, z: frame.z, width: frame.width, height: frame.height, yaw: 0 });
  const reset = plan.removeStageItem(rig, { ...stage, walls: [{ ...main, label: 'Upstage LED' }] }, { kind: 'wall', id: 'main-led' });
  assert.deepEqual(reset.walls, [{ id: 'main-led', label: 'Upstage LED' }]);
});

test('editing a stock flown array materialises authored hangs; removing all keeps an explicit empty list', () => {
  const rig = arena();
  const stock = plan.effectiveHangs(rig, undefined);
  assert.equal(stock.authored, false);
  assert.equal(stock.hangs.length, 2);
  const aimed = plan.moveStageItem(rig, undefined, { kind: 'hang', id: '1', node: 0 }, stock.hangs[1], { x: stock.hangs[1].x - 2, z: stock.hangs[1].z + 2 }, 5);
  assert.equal(aimed.layout.hangs.length, 2);
  assert.equal(aimed.layout.hangs[1].yaw, -45);
  assert.deepEqual(aimed.layout.hangs[0], stock.hangs[0]);
  const none = plan.removeStageItem(rig, plan.removeStageItem(rig, aimed, { kind: 'hang', id: '0' }), { kind: 'hang', id: '0' });
  assert.deepEqual(none.layout.hangs, [], 'an empty list explicitly removes the rig arrays');
  assert.equal(plan.setHangs(rig, none, undefined).layout, undefined, 'reverting drops the override');
  assert.deepEqual(plan.effectiveHangs(rig, plan.setLayoutReplace(rig, undefined, true)).hangs, []);
});

test('layout trusses move by either end, refuse short spans, and convert to the same rig truss Studio renders', () => {
  const rig = arena();
  const stage = plan.setLayoutTrusses(rig, undefined, [{ x: -2, z: -1, endX: 2, endZ: 1, height: 6 }]);
  const end = plan.moveStageItem(rig, stage, { kind: 'span', id: '0', node: 1 }, { x: 2, z: 1 }, { x: 3, z: 3 });
  assert.deepEqual(end.layout.trusses[0], { x: -2, z: -1, endX: 3, endZ: 3, height: 6 });
  assert.equal(plan.moveStageItem(rig, stage, { kind: 'span', id: '0', node: 1 }, { x: 2, z: 1 }, { x: -1.8, z: -1 }), stage);

  const rendered = resolveStudioGeometry(rig, stage.layout).rig.trussPods.at(-1);
  const converted = plan.convertLayoutTruss(rig, stage, 0);
  const pod = converted.rig.trussPods.at(-1);
  for (const key of ['width', 'x', 'z', 'rotationY', 'baseY']) close(pod[key], rendered[key], 1e-3);
  assert.equal(converted.stage.layout, undefined, 'the converted truss leaves the layout');
  assert.equal(converted.rig.trussPods.length, rig.trussPods.length + 1);
  assert.equal(plan.convertLayoutTruss(rig, plan.setLayoutReplace(rig, stage, true), 0), null, 'replace hides rig trusses');
});

test('layout props move, change type and keep schema-valid numbers', () => {
  const rig = arena();
  const stage = plan.setLayoutProps(rig, undefined, [{ x: 1.23456, z: -2, type: 'inflatable', height: 2 }]);
  assert.deepEqual(stage.layout.props, [{ x: 1.235, z: -2, type: 'inflatable', height: 2 }]);
  const moved = plan.moveStageItem(rig, stage, { kind: 'prop', id: '0' }, { x: 1, z: -2 }, { x: 4, z: 0 });
  assert.deepEqual(moved.layout.props[0], { x: 4.235, z: 0, type: 'inflatable', height: 2 });
  const scenic = plan.setLayoutProps(rig, moved, [{ ...moved.layout.props[0], type: 'scenic', height: 0 }]);
  assert.equal(scenic.layout.props[0].type, 'scenic');
  assert.ok(scenic.layout.props[0].height > 0, 'height stays inside the schema dimension (> 0)');
});

test('removing a screen drops its wall cues; the stage still validates and round-trips through a v3 show', () => {
  const rig = arena();
  let stage = stageWith({
    walls: [{ id: 'main-led' }, { id: 'side-led', label: 'Stage right', x: 9, z: 2, yaw: -18 }, { id: 'wall-2', x: -9, z: 2, yaw: 18 }],
    screenEvents: [
      { atMs: 1000, target: 'side-led', kind: 'image', name: 'logo.png', playing: false },
      { atMs: 2000, target: 'wall-2', kind: 'none', name: '', playing: false },
    ],
  });
  stage = plan.moveStageItem(rig, stage, { kind: 'hang', id: '0' }, { x: 0, z: 0 }, { x: -1, z: 0 });
  stage = plan.setLayoutTrusses(rig, stage, [{ x: -3, z: 4, endX: 3, endZ: 4, height: 7 }]);
  stage = plan.setLayoutProps(rig, stage, [{ x: 0, z: 6, type: 'scenic', height: 3 }]);
  const finished = plan.finalizeStage(rig, stage);
  const show = parseShowFile(JSON.stringify(makeShowFile(rig, [], INITIAL_SHOW_STATE, null, undefined, undefined, undefined, finished)));
  assert.deepEqual(show.stage, finished);
  assert.equal(show.version, 3);

  const without = plan.removeStageItem(rig, stage, { kind: 'wall', id: 'wall-2' });
  assert.deepEqual(without.walls.map(w => w.id), ['main-led', 'side-led']);
  assert.deepEqual(without.screenEvents.map(e => e.target), ['side-led']);
  assert.equal(plan.finalizeStage(rig, stageWith()), undefined, 'an empty overlay is dropped');
  assert.throws(() => plan.finalizeStage(rig, stageWith({ walls: [{ id: 'a' }, { id: 'a' }] })), /share the ID/);
});

test('replace toggles cleanly and only writes the layout fields that carry meaning', () => {
  const rig = arena();
  const on = plan.setLayoutReplace(rig, undefined, true);
  assert.deepEqual(on.layout, { replace: true });
  const off = plan.setLayoutReplace(rig, on, false);
  assert.equal(off.layout, undefined);
  assert.equal(plan.finalizeStage(rig, off), undefined);
  assert.ok(plan.stagePlanPoints(rig, plan.setLayoutProps(rig, on, [{ x: 30, z: 2, type: 'scenic', height: 1 }])).some(p => p.x === 30));
});

test('a label-only edit keeps the stock main wall following the rig; geometry edits pin it', () => {
  const rig = arena();
  const [main] = plan.planWalls(rig, undefined);
  const labelled = plan.patchWall(main, { label: 'Upstage LED' });
  assert.deepEqual(labelled, { id: 'main-led', label: 'Upstage LED' });
  assert.equal(isCustomMainWall(labelled), false);
  const moved = plan.patchWall(main, { x: 2 });
  assert.equal(isCustomMainWall(moved), true);
  assert.equal(moved.width, main.frame.width, 'moving pins the rest of the resolved frame');
});

test('the 8-entry wall cap reserves room for the rig LED wall', () => {
  const rig = arena();
  const seven = stageWith({ walls: Array.from({ length: 7 }, (_, i) => ({ id: `wall-${i + 2}`, x: i })) });
  assert.equal(plan.canAddWall(rig, seven), false, 'the stock main wall still needs its entry');
  const off = { ...rig, ledWall: { ...rig.ledWall, enabled: false } };
  assert.equal(plan.canAddWall(off, seven), true);
  const eight = stageWith({ walls: Array.from({ length: 8 }, (_, i) => ({ id: `wall-${i + 2}`, x: i })) });
  const [main] = plan.planWalls(rig, eight);
  assert.ok(main.primary && main.stock);
  assert.equal(plan.canAuthorWall(main, eight), false);
  assert.equal(plan.canAuthorWall(main, seven), true);
  assert.equal(plan.canAuthorWall(plan.planWalls(rig, eight)[1], eight), true, 'secondary walls are already entries');
});

test('Apply rejects overlays outside the v3 schema', () => {
  const rig = arena();
  const tooMany = { trusses: Array.from({ length: 129 }, (_, i) => ({ x: i, z: 0, endX: i, endZ: 1, height: 4 })) };
  assert.throws(() => plan.finalizeStage(rig, stageWith({ layout: tooMany })), /invalid number of entries/);
  assert.throws(() => plan.finalizeStage(rig, stageWith({ layout: { hangs: [{ x: 0, y: 4, z: 0, yaw: 0, tilt: 0, count: 17, splay: 4 }] } })), /out of range/);
  assert.throws(() => plan.finalizeStage(rig, stageWith({ walls: [{ id: 'main-led' }, { id: 'side', width: 0 }] })), /out of range/);
  // The setters keep authored values inside the schema.
  assert.equal(plan.setLayoutTrusses(rig, undefined, tooMany.trusses).layout.trusses.length, 128);
  assert.equal(plan.setHangs(rig, undefined, [{ x: 0, y: 4, z: 0, yaw: 0, tilt: 0, count: 40, splay: 4 }]).layout.hangs[0].count, 16);
});