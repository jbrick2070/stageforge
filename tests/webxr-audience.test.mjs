import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createServer } from 'vite';

const loader = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});
const mod = await loader.ssrLoadModule('/src/xr/audienceExperience.ts');

test.after(async () => loader.close());

test('audience viewpoints are bounded and preserve seated/standing eye heights', () => {
  for (const venue of ['arena', 'warehouse', 'festival', 'theatre', 'club']) {
    const rig = { venue, stageWidth: 24, stageDepth: 12 };
    const foh = { position: { x: 2, y: 6.4, z: 40 }, target: { x: 0, y: 4, z: 0 } };
    const seats = mod.deriveAudienceViewpoints(rig, foh);
    assert.deepEqual(seats.map((seat) => seat.id), ['stage-front', 'floor', 'mezzanine', 'balcony', 'foh']);
    for (const seat of seats) {
      assert.ok(Number.isFinite(seat.x) && Number.isFinite(seat.z) && Number.isFinite(seat.yawRad));
      const standing = mod.viewpointHeadPose(seat, 'standing');
      const seated = mod.viewpointHeadPose(seat, 'seated');
      assert.equal(Number((standing.position.y - seat.floorY).toFixed(6)), 1.6);
      assert.equal(Number((seated.position.y - seat.floorY).toFixed(6)), 1.2);
      assert.equal(Number((standing.position.y - seated.position.y).toFixed(6)), 0.4);
    }
    assert.equal(seats.find((seat) => seat.id === 'foh').x, 2);
  }
  const arena = mod.deriveAudienceViewpoints({ venue: 'arena', stageWidth: 24, stageDepth: 12 });
  assert.equal(arena.find((seat) => seat.id === 'mezzanine').virtualTier, false);
  assert.equal(arena.find((seat) => seat.id === 'balcony').floorY, 4.29);
  const festival = mod.deriveAudienceViewpoints({ venue: 'festival', stageWidth: 24, stageDepth: 12 });
  assert.equal(festival.find((seat) => seat.id === 'balcony').virtualTier, true);
});

test('front sightlines, theatre aisles and elevated lookouts reject occupied landings', async () => {
  const arena = { venue: 'arena', stageWidth: 24, stageDepth: 12 };
  const theatre = { ...arena, venue: 'theatre' };
  const stageFront = mod.deriveAudienceViewpoints(arena).find(seat => seat.id === 'stage-front');
  const postFaceZ = arena.stageDepth / 2 + 2.4 + 0.225;
  assert.ok(stageFront.z - postFaceZ >= 1);
  assert.ok(!stageFront.blocked);
  const displaced = mod.deriveAudienceViewpoints(arena, undefined,
    [{ x: stageFront.x, y: 0, z: stageFront.z, radius: 0.5, height: 2 }]).find(seat => seat.id === 'stage-front');
  assert.ok(!displaced.blocked);
  assert.ok(Math.hypot(displaced.x - stageFront.x, displaced.z - stageFront.z) >= 0.75);

  const { theatreSeatAnchors } = await loader.ssrLoadModule('/src/data/crowdPlacement.ts');
  const chairs = theatreSeatAnchors(theatre);
  const chair = chairs.find(seat => seat.row === 7);
  const foh = { position: { x: chair.x, y: 1.6, z: chair.z }, target: { x: 0, y: 0, z: 0 } };
  const theatreViews = mod.deriveAudienceViewpoints(theatre, foh);
  for (const name of ['floor', 'foh']) {
    const seat = theatreViews.find(view => view.id === name);
    assert.ok(!seat.blocked);
    assert.ok(seat.floorY > 0);
    assert.ok(chairs.some(chair => chair.y === seat.floorY && chair.z - 0.05 === seat.z));
    assert.ok(chairs.filter(chair => chair.y === seat.floorY).every(chair => Math.abs(chair.x - seat.x) >= 0.6));
  }

  const wall = { x: 0, y: 0, z: 0, radius: 500, height: 20 };
  assert.ok(mod.deriveAudienceViewpoints(arena, undefined, [wall]).every(view => view.blocked));
});

