import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createArtNetRxMux } = require('../desktop/artnet-rx.cjs');
const { createArtNetInput, validateInputConfig, INPUT_TIMEOUT_MS, INPUT_TICK_MS } = require('../desktop/artnet-input.cjs');
const { createDmxController } = require('../desktop/dmx-sender.cjs');
const { createDmxIpcHandlers } = require('../desktop/dmx-ipc.cjs');
const { createOutputInterlock } = require('../desktop/output-interlock.cjs');
const { createQuitDrain } = require('../desktop/quit-drain.cjs');
const { ARTNET_OPCODE_DMX, encodeArtDmxPacket } = require('../desktop/dmx-packets.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
const pin = '127.0.0.1';
const any = '0.0.0.0';
const config = { binding: 'loopback', address: pin, mappings: [
  { portAddress: 0, universe: 1, sender: pin }, { portAddress: 2, universe: 3, sender: pin },
] };
const authority = { revision: 'first', generation: 1 };
const start = { type: 'start', authority, config };
const frame = (sequence, slots = [128, 0], portAddress = 2) => encodeArtDmxPacket({
  sequence, slots: Uint8Array.from(slots), portAddress,
});
const osModule = { networkInterfaces: () => ({ loop: [{ family: 'IPv4', address: pin, internal: true, netmask: '255.0.0.0' }] }) };

function mockUdp() {
  const sockets = [];
  class Socket extends EventEmitter {
    writes = [];
    closes = 0;
    bind(tuple) { this.requested = tuple; }
    admit(port = this.requested.port || 40024) {
      this.address = () => ({ port, address: this.requested.address });
      this.emit('listening');
    }
    close(done) { this.closes++; this.closeDone = done; }
    finishClose() { assert.equal(this.closes, 1); this.closeDone(); }
    setBroadcast() {}
    send(packet, port, address, done) { this.writes.push({ packet, port, address }); done?.(); }
  }
  return { sockets, createSocket() { const socket = new Socket(); sockets.push(socket); return socket; } };
}

function editor(id = 1, options = {}) {
  const sent = [];
  const url = options.url ?? 'stageforge://app/';
  const mainFrame = { url };
  return {
    sent, senderFrame: options.subframe ? { url } : mainFrame,
    sender: { id, mainFrame, getURL: () => url, isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) },
  };
}

function inputHarness(options = {}) {
  const udp = mockUdp();
  const mux = createArtNetRxMux({ dgramModule: udp });
  const interlock = createOutputInterlock();
  let time = 0;
  let tick = () => {};
  const input = createArtNetInput({
    mux, interlock, listInterfaces: () => [], port: 0, now: () => time,
    schedule: (fn, interval) => { assert.equal(interval, INPUT_TICK_MS); tick = fn; return 1; },
    unschedule: () => { tick = () => {}; },
    ...options,
  });
  return { udp, mux, interlock, input, at: (clock) => { time = clock; }, tick: () => tick() };
}

test('Art-Net input validates explicit binding, bounded unique mappings and pinned IPv4', () => {
  const interfaces = [{ name: 'Adapter', address: '10.20.30.1', internal: false }];
  assert.deepEqual(validateInputConfig(config, interfaces), config);
  assert.equal(validateInputConfig({ ...config, binding: 'all', address: any }, interfaces).address, any);
  assert.equal(validateInputConfig({ ...config, binding: 'interface', address: '10.20.30.1' }, interfaces).address, '10.20.30.1');
  for (const invalid of [
    { ...config, binding: 'interface' }, { ...config, binding: 'all' }, { ...config, address: any },
    { ...config, address: '10.20.30.1' }, { ...config, binding: 'interface', address: '10.20.30.2' },
    { ...config, mappings: [] }, { ...config, mappings: Array(17).fill(config.mappings[0]) },
    { ...config, mappings: [config.mappings[0], { ...config.mappings[1], universe: 1 }] },
    { ...config, mappings: [config.mappings[0], { ...config.mappings[1], portAddress: 0 }] },
    ...[{ universe: 17 }, { portAddress: 32768 }, { sender: any }, { sender: '224.0.0.1' }, { sender: 'localhost' }]
      .map(patch => ({ ...config, mappings: [{ ...config.mappings[0], ...patch }] })),
  ]) assert.throws(() => validateInputConfig(invalid, interfaces), /Art-Net/);
});

