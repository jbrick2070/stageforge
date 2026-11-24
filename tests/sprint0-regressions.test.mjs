import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createServer, createLogger } from 'vite';

const warnings = [];
const logger = createLogger();
const origWarn = logger.warn.bind(logger);
logger.warn = (msg, opts) => {
  warnings.push(String(msg));
  origWarn(msg, opts);
};

const compiler = await createServer({
  configFile: false,
  customLogger: logger,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

await compiler.ssrLoadModule('/src/data/showFile.ts');
const { parseRigJson } = await compiler.ssrLoadModule('/src/data/rigImport.ts');
const { createBlankDesign } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { resolveTakeFrame } = await compiler.ssrLoadModule('/src/data/showClock.ts');
const { INITIAL_SHOW_STATE, RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { hungUnits, floorUnitX, placeFixtures } = await compiler.ssrLoadModule('/src/data/fixturePlacement.ts');
const { fitAuthoredFoh } = await compiler.ssrLoadModule('/src/engine/fohFraming.ts');
const { MAX_WALL_CUE_MS, setAuthoredHangs, upsertSecondaryScreenEvent, upsertStageWall } = await compiler.ssrLoadModule('/src/data/studioGeometry.ts');
const { createLiveStore } = await compiler.ssrLoadModule('/src/state/liveTelemetry.ts');

const isReadableError = (e) => e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError) && e.message.length > 0;

test('schemas live in src/schemas without Vite public-directory warnings and package.json pins exact versions', async () => {
  assert.equal(existsSync(new URL('../public/schemas', import.meta.url)), false, 'public/schemas must not exist');
  assert.deepEqual(
    warnings.filter((w) => /Assets in public directory/i.test(w)),
    [],
    'loading showFile.ts must not emit Vite public-directory warnings',
  );
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      assert.doesNotMatch(spec, /^[\^~]/, `${section}.${name} must be pinned exactly (got "${spec}")`);
    }
  }
});

test('parseRigJson enforces size cap, BOM handling, bounds, list caps and prototype-pollution ID bans', () => {
  const base = createBlankDesign();
  // UTF-8 BOM is accepted cleanly.
  assert.equal(parseRigJson('\uFEFF' + JSON.stringify(base)).name, base.name);

  // Oversized JSON rejected with readable Error.
  assert.throws(() => parseRigJson(' '.repeat(32 * 1024 * 1024 + 2) + '{}'), (e) => isReadableError(e) && /32 MiB/.test(e.message));

  const badRigs = [
    ['stageWidth Infinity', (r) => { r.stageWidth = 1e308; }],
    ['stageWidth > 1000', (r) => { r.stageWidth = 1001; }],
    ['pod id constructor', (r) => {
      r.trussPods = [{ id: 'constructor', name: 'T', shape: 'box', width: 4, x: 0, baseY: 5, z: 0, rotationY: 0, motorized: false, motorMinY: 5, motorMaxY: 5, fixtures: [] }];
    }],
    ['pod id __proto__', (r) => {
      r.trussPods = [{ id: '__proto__', name: 'T', shape: 'box', width: 4, x: 0, baseY: 5, z: 0, rotationY: 0, motorized: false, motorMinY: 5, motorMaxY: 5, fixtures: [] }];
    }],
    ['coord > 10000', (r) => {
      r.trussPods = [{ id: 't1', name: 'T', shape: 'box', width: 4, x: 1e9, baseY: 5, z: 0, rotationY: 0, motorized: false, motorMinY: 5, motorMaxY: 5, fixtures: [] }];
    }],
    ['too many trussPods', (r) => {
      r.trussPods = Array.from({ length: 257 }, (_, i) => ({
        id: `t-${i}`, name: `T${i}`, shape: 'box', width: 2, x: 0, baseY: 5, z: 0, rotationY: 0, motorized: false, motorMinY: 5, motorMaxY: 5, fixtures: [],
      }));
    }],
    ['long label > 512', (r) => { r.name = 'A'.repeat(513); }],
  ];
  for (const [label, edit] of badRigs) {
    const draft = structuredClone(base);
    edit(draft);
    assert.throws(() => parseRigJson(JSON.stringify(draft)), isReadableError, label);
  }

  // Huge name (10 MB) must fail fast without allocating a 10M-element code-point array.
  const hugeNameRig = JSON.stringify({ ...base, name: 'X'.repeat(10_000_000) });
  const t0 = performance.now();
  assert.throws(() => parseRigJson(hugeNameRig), isReadableError);
  assert.ok(performance.now() - t0 < 1000, '10 MB name rejected quickly');

  // Legacy schema-valid rigs allow arbitrary finite rotationY values.
  const bigRot = structuredClone(base);
  bigRot.trussPods = [{ id: 't1', name: 'T', shape: 'box', width: 4, x: 0, baseY: 5, z: 0, rotationY: 20000, motorized: false, motorMinY: 5, motorMaxY: 5, fixtures: [] }];
  assert.equal(parseRigJson(JSON.stringify(bigRot)).trussPods[0].rotationY, 20000);
});

