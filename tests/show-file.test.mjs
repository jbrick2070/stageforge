import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());
const { parseShowFile, makeShowFile, SHOW_SCHEMA_URL } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { RIG_TEMPLATES, INITIAL_SHOW_STATE, SHOW_CUES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { cueLook, differsFromCue } = await compiler.ssrLoadModule('/src/data/cueLook.ts');
const { frameDelta } = await compiler.ssrLoadModule('/src/input/useShowTimeline.ts');
const example = JSON.parse(await readFile(new URL('../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));
const parse = value => parseShowFile(JSON.stringify(value));
const write = show => makeShowFile(show.rig, show.cues, show.look, show.activeCueId, show.controls, show.timeline, show.media);

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

const badEdits = [
  ['unsupported file version', s => { s.version = 2; }],
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

test('malformed nested rig, cue, media and timeline data produce an error', () => {
  for (const [name, edit] of badEdits) {
    const draft = structuredClone(example);
    edit(draft);
    assert.throws(() => parse(draft), undefined, name);
  }
  assert.throws(() => parseShowFile('not JSON'));
  assert.throws(() => parseShowFile(JSON.stringify(example).replace('"bpm":128', '"bpm":1e400')));
});