test('Art-Net mux admits exact pending/effective tuples and preserves independent Timecode handles', async () => {
  for (const address of [any, pin]) {
    const otherAddress = address === any ? pin : any;
    const udp = mockUdp();
    const mux = createArtNetRxMux({ dgramModule: udp });
    const received = [];
    const onPacket = () => received.push('artdmx');
    const first = mux.acquire(ARTNET_OPCODE_DMX, onPacket, { port: 0, address });
    await assert.rejects(mux.acquire(ARTNET_OPCODE_DMX, onPacket, { port: 40123, address }), /opening/);
    await assert.rejects(mux.acquire(ARTNET_OPCODE_DMX, onPacket, { port: 0, address: otherAddress }), /opening/);
    const second = mux.acquire(ARTNET_OPCODE_DMX, onPacket, { port: 0, address });
    const socket = udp.sockets[0];
    socket.emit('message', frame(1), { address: pin });
    assert.deepEqual(received, []);
    socket.admit(40123);
    const [rx, duplicate] = await Promise.all([first, second]);
    await assert.rejects(mux.acquire(ARTNET_OPCODE_DMX, onPacket, { address }), /already uses/);
    await assert.rejects(mux.acquire(ARTNET_OPCODE_DMX, onPacket, { port: 40123, address: otherAddress }), /already uses/);
    const onTimecode = () => received.push('timecode');
    const tc = await mux.acquire(0x9700, onTimecode, { port: 40123, address });
    const tcPacket = frame(2);
    tcPacket.writeUInt16LE(0x9700, 8);
    socket.emit('message', frame(2), { address: pin });
    assert.deepEqual(received, ['artdmx', 'artdmx']);
    await rx.release();
    await duplicate.release();
    socket.emit('message', tcPacket, { address: pin });
    assert.deepEqual(received, ['artdmx', 'artdmx', 'timecode']);
    assert.equal(udp.sockets.length, 1);
    const drain = tc.release();
    assert.equal(tc.release(), drain);
    assert.equal(mux.closeAll(), drain);
    socket.finishClose();
    await drain;
    const fixed = mux.acquire(ARTNET_OPCODE_DMX, onPacket, { port: 40123, address });
    const wildcardPort = mux.acquire(ARTNET_OPCODE_DMX, onPacket, { port: 0, address });
    udp.sockets[1].admit();
    const [a, b] = await Promise.all([fixed, wildcardPort]);
    await rx.release(); // an old handle cannot close a new binding
    await a.release();
    const close = b.release();
    udp.sockets[1].finishClose();
    await close;
  }
});

test('Art-Net mux joins real pending bind cancellation and releases before reopening', async () => {
  const udp = mockUdp();
  const mux = createArtNetRxMux({ dgramModule: udp });
  const opening = mux.acquire(ARTNET_OPCODE_DMX, () => assert.fail('cancelled delivery'), { port: 0, address: pin });
  const rejected = assert.rejects(opening, /cancelled/);
  const closing = mux.closeAll();
  assert.equal(mux.closeAll(), closing);
  const retry = mux.acquire(ARTNET_OPCODE_DMX, () => {}, { port: 0, address: pin });
  assert.equal(udp.sockets.length, 1);
  udp.sockets[0].admit();
  await turn();
  assert.equal(udp.sockets[0].closes, 1);
  assert.equal(udp.sockets.length, 1);
  udp.sockets[0].finishClose();
  await Promise.all([closing, rejected]);
  await turn();
  assert.equal(udp.sockets.length, 2);
  udp.sockets[1].admit();
  const handle = await retry;
  const released = handle.release();
  udp.sockets[1].finishClose();
  await released;
});