test('resolveTakeFrame guards NaN and Infinity seeks without poisoning offsets', () => {
  const base = {
    look: structuredClone(INITIAL_SHOW_STATE),
    cueId: null,
    camera: 'foh',
    volume: 0.72,
    bump: { blinder: false, strobe: false, co2: false, smoke: false, laser: false, motorDrop: false },
    music: { kind: 'demo', name: 'Demo', playing: true, demoStep: 0 },
    screen: { target: 'main-led', kind: 'video', name: 'clip.mp4', playing: true, offsetSeconds: 0 },
  };
  const take = {
    durationMs: 4000,
    events: [
      { atMs: 0, look: base.look, cueId: null, camera: 'foh', volume: 0.72, bump: base.bump, music: base.music, screen: base.screen },
      { atMs: 2000, look: { masterDimmer: 0.25 } },
    ],
  };
  const nanFrame = resolveTakeFrame(take, Number.NaN, base, true);
  assert.equal(nanFrame.atMs, 0);
  assert.equal(nanFrame.look.masterDimmer, base.look.masterDimmer);
  assert.ok(Number.isFinite(nanFrame.music.demoStep));
  assert.ok(Number.isFinite(nanFrame.screen.offsetSeconds));

  const infFrame = resolveTakeFrame(take, Infinity, base, true);
  assert.equal(infFrame.atMs, 4000);
  assert.equal(infFrame.look.masterDimmer, 0.25);
});

test('hungUnits and floorUnitX match placeFixtures across mixed pods and floor rows', () => {
  for (const rig of Object.values(RIG_TEMPLATES)) {
    const placements = placeFixtures(rig);
    const floorUnits = placements.filter((u) => u.floor);
    let idx = 0;
    for (const group of rig.floorFx) {
      for (let i = 0; i < group.count; i++) {
        assert.equal(floorUnits[idx].position.x, floorUnitX(group, i));
        idx++;
      }
    }
    for (const pod of rig.trussPods) {
      const expected = hungUnits(pod.fixtures);
      const actual = placements.filter((u) => u.podId === pod.id);
      assert.equal(actual.length, expected.length);
      expected.forEach((entry, n) => {
        assert.equal(actual[n].group, entry.group);
        assert.equal(actual[n].index, entry.index);
      });
    }
  }
});

test('fitAuthoredFoh frames far-off secondary LED screens named "LED display"', () => {
  const stage = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 1, 4), new THREE.MeshStandardMaterial());
  stage.add(deck);
  const secondaryMat = new THREE.ShaderMaterial({ name: 'LED display' });
  const secondaryScreen = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), secondaryMat);
  secondaryScreen.position.set(28, 4, 0);
  stage.add(secondaryScreen);
  // A volumetric beam ShaderMaterial (not named 'LED display') must still be excluded.
  const beamMat = new THREE.ShaderMaterial({ name: 'Beam volume' });
  const beam = new THREE.Mesh(new THREE.ConeGeometry(1, 200), beamMat);
  beam.position.set(-200, 0, 0);
  stage.add(beam);

  const frame = fitAuthoredFoh([stage], [], 16 / 9, 18, 45, 48);
  assert.ok(frame.target.x > 10, `target.x (${frame.target.x}) must include secondary screen at x=28`);
  assert.ok(frame.target.x < 20, `target.x (${frame.target.x}) must ignore beam volume at x=-200`);
});

test('studioGeometry clamps extreme wall-cue timestamps and rejects NaN geometry edits cleanly', () => {
  const rig = createBlankDesign();
  let stage = upsertStageWall(rig, undefined, { id: 'side-led', x: Number.NaN, y: 2, z: -2, width: 3, height: 2, yaw: 0 });
  assert.ok(Number.isFinite(stage.walls.find((w) => w.id === 'side-led').x));

  stage = upsertSecondaryScreenEvent(rig, stage, {
    atMs: 1e20, target: 'side-led', kind: 'video', name: 'clip.mp4', playing: true, offsetSeconds: 1e20,
  });
  assert.equal(stage.screenEvents[0].atMs, MAX_WALL_CUE_MS);
  assert.equal(stage.screenEvents[0].offsetSeconds, MAX_WALL_CUE_MS / 1000);

  const withHang = setAuthoredHangs(rig, stage, [{ x: Number.NaN, y: 8, z: 0, yaw: 0, tilt: 0, count: 6, splay: 4 }]);
  assert.ok(Number.isFinite(withHang.layout.hangs[0].x));
});

test('createLiveStore notifies subscribers only on changes and cleans up on unsubscribe', () => {
  const store = createLiveStore(60);
  let calls = 0;
  const unsub = store.subscribe(() => calls++);
  store.set(60);
  assert.equal(calls, 0);
  store.set(59);
  assert.equal(calls, 1);
  assert.equal(store.get(), 59);
  unsub();
  store.set(58);
  assert.equal(calls, 1);
});

test('StageEngine.dispose safely cleans up a partially constructed instance (before mats exists)', async () => {
  const { StageEngine } = await compiler.ssrLoadModule('/src/engine/StageEngine.ts');
  const partial = Object.create(StageEngine.prototype);
  partial.secondaryPlayers = new Map();
  partial.mediaGeneration = 0;
  partial.rafId = null;
  partial.rigGroup = new THREE.Group();
  partial.laserShapeGeometries = new Set();
  partial.laserShapes = new Map();
  partial.scenicPieces = new Map();
  // mats, renderer, composer, controls, resizeObserver, particles, textTex are all undefined here.
  assert.doesNotThrow(() => partial.dispose());
});