test('offset reference-space transform resolves viewer and controller poses coherently', () => {
  const q = (yaw) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
  const baseHead = { position: { x: 0.12, y: 1.62, z: -0.08 }, orientation: q(0.1) };
  const desired = { position: { x: 5, y: 4.17, z: 28 }, orientation: q(-0.8) };
  const offset = mod.offsetPoseForDesiredHead(baseHead, desired);
  const resolved = mod.resolvePoseInOffsetSpace(baseHead, offset);
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(resolved.position[axis] - desired.position[axis]) < 1e-9);
  assert.ok(Math.abs(resolved.orientation.y - desired.orientation.y) < 1e-9);
  assert.ok(Math.abs(resolved.orientation.w - desired.orientation.w) < 1e-9);

  const baseController = { position: { x: 0.4, y: 1.25, z: -0.5 }, orientation: q(0.1) };
  const resolvedController = mod.resolvePoseInOffsetSpace(baseController, offset);
  const headToControllerBase = Math.hypot(
    baseController.position.x - baseHead.position.x,
    baseController.position.y - baseHead.position.y,
    baseController.position.z - baseHead.position.z,
  );
  const headToControllerDerived = Math.hypot(
    resolvedController.position.x - resolved.position.x,
    resolvedController.position.y - resolved.position.y,
    resolvedController.position.z - resolved.position.z,
  );
  assert.ok(Math.abs(headToControllerBase - headToControllerDerived) < 1e-9);
  assert.equal(Number(mod.snapYaw(0, 1).toFixed(9)), Number((Math.PI / 6).toFixed(9)));
  assert.equal(Number(mod.snapYaw(0, -1).toFixed(9)), Number((-Math.PI / 6).toFixed(9)));
});

test('menu hit testing uses half-open button bounds and input edges are globally one-shot per frame', () => {
  const rects = [
    { id: 'left', x: 0, y: 0, width: 100, height: 100 },
    { id: 'right', x: 100, y: 0, width: 100, height: 100 },
  ];
  assert.equal(mod.menuHitTest({ x: -0.25, y: 0.25, z: 1 }, { x: 0, y: 0, z: -1 }, 200, 200, rects)?.id, 'left');
  assert.equal(mod.menuHitTest({ x: 0, y: 0.25, z: 1 }, { x: 0, y: 0, z: -1 }, 200, 200, rects)?.id, 'right');
  assert.equal(mod.menuHitTest({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, 200, 200, rects), null);
  assert.equal(mod.menuHitTest({ x: 0.6, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, 200, 200, rects), null);
  const scratch = { id: '', pixelX: 0, pixelY: 0, distance: 0 };
  assert.equal(mod.menuHitTest({ x: 0, y: 0.25, z: 1 }, { x: 0, y: 0, z: -1 }, 200, 200, rects, scratch), scratch);
  assert.equal(scratch.id, 'right');

  const state = mod.createInputEdgeState();
  assert.equal(mod.consumeInputEdge(state, 'left', 'select', true, 12), true);
  assert.equal(mod.consumeInputEdge(state, 'left', 'select', true, 12), false);
  assert.equal(mod.consumeInputEdge(state, 'right', 'select', true, 12), false);
  assert.equal(mod.consumeInputEdge(state, 'left', 'select', false, 13), false);
  assert.equal(mod.consumeInputEdge(state, 'left', 'select', true, 13), true);
});

test('visible XR frame/controller hot paths reuse retained scratch objects', () => {
  const source = readFileSync(new URL('../src/xr/audienceScene.ts', import.meta.url), 'utf8');
  const controllerHit = source.slice(source.indexOf('private controllerHit'), source.indexOf('private beginTeleport'));
  const update = source.slice(source.indexOf('public update('), source.indexOf('public activateForTest'));
  assert.doesNotMatch(controllerHit, /new THREE\.(?:Vector|Quaternion|Matrix)/);
  assert.doesNotMatch(controllerHit, /\.clone\(\)/);
  assert.doesNotMatch(update, /new THREE\.(?:Vector|Quaternion|Matrix)/);
  assert.doesNotMatch(update, /for \(const .* of \[/);
});

test('XR quality preference is validated and defaults to standalone only for Oculus Browser', () => {
  assert.equal(mod.defaultXrQualityProfile('Mozilla OculusBrowser/35'), 'standalone-low');
  assert.equal(mod.defaultXrQualityProfile('Mozilla Chrome/130'), 'pc-link-high');
  assert.deepEqual(mod.XR_ARENA_EMULATOR_BUDGET, {
    calls: 270,
    triangles: 760000,
    rendererTextures: 26,
    ownedTextures: 1,
  });
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    mod.saveXrQualityProfile('standalone-low');
    assert.equal(mod.loadXrQualityProfile('Chrome'), 'standalone-low');
    values.set(mod.XR_PROFILE_STORAGE_KEY, 'corrupt');
    assert.equal(mod.loadXrQualityProfile('Chrome'), 'pc-link-high');
    globalThis.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    assert.equal(mod.loadXrQualityProfile('OculusBrowser'), 'standalone-low');
    assert.doesNotThrow(() => mod.saveXrQualityProfile('pc-link-high'));
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});
