import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const isReadableError = (e) => e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError) && e.message.length > 0;

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());
const { parseShowFile, makeShowFile, SHOW_SCHEMA_URL, V4_SCHEMA_URL, V5_SCHEMA_URL, V6_SCHEMA_URL, V7_SCHEMA_URL, V8_SCHEMA_URL, V9_SCHEMA_URL } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { RIG_TEMPLATES, INITIAL_SHOW_STATE, SHOW_CUES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { cueLook, differsFromCue } = await compiler.ssrLoadModule('/src/data/cueLook.ts');
const { frameDelta } = await compiler.ssrLoadModule('/src/input/useShowTimeline.ts');
const { laserProjectors } = await compiler.ssrLoadModule('/src/data/laserProjectors.ts');
const example = JSON.parse(await readFile(new URL('../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));
const parse = value => parseShowFile(JSON.stringify(value));
const write = show => makeShowFile(show.rig, show.cues, show.look, show.activeCueId, show.controls, show.timeline, show.media, show.stage, show.interchange);

test('v1 remains writable and a v2 cue or take preserves independently focused and colored groups', () => {
  const authored = parse(example);
  assert.equal(write(authored).version, 1);
  const split = { wash: { focusMarkId: 'platform:main-deck', primaryColor: '#ffb869', movementMode: 'manual' } };
  authored.timeline.events[1].look = { movingGroups: split };
  const fromTake = write(authored);
  assert.equal(fromTake.version, 2);
  assert.deepEqual(parse(fromTake).timeline.events[1].look.movingGroups, split);
  authored.cues[1].state.movingGroups = split;
  delete authored.timeline;
  const fromCue = write(authored);
  assert.equal(fromCue.version, 2);
  fromCue.cues[1].state.movingGroups.wash.focusMarkId = 'platform:removed';
  assert.throws(() => parse(fromCue), /movingGroups.wash.focusMarkId/);
  assert.equal(write(fromCue).cues[1].state.movingGroups.wash.focusMarkId, null);
  fromCue.version = 1;
  assert.throws(() => parse(fromCue));
});

test('reopened v1 cues compare their authored values and ignore inherited fields, URL resolution and JSON key order', () => {
  const previous = structuredClone(INITIAL_SHOW_STATE);
  const screen = { kind: 'none', target: 'main-led', playing: false, name: '' };
  previous.led.tourText = 'Festival';
  previous.motors.podTargets = { front: { height: 1, tilt: 0 }, rear: { height: 0.5, tilt: 0.3 } };
  const partial = SHOW_CUES[1];
  const look = cueLook(previous, partial);
  look.masterDimmer = 0.42;
  assert.equal(differsFromCue(look, partial, screen), false);
  assert.equal(differsFromCue({ ...look, primaryColor: '#abcdef' }, partial, screen), true);
  const captured = { ...partial, state: structuredClone(look) };
  const reopened = structuredClone(look);
  reopened.motors.podTargets = { rear: { tilt: 0.3, height: 0.5 }, front: { tilt: 0, height: 1 } };
  reopened.led.customMediaUrl = 'blob:session';
  assert.equal(differsFromCue(reopened, captured, screen), false);
  assert.equal(differsFromCue({ ...reopened, masterDimmer: 1 }, captured, screen), true);
});

test('a recorded override retains its cue cursor and refiring the same cue records its ID', () => {
  const frame = { ...example.timeline.events[0], cueModified: false };
  const edited = { ...frame, cueModified: true, look: { ...frame.look, masterDimmer: 0.6 } };
  assert.deepEqual(frameDelta(frame, edited, 100, 100), { atMs: 100, look: { masterDimmer: 0.6 } });
  assert.deepEqual(frameDelta(edited, frame, 200, 100), {
    atMs: 200, look: { masterDimmer: frame.look.masterDimmer }, cueId: frame.cueId,
  });
});

test('the public example round-trips its ordered cues, playback clock and media transport', () => {
  const show = parse(example);
  assert.deepEqual(write(show), example);
  assert.equal(show.$schema, SHOW_SCHEMA_URL);
  assert.deepEqual(show.cues.map(cue => cue.followSeconds), [2.5, undefined]);
  assert.equal(show.cues[1].screen.name, 'amber-clouds.mp4');
  assert.deepEqual(show.timeline.events.map(event => event.atMs), [0, 2500, 5000, 6000]);
  assert.equal(show.timeline.events[0].look.masterDimmer, 0);
  assert.equal(show.timeline.events[2].screen.offsetSeconds, 2.5);
  assert.equal(show.timeline.events[3].music.playing, false);
});

test('every stock venue and its factory looks export without changing the live desk', () => {
  const snapshot = structuredClone(INITIAL_SHOW_STATE);
  for (const rig of Object.values(RIG_TEMPLATES)) {
    const show = makeShowFile(rig, SHOW_CUES, INITIAL_SHOW_STATE, SHOW_CUES[0].id);
    assert.deepEqual(parse(show), show);
    assert.deepEqual(show.cues.map(cue => cue.id), SHOW_CUES.map(cue => cue.id));
    assert.ok(Object.keys(show.look.motors.podTargets).every(id => rig.trussPods.some(pod => pod.id === id)));
    assert.ok(!('media' in show) && !('timeline' in show) && !('controls' in show));
    show.look.led.tourText = 'edited';
  }
  assert.deepEqual(INITIAL_SHOW_STATE, snapshot);
});

test('empty cue lists, a bare rig, deleted historical cue IDs and simultaneous events remain valid', () => {
  const show = structuredClone(example);
  show.cues = [];
  show.activeCueId = null;
  show.rig.platforms = [];
  const exported = write(show);
  assert.equal(exported.look.focusMarkId, null);
  assert.equal(exported.timeline.events[0].cueId, 'walk-on');
  exported.timeline.events[2].atMs = exported.timeline.events[1].atMs;
  assert.deepEqual(parse(exported), exported);
  exported.timeline = { durationMs: 0, events: [] };
  assert.deepEqual(parse(exported).timeline, exported.timeline);
});

test('export discards session URLs, private fields and media paths throughout the file', () => {
  const show = structuredClone(example);
  const local = 'blob:stageforge/session-only';
  for (const state of [show.look, show.cues[0].state, show.timeline.events[0].look]) {
    state.led.customMediaUrl = local;
    state.led.customMediaType = 'video';
  }
  show.rig.privateToken = 'secret';
  show.media.music = { kind: 'file', name: 'C:\\User\\Music\\Act #2.wav', playing: true, deviceId: 'secret' };
  show.media.screen.name = 'https://private.invalid/Secret.mp4?token=secret';
  show.cues[0].screen.name = '/Users/Secret/Desktop/gold.png';
  show.timeline.events[2].screen.name = 'blob:stageforge/secret';
  const saved = write(show);
  assert.ok(!/session-only|secret|privateToken|deviceId/i.test(JSON.stringify(saved)));
  assert.equal(saved.media.music.name, 'Act #2.wav');
  assert.equal(saved.cues[0].screen.name, 'gold.png');
  assert.equal(saved.look.led.customMediaType, null);
  assert.equal(show.look.led.customMediaUrl, local);
  assert.deepEqual(parse(saved), saved);
});

test('native walls, stage design and timed secondary screen events survive a v3 round trip', () => {
  const stage = {
    format: 'stageforge-native-stage', version: 1,
    walls: [{ id: 'main-led' }, { id: 'side-led', label: 'Side', x: 3, y: 2, z: -4, yaw: 12, width: 2, height: 1 }],
    screenEvents: [{ atMs: 5000, target: 'side-led', kind: 'video', name: 'swirls.mp4', playing: true, offsetSeconds: 1 }],
    layout: { replace: true, trusses: [{ x: -1, z: 2, endX: 4, endZ: 3, height: 5 }],
      hangs: [{ x: 0, y: 2, z: 1, yaw: 30, tilt: -5, count: 4, splay: 4 }],
      props: [{ x: 4, z: 0, type: 'inflatable', height: 3 }] },
  };
  const saved = write({ ...example, stage });
  assert.equal(saved.version, 3);
  assert.deepEqual(parse(saved).stage, stage);
  assert.deepEqual(write(parse(saved)), saved);
  assert.equal(write({ ...saved, timeline: { durationMs: 1000, events: [] } }).timeline.durationMs, 5000);
  for (const change of [
    next => next.walls.push(next.walls[0]),
    next => { next.screenEvents[0].target = 'main-led'; },
    next => { next.screenEvents[0].target = 'absent'; },
    next => { next.screenEvents[0].name = '../private.mp4'; },
    next => { next.layout.hangs[0].count = 0; },
    next => { next.screenEvents[0].atMs = 999999; },
  ]) {
    const invalid = structuredClone(saved);
    change(invalid.stage);
    assert.throws(() => parse(invalid));
  }
  for (const version of [1, 2]) {
    assert.throws(() => parse({ ...saved, version, $schema: saved.$schema.replace('v3','v' + version) }));
  }
});

const badEdits = [
  ['unsupported file version', s => { s.version = 6; }],
  ['wrong schema', s => { s.$schema = 'https://other.invalid'; }],
  ['missing complete look field', s => { delete s.look.bpm; }],
  ['bad look color', s => { s.look.primaryColor = 'url(...)'; }],
  ['bad enum', s => { s.look.laser.pattern = 'unknown'; }],
  ['unsafe media URL', s => { s.look.led.customMediaUrl = 'data:video/mp4;base64,...'; }],
  ['unknown nested private field', s => { s.media.music.password = 'secret'; }],
  ['media reference with URL', s => { s.cues[0].screen.name = 'https://example.invalid/file.mp4'; }],
  ['loaded media missing identity', s => { s.media.screen.name = ' '; }],
  ['unsafe ID', s => { s.cues[1].id = '__proto__'; }],
  ['duplicate cue', s => { s.cues[1].id = s.cues[0].id; }],
  ['dangling active cue', s => { s.activeCueId = 'missing'; }],
  ['dangling motor target', s => { s.look.motors.podTargets.missing = {height: 0.7, tilt: 0}; }],
  ['dangling focus mark', s => { s.look.focusMarkId = 'platform:missing'; }],
  ['zero follow', s => { s.cues[0].followSeconds = 0; }],
  ['long follow', s => { s.cues[0].followSeconds = 3600.01; }],
  ['invalid volume', s => { s.controls.volume = 1.001; }],
  ['invalid current camera', s => { s.controls.camera = 'balcony'; }],
  ['invalid fixture patch', s => { s.rig.trussPods[0].fixtures[0].dmxStartChannel = 513; }],
  ['reversed motor limits', s => { s.rig.trussPods[0].motorMinY = 200; }],
  ['duplicate rig pod', s => { s.rig.trussPods.push(s.rig.trussPods[0]); }],
  ['missing truss path', s => { s.rig.trussPods[0].shape = 'path'; }],
  ['short truss path', s => { Object.assign(s.rig.trussPods[0], {shape:'path', path:[{x:0,z:0},{x:0,z:0.1}]}); }],
  ['missing initial timeline field', s => { delete s.timeline.events[0].screen; }],
  ['initial look is partial', s => { delete s.timeline.events[0].look.motors; }],
  ['empty later event', s => { s.timeline.events[1] = {atMs: 2500}; }],
  ['nonzero initial event', s => { s.timeline.events[0].atMs = 1; }],
  ['fractional time', s => { s.timeline.events[1].atMs = 1.1; }],
  ['event out of order', s => { s.timeline.events[2].atMs = 2499; }],
  ['event outside duration', s => { s.timeline.durationMs = 5999; }],
  ['invalid bump mask', s => { delete s.timeline.events[0].bump.strobe; }],
  ['negative video time', s => { s.timeline.events[2].screen.offsetSeconds = -1; }],
  ['wrong screen target', s => { s.timeline.events[2].screen.target = 'unknown'; }],
  ['invalid demo step', s => { s.timeline.events[3].music.demoStep = 1025; }],
];

test('malformed nested rig, cue, media and timeline data produce a readable Error (never TypeError/RangeError)', () => {
  for (const [name, edit] of badEdits) {
    const draft = structuredClone(example);
    edit(draft);
    assert.throws(() => parse(draft), isReadableError, name);
  }
  for (const raw of ['not JSON', 'null', '[]', '"x"', '{}', '{"version":"3"}', JSON.stringify(example).replace('"bpm":128', '"bpm":1e400')]) {
    assert.throws(() => parseShowFile(raw), isReadableError, `reject ${raw.slice(0, 24)}`);
  }
  assert.throws(() => parseShowFile(' '.repeat(32 * 1024 * 1024 + 2) + '{}'), (e) => isReadableError(e) && /32 MiB/.test(e.message));
  // UTF-8 BOM is accepted cleanly.
  assert.equal(parseShowFile('\uFEFF' + JSON.stringify(example)).version, 1);
});

test('legacy fixtures load cleanly and published v1-v12 schema hashes stay pinned', async () => {
  const v1 = parseShowFile(await readFile(new URL('./fixtures/legacy-v1.stageforge.show.json', import.meta.url), 'utf8'));
  const v2 = parseShowFile(await readFile(new URL('./fixtures/legacy-v2.stageforge.show.json', import.meta.url), 'utf8'));
  const v3 = parseShowFile(await readFile(new URL('./fixtures/native-authoring-v3.stageforge.show.json', import.meta.url), 'utf8'));
  const splitRig = parseShowFile(await readFile(new URL('../public/examples/split-rig.stageforge.show.json', import.meta.url), 'utf8'));
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v3.version, 3);
  assert.equal(splitRig.version, 2);

  // Pins are over LF text (the committed form), so a Windows CRLF checkout and GitHub's Linux
  // runner, which tests before every Pages deploy, compute the same digest.
  const schemaDigest = (raw) => createHash('sha256').update(raw.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
  const expectedHashes = {
    1: '7baa3f2dd7c75e2d6207fab317219528b91b19d9ae275a005650633f6d0d129a',
    2: 'ddec7de0eac8e9df9620a5b93d6185f0779432f45b37c7c3d945987435ba9437',
    3: 'b0efe812338e41838923e332c700ef4a077e8a8609990e8ee1ed12c752236881',
    4: 'd114ce279e9de66b26fc9010c9e8ca8b7c260956c03a73a3813b8171b8996d49',
    5: '9cbf644005c09bd1ec92be20aad348fe0f8a7377134ae05c9e5826bdf5b0350f',
    6: '6db46f168be983490fb5f226ad375df55881800304a872471583c3719e9ba2e2',
    7: '3477be940a11c56d4a7c121903cd63e966be2110f2db0d3b120693e24fe9d98e',
    8: 'c6181276d26ff987127873e86c5f1d800b855ede1ab9770ebaa9ddaf351fe59e',
    9: 'be22bb11ec9bc656b5235b0fa0a0241126a7830e45ae41ffcff9c1f4f3a7e3a5',
    10: 'a1e8ba9cbf05ceeca2f1f2467240bfff1c736c301ea45f6957b1d3faf5a8cf07',
    11: '3a628624280cbebd5c6e003d6b05558e3a8261545ea4b692223a13657f5d920d',
    12: '1b590eed165d55ba87193cb053b04d62db64694ea85278857332d10ed008160d',
  };
  for (const [ver, hash] of Object.entries(expectedHashes)) {
    const raw = await readFile(new URL(`../src/schemas/show-v${ver}.schema.json`, import.meta.url));
    assert.equal(schemaDigest(raw), hash, `show-v${ver}.schema.json hash pin`);
    const lf = raw.toString('utf8').replace(/\r\n/g, '\n');
    assert.equal(schemaDigest(Buffer.from(lf.replace(/\n/g, '\r\n'))), hash, `show-v${ver}.schema.json pin ignores CRLF`);
    const parsed = JSON.parse(raw.toString('utf8'));
    assert.equal(parsed.$id, `https://jbrick2070.github.io/stageforge/schemas/show-v${ver}.schema.json`);
  }
});

test('show v4 interchange block is additive, round-trips with or without stage, and stays v1–v3 when empty', () => {
  const interchange = {
    mvr: {
      uuids: {
        'layer:stageforge': '11111111-2222-4333-8444-555555555555',
        'truss:pod-front': 'AAAAAAAA-0000-4000-8000-000000000001',
      },
      synthetic: ['mvr-position-1'],
      fixtureSpecs: {
        'fixture:["pod","pod-front","g1",0]': { spec: 'Vendor@Spot.gdtf', mode: 'Extended' },
      },
      passthrough: {
        userData: ['<Data provider="Vectorworks" ver="2025"/>'],
        auxData: ['<Position uuid="CCCCCCCC-0000-4000-8000-000000000001" name="FOH"/>'],
        sceneNodes: ['<Support uuid="DDDDDDDD-0000-4000-8000-000000000001" name="Hoist 1"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,8000}</Matrix></Support>'],
        objectExtras: {
          'fixture:["pod","pod-front","g1",0]': ['<Color>0.3127,0.329,100</Color>'],
        },
      },
    },
  };

  // Without stage: writes v4 with interchange and no stage.
  const v4NoStage = write({ ...example, interchange });
  assert.equal(v4NoStage.version, 4);
  assert.equal(v4NoStage.$schema, V4_SCHEMA_URL);
  assert.equal(v4NoStage.stage, undefined);
  assert.deepEqual(parse(v4NoStage), v4NoStage);

  // With stage: writes v4 carrying both stage and interchange.
  const stage = { format: 'stageforge-native-stage', version: 1, walls: [{ id: 'main-led' }], screenEvents: [] };
  const v4WithStage = write({ ...example, stage, interchange });
  assert.equal(v4WithStage.version, 4);
  assert.deepEqual(parse(v4WithStage).stage, stage);
  assert.deepEqual(parse(v4WithStage).interchange, interchange);

  // Empty interchange containers collapse so v1–v3 remain selected.
  for (const empty of [undefined, {}, { mvr: {} }, { mvr: { uuids: {}, synthetic: [], passthrough: { sceneNodes: [] } } }]) {
    const savedV1 = write({ ...example, interchange: empty });
    assert.equal(savedV1.version, 1);
    assert.equal(savedV1.interchange, undefined);
    const savedV3 = write({ ...example, stage, interchange: empty });
    assert.equal(savedV3.version, 3);
    assert.equal(savedV3.interchange, undefined);
  }

  // v4 supports up to 256 truss pods (matching MVR import capacity).
  const manyPods = structuredClone(example);
  manyPods.rig.trussPods = Array.from({ length: 100 }, (_, i) => ({
    id: `pod-${i}`, name: `Truss ${i}`, shape: 'box', width: 2, x: i, baseY: 6, z: 0, rotationY: 0,
    motorized: false, motorMinY: 6, motorMaxY: 6, fixtures: [],
  }));
  manyPods.cues = [];
  manyPods.activeCueId = null;
  manyPods.look.motors.podTargets = {};
  delete manyPods.timeline;
  const savedMany = write({ ...manyPods, interchange: { mvr: { uuids: { 'layer:stageforge': '11111111-2222-4333-8444-555555555555' } } } });
  assert.equal(savedMany.version, 4);
  assert.equal(parse(savedMany).rig.trussPods.length, 100);

  // Hostile / invalid v4 interchange payloads fail with readable Error.
  const badV4Edits = [
    ['v4 missing interchange', s => { delete s.interchange; }],
    ['lowercase uuid', s => { s.interchange.mvr.uuids['truss:pod-front'] = 'aaaaaaaa-0000-4000-8000-000000000001'; }],
    ['bad key prefix', s => { s.interchange.mvr.uuids['unknown:x'] = 'AAAAAAAA-0000-4000-8000-000000000001'; }],
    ['DTD in passthrough', s => { s.interchange.mvr.passthrough.sceneNodes = ['<!DOCTYPE x><Support/>']; }],
    ['PI in passthrough', s => { s.interchange.mvr.passthrough.sceneNodes = ['<?xml version="1.0"?><Support/>']; }],
    ['control char in passthrough', s => { s.interchange.mvr.passthrough.sceneNodes = ['<Support name="\u0007"/>']; }],
    ['wrong root in auxData', s => { s.interchange.mvr.passthrough.auxData = ['<Script/>']; }],
    ['ChildList in objectExtras', s => { s.interchange.mvr.passthrough.objectExtras['fixture:["pod","pod-front","g1",0]'] = ['<ChildList/>']; }],
    ['spoofed StageForge UserData', s => { s.interchange.mvr.passthrough.userData = ['<Data provider="StageForge" ver="1"/>']; }],
    ['quoted > before spoofed StageForge UserData (L3)', s => { s.interchange.mvr.passthrough.userData = ['<Data x=">" provider="StageForge" ver="1"/>']; }],
    ['unbalanced passthrough fragment (L3)', s => { s.interchange.mvr.passthrough.sceneNodes = ['<Support name="open"']; }],
    ['duplicate synthetic pod', s => { s.interchange.mvr.synthetic = ['mvr-position-1', 'mvr-position-1']; }],
    ['over 8 MiB passthrough total', s => {
      const chunk = '<Support name="' + 'A'.repeat(200_000) + '"/>';
      s.interchange.mvr.passthrough.sceneNodes = Array.from({ length: 45 }, () => chunk);
    }],
  ];
  for (const [label, edit] of badV4Edits) {
    const draft = structuredClone(v4NoStage);
    edit(draft);
    assert.throws(() => parse(draft), isReadableError, label);
  }
  for (const version of [1, 2, 3]) {
    assert.throws(() => parse({ ...v4NoStage, version, $schema: v4NoStage.$schema.replace('v4', 'v' + version) }), isReadableError, `v${version} rejects interchange`);
  }
});

test('show v5 timeline frame-rate and timecodeOffsetMs are additive, work with/without interchange, and fall back to v1-v4 when omitted', () => {
  const withTc = structuredClone(example);
  withTc.timeline.frameRate = 29.97;
  withTc.timeline.timecodeOffsetMs = 3_600_000;
  const savedV5 = write(withTc);
  assert.equal(savedV5.version, 5);
  assert.equal(savedV5.$schema, V5_SCHEMA_URL);
  assert.equal(savedV5.interchange, undefined);
  assert.equal(savedV5.timeline.frameRate, 29.97);
  assert.equal(savedV5.timeline.timecodeOffsetMs, 3_600_000);
  assert.deepEqual(parse(savedV5), savedV5);

  // Removing frameRate and timecodeOffsetMs returns cleanly to v1.
  const stripped = structuredClone(savedV5);
  delete stripped.timeline.frameRate;
  delete stripped.timeline.timecodeOffsetMs;
  assert.equal(write(stripped).version, 1);

  // v5 + interchange round-trips together.
  const interchange = { mvr: { uuids: { 'layer:stageforge': '11111111-2222-4333-8444-555555555555' } } };
  const v5Interchange = write({ ...withTc, interchange });
  assert.equal(v5Interchange.version, 5);
  assert.deepEqual(parse(v5Interchange).interchange, interchange);
  assert.equal(parse(v5Interchange).timeline.frameRate, 29.97);

  // Out-of-enum frameRate or out-of-range offset rejected with readable Error.
  const badRate = structuredClone(savedV5);
  badRate.timeline.frameRate = 60;
  assert.throws(() => parse(badRate), isReadableError);
  const badOffset = structuredClone(savedV5);
  badOffset.timeline.timecodeOffsetMs = 86_400_000;
  assert.throws(() => parse(badOffset), isReadableError);
  // v1-v4 reject frameRate on timeline.
  assert.throws(() => parse({ ...savedV5, version: 4, $schema: V4_SCHEMA_URL, interchange }), isReadableError);
});

test('show v6 catalogue fields are additive, round-trip each field independently, and keep stock templates at v1/v2', () => {
  // Stock templates without catalogue fields never drift to v6.
  for (const [key, rig] of Object.entries(RIG_TEMPLATES)) {
    const saved = makeShowFile(rig, SHOW_CUES, INITIAL_SHOW_STATE, SHOW_CUES[0].id);
    assert.ok(saved.version <= 2, `${key} stays at version <= 2 (got ${saved.version})`);
  }

  // 1. Overhead fixture with catalogId + dmxMode + dmxChannels.
  const withFixtureCat = structuredClone(example);
  Object.assign(withFixtureCat.rig.trussPods[0].fixtures[0], {
    modelName: 'Claypaky Sharpy',
    catalogId: 'claypaky-sharpy',
    dmxMode: 'Standard',
    dmxChannels: 16,
  });
  const savedOverhead = write(withFixtureCat);
  assert.equal(savedOverhead.version, 6);
  assert.equal(savedOverhead.$schema, V6_SCHEMA_URL);
  assert.deepEqual(parse(savedOverhead), savedOverhead);
  assert.equal(parse(savedOverhead).rig.trussPods[0].fixtures[0].catalogId, 'claypaky-sharpy');

  // 2. Floor FX with catalogId + dmxMode + dmxChannels only.
  const withFloorCat = structuredClone(example);
  withFloorCat.rig.floorFx = [
    {
      id: 'fx-hazer-cat',
      type: 'hazer',
      modelName: 'MDG ATMe',
      catalogId: 'mdg-atme',
      dmxMode: '3-Ch DMX/RDM',
      dmxChannels: 3,
      count: 1,
      x: 0,
      z: -2,
      spread: 0,
      dmxUniverse: 2,
      dmxStartChannel: 1,
    },
  ];
  const savedFloor = write(withFloorCat);
  assert.equal(savedFloor.version, 6);
  assert.equal(parse(savedFloor).rig.floorFx[0].catalogId, 'mdg-atme');

  // 3. Standalone dmxChannels (without catalogId) also upgrades cleanly to v6 and round-trips.
  const withChannelsOnly = structuredClone(example);
  withChannelsOnly.rig.trussPods[0].fixtures[0].dmxChannels = 20;
  const savedChOnly = write(withChannelsOnly);
  assert.equal(savedChOnly.version, 6);
  assert.equal(parse(savedChOnly).rig.trussPods[0].fixtures[0].dmxChannels, 20);

  // 4. LED cabinetId alone upgrades cleanly to v6 and round-trips (no silent field drop!).
  const withCabId = structuredClone(example);
  withCabId.rig.ledWall.cabinets = {
    cabinetId: 'roe-bp2-v2',
    columns: 6,
    rows: 4,
    widthMm: 500,
    heightMm: 500,
    pixelsWide: 176,
    pixelsHigh: 176,
  };
  const savedCab = write(withCabId);
  assert.equal(savedCab.version, 6);
  assert.equal(parse(savedCab).rig.ledWall.cabinets.cabinetId, 'roe-bp2-v2');

  // 5. Removing v6 fields drops cleanly back to v1/v2.
  const stripped = structuredClone(savedOverhead);
  delete stripped.rig.trussPods[0].fixtures[0].catalogId;
  delete stripped.rig.trussPods[0].fixtures[0].dmxMode;
  delete stripped.rig.trussPods[0].fixtures[0].dmxChannels;
  assert.equal(write(stripped).version, 1);

  // 6. v5 rejects v6 fields with a readable Error.
  assert.throws(
    () => parse({ ...savedOverhead, version: 5, $schema: V5_SCHEMA_URL }),
    isReadableError,
    'v5 rejects catalogId on fixture',
  );
  assert.throws(
    () => parse({ ...savedCab, version: 5, $schema: V5_SCHEMA_URL }),
    isReadableError,
    'v5 rejects cabinetId on ledWall.cabinets',
  );
  // 7. Unknown future version fails with a readable Error.
  assert.throws(
    () => parse({ ...savedOverhead, version: 9 }),
    isReadableError,
    'unsupported version 9 fails cleanly',
  );
});

test('show v7 rigging and power fields are additive, round-trip each field independently, and reject hostile inputs', () => {
  // 1. Any single v7 field upgrades to v7 and round-trips cleanly.
  const fieldCases = [
    ['trussProfileId', (s) => { s.rig.trussPods[0].trussProfileId = 'prolyte-h30v'; }],
    ['hoistId', (s) => { s.rig.trussPods[0].hoistId = 'chainmaster-d8plus-500'; }],
    ['hoistCount', (s) => { s.rig.trussPods[0].shape = 'box'; s.rig.trussPods[0].hoistCount = 3; }],
    ['fixture.circuitGroup', (s) => { s.rig.trussPods[0].fixtures[0].circuitGroup = 'LX-01'; }],
    ['fixture.phase', (s) => { s.rig.trussPods[0].fixtures[0].phase = 'L2'; }],
    ['floorFx.circuitGroup', (s) => {
      s.rig.floorFx = [{
        id: 'fx-c1', type: 'hazer', modelName: 'MDG ATMe', count: 1, x: 0, z: 0, spread: 0,
        dmxUniverse: 2, dmxStartChannel: 1, circuitGroup: 'FX-A',
      }];
    }],
    ['floorFx.phase', (s) => {
      s.rig.floorFx = [{
        id: 'fx-p1', type: 'hazer', modelName: 'MDG ATMe', count: 1, x: 0, z: 0, spread: 0,
        dmxUniverse: 2, dmxStartChannel: 1, phase: 'L3',
      }];
    }],
    ['rig.power', (s) => {
      s.rig.power = { system: 'eu_400_3p', feederA: 63, pins: [{ target: 'ledWall', phase: 'L1' }] };
    }],
  ];

  for (const [label, mutate] of fieldCases) {
    const draft = structuredClone(example);
    mutate(draft);
    const saved = write(draft);
    assert.equal(saved.version, 7, `${label} writes v7`);
    assert.equal(saved.$schema, V7_SCHEMA_URL, `${label} $schema`);
    assert.deepEqual(parse(saved), saved, `${label} round-trips`);
  }

  // 2. Unknown future trussProfileId / hoistId are preserved for forward compatibility.
  const futureIds = structuredClone(example);
  futureIds.rig.trussPods[0].trussProfileId = 'future-truss-99';
  futureIds.rig.trussPods[0].hoistId = 'future-hoist-5t';
  const savedFuture = write(futureIds);
  assert.equal(savedFuture.version, 7);
  assert.equal(parse(savedFuture).rig.trussPods[0].trussProfileId, 'future-truss-99');
  assert.equal(parse(savedFuture).rig.trussPods[0].hoistId, 'future-hoist-5t');

  // 3. Removing v7 fields drops cleanly back to v1.
  const stripped = structuredClone(savedFuture);
  delete stripped.rig.trussPods[0].trussProfileId;
  delete stripped.rig.trussPods[0].hoistId;
  assert.equal(write(stripped).version, 1);

  // 4. v6 rejects v7 fields with a readable Error.
  assert.throws(
    () => parse({ ...savedFuture, version: 6, $schema: V6_SCHEMA_URL }),
    isReadableError,
    'v6 rejects trussProfileId',
  );

  // 5. Hostile v7 payloads fail with readable Errors (never TypeError).
  const baseV7 = write(futureIds);
  const badV7 = [
    ['hoistCount on circle truss', (s) => { s.rig.trussPods[0].shape = 'circle'; s.rig.trussPods[0].hoistCount = 3; }],
    ['hoistCount on chevron truss', (s) => { s.rig.trussPods[0].shape = 'chevron'; s.rig.trussPods[0].hoistCount = 2; }],
    ['hoistCount out of range (5)', (s) => { s.rig.trussPods[0].shape = 'box'; s.rig.trussPods[0].hoistCount = 5; }],
    ['circuitGroup > 32 chars', (s) => { s.rig.trussPods[0].fixtures[0].circuitGroup = 'A'.repeat(33); }],
    ['circuitGroup control char', (s) => { s.rig.trussPods[0].fixtures[0].circuitGroup = 'LX\n1'; }],
    ['invalid phase L4', (s) => { s.rig.trussPods[0].fixtures[0].phase = 'L4'; }],
    ['more than 8 power pins', (s) => {
      s.rig.power = { system: 'us_208_3p', pins: Array.from({ length: 9 }, () => ({ target: 'foh', phase: 'L1' })) };
    }],
    ['duplicate power pin target', (s) => {
      s.rig.power = { system: 'us_208_3p', pins: [{ target: 'ledWall', phase: 'L1' }, { target: 'ledWall', phase: 'L2' }] };
    }],
    ['non-finite feederA', (s) => { s.rig.power = { system: 'us_208_3p', feederA: Number.NaN }; }],
    ['unknown property on rig.power', (s) => { s.rig.power = { system: 'us_208_3p', extra: 1 }; }],
  ];
  for (const [label, mutate] of badV7) {
    const draft = structuredClone(baseV7);
    mutate(draft);
    assert.throws(() => parse(draft), isReadableError, label);
  }
  // Raw JSON with __proto__ inside rig.power is rejected cleanly.
  const protoJson = JSON.stringify({ ...baseV7, rig: { ...baseV7.rig, power: { system: 'us_208_3p' } } })
    .replace('"system":"us_208_3p"', '"system":"us_208_3p","__proto__":{"polluted":true}');
  assert.throws(() => parseShowFile(protoJson), isReadableError, '__proto__ in rig.power');
});

test('show v8 audioMap is additive, round-trips in look/cues/timeline, clears cleanly in cues, and rejects hostile inputs', () => {
  const kickMapping = {
    id: 'kick-wash',
    name: 'Kick → wash dimmer',
    enabled: true,
    source: 'band',
    bands: [0, 1],
    target: { group: 'wash', param: 'dimmer' },
    amount: 0.75,
    attackMs: 12,
    releaseMs: 140,
    threshold: 0.12,
    curve: 'linear',
  };
  const laserMapping = {
    id: 'band-laser-rot',
    name: 'Band 8–14 → laser rotation',
    enabled: true,
    source: 'band',
    bands: [8, 14],
    target: { group: 'laser', param: 'rotation' },
    amount: 0.85,
    attackMs: 25,
    releaseMs: 180,
    threshold: 0.1,
    curve: 'sqrt',
  };

  // 1. Empty audioMap collapses cleanly and does NOT bump to v8.
  const emptyAudio = structuredClone(example);
  emptyAudio.look.audioMap = { mappings: [] };
  const savedEmpty = write(emptyAudio);
  assert.equal(savedEmpty.version, 1);
  assert.equal(savedEmpty.look.audioMap, undefined);

  // 2. Look, cue, and timeline audioMap round-trip as v8.
  const withAudio = structuredClone(example);
  withAudio.look.audioMap = { mappings: [kickMapping, laserMapping] };
  withAudio.cues[0].state.audioMap = { mappings: [kickMapping] };
  withAudio.timeline.events[1].look = { audioMap: { mappings: [laserMapping] } };
  const savedV8 = write(withAudio);
  assert.equal(savedV8.version, 8);
  assert.equal(savedV8.$schema, V8_SCHEMA_URL);
  assert.deepEqual(parse(savedV8), savedV8);

  // 3. Removing mappings drops cleanly back to v1.
  const stripped = structuredClone(savedV8);
  delete stripped.look.audioMap;
  delete stripped.cues[0].state.audioMap;
  delete stripped.timeline.events[1].look;
  stripped.timeline.events[1].cueId = stripped.cues[0].id;
  assert.equal(write(stripped).version, 1);

  // 4. Per-projector laser mapping is preserved when projector exists, and pruned (dropping the mapping) when removed.
  const arenaShow = makeShowFile(RIG_TEMPLATES.arena_mainstage, SHOW_CUES, INITIAL_SHOW_STATE, SHOW_CUES[0].id);
  const validProjKey = laserProjectors(RIG_TEMPLATES.arena_mainstage)[0].key;
  arenaShow.look.audioMap = {
    mappings: [{
      ...laserMapping,
      id: 'proj-1',
      target: { group: 'laser', param: 'intensity', projectorKey: validProjKey },
    }],
  };
  const savedProj = write(arenaShow);
  assert.equal(savedProj.version, 8);
  assert.equal(parse(savedProj).look.audioMap.mappings[0].target.projectorKey, validProjKey);

  const missingProj = structuredClone(savedProj);
  missingProj.look.audioMap.mappings[0].target.projectorKey = '["pod-missing","f-lasers",9]';
  assert.throws(() => parse(missingProj), isReadableError, 'unknown laser projectorKey rejected on parse');
  const prunedProj = write(missingProj);
  assert.ok(prunedProj.version <= 2, 'pruning last mapping drops back below v8');
  assert.equal(prunedProj.look.audioMap, undefined);

  // 5. cueLook recalls mappings and clears them cleanly on full cue capture without audioMap (no undefined key).
  const screen = { kind: 'none', target: 'main-led', playing: false, name: '' };
  const liveWithMap = { ...structuredClone(INITIAL_SHOW_STATE), audioMap: { mappings: [kickMapping] } };
  const fullCueNoMap = { id: 'c-clean', name: 'Clean', tag: 'USER', accent: '#ffffff', state: structuredClone(INITIAL_SHOW_STATE) };
  const recalledClean = cueLook(liveWithMap, fullCueNoMap);
  assert.equal(Object.hasOwn(recalledClean, 'audioMap'), false, 'audioMap key deleted on full cue without mappings');
  assert.equal(differsFromCue(recalledClean, fullCueNoMap, screen), false);
  const fullCueWithMap = { id: 'c-map', name: 'Mapped', tag: 'USER', accent: '#ffffff', state: structuredClone(liveWithMap) };
  const recalledMap = cueLook(structuredClone(INITIAL_SHOW_STATE), fullCueWithMap);
  assert.deepEqual(recalledMap.audioMap, { mappings: [kickMapping] });
  assert.equal(differsFromCue(recalledMap, fullCueWithMap, screen), false);
  // Built-in full scene cue (no masterDimmer, no audioMap) clears live audioMap and flags differsFromCue when live has mappings.
  const builtInArena = SHOW_CUES[3];
  const recalledBuiltIn = cueLook(liveWithMap, builtInArena);
  assert.equal(Object.hasOwn(recalledBuiltIn, 'audioMap'), false, 'built-in full scene cue clears live audioMap');
  assert.equal(differsFromCue({ ...recalledBuiltIn, audioMap: { mappings: [kickMapping] } }, builtInArena, screen), true);
  // True partial cue (lighting-only delta) preserves live audioMap and reports no spurious diff.
  const partialCue = { id: 'c-part', name: 'Dimmer Bump', tag: 'PART', accent: '#ffffff', state: { beamIntensity: 0.9 } };
  const recalledPartial = cueLook(liveWithMap, partialCue);
  assert.deepEqual(recalledPartial.audioMap, { mappings: [kickMapping] });
  assert.equal(differsFromCue(recalledPartial, partialCue, screen), false);

  // 6. v7 rejects audioMap; hostile v8 inputs fail with readable Errors.
  assert.throws(
    () => parse({ ...savedV8, version: 7, $schema: V7_SCHEMA_URL }),
    isReadableError,
    'v7 rejects audioMap',
  );
  const badV8 = [
    ['> 16 mappings', (s) => {
      s.look.audioMap.mappings = Array.from({ length: 17 }, (_, i) => ({ ...kickMapping, id: `m-${i}` }));
    }],
    ['duplicate mapping id', (s) => {
      s.look.audioMap.mappings = [kickMapping, { ...laserMapping, id: kickMapping.id }];
    }],
    ['__proto__ mapping id', (s) => {
      s.look.audioMap.mappings[0].id = '__proto__';
    }],
    ['band source missing bands', (s) => {
      delete s.look.audioMap.mappings[0].bands;
    }],
    ['reversed bands [14, 8]', (s) => {
      s.look.audioMap.mappings[0].bands = [14, 8];
    }],
    ['out-of-range band 32', (s) => {
      s.look.audioMap.mappings[0].bands = [0, 32];
    }],
    ['invalid group/param pair haze.rotation', (s) => {
      s.look.audioMap.mappings[0].target = { group: 'haze', param: 'rotation' };
    }],
    ['projectorKey on non-laser group', (s) => {
      s.look.audioMap.mappings[0].target = { group: 'wash', param: 'dimmer', projectorKey: validProjKey };
    }],
    ['negative amount on strobe', (s) => {
      s.look.audioMap.mappings[0].target = { group: 'beam', param: 'strobe' };
      s.look.audioMap.mappings[0].amount = -0.5;
    }],
    ['negative amount on laser speed', (s) => {
      s.look.audioMap.mappings[0].target = { group: 'laser', param: 'speed' };
      s.look.audioMap.mappings[0].amount = -0.2;
    }],
    ['haze attackMs < 1000', (s) => {
      s.look.audioMap.mappings[0].target = { group: 'haze', param: 'dimmer' };
      s.look.audioMap.mappings[0].attackMs = 200;
      s.look.audioMap.mappings[0].releaseMs = 2500;
    }],
    ['haze releaseMs < 2000', (s) => {
      s.look.audioMap.mappings[0].target = { group: 'haze', param: 'dimmer' };
      s.look.audioMap.mappings[0].attackMs = 1500;
      s.look.audioMap.mappings[0].releaseMs = 500;
    }],
    ['extra unknown property on mapping', (s) => {
      s.look.audioMap.mappings[0].extra = true;
    }],
  ];
  for (const [label, mutate] of badV8) {
    const draft = structuredClone(savedV8);
    mutate(draft);
    assert.throws(() => parse(draft), isReadableError, label);
  }
});

test('show v9 cue fades are additive, bounded, lossless, and leave prior writer selection unchanged when unused', () => {
  const legacy = structuredClone(example);
  assert.equal(write(legacy).version, 1, 'omitted fade retains the legacy writer');
  legacy.cues[0].fadeSeconds = undefined;
  assert.equal(write(legacy).version, 1, 'a cleared editor field retains the legacy writer');

  legacy.cues[0].fadeSeconds = 0;
  const explicitCut = write(legacy);
  assert.equal(explicitCut.version, 9, 'an authored zero remains distinguishable from omission');
  assert.equal(explicitCut.$schema, V9_SCHEMA_URL);
  assert.equal(parse(explicitCut).cues[0].fadeSeconds, 0);

  const timed = structuredClone(example);
  timed.cues[1].fadeSeconds = 2.5;
  timed.timeline.events[1].cueFade = {
    durationMs: 2500,
    from: { beamIntensity: 0.2, washIntensity: 0.4 },
    to: { beamIntensity: 0.8, washIntensity: 1 },
  };
  const saved = write(timed);
  assert.equal(saved.version, 9);
  assert.deepEqual(parse(saved), saved, 'cue duration and recorded transition survive save/reopen');

  const priorV8 = structuredClone(timed);
  delete priorV8.cues[1].fadeSeconds;
  delete priorV8.timeline.events[1].cueFade;
  priorV8.look.audioMap = { mappings: [{
    id: 'level', name: 'Level', enabled: true, source: 'energy',
    target: { group: 'beam', param: 'dimmer' }, amount: 0.5,
    attackMs: 10, releaseMs: 100, threshold: 0, curve: 'linear',
  }] };
  assert.equal(write(priorV8).version, 8, 'v8 remains the default when no v9 field is used');

  for (const [label, mutate] of [
    ['negative cue duration', s => { s.cues[1].fadeSeconds = -0.01; }],
    ['long cue duration', s => { s.cues[1].fadeSeconds = 3600.01; }],
    ['long recorded duration', s => { s.timeline.events[1].cueFade.durationMs = 3600001; }],
    ['fractional recorded duration', s => { s.timeline.events[1].cueFade.durationMs = 12.5; }],
    ['invalid recorded origin', s => { s.timeline.events[1].cueFade.from.beamIntensity = -0.01; }],
    ['unknown recorded fade key', s => { s.timeline.events[1].cueFade.private = true; }],
  ]) {
    const invalid = structuredClone(saved);
    mutate(invalid);
    assert.throws(() => parse(invalid), isReadableError, label);
  }
  assert.throws(
    () => parse({ ...saved, version: 8, $schema: V8_SCHEMA_URL }),
    isReadableError,
    'frozen v8 rejects v9 fields',
  );
});
