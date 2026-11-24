import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { resolveTakeFrame, secondaryScreensAt } = await compiler.ssrLoadModule('/src/data/showClock.ts');
const {
  createSecondaryWall,
  defaultSpeakerHangs,
  pruneNativeStage,
  removeSecondaryScreenEvent,
  removeStageWall,
  resolveStudioGeometry,
  resolveWallFrame,
  setAuthoredHangs,
  upsertSecondaryScreenEvent,
  upsertStageWall,
} = await compiler.ssrLoadModule('/src/data/studioGeometry.ts');
const { makeShowFile, parseShowFile, referencedFiles } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { exportStageDxf } = await compiler.ssrLoadModule('/src/data/stageDxf.ts');
const { calculateProductionEstimate } = await compiler.ssrLoadModule('/src/data/productionEstimator.ts');
const { INITIAL_SHOW_STATE, RIG_TEMPLATES, SHOW_CUES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { ledPlacement } = await compiler.ssrLoadModule('/src/data/stageEquipment.ts');

const nativeV3 = parseShowFile(await readFile(new URL('./fixtures/native-authoring-v3.stageforge.show.json', import.meta.url), 'utf8'));

test('showClock resolves forward play, held pauses, tempo shifts and backward jumps deterministically', () => {
  const base = {
    look: nativeV3.look,
    cueId: nativeV3.activeCueId,
    camera: nativeV3.controls.camera,
    volume: nativeV3.controls.volume,
    bump: { blinder: false, strobe: false, co2: false, smoke: false, laser: false, motorDrop: false },
    music: nativeV3.media.music,
    screen: nativeV3.media.screen,
  };
  const at8500 = resolveTakeFrame(nativeV3.timeline, 8500, base, true);
  assert.equal(at8500.cueId, 'sweep');
  assert.equal(at8500.screen.name, 'amber-clouds.mp4');
  assert.equal(at8500.screen.offsetSeconds, 2.0);
  assert.equal(at8500.screen.playing, true);

  const back7200 = resolveTakeFrame(nativeV3.timeline, 7200, base, false);
  assert.equal(back7200.cueId, 'sweep');
  assert.equal(back7200.screen.playing, false);
  assert.ok(Math.abs(back7200.screen.offsetSeconds - 0.7) < 1e-6);
  assert.equal(back7200.music.playing, false);
  assert.ok(Math.abs(back7200.music.demoStep - 7.2 * 128 / 15) < 1e-6);

  const end16000 = resolveTakeFrame(nativeV3.timeline, 99999, base, true);
  assert.equal(end16000.atMs, 16000);
  assert.equal(end16000.cueId, 'dark');
  assert.equal(end16000.look.blackout, true);

  const walls8500 = secondaryScreensAt(nativeV3.stage, 8500, true, (k, n) => `blob:${k}/${n}`);
  assert.equal(walls8500['side-led'].name, 'guest-surface.mp4');
  assert.equal(walls8500['side-led'].playing, false);
  assert.equal(walls8500['side-led'].offsetSeconds, 1.75);

  const walls14000 = secondaryScreensAt(nativeV3.stage, 14000, true, (k, n) => `blob:${k}/${n}`);
  assert.equal(walls14000['side-led'].name, 'blue-raster.mp4');
  assert.equal(walls14000['side-led'].playing, true);
  assert.ok(Math.abs(walls14000['side-led'].offsetSeconds - 3.25) < 1e-6);
});

test('Studio speaker hangs and secondary screen authoring round-trip cleanly through v3 schema', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  const seedHangs = defaultSpeakerHangs(rig);
  assert.equal(seedHangs.length, 2);
  let stage = setAuthoredHangs(rig, undefined, [
    { ...seedHangs[0], count: 7, yaw: 18, tilt: -6, splay: 5.5 },
    { ...seedHangs[1], count: 5, yaw: -22, tilt: -4, splay: 4.5 },
  ]);
  const wall = createSecondaryWall(rig, stage);
  assert.equal(wall.id, 'side-led');
  stage = upsertStageWall(rig, stage, { ...wall, label: 'House right', yaw: -24 });
  stage = upsertSecondaryScreenEvent(rig, stage, {
    atMs: 3000, target: 'side-led', kind: 'video', name: 'C:\\clips\\side-loop.mp4', playing: true, offsetSeconds: 1.5,
  });
  stage = upsertSecondaryScreenEvent(rig, stage, {
    atMs: 1000, target: 'side-led', kind: 'image', name: 'logo.png', playing: false,
  });
  assert.deepEqual(stage.screenEvents.map(e => e.atMs), [1000, 3000]);
  assert.equal(stage.screenEvents[1].name, 'side-loop.mp4');

  const show = makeShowFile(rig, SHOW_CUES, INITIAL_SHOW_STATE, SHOW_CUES[0].id, undefined, undefined, undefined, stage);
  assert.equal(show.version, 3);
  assert.equal(show.timeline.durationMs, 3000);
  const parsed = parseShowFile(JSON.stringify(show));
  assert.deepEqual(parsed.stage, stage);
  assert.deepEqual([...referencedFiles(parsed.media, parsed.cues, parsed.timeline, parsed.stage)].sort(), [
    'image:logo.png',
    'video:side-loop.mp4',
  ]);

  const resolved = resolveStudioGeometry(rig, stage.layout);
  assert.equal(resolved.hangs.length, 2);
  assert.equal(resolved.hangs[0].count, 7);

  stage = removeSecondaryScreenEvent(rig, stage, 'side-led', 1000);
  assert.equal(stage.screenEvents.length, 1);
  stage = removeStageWall(rig, stage, 'side-led');
  assert.equal(stage.screenEvents.length, 0);
  stage = setAuthoredHangs(rig, stage, undefined);
  assert.equal(pruneNativeStage(stage), undefined);
});