test('Art-Net input scopes IPC and coalesces 512 slots, sequence, pinned source, stale and loss', async () => {
  const { input, udp, interlock, tick, at } = inputHarness({ isRestricted: id => id === 3 });
  const e = editor();
  const outsider = editor(2);
  await assert.rejects(input.onControl(editor(3), start), /authorized/);
  await assert.rejects(input.onControl(editor(1, { url: 'stageforge://app/?view' }), start), /authorized/);
  await assert.rejects(input.onControl(editor(1, { subframe: true }), start), /authorized/);
  await assert.rejects(input.onControl(editor(1, { url: 'https://example.invalid/' }), start), /authorized/);
  await assert.rejects(input.onControl(e, { ...start, port: 9999 }), /Invalid/);
  const starting = input.onControl(e, start);
  const duplicateStart = input.onControl(e, start);
  await assert.rejects(input.onControl(outsider, start), /busy/);
  await assert.rejects(input.onControl(e, { ...start, config: { ...config, mappings: [config.mappings[0]] } }), /Stale/);
  assert.equal(interlock.claimOutput(2, 'armed').ok, false);
  assert.equal(interlock.tryBeginDmxEnable(2).ok, false);
  assert.throws(() => interlock.reserveDiscovery(2), /Stop Art-Net input/);
  assert.match(interlock.canEnableBridge(), /Stop Art-Net input/);
  const socket = udp.sockets[0];
  socket.admit();
  await Promise.all([starting, duplicateStart]);
  const send = (packet, address = pin) => socket.emit('message', packet, { address });
  const batches = () => e.sent.filter(item => item.channel.endsWith('-batch')).map(item => item.data);
  const ack = (batchId, who = e, token = authority) => input.onAck(who, { batchId, authority: token });

  send(frame(254, Array(512).fill(255)));
  tick();
  assert.equal(batches().length, 1);
  assert.equal(batches()[0].rows.find(row => row.universe === 3).data[511], 255);
  send(frame(255, [90, 1]));
  send(frame(1, [44, 2])); // the numbered 1–255 ring skips zero on wrap
  send(frame(255, [250, 2])); // old after wrap
  send(frame(0, [123, 3])); // ordering disabled, resets previous number
  send(frame(200, [77, 4]));
  send(frame(203, [88, 5])); // two lost numbers
  send(frame(204), '127.0.0.2');
  send(frame(204, [11, 12], 31));
  const malformed = frame(204); malformed[15] |= 0x80;
  send(malformed);
  tick();
  assert.equal(batches().length, 1, 'stalling the ACK retains only the latest received rows');
  assert.equal(ack(1, outsider), false);
  assert.equal(ack(1, e, { ...authority, generation: 0 }), false);
  assert.equal(ack(2), false);
  assert.equal(ack(1), true);
  assert.equal(ack(1), false);
  tick();
  const latest = batches()[1];
  const u3 = latest.rows.find(row => row.universe === 3);
  assert.equal(u3.data.length, 512);
  assert.deepEqual([...u3.data.slice(0, 4)], [88, 5, 0, 0]);
  assert.equal(u3.data[511], 0);
  assert.equal(u3.received, 6);
  assert.equal(u3.lost, 2);
  assert.deepEqual(latest.drops, { invalid: 1, unmapped: 1, unselected: 1, sequence: 1 });
  assert.equal(latest.rows[0].state, 'awaiting');
  assert.equal(ack(latest.batchId), true);
  at(INPUT_TIMEOUT_MS - 1);
  send(frame(203)); // duplicate must not refresh the packet age
  tick();
  assert.equal(batches().at(-1).rows[1].state, 'active');
  assert.equal(ack(batches().at(-1).batchId), true);
  at(INPUT_TIMEOUT_MS);
  tick();
  assert.equal(batches().at(-1).rows[1].state, 'stale');
  assert.equal(batches().at(-1).rows[1].data.some(Boolean), false);
  assert.equal(ack(batches().at(-1).batchId), true);
  send(frame(7, [5, 1]));
  tick();
  assert.equal(batches().at(-1).rows[1].state, 'active');
  assert.equal(batches().at(-1).rows[1].data[0], 5);

  const newDocument = { revision: 'second', generation: 2 };
  const invalidating = input.onControl(e, { type: 'document', authority: newDocument });
  assert.equal(ack(batches().at(-1).batchId), false);
  assert.equal(e.sent.at(-1).data.phase, 'stopping');
  await turn();
  assert.equal(interlock.claimOutput(2, 'serial').ok, false);
  socket.finishClose();
  await invalidating;
  const next = input.onControl(e, { ...start, authority: { ...newDocument, generation: 3 } });
  udp.sockets[1].admit();
  await next;
  await assert.rejects(input.onControl(e, { type: 'stop', authority }), /stale/);
  tick();
  assert.equal(batches().at(-1).rows[1].state, 'awaiting');
  const off = input.stopForWindow();
  await turn();
  udp.sockets[1].finishClose();
  await off;
});

test('Art-Net input bind failure keeps authority through socket close and allows a later retry', async () => {
  const { input, udp, interlock } = inputHarness();
  const e = editor();
  const failed = assert.rejects(input.onControl(e, start), /occupied/);
  udp.sockets[0].emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }));
  await turn();
  assert.match(interlock.canEnableBridge(), /Stop Art-Net input/);
  udp.sockets[0].finishClose();
  await failed;
  assert.equal(interlock.canEnableBridge(), null);
  const retry = input.onControl(e, { ...start, authority: { ...authority, generation: 2 } });
  udp.sockets[1].admit();
  await retry;
  const stopped = input.stopForWindow();
  await turn();
  udp.sockets[1].finishClose();
  await stopped;
});

