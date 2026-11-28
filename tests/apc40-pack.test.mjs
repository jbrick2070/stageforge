import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());
const { parseShowFile, makeShowFile } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const {
  APC_CUE_IDS, APC_FADERS, APC_LIFT_ID, APC_PADS, APC_ROWS, APC_SCENES,
  apcActionAvailable, apcFaderValue, apcPadSelected, applyApcLook, resolveApcRig,
} = await compiler.ssrLoadModule('/src/input/apc40Pack.ts');
const {
  APC_INQUIRY, APC_MODE, ApcMidiSession, advanceApcPickup, apcLedMessage,
  decodeApcMidi, isApcIdentity, isApcIntroduction, selectApcPair,
} = await compiler.ssrLoadModule('/src/input/apc40Midi.ts');
const bundled = await readFile(new URL('../public/examples/deep-house.stageforge.show.json', import.meta.url), 'utf8');
const identity = [0xf0, 0x7e, 0, 6, 2, 0x47, 0x29, 0, 0x19, ...Array(25).fill(0), 0xf7];
const introduced = [0xf0, 0x47, 0x7f, 0x29, 0x61, 0, 4, ...Array(9).fill(0), 0xf7];
const active = { suspended: false, motorDrop: false, laserClip: false };

test('APC40 authoring round trips the complete U3 rehearsal and rejects a mixed, conflicting or arbitrary rig', () => {
  const show = parseShowFile(bundled);
  assert.deepEqual(APC_ROWS.map(row => row.pads.length), [8, 8, 8, 8, 8]);
  assert.equal(APC_FADERS.length, 9);
  assert.deepEqual(show.cues.map(cue => cue.id), APC_CUE_IDS);
  assert.deepEqual(APC_SCENES.map(scene => scene.name), ['Intro', 'Groove', 'Build', 'Peak', 'Close']);
  const rig = resolveApcRig(show.rig);
  assert.equal(rig.eligible, true);
  assert.equal(rig.rgb, true);
  assert.equal(rig.lift.id, APC_LIFT_ID);
  assert.equal(show.media, undefined);
  assert.equal(show.cues.every(cue => cue.state.motors.mode === 'manual' && cue.state.laser.colorMode === 'custom' &&
    !cue.state.laser.projectors && !cue.state.laser.audienceScan && cue.state.laser.strobe === 0), true);
  const save = makeShowFile(show.rig, show.cues, show.look, show.activeCueId, show.controls);
  assert.equal(resolveApcRig(parseShowFile(JSON.stringify(save)).rig).eligible, true);
  for (const edit of [
    rig => { rig.floorFx[0].dmxUniverse = 1; }, rig => { rig.floorFx[0].dmxUniverse = 4; },
    rig => { rig.floorFx[0].dmxStartChannel = 1; },
    rig => { rig.trussPods.forEach(pod => pod.fixtures.forEach(group => { group.id += '-other'; })); },
  ]) {
    const renamed = structuredClone(show.rig);
    edit(renamed);
    assert.equal(resolveApcRig(renamed).eligible, false);
  }
  const noLift = structuredClone(show.rig);
  noLift.trussPods = noLift.trussPods.filter(pod => pod.id !== APC_LIFT_ID);
  assert.equal(resolveApcRig(noLift).eligible, true);
  assert.equal(resolveApcRig(noLift).lift, undefined);
});

