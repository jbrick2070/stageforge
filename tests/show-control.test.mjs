import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const cjsOsc = require('../desktop/osc-packets.cjs');
const { createArtNetRxMux } = require('../desktop/artnet-rx.cjs');
const { createShowControlService, validateShowControlConfig } = require('../desktop/show-control-service.cjs');
const { createShowControlIpcHandlers } = require('../desktop/show-control-ipc.cjs');
const { createDmxController } = require('../desktop/dmx-sender.cjs');
const { ARTNET_OPCODE_POLL_REPLY } = require('../desktop/dmx-packets.cjs');

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const tsOsc = await compiler.ssrLoadModule('/src/showControl/oscCodec.ts');
const tsTc = await compiler.ssrLoadModule('/src/showControl/timecode.ts');
const tsMidi = await compiler.ssrLoadModule('/src/showControl/midiShowControl.ts');
const tsClock = await compiler.ssrLoadModule('/src/showControl/clockOwner.ts');
const tsTempo = await compiler.ssrLoadModule('/src/audio/tempoEngine.ts');

const vectors = JSON.parse(await readFile(new URL('./fixtures/osc-vectors.json', import.meta.url), 'utf8'));

function hexToU8(hex) {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function u8ToHex(u8) {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('hex');
}

function normalizeDecodedForCompare(messages) {
  return messages.map((m) => ({
    address: m.address,
    args: m.args.map((a) => (a.type === 'b' ? { type: 'b', hex: u8ToHex(a.value) } : a)),
  }));
}

test('CJS and TS OSC 1.0 codecs agree byte-for-byte on all golden vectors and reject hostile packets', () => {
  for (const vec of vectors.valid) {
    const bytes = hexToU8(vec.hex);
    const cjsDecoded = cjsOsc.decodeOscPacket(bytes);
    const tsDecoded = tsOsc.decodeOscPacket(bytes);
    assert.ok(cjsDecoded, `CJS decode failed for ${vec.name}`);
    assert.ok(tsDecoded, `TS decode failed for ${vec.name}`);
    assert.deepEqual(normalizeDecodedForCompare(cjsDecoded), vec.messages, `CJS mismatch: ${vec.name}`);
    assert.deepEqual(normalizeDecodedForCompare(tsDecoded), vec.messages, `TS mismatch: ${vec.name}`);

    // Re-encode single messages & 2-element bundles and verify identical bytes.
    if (vec.messages.length === 1) {
      const m = vec.messages[0];
      const args = m.args.map((a) => (a.type === 'b' ? { type: 'b', value: hexToU8(a.hex) } : a));
      assert.equal(u8ToHex(cjsOsc.encodeOscMessage(m.address, args)), vec.hex, `CJS re-encode: ${vec.name}`);
      assert.equal(u8ToHex(tsOsc.encodeOscMessage(m.address, args)), vec.hex, `TS re-encode: ${vec.name}`);
    } else {
      const elems = vec.messages.map((m) => ({ address: m.address, args: m.args }));
      assert.equal(u8ToHex(cjsOsc.encodeOscBundle(elems, 1n)), vec.hex, `CJS bundle re-encode: ${vec.name}`);
      assert.equal(u8ToHex(tsOsc.encodeOscBundle(elems, 1n)), vec.hex, `TS bundle re-encode: ${vec.name}`);
    }
  }

  for (const bad of vectors.invalid) {
    const bytes = hexToU8(bad.hex);
    assert.equal(cjsOsc.decodeOscPacket(bytes), null, `CJS must reject ${bad.name}`);
    assert.equal(tsOsc.decodeOscPacket(bytes), null, `TS must reject ${bad.name}`);
  }

  // Deeply nested bundles (> 4 depth) and oversized (> 8192 bytes) are rejected by both codecs.
  let nested = cjsOsc.encodeOscMessage('/stageforge/go', []);
  for (let d = 0; d < 5; d++) nested = cjsOsc.encodeOscBundle([nested], 1n);
  assert.equal(cjsOsc.decodeOscPacket(nested), null);
  assert.equal(tsOsc.decodeOscPacket(nested), null);

  const huge = new Uint8Array(8196);
  assert.equal(cjsOsc.decodeOscPacket(huge), null);
  assert.equal(tsOsc.decodeOscPacket(huge), null);

  // Rising-edge vs release-edge TouchOSC handling.
  assert.ok(cjsOsc.normalizeOscMessage({ address: '/stageforge/go', args: [{ type: 'f', value: 1 }] }));
  assert.equal(cjsOsc.normalizeOscMessage({ address: '/stageforge/go', args: [{ type: 'f', value: 0 }] }), null);
  assert.deepEqual(
    tsOsc.normalizeOscMessage({ address: '/stageforge/bump/1', args: [{ type: 'f', value: 1 }] }, 100),
    { source: 'osc', kind: 'trigger', command: 'bump', bumpKey: 'blinder', value: 1, at: 100 },
  );
  assert.deepEqual(
    tsOsc.normalizeOscMessage({ address: '/stageforge/bump/1', args: [{ type: 'f', value: 0 }] }, 100),
    { source: 'osc', kind: 'trigger', command: 'bump', bumpKey: 'blinder', value: 0, at: 100 },
  );

  // Audio-reactive OSC endpoints agree across CJS and TS codecs and reject unsafe mapping IDs.
  for (const codec of [cjsOsc, tsOsc]) {
    assert.deepEqual(
      codec.normalizeOscMessage({ address: '/stageforge/audio/reactive', args: [] }, 199),
      { source: 'osc', kind: 'trigger', command: 'audio_reactive', value: 1, at: 199 },
    );
    assert.deepEqual(
      codec.normalizeOscMessage({ address: '/stageforge/audio/reactive', args: [{ type: 'T', value: true }] }, 198),
      { source: 'osc', kind: 'trigger', command: 'audio_reactive', value: 1, at: 198 },
    );
    assert.deepEqual(
      codec.normalizeOscMessage({ address: '/stageforge/audio/reactive', args: [{ type: 'F', value: false }] }, 197),
      { source: 'osc', kind: 'trigger', command: 'audio_reactive', value: 0, at: 197 },
    );
    assert.deepEqual(
      codec.normalizeOscMessage({ address: '/stageforge/audio/reactive', args: [{ type: 'i', value: 1 }] }, 200),
      { source: 'osc', kind: 'trigger', command: 'audio_reactive', value: 1, at: 200 },
    );
    assert.deepEqual(
      codec.normalizeOscMessage({ address: '/stageforge/audio/reactive', args: [{ type: 'f', value: 0 }] }, 201),
      { source: 'osc', kind: 'trigger', command: 'audio_reactive', value: 0, at: 201 },
    );
    assert.deepEqual(
      codec.normalizeOscMessage({ address: '/stageforge/audio/mapping/kick-wash/amount', args: [{ type: 'f', value: 0.75 }] }, 202),
      { source: 'osc', kind: 'trigger', command: 'audio_mapping_amount', mappingId: 'kick-wash', value: 0.75, at: 202 },
    );
    assert.deepEqual(
      codec.normalizeOscMessage({ address: '/stageforge/audio/mapping/kick-wash/amount', args: [{ type: 'f', value: -2.5 }] }, 203),
      { source: 'osc', kind: 'trigger', command: 'audio_mapping_amount', mappingId: 'kick-wash', value: -1, at: 203 },
    );
    assert.equal(codec.normalizeOscMessage({ address: '/stageforge/audio/mapping/__proto__/amount', args: [{ type: 'f', value: 0.5 }] }), null);
    assert.equal(codec.normalizeOscMessage({ address: '/stageforge/audio/mapping/bad/slash/amount', args: [{ type: 'f', value: 0.5 }] }), null);
    assert.equal(codec.normalizeOscMessage({ address: '/stageforge/audio/mapping/kick-wash/amount', args: [] }), null);
  }
  assert.equal(tsClock.allows('caller', 'osc', 'audio'), true);
  assert.equal(tsClock.allows('master', 'osc', 'audio'), false);
  assert.equal(tsClock.allows('chase', 'osc', 'audio'), false);
  assert.equal(tsClock.allows('chase', 'manual', 'audio'), true);
  assert.equal(tsClock.allows('master', 'manual', 'audio'), true);
  assert.equal(tsClock.allows('caller', 'manual', 'audio'), true);
});

test('SMPTE timecode math (24/25/29.97DF/30) and Art-Net OpTimeCode 0x9700 layout match spec', () => {
  // Non-drop-frame round-trip
  for (const fps of [24, 25, 30]) {
    const sample = { hours: 1, minutes: 23, seconds: 45, frames: fps - 1, fps };
    const msTs = tsTc.smpteToMs(sample);
    const msCjs = cjsOsc.smpteToMs(sample.hours, sample.minutes, sample.seconds, sample.frames, fps);
    assert.equal(msTs, msCjs);
    assert.deepEqual(tsTc.msToSmpte(msTs, fps), sample);
    assert.deepEqual(cjsOsc.msToSmpte(msCjs, fps), sample);
  }

  // 29.97 drop-frame rules: 00:01:00;00 and 00:01:00;01 are invalid; 00:01:00;02 follows 00:00:59;29; 00:10:00;00 is valid.
  assert.equal(tsTc.smpteToMs({ hours: 0, minutes: 1, seconds: 0, frames: 0, fps: 29.97 }), null);
  assert.equal(tsTc.smpteToMs({ hours: 0, minutes: 1, seconds: 0, frames: 1, fps: 29.97 }), null);
  assert.equal(cjsOsc.smpteToMs(0, 1, 0, 0, 29.97), null);
  const beforeDrop = tsTc.smpteToMs({ hours: 0, minutes: 0, seconds: 59, frames: 29, fps: 29.97 });
  const afterDrop = tsTc.smpteToMs({ hours: 0, minutes: 1, seconds: 0, frames: 2, fps: 29.97 });
  assert.ok(Math.abs((afterDrop - beforeDrop) - (1001 / 30)) < 1e-6, '00:01:00;02 must be 1 DF frame after 00:00:59;29');
  assert.deepEqual(tsTc.msToSmpte(afterDrop, 29.97), { hours: 0, minutes: 1, seconds: 0, frames: 2, fps: 29.97 });
  const tenthMin = tsTc.smpteToMs({ hours: 0, minutes: 10, seconds: 0, frames: 0, fps: 29.97 });
  assert.ok(tenthMin !== null);
  assert.deepEqual(tsTc.msToSmpte(tenthMin, 29.97), { hours: 0, minutes: 10, seconds: 0, frames: 0, fps: 29.97 });
  assert.equal(tsTc.formatSmpte({ hours: 1, minutes: 0, seconds: 5, frames: 12, fps: 29.97 }), '01:00:05;12');
  assert.equal(tsTc.parseSmpteString('01:00:00:00', 30), 3_600_000);
  assert.equal(tsTc.parseSmpteString('00:01:00;00', 29.97), null);

  // Art-Net OpTimeCode (0x9700) byte layout
  const pkt = cjsOsc.encodeArtNetTimecode({ hours: 1, minutes: 2, seconds: 3, frames: 4, fps: 29.97 });
  assert.equal(pkt.byteLength, 19);
  assert.equal(pkt.subarray(0, 8).toString('ascii'), 'Art-Net\0');
  assert.equal(pkt.readUInt16LE(8), 0x9700);
  assert.equal(pkt.readUInt16BE(10), 14);
  assert.equal(pkt[13], 0); // StreamId 0
  assert.deepEqual([pkt[14], pkt[15], pkt[16], pkt[17], pkt[18]], [4, 3, 2, 1, 2]);
  const decoded = cjsOsc.decodeArtNetTimecode(pkt);
  assert.equal(decoded.fps, 29.97);
  assert.equal(decoded.hours, 1);
  assert.equal(decoded.frames, 4);

  // Non-zero StreamId and invalid DF frame rejected
  const badStream = Buffer.from(pkt);
  badStream[13] = 1;
  assert.equal(cjsOsc.decodeArtNetTimecode(badStream), null);
  const badDf = Buffer.from(pkt);
  badDf[17] = 0; badDf[16] = 1; badDf[15] = 0; badDf[14] = 0; badDf[18] = 2;
  assert.equal(cjsOsc.decodeArtNetTimecode(badDf), null);
});

test('Web MIDI MTC Quarter-Frame (+2 frame offset, reverse seek-only) and Full-Frame SysEx decode accurately', () => {
  const dec = new tsMidi.MtcDecoder();
  // Encode 01:00:00:00 at 30 fps -> forward completion on piece 7 adds +2 frames -> 01:00:00:02.
  const qfs = tsMidi.encodeMtcQuarterFrames(3_600_000, 30);
  let last = null;
  for (let i = 0; i < 8; i++) {
    last = dec.feedQuarterFrame(qfs[i][1], 1000 + i * 8);
  }
  assert.ok(last);
  assert.equal(last.fps, 30);
  assert.equal(last.hours, 1);
  assert.equal(last.frames, 2, 'forward MTC completes with +2 frame display offset');
  assert.equal(last.reverse, undefined);

  // Reverse MTC (pieces 7 -> 0) marks reverse: true (seek-only, no +2 offset).
  dec.reset();
  let rev = null;
  for (let i = 7; i >= 0; i--) {
    rev = dec.feedQuarterFrame(qfs[i][1], 2000 + (7 - i) * 8);
  }
  assert.ok(rev);
  assert.equal(rev.reverse, true);
  assert.equal(rev.frames, 0);

  // Out-of-sequence piece resets assembly.
  dec.reset();
  dec.feedQuarterFrame(qfs[0][1], 3000);
  dec.feedQuarterFrame(qfs[1][1], 3008);
  assert.equal(dec.feedQuarterFrame(qfs[5][1], 3016), null);

  // Full-Frame SysEx locates immediately with no +2 offset.
  const ff = tsMidi.encodeMtcFullFrame(3_600_000, 30, 0x7f);
  const located = dec.feedFullFrame(ff, 0x7f, 4000);
  assert.ok(located);
  assert.equal(located.locate, true);
  assert.equal(located.hours, 1);
  assert.equal(located.frames, 0);
});

test('Web MIDI MSC SysEx decodes GO, TIMED_GO, SET, ALL_OFF, RESTORE, RESET and rejects invalid/oversized messages', () => {
  const go3 = tsMidi.encodeMscGo('3', 0x05, 0x01);
  assert.deepEqual(tsMidi.decodeMscSysex(go3, { deviceId: 5 }, 50), {
    source: 'msc', kind: 'trigger', command: 'go', cue: { index: 3 }, at: 50,
  });
  // Different device ID rejected
  assert.equal(tsMidi.decodeMscSysex(go3, { deviceId: 9 }, 50), null);

  // Dotted cue number resolves to exact label ref
  const goDotted = tsMidi.encodeMscGo('1.5', 0x7f, 0x01);
  assert.deepEqual(tsMidi.decodeMscSysex(goDotted, { deviceId: 5 }, 60), {
    source: 'msc', kind: 'trigger', command: 'go', cue: { ref: '1.5' }, at: 60,
  });

  // TIMED_GO (0x04): 5 time bytes + Q_number '2'
  const timedGo = new Uint8Array([0xf0, 0x7f, 0x7f, 0x02, 0x01, 0x04, 0, 0, 2, 0, 0, 0x32, 0xf7]);
  assert.equal(tsMidi.decodeMscSysex(timedGo, { deviceId: 0x7f }, 70).cue.index, 2);

  // SET ctrl 1 (grand master) 14-bit value 16383 -> 1.0
  const setFull = new Uint8Array([0xf0, 0x7f, 0x7f, 0x02, 0x01, 0x06, 0x01, 0x00, 0x7f, 0x7f, 0xf7]);
  assert.equal(tsMidi.decodeMscSysex(setFull, { deviceId: 0x7f }, 80).value, 1);

  // ALL_OFF -> blackout 1; RESTORE -> blackout 0; RESET -> reset
  assert.equal(tsMidi.decodeMscSysex(new Uint8Array([0xf0, 0x7f, 0x7f, 0x02, 0x01, 0x08, 0xf7])).value, 1);
  assert.equal(tsMidi.decodeMscSysex(new Uint8Array([0xf0, 0x7f, 0x7f, 0x02, 0x01, 0x09, 0xf7])).value, 0);
  assert.equal(tsMidi.decodeMscSysex(new Uint8Array([0xf0, 0x7f, 0x7f, 0x02, 0x01, 0x0a, 0xf7])).command, 'reset');

  // Non-numeric Q_number and >128 byte SysEx rejected
  assert.equal(tsMidi.decodeMscSysex(tsMidi.encodeMscGo('drop', 0x7f, 0x01)), null);
  const oversized = new Uint8Array(130);
  oversized[0] = 0xf0; oversized[1] = 0x7f; oversized[2] = 0x7f; oversized[3] = 0x02; oversized[4] = 0x01; oversized[5] = 0x01; oversized[129] = 0xf7;
  assert.equal(tsMidi.decodeMscSysex(oversized), null);
});

test('Single Clock Owner truth table, ChaseEngine state machine, and CallerDedupe prevent double-firing', () => {
  // Truth table invariants
  assert.equal(tsClock.allows('master', 'internal', 'take_play'), true);
  assert.equal(tsClock.allows('master', 'osc', 'go'), false);
  assert.equal(tsClock.allows('master', 'mtc', 'timecode_transport'), false);
  assert.equal(tsClock.allows('chase', 'mtc', 'timecode_transport'), true);
  assert.equal(tsClock.allows('chase', 'internal', 'take_play'), false);
  assert.equal(tsClock.allows('chase', 'follow', 'cue_follow'), false);
  assert.equal(tsClock.allows('chase', 'autoLD', 'auto_ld'), false);
  assert.equal(tsClock.allows('chase', 'manual', 'go'), false);
  assert.equal(tsClock.allows('chase', 'manual', 'blackout'), true);
  assert.equal(tsClock.allows('chase', 'msc', 'blackout'), true);
  assert.equal(tsClock.allows('chase', 'internal', 'outbound_timecode'), false);
  assert.equal(tsClock.allows('caller', 'osc', 'go'), true);
  assert.equal(tsClock.allows('caller', 'msc', 'go'), true);
  assert.equal(tsClock.allows('caller', 'follow', 'cue_follow'), false);
  assert.equal(tsClock.allows('caller', 'autoLD', 'auto_ld'), false);
  assert.equal(tsClock.allows('caller', 'internal', 'take_play'), false);
  for (const mode of ['master', 'chase', 'caller']) {
    assert.equal(tsClock.allows(mode, 'osc', 'remote_clock_mode'), false);
  }

  // ChaseEngine: 2 consistent frames -> LOCKED (initial seek), jitter slew, >10 frame jump -> seek, dropout -> FREEWHEEL -> STOPPED
  const chase = new tsClock.ChaseEngine({ dropoutMs: 300, freewheelMs: 500, timecodeOffsetMs: 3_600_000 });
  const s1 = chase.onTimecode({ ms: 3_601_000, fps: 30 }, 1000);
  assert.equal(s1.lockState, 'LOCKING');
  assert.equal(s1.action, 'none');
  const s2 = chase.onTimecode({ ms: 3_601_033, fps: 30 }, 1033);
  assert.equal(s2.lockState, 'LOCKED');
  assert.equal(s2.action, 'seek');
  assert.equal(s2.takeMs, 1033);

  // Small backward jitter (1 frame) slews monotonically, never seeks/re-fires.
  const s3 = chase.onTimecode({ ms: 3_601_040, fps: 30 }, 1066);
  assert.equal(s3.action, 'advance');
  assert.ok(s3.takeMs >= 1033);

  // Forward jump > 10 frames seeks silently.
  const s4 = chase.onTimecode({ ms: 3_605_000, fps: 30 }, 1100);
  assert.equal(s4.action, 'seek');
  assert.equal(s4.takeMs, 5000);

  // Dropout > 300 ms -> FREEWHEEL, then > 500 ms freewheel -> STOPPED.
  const fw = chase.tick(1450);
  assert.equal(fw.lockState, 'FREEWHEEL');
  const stopped = chase.tick(2000);
  assert.equal(stopped.lockState, 'STOPPED');
  assert.equal(stopped.action, 'stop');

  // CallerDedupe & strict cue resolution
  const cues = [
    { id: 'c-intro', name: 'Intro' },
    { id: 'c-drop', name: '1.5' },
  ];
  assert.equal(tsClock.resolveCallerCue(cues, { index: 1 }, 'msc').id, 'c-intro');
  assert.equal(tsClock.resolveCallerCue(cues, { ref: '1.5' }, 'msc').id, 'c-drop');
  assert.equal(tsClock.resolveCallerCue(cues, { ref: 'c-intro' }, 'osc').id, 'c-intro');
  assert.equal(tsClock.resolveCallerCue(cues, { ref: 'Int' }, 'osc'), null, 'no fuzzy matching');

  const dedupe = new tsClock.CallerDedupe();
  assert.equal(dedupe.acceptGo('c-intro', false, null, 100), true);
  assert.equal(dedupe.acceptGo('c-intro', false, 'c-intro', 200), false, 'duplicate GO within 250 ms dropped');
  assert.equal(dedupe.acceptGo('c-intro', false, 'c-intro', 400), true);
  assert.equal(dedupe.acceptGo(null, true, null, 500), true);
  assert.equal(dedupe.acceptGo(null, true, null, 550), false, 'bare GO coalesced within 100 ms');
});

test('Tempo folding, half/double bounds, tap tempo, beat grid nudge/downbeat, and live BPM stabilizer work accurately', () => {
  assert.equal(tsTempo.foldBpm(64), 128);
  assert.equal(tsTempo.foldBpm(256), 128);
  assert.equal(tsTempo.foldBpm(128.04), 128);
  assert.equal(tsTempo.halfTimeBpm(140), 70);
  assert.equal(tsTempo.halfTimeBpm(138), null, 'half time must not fold below 70');
  assert.equal(tsTempo.doubleTimeBpm(90), 180);
  assert.equal(tsTempo.doubleTimeBpm(92), null, 'double time must not fold above 180');

  // Tap tempo at 120 BPM (500 ms) with 2 s reset
  const tapper = new tsTempo.TapTempoTracker();
  assert.equal(tapper.tap(0).bpm, null);
  assert.equal(tapper.tap(500).bpm, 120);
  assert.equal(tapper.tap(1000).bpm, 120);
  assert.equal(tapper.tap(1500).bpm, 120);
  // After 2.5 s gap, resets cleanly
  assert.equal(tapper.tap(4000).bpm, null);
  assert.equal(tapper.tap(4400).bpm, 150);

  // Beat grid nudge & set downbeat (preserves 4-beat bar phase, M4)
  const grid = { bpm: 120, offsetMs: 100, source: 'offline' };
  const nudged = tsTempo.nudgeBeatGrid(grid, -50);
  assert.equal(nudged.offsetMs, 50);
  const anchored = tsTempo.setBeatGridDownbeat(grid, 1250); // 1250 % 2000 = 1250 (bar phase preserved)
  assert.equal(anchored.offsetMs, 1250);
  const phase = tsTempo.beatGridPhase(anchored, 1250);
  assert.equal(phase.phase, 0);
  assert.equal(phase.beatIndex, 0);
  assert.equal(phase.isDownbeat, true);

  // Live BPM stabilizer: requires 4 s stability within ±1.5 BPM and >1 BPM diff
  const stab = new tsTempo.LiveBpmStabilizer(5, 4000, 1.5);
  assert.equal(stab.observe(132, 128, true, 0).applyBpm, null);
  assert.equal(stab.observe(132.4, 128, true, 2000).applyBpm, null);
  assert.equal(stab.observe(132.1, 128, true, 4100).applyBpm, 132);
  // Follow off -> never applies
  const stabOff = new tsTempo.LiveBpmStabilizer(5, 4000, 1.5);
  stabOff.observe(140, 128, false, 0);
  assert.equal(stabOff.observe(140, 128, false, 5000).applyBpm, null);
});

test('Main-process Show Control loopback UDP (OSC + Art-Net TC + shared Art-Net RX discovery) and IPC security', async () => {
  const artnetRx = createArtNetRxMux();
  const received = [];
  const svc = createShowControlService({
    artnetRx,
    allowZeroPort: true,
    testPorts: { artnetRx: 0 },
    onEvent: (ev) => received.push(ev),
  });
  const sender = dgram.createSocket('udp4');
  const fakeNode = dgram.createSocket('udp4');
  try {
    // Start OSC RX on ephemeral 127.0.0.1 port + Art-Net TC RX on ephemeral port
    const status = await svc.configure({
      oscRxEnabled: true,
      oscPort: 0,
      oscAllowAllInterfaces: false,
      oscTxEnabled: false,
      artnetTcRxEnabled: true,
      artnetTcTxEnabled: false,
    }, 42);
    assert.equal(status.oscRxListening, true);
    assert.equal(status.oscRxAddress, '127.0.0.1');
    assert.ok(status.oscRxPort > 0);
    assert.equal(status.artnetTcRxListening, true);
    assert.ok(status.artnetTcRxPort > 0);

    // Send OSC /stageforge/go 2 and Art-Net OpTimeCode over loopback 127.0.0.1
    await new Promise((r) => sender.bind(0, '127.0.0.1', r));
    const oscPkt = cjsOsc.encodeOscMessage('/stageforge/go', [{ type: 'i', value: 2 }]);
    const tcPkt = cjsOsc.encodeArtNetTimecode({ hours: 1, minutes: 0, seconds: 2, frames: 15, fps: 30 });
    sender.send(oscPkt, status.oscRxPort, '127.0.0.1');
    sender.send(tcPkt, status.artnetTcRxPort, '127.0.0.1');

    await new Promise((r) => setTimeout(r, 120));
    assert.ok(received.some((e) => e.source === 'osc' && e.command === 'go' && e.cue?.index === 2), 'OSC loopback trigger received');
    assert.ok(received.some((e) => e.source === 'artnetTC' && e.hours === 1 && e.seconds === 2 && e.frames === 15), 'Art-Net TC loopback received');

    // Verify shared Art-Net RX mux lets DMX discovery subscribe to 0x2100 without EADDRINUSE while TC RX is active!
    await new Promise((r) => fakeNode.bind(0, '127.0.0.1', r));
    const fakeNodePort = fakeNode.address().port;
    fakeNode.on('message', () => {
      const reply = Buffer.alloc(239);
      Buffer.from('Art-Net\0', 'ascii').copy(reply, 0);
      reply.writeUInt16LE(ARTNET_OPCODE_POLL_REPLY, 8);
      reply[10] = 127; reply[11] = 0; reply[12] = 0; reply[13] = 1;
      reply.write('SharedMuxNode', 26, 'ascii');
      fakeNode.send(reply, status.artnetTcRxPort, '127.0.0.1');
    });

    const dmx = createDmxController({
      artnetRx,
      testPorts: { artnet: fakeNodePort, artnetDiscovery: status.artnetTcRxPort },
      discoverDurationMs: 250,
    });
    const disc = await dmx.discover('127.0.0.1');
    assert.equal(disc.warning, null, 'discovery must share Art-Net RX socket with zero EADDRINUSE');
    assert.equal(disc.nodes.length, 1);
    assert.equal(disc.nodes[0].shortName, 'SharedMuxNode');

    // IPC security handler checks
    const { onControl } = createShowControlIpcHandlers(() => svc);
    const makeEv = ({ id = 42, url = 'stageforge://app/', isSubframe = false } = {}) => {
      const mainFrame = { url };
      return {
        senderFrame: isSubframe ? { url } : mainFrame,
        sender: { id, mainFrame, getURL: () => url, isDestroyed: () => false },
      };
    };
    await assert.rejects(() => onControl(makeEv({ url: 'https://evil.example/' }), { type: 'getStatus' }), /Unauthorized/);
    await assert.rejects(() => onControl(makeEv({ isSubframe: true }), { type: 'getStatus' }), /Unauthorized/);
    await assert.rejects(() => onControl(makeEv({ id: 99 }), { type: 'stop' }), /another StageForge window/);
    const otherStatus = await onControl(makeEv({ id: 99 }), { type: 'getStatus' });
    assert.equal(otherStatus.active, false);
    assert.equal(otherStatus.oscRxPort, null, 'non-owner status must sanitize port/host/counts (L5)');
    assert.equal(otherStatus.oscTxHost, '');
    assert.equal(otherStatus.oscRxCount, 0);
    assert.throws(() => validateShowControlConfig({ oscPort: 80 }), /1024/);
    assert.throws(() => validateShowControlConfig({ oscTxEnabled: true, oscTxHost: '255.255.255.255' }), /Invalid/);
    // M-C: An invalid unused TX host must not block enabling OSC RX.
    assert.equal(validateShowControlConfig({ oscRxEnabled: true, oscTxEnabled: false, oscTxHost: 'localhost' }).oscTxHost, '127.0.0.1');
    assert.throws(() => validateShowControlConfig({ oscRxEnabled: 'false' }), /boolean/, 'string boolean rejected (L4)');
    assert.throws(() => svc.send({ kind: 'timecode', ms: 86_400_000, fps: 30 }), /Invalid timecode ms/);
  } finally {
    await svc.shutdown();
    await artnetRx.closeAll();
    await new Promise((r) => { try { sender.close(r); } catch { r(); } });
    await new Promise((r) => { try { fakeNode.close(r); } catch { r(); } });
  }
});

test('Sprint 3 QA regressions: overlapping configure (H1), paused/interleaved chase (H2/M2), dual TC source pin (M5), MIDI flood (M4), and mux re-acquire (L1)', async () => {
  // H1 & L1: Overlapping configure() with Art-Net TC RX must still deliver packets and cleanly re-acquire.
  const artnetRx = createArtNetRxMux();
  const tcEvents = [];
  const svc = createShowControlService({
    artnetRx,
    allowZeroPort: true,
    testPorts: { artnetRx: 0 },
    onEvent: (ev) => { if (ev.kind === 'timecode') tcEvents.push(ev); },
  });
  const sender = dgram.createSocket('udp4');
  try {
    await new Promise((r) => sender.bind(0, '127.0.0.1', r));
    const p1 = svc.configure({ artnetTcRxEnabled: true, oscRxEnabled: false }, 1);
    const p2 = svc.configure({ artnetTcRxEnabled: true, oscRxEnabled: false }, 1);
    const [, finalStatus] = await Promise.all([p1, p2]);
    assert.equal(finalStatus.artnetTcRxListening, true);
    const tcPkt = cjsOsc.encodeArtNetTimecode({ hours: 0, minutes: 0, seconds: 5, frames: 10, fps: 30 });
    sender.send(tcPkt, finalStatus.artnetTcRxPort, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(tcEvents.length >= 1, 'Art-Net TC must still be delivered after overlapping configure (H1)');

    // L1: Release and immediately re-acquire on the same fixed port without EADDRINUSE.
    const fixedPort = finalStatus.artnetTcRxPort;
    await svc.shutdown();
    const reacquired = await artnetRx.acquire(cjsOsc.ARTNET_OPCODE_TIMECODE, () => {}, { port: fixedPort });
    assert.equal(reacquired.port, fixedPort);
    await reacquired.release();
  } finally {
    await svc.shutdown();
    await artnetRx.closeAll();
    await new Promise((r) => { try { sender.close(r); } catch { r(); } });
  }

  // H2 & M2: Interleaved onTimecode + tick at 30 fps stays accurate (< 1 frame error),
  // and repeated stationary TC frames never creep forward or trigger snap-back seeks.
  const chase = new tsClock.ChaseEngine({ dropoutMs: 300, freewheelMs: 500, timecodeOffsetMs: 0 });
  chase.onTimecode({ ms: 1000, fps: 30, source: 'artnetTC' }, 1000);
  const lockStep = chase.onTimecode({ ms: 1033.333, fps: 30, source: 'artnetTC' }, 1033);
  assert.equal(lockStep.lockState, 'LOCKED');

  for (let i = 2; i <= 20; i++) {
    const t = 1000 + i * (1000 / 30);
    chase.tick(t - 10);
    const step = chase.onTimecode({ ms: t, fps: 30, source: 'artnetTC' }, t);
    assert.equal(step.action, 'advance');
    assert.ok(Math.abs(step.rawTcMs - t) < 34, `playhead drift must stay < 1 frame (got ${step.rawTcMs - t} ms)`);
  }

  // Repeated identical frame (paused generator) must never seek back, emits one 'hold' after >= 120 ms, and never creeps once held.
  const pausedTc = 1000 + 20 * (1000 / 30);
  let holdTransitions = 0;
  for (let k = 1; k <= 10; k++) {
    const t = pausedTc + k * 33;
    const tStep = chase.tick(t - 10);
    const rStep = chase.onTimecode({ ms: pausedTc, fps: 30, source: 'artnetTC' }, t);
    assert.notEqual(rStep.action, 'seek', 'paused repeated TC must never trigger snap-back seek (H2)');
    if (rStep.action === 'hold') holdTransitions++;
    else assert.equal(rStep.action, 'none');
    if (k > 5) assert.equal(tStep.action, 'none', 'tick during paused TC must not creep forward');
  }
  assert.equal(holdTransitions, 1, 'stationary timecode must emit exactly one hold transition (M3)');

  // M5: While locked to artnetTC, competing MTC samples at a different offset are ignored (no false seeks).
  const competing = chase.onTimecode({ ms: 9000, fps: 30, source: 'mtc' }, pausedTc + 400);
  assert.equal(competing.action, 'none', 'competing TC source must be ignored while locked (M5)');
  assert.equal(chase.activeSource, 'artnetTC');

  // M-A: A stuck LOCKING source times out after dropoutMs and clears activeSource so another source can lock.
  const stuckChase = new tsClock.ChaseEngine({ dropoutMs: 300, freewheelMs: 500, timecodeOffsetMs: 0 });
  stuckChase.onTimecode({ ms: 1000, fps: 30, source: 'mtc' }, 100);
  assert.equal(stuckChase.lockState, 'LOCKING');
  assert.equal(stuckChase.activeSource, 'mtc');
  stuckChase.tick(500); // > 300 ms silent while LOCKING
  assert.equal(stuckChase.lockState, 'UNLOCKED');
  assert.equal(stuckChase.activeSource, null);
  stuckChase.onTimecode({ ms: 2000, fps: 30, source: 'artnetTC' }, 600);
  const relocked = stuckChase.onTimecode({ ms: 2033.333, fps: 30, source: 'artnetTC' }, 633);
  assert.equal(relocked.lockState, 'LOCKED');
  assert.equal(stuckChase.activeSource, 'artnetTC');

  // Stale release() after closeAll() must not close a newly acquired socket.
  const staleMux = createArtNetRxMux();
  try {
    const h1 = await staleMux.acquire(cjsOsc.ARTNET_OPCODE_TIMECODE, () => {}, { port: 0 });
    await staleMux.closeAll();
    const h2 = await staleMux.acquire(cjsOsc.ARTNET_OPCODE_TIMECODE, () => {}, { port: 0 });
    await h1.release(); // stale handle from prior epoch
    assert.equal(staleMux.isBound, true, 'stale release must not close new socket');
    await h2.release();
    assert.equal(staleMux.isBound, false);
  } finally {
    await staleMux.closeAll();
  }

  // M4: MIDI CC/0xF8 flood (2000 msgs) must NOT starve MTC or MSC decoding.
  const midiEvents = [];
  const midiClient = new tsMidi.MidiShowControlClient((ev) => midiEvents.push(ev), () => {});
  midiClient.configure({ mtcEnabled: true, mscEnabled: true, inputId: 'all', outputId: '', deviceId: 0x7f });
  for (let i = 0; i < 2000; i++) {
    midiClient.handleMidiMessage({ data: new Uint8Array([0xf8]) });
    midiClient.handleMidiMessage({ data: new Uint8Array([0xb0, 7, i & 0x7f]) });
  }
  midiClient.handleMidiMessage({ data: tsMidi.encodeMscGo('2', 0x7f, 0x01) });
  assert.equal(midiEvents.length, 1, 'MSC GO must pass after 4000 unrelated MIDI clock/CC messages (M4)');
  assert.equal(midiEvents[0].cue.index, 2);

  // MTC rate-change reset
  const mtcDec = new tsMidi.MtcDecoder();
  const qf30 = tsMidi.encodeMtcQuarterFrames(1000, 30);
  for (let i = 0; i < 8; i++) mtcDec.feedQuarterFrame(qf30[i][1], i * 8);
  const qf25 = tsMidi.encodeMtcQuarterFrames(2000, 25);
  let rateChangedResult = null;
  for (let i = 0; i < 8; i++) rateChangedResult = mtcDec.feedQuarterFrame(qf25[i][1], 100 + i * 10);
  assert.equal(rateChangedResult, null, 'MTC rate change must reset assembly cleanly');
});