test('DXF and production estimator account for authored speaker hangs and secondary LED screens', () => {
  const dxf = exportStageDxf(nativeV3.rig, nativeV3.stage);
  assert.match(dxf, /\r\nPA\r\n/);
  assert.match(dxf, /\r\nVIDEO_WALLS\r\n/);
  assert.match(dxf, /SF_PA_HANG/);
  assert.match(dxf, /Stage right/);

  const baseEst = calculateProductionEstimate(nativeV3.rig);
  const authoredEst = calculateProductionEstimate(nativeV3.rig, nativeV3.stage);
  const paRow = authoredEst.equipmentItems.find(item => item.category === 'Audio / Speakers' && item.label.includes('hangs'));
  assert.ok(paRow, 'expected authored speaker hangs row');
  assert.match(paRow.qty, /^11 boxes \+ 2 racks$/);
  const secRow = authoredEst.equipmentItems.find(item => item.category === 'LED Video' && item.label.includes('Secondary'));
  assert.ok(secRow, 'expected secondary LED walls row');
  assert.ok(authoredEst.oneNightShowTotal > baseEst.oneNightShowTotal);
});

// Minimal DXF reader: group-code/value pairs split into entities.
function dxfEntities(dxf, type) {
  const lines = dxf.split('\r\n');
  const out = [];
  let current = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1];
    if (code === '0') { current = value === type ? [] : null; if (current) out.push(current); continue; }
    if (current) current.push([code, value]);
  }
  return out.map(pairs => ({
    get: code => pairs.find(([c]) => c === code)?.[1],
    all: code => pairs.filter(([c]) => c === code).map(([, v]) => Number(v)),
  }));
}
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`);

test('DXF orients aimed hangs and yawed walls like StageEngine and draws a partially authored main-led', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  const stage = {
    format: 'stageforge-native-stage', version: 1, screenEvents: [],
    walls: [{ id: 'main-led', y: 3.3 }, { id: 'w90', x: 5, y: 2.5, z: 1, width: 4, height: 2, yaw: 90 }],
    layout: { hangs: [{ x: -6, y: 9, z: 4, yaw: 90, tilt: -5, count: 6, splay: 3 }] },
  };
  const dxf = exportStageDxf(rig, stage);
  const insert = dxfEntities(dxf, 'INSERT').find(e => e.get('2') === 'SF_PA_HANG');
  assert.ok(insert, 'hang insert');
  // +Y upstage in CAD: world (x, z) -> CAD (x, -z); yaw is CCW about CAD +Z, matching three.js rotation.y.
  near(Number(insert.get('10')), -6, 'hang x');
  near(Number(insert.get('20')), -4, 'hang y');
  near(Number(insert.get('30')), 9, 'hang elevation');
  near(Number(insert.get('50')), 90, 'hang rotation');

  const walls = dxfEntities(dxf, 'LWPOLYLINE').filter(e => e.get('8') === 'VIDEO_WALLS');
  assert.equal(walls.length, 2, 'main-led with only y plus the yawed wall');
  const yawed = walls.find(e => Math.abs(Number(e.get('38')) - 2.5) < 1e-6);
  // Local +X at yaw 90 points to world -Z (upstage), i.e. CAD +Y: the second (local +X) vertex is upstage.
  assert.deepEqual(yawed.all('10').map(v => Number(v.toFixed(6))), [5, 5]);
  assert.deepEqual(yawed.all('20').map(v => Number(v.toFixed(6))), [-3, 1]);
  const main = walls.find(e => Math.abs(Number(e.get('38')) - 3.3) < 1e-6);
  const stock = ledPlacement(rig);
  const xs = main.all('10');
  near(Math.abs(xs[1] - xs[0]), stock.width, 'main-led inherits stock width');
  near(-main.all('20')[0], stock.z, 'main-led inherits stock z');
});

test('resolveWallFrame uses native defaults for secondary walls and stock placement for a partial main-led', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  assert.deepEqual(resolveWallFrame(rig, { id: 'side' }), { id: 'side', x: 0, y: 2, z: -2, width: 3, height: 2, yaw: 0 });
  // Imported oversize walls clamp to native render limits for 3D, DXF and estimator alike.
  const huge = resolveWallFrame(rig, { id: 'side', width: 300, height: 90 });
  assert.deepEqual([huge.width, huge.height], [40, 25]);
  const stock = ledPlacement(rig);
  const main = resolveWallFrame(rig, { id: 'main-led', width: 4 });
  assert.equal(main.width, 4);
  near(main.x, stock.x, 'x');
  near(main.y, stock.y, 'y');
  near(main.z, stock.z, 'z');
  near(main.height, stock.height, 'height');
});

test('estimator replaces stock wall and wings with an authored main-led and costs authored props', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  rig.ledWall = { ...rig.ledWall, enabled: true, sideWings: true,
    cabinets: { columns: 20, rows: 10, widthMm: 500, heightMm: 500, pixelsWide: 128, pixelsHigh: 128 } };
  const stage = { format: 'stageforge-native-stage', version: 1, screenEvents: [],
    walls: [{ id: 'main-led', width: 3, height: 2 }],
    layout: { props: [{ type: 'inflatable', x: 1, z: 0, height: 3 }, { type: 'scenic', x: -1, z: 0, height: 2 }] } };
  const est = calculateProductionEstimate(rig, stage);
  const led = est.equipmentItems.filter(i => i.category === 'LED Video');
  assert.equal(led.length, 1);
  assert.equal(led[0].label, 'LED wall (authored placement)');
  assert.equal(led[0].qty, '24 cabinets · 6 m²');
  assert.equal(led[0].buyCost, 6 * 3800);
  const scenery = est.equipmentItems.filter(i => i.category === 'Scenery (simulation allowance)').map(i => i.label);
  assert.ok(scenery.includes('Authored inflatables') && scenery.includes('Authored scenic pieces'));
});

test('wall cue authoring rejects unusable cues and keeps label edits from pinning the stock main wall', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  let stage = upsertStageWall(rig, undefined, createSecondaryWall(rig, undefined));
  const before = JSON.stringify(stage.screenEvents);
  for (const bad of [
    { atMs: Number.NaN, target: 'side-led', kind: 'video', name: 'a.mp4', playing: true },
    { atMs: 10, target: 'side-led', kind: 'video', name: '  \u0007 ', playing: true },
    { atMs: 10, target: 'main-led', kind: 'video', name: 'a.mp4', playing: true },
    { atMs: 10, target: 'nope', kind: 'image', name: 'a.png', playing: false },
  ]) assert.equal(JSON.stringify(upsertSecondaryScreenEvent(rig, stage, bad).screenEvents), before);
  stage = upsertSecondaryScreenEvent(rig, stage, { atMs: 5, target: 'side-led', kind: 'image', name: 'a\tb.png', playing: true });
  assert.deepEqual(stage.screenEvents[0], { atMs: 5, target: 'side-led', kind: 'image', name: 'ab.png', playing: false });
  // A label-only main-led entry stays a stock wall (no geometry keys).
  stage = upsertStageWall(rig, stage, { id: 'main-led', label: 'Upstage' });
  assert.deepEqual(stage.walls.find(w => w.id === 'main-led'), { id: 'main-led', label: 'Upstage' });
  // Wall sizes clamp to native-v0.1.0 render limits.
  const big = upsertStageWall(rig, stage, { id: 'side-led', width: 90, height: 60 }).walls.find(w => w.id === 'side-led');
  assert.deepEqual([big.width, big.height], [40, 25]);
});

test('showClock: tempo changes advance demo music piecewise, and wall state before the first cue is absent', () => {
  const look = { ...INITIAL_SHOW_STATE, bpm: 120 };
  const base = { look, cueId: null, camera: 'foh', volume: 0.7,
    bump: { blinder: false, strobe: false, co2: false, smoke: false, laser: false, motorDrop: false },
    music: { kind: 'demo', name: 'Demo', playing: true, demoStep: 0 }, screen: { kind: 'none', name: '', playing: false } };
  const take = { durationMs: 4000, events: [{ atMs: 0, look }, { atMs: 1000, look: { bpm: 60 } }, { atMs: 2000, look: { bpm: 180 } }] };
  // 1 s @120 + 1 s @60 + 1 s @180 = (120 + 60 + 180) / 15 steps.
  const at3 = resolveTakeFrame(take, 3000, base, true);
  near(at3.music.demoStep, (120 + 60 + 180) / 15, 'demo step after tempo changes');
  assert.equal(at3.look.bpm, 180);
  // Jumping back resolves from the start, not from the previous playhead.
  near(resolveTakeFrame(take, 1500, base, false).music.demoStep, (120 + 30) / 15, 'backward jump');

  const stage = { screenEvents: [
    { atMs: 1000, target: 'a', kind: 'video', name: 'a.mp4', playing: true, offsetSeconds: 2 },
    { atMs: 1500, target: 'b', kind: 'image', name: 'b.png', playing: false },
    { atMs: 3000, target: 'a', kind: 'none', name: '', playing: false },
  ] };
  assert.deepEqual(secondaryScreensAt(stage, 500, true, () => 'u'), {});
  const mid = secondaryScreensAt(stage, 2000, true, () => undefined);
  near(mid.a.offsetSeconds, 3, 'a offset');
  assert.equal(mid.a.url, undefined);
  assert.equal(mid.b.playing, false);
  assert.equal(secondaryScreensAt(stage, 3000, true, () => 'u').a.kind, 'none');
});

test('resetting a custom main-led prunes empty stage wrappers and estimator scales riggers with hang count', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  let stage = upsertStageWall(rig, undefined, { id: 'main-led', width: 8, height: 4 });
  assert.ok(pruneNativeStage(stage), 'custom main-led stays authored');
  stage = pruneNativeStage(upsertStageWall(rig, stage, {
    id: 'main-led', x: undefined, y: undefined, z: undefined, width: undefined, height: undefined, yaw: undefined,
  }));
  assert.equal(stage, undefined, 'resetting custom main-led with no other stage overrides prunes to undefined');

  const hang = { x: -8, y: 10, z: 4, yaw: 0, tilt: 0, count: 6, splay: 4 };
  const twoHangs = calculateProductionEstimate(rig, setAuthoredHangs(rig, undefined, [hang, { ...hang, x: 8 }]));
  const sixHangs = calculateProductionEstimate(rig, setAuthoredHangs(rig, undefined, Array.from({ length: 6 }, (_, i) => ({ ...hang, x: -12 + i * 5 }))));
  const riggers = est => est.laborItems.find(item => item.role.includes('Rigger')).crewCount;
  assert.ok(riggers(sixHangs) > riggers(twoHangs), 'more flown speaker hangs scale rigging crew');
});