test('APC40 shared actions isolate laser, lighting, wall, lift and neighboring state', () => {
  const show = parseShowFile(bundled);
  const rig = resolveApcRig(show.rig);
  const [lighting, laser] = [APC_ROWS[0].pads[0].action, APC_ROWS[1].pads[3].action];
  const lit = applyApcLook(show.look, lighting);
  assert.deepEqual(lit.laser, show.look.laser);
  assert.equal(lit.colorSplitMode, 'solid');
  const reLaser = applyApcLook(lit, laser);
  assert.equal(reLaser.primaryColor, lit.primaryColor);
  assert.equal(reLaser.accentColor, lit.accentColor);
  assert.deepEqual(reLaser.laser, { ...lit.laser, colorMode: 'custom', colorA: laser.primary });
  assert.equal(apcPadSelected(lighting, reLaser, null), true);
  assert.equal(apcPadSelected(laser, reLaser, null), true);
  const wall = applyApcLook(reLaser, APC_ROWS[3].pads[0].action);
  assert.deepEqual(wall.led, { ...reLaser.led, visualMode: 'tunnel' });
  const lift = { kind: 'fader', fader: 'lift', value: 0.81 };
  const lookWithNeighbor = { ...wall, motors: { ...wall.motors, podTargets: { ...wall.motors.podTargets, other: { height: 0.4, tilt: -0.3 } } } };
  const lifted = applyApcLook(lookWithNeighbor, lift);
  assert.deepEqual(lifted.motors, { ...lookWithNeighbor.motors, podTargets: { ...lookWithNeighbor.motors.podTargets,
    [APC_LIFT_ID]: { height: 0.81, tilt: wall.motors.podTargets[APC_LIFT_ID].tilt } } });
  assert.equal(apcFaderValue(lifted, 'lift', rig), 0.81);
  assert.equal(apcActionAvailable(lift, rig, wall, show.cues, { ...active, motorDrop: true }), false);
  assert.equal(apcActionAvailable(lift, rig, { ...wall, motors: { ...wall.motors, mode: 'high' } }, show.cues, active), false);
  assert.equal(apcActionAvailable(laser, rig, wall, show.cues, { ...active, laserClip: true }), false);
  assert.equal(apcActionAvailable(laser, { ...rig, rgb: false }, wall, show.cues, active), false);
  for (const action of [...APC_PADS.map(pad => pad.action), ...APC_FADERS.map(([fader]) => ({ kind: 'fader', fader, value: 1 }))]) {
    assert.equal(apcActionAvailable(action, rig, wall, show.cues, { ...active, suspended: true }), false);
  }
  assert.equal(apcActionAvailable({ kind: 'blackout' }, rig, wall, show.cues, { ...active, suspended: true }), true);
  assert.equal(apcActionAvailable({ kind: 'blackout' }, { ...rig, eligible: false }, wall, show.cues, active), false);
});

test('APC40 protocol checks exact model/format, reversed grid orientation, scene, note release and track faders', () => {
  assert.equal(isApcIdentity(identity), true);
  assert.equal(isApcIntroduction(introduced), true);
  assert.equal(isApcIdentity(identity.with(6, 0x73)), false);
  assert.equal(isApcIdentity(identity.slice(0, 34)), false);
  assert.equal(isApcIntroduction(introduced.with(4, 0x60)), false);
  assert.deepEqual(decodeApcMidi([0x90, 32, 127]).action, APC_ROWS[0].pads[0].action);
  assert.deepEqual(decodeApcMidi([0x90, 0, 127]).action, APC_ROWS[4].pads[0].action);
  assert.deepEqual(decodeApcMidi([0x90, 0x56, 127]).action, APC_SCENES[4].action);
  assert.deepEqual(decodeApcMidi([0x90, 0x51, 127]).action, { kind: 'blackout' });
  assert.equal(decodeApcMidi([0x90, 32, 0]).pressed, false);
  assert.equal(decodeApcMidi([0x80, 32, 127]).pressed, false);
  assert.deepEqual(apcLedMessage(0, 5), [0x90, 32, 5]);
  assert.deepEqual(apcLedMessage(32, 5), [0x90, 0, 5]);
  assert.deepEqual(apcLedMessage(40, 5), [0x90, 0x52, 5]);
  assert.deepEqual(decodeApcMidi([0xb5, 7, 48]), { kind: 'continuous', fader: 'lift', value: 48 / 127 });
  assert.deepEqual(decodeApcMidi([0xb0, 14, 127]), { kind: 'continuous', fader: 'masterDimmer', value: 1 });
  for (const invalid of [[0xb8, 7, 50], [0xf8], [0x90, 32, 128], [0xc0, 1, 127], [0x90, 32]]) assert.equal(decodeApcMidi(invalid), null);
});

test('APC40 pickup requires proximity or a crossing and discards old hardware position after a software edit', () => {
  let pickup = advanceApcPickup(undefined, 0.6, 0.13);
  assert.equal(pickup.latched, false);
  pickup = advanceApcPickup(pickup, 0.6, 0.72);
  assert.equal(pickup.latched, true);
  assert.equal(advanceApcPickup(pickup, 0.6, 0.2).latched, true);
  pickup = advanceApcPickup(pickup, 0.91, 0.59);
  assert.equal(pickup.latched, false);
  assert.equal(advanceApcPickup(pickup, 0.91, 0.9).latched, true);
});