test('Art-Net discovery reserves across windows, blocks AI, and checks both ArtPoll sends', async () => {
  const udp = mockUdp();
  const timers = [];
  const ctrl = createDmxController({ dgramModule: udp, osModule, testPorts: { artnetDiscovery: 0 },
    scheduleDiscovery: (fn) => { timers.push(fn); return fn; }, cancelDiscoveryTimer: () => {} });
  const interlock = createOutputInterlock();
  const { onControl } = createDmxIpcHandlers(() => ctrl, { interlock });
  const discover = { type: 'discover', iface: pin };
  const e = editor();
  assert.equal(interlock.tryBeginBridgeStart(1).ok, true);
  await assert.rejects(onControl(e, discover), /Disable the AI bridge/);
  interlock.markBridgeOn(1);
  await assert.rejects(onControl(e, discover), /Disable the AI bridge/);
  interlock.beginBridgeStop();
  await assert.rejects(onControl(e, discover), /Disable the AI bridge/);
  assert.equal(udp.sockets.length, 0);
  interlock.finishBridgeStop();

  const first = assert.rejects(onControl(e, discover), /cancelled/);
  const same = assert.rejects(onControl(e, discover), /cancelled/);
  await assert.rejects(onControl(editor(2), discover), /busy/);
  assert.throws(() => interlock.reservePreview(2), /discovery/);
  assert.match(interlock.canEnableBridge(), /discovery/);
  const live = interlock.tryBeginDmxEnable(1); // Existing same-owner discovery + physical Go remains allowed.
  assert.equal(live.ok, true);
  interlock.finishDmxEnableAttempt(live.lease);
  const stopBeforeBind = ctrl.cancelDiscover(1);
  udp.sockets[0].admit();
  await turn();
  assert.equal(udp.sockets[0].writes.length, 0);
  await assert.rejects(onControl(editor(2), discover), /busy/);
  udp.sockets[0].finishClose();
  await Promise.all([first, same, stopBeforeBind]);
  assert.equal(interlock.canEnableBridge(), null);

  const second = assert.rejects(onControl(e, discover), /cancelled/);
  await ctrl.cancelDiscover(2); // A stale or different owner cannot stop the new scan.
  udp.sockets[1].admit();
  await turn();
  assert.equal(udp.sockets[1].writes.length, 1);
  const stopBeforeSecondSend = ctrl.cancelDiscover(1);
  timers[0](); // even a late, already-queued timer must recheck its reservation
  await turn();
  assert.equal(udp.sockets[1].writes.length, 1);
  assert.equal(udp.sockets[1].writes[0].packet.readUInt16LE(8), 0x2000);
  udp.sockets[1].finishClose();
  await Promise.all([second, stopBeforeSecondSend]);
  assert.equal(interlock.canEnableBridge(), null);
});

for (const kind of ['preview', 'discovery']) {
  test(`repeated before-quit waits for pending Art-Net ${kind} bind and actual socket cleanup`, async () => {
    const { udp, mux, input, interlock } = inputHarness();
    const dmx = createDmxController({ dgramModule: udp, osModule, testPorts: { artnetDiscovery: 0 } });
    const { onControl } = createDmxIpcHandlers(() => dmx, { interlock });
    const e = editor();
    const request = kind === 'preview' ? input.onControl(e, start) : onControl(e, { type: 'discover', iface: pin });
    const failed = assert.rejects(request, /cancelled/);
    let prevented = 0;
    let quits = 0;
    const event = { preventDefault: () => { prevented++; } };
    const beforeQuit = createQuitDrain({
      closeAdmissions: () => interlock.closeAdmissions(),
      hasWork: () => input.active || dmx.discovering,
      drain: () => Promise.allSettled([input.stopForWindow(), dmx.cancelDiscover(), mux.closeAll()]),
      quit: () => { quits++; },
    });
    beforeQuit(event);
    beforeQuit(event);
    assert.deepEqual([prevented, quits], [2, 0]);
    assert.throws(() => interlock.reservePreview(2), /closing/);
    await turn();
    udp.sockets[0].admit();
    await turn();
    beforeQuit(event);
    assert.deepEqual([prevented, quits], [3, 0]);
    assert.equal(udp.sockets[0].writes.length, 0);
    udp.sockets[0].finishClose();
    await failed;
    await turn();
    assert.equal(input.active || dmx.discovering, false);
    beforeQuit(event);
    assert.deepEqual([prevented, quits], [3, 1]);
  });
}