function fakePort(id, calls, options = {}) {
  const port = new EventTarget();
  return Object.assign(port, {
    id, name: 'APC40 mkII', state: 'connected', connection: options.initial ?? 'closed',
    async open() { calls.push(['open', id]); await options.waitOpen?.(); this.connection = 'open'; },
    async close() { calls.push(['close', id]); this.connection = 'closed'; },
    send(bytes) { calls.push(['send', id, Array.from(bytes)]); },
    emit(bytes) {
      const event = new Event('midimessage');
      Object.defineProperty(event, 'data', { value: Uint8Array.from(bytes) });
      this.dispatchEvent(event);
    },
  });
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('APC40 selected-port handshake is ordered, scoped and deduped and sends only changed LEDs', async t => {
  const calls = [];
  const input = fakePort('A', calls);
  const output = fakePort('out-A', calls);
  const other = fakePort('B', calls);
  assert.equal(selectApcPair([input, other], [output], 'A', 'out-A'), null);
  assert.deepEqual(selectApcPair([input], [output], 'A', 'out-A'), { input, output });
  let liveEpoch = 1;
  let software = 0.5;
  let mirrorLag = false;
  const actions = [];
  const session = new ApcMidiSession({
    current: epoch => epoch === liveEpoch, read: () => software, status: () => {},
    send(action) { actions.push(action); if (action.kind === 'fader' && !mirrorLag) software = action.value; return true; },
  });
  t.after(() => session.disconnect());
  session.setFeedback(Array(45).fill(37));
  session.connect(input, output, liveEpoch);
  assert.equal(calls.length, 0);
  await turn();
  assert.deepEqual(calls, [['open', 'A'], ['open', 'out-A'], ['send', 'out-A', APC_INQUIRY]]);
  other.emit(identity);
  input.emit(identity.with(6, 0x73));
  input.emit([0x90, 32, 127]);
  assert.equal(calls.length, 3);
  assert.equal(actions.length, 0);
  input.emit(identity);
  assert.deepEqual(calls.at(-1), ['send', 'out-A', APC_MODE]);
  input.emit([0x90, 32, 127]);
  assert.equal(actions.length, 0);
  input.emit(introduced);
  await wait(45);
  assert.equal(calls.length, 49);
  const change = Array(45).fill(37).with(0, 4);
  session.setFeedback(change);
  session.setFeedback(change);
  await wait(45);
  assert.deepEqual(calls.at(-1), ['send', 'out-A', [0x90, 32, 4]]);
  assert.equal(calls.length, 50);
  input.emit([0x90, 32, 127]);
  input.emit([0x90, 32, 127]);
  input.emit([0x90, 32, 0]);
  input.emit([0x90, 32, 127]);
  assert.equal(actions.length, 2);
  input.emit([0xb0, 7, 10]);
  input.emit([0xb0, 7, 90]);
  assert.equal(actions.length, 3);
  software = 0.23;
  input.emit([0xb0, 7, 90]);
  assert.equal(actions.length, 3);
  input.emit([0xb0, 7, 27]);
  assert.equal(actions.length, 4);
  software = 64 / 127;
  mirrorLag = true;
  session.rearm();
  for (const value of [64, 70, 76]) input.emit([0xb0, 7, value]);
  assert.deepEqual(actions.slice(-3).map(action => action.value), [64 / 127, 70 / 127, 76 / 127]);
  software = 70 / 127;
  input.emit([0xb0, 7, 80]);
  assert.equal(actions.at(-1).value, 80 / 127);
  software = 0.31;
  input.emit([0xb0, 7, 90]);
  assert.equal(actions.length, 8, 'an independent software change still clears pickup');
  session.setFeedback(Array(45).fill(4));
  liveEpoch++;
  input.emit([0x90, 0x51, 127]);
  await wait(45);
  assert.equal(actions.length, 8);
  assert.equal(calls.filter(([type]) => type === 'send').length, 48);
  assert.deepEqual(calls.slice(-2), [['close', 'A'], ['close', 'out-A']]);
});

test('APC40 canceled async opens are drained before a same-port rebind while borrowed ports stay open', async t => {
  const calls = [];
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const input = fakePort('A', calls, { waitOpen: () => delayed });
  const output = fakePort('out-A', calls, { initial: 'open' });
  let epoch = 1;
  const session = new ApcMidiSession({ current: value => value === epoch, read: () => null, send: () => false, status: () => {} });
  t.after(() => { release(); session.disconnect(); });
  session.connect(input, output, epoch);
  await turn();
  assert.deepEqual(calls, [['open', 'A']]);
  session.disconnect();
  session.connect(input, output, ++epoch);
  await turn();
  assert.deepEqual(calls, [['open', 'A']]);
  release();
  await turn();
  assert.deepEqual(calls, [['open', 'A'], ['close', 'A'], ['open', 'A'], ['send', 'out-A', APC_INQUIRY]]);
  session.disconnect();
  await turn();
  assert.deepEqual(calls.at(-1), ['close', 'A']);
  assert.equal(calls.some(([type, id]) => type === 'close' && id === output.id), false);
});
