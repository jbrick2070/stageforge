import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const packets = require('../desktop/dmx-packets.cjs');
const sender = require('../desktop/dmx-sender.cjs');
const { createDmxIpcHandlers } = require('../desktop/dmx-ipc.cjs');
const { createAiBridgeIpcHandlers } = require('../desktop/ai-bridge-ipc.cjs');
const { createOutputInterlock } = require('../desktop/output-interlock.cjs');
const { createViewerIpcHandler, createViewerModeTracker } = require('../desktop/viewer-ipc.cjs');

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const enttec = await compiler.ssrLoadModule('/src/dmx/enttecPro.ts');
const liveDmx = await compiler.ssrLoadModule('/src/dmx/liveDmx.ts');

function bindLoopbackReceiver() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const received = [];
    sock.on('message', (msg, rinfo) => {
      received.push({ buf: Buffer.from(msg), rinfo, at: process.hrtime.bigint() });
    });
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      resolve({
        sock,
        port: sock.address().port,
        received,
        close: () => new Promise((done) => sock.close(() => done())),
      });
    });
  });
}

function waitFor(predicate, timeoutMs = 2500, stepMs = 15) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, stepMs);
    };
    poll();
  });
}

function buildArtPollReplyFixture({
  ip = [127, 0, 0, 1],
  port = 6454,
  netSwitch = 0,
  subSwitch = 0,
  shortName = 'StageNode',
  longName = 'StageForge Test Art-Net Node',
  numPorts = 2,
  portTypes = [0x80, 0x80, 0x40, 0x00],
  swOut = [0, 1, 2, 3],
  length = 239,
} = {}) {
  const buf = Buffer.alloc(length);
  Buffer.from('Art-Net\0', 'ascii').copy(buf, 0);
  buf.writeUInt16LE(0x2100, 8);
  buf[10] = ip[0];
  buf[11] = ip[1];
  buf[12] = ip[2];
  buf[13] = ip[3];
  buf.writeUInt16LE(port, 14);
  buf[18] = netSwitch;
  buf[19] = subSwitch;
  buf.write(shortName, 26, 17, 'utf8');
  buf.write(longName, 44, 63, 'utf8');
  buf.writeUInt16BE(numPorts, 172);
  for (let i = 0; i < 4; i++) {
    buf[174 + i] = portTypes[i] ?? 0;
    buf[190 + i] = swOut[i] ?? 0;
  }
  buf[201] = 0xaa;
  buf[202] = 0xbb;
  buf[203] = 0xcc;
  buf[204] = 0xdd;
  buf[205] = 0xee;
  buf[206] = 0xff;
  if (length >= 211) {
    buf[207] = ip[0];
    buf[208] = ip[1];
    buf[209] = ip[2];
    buf[210] = ip[3];
  }
  if (length >= 212) buf[211] = 1;
  return buf;
}

test('E1.31 (sACN) packet encoding matches ANSI E1.31-2018 Root, Framing and DMP byte layout', () => {
  const cidUuid = '12345678-9abc-4def-8123-456789abcdef';
  const slots = new Uint8Array(512);
  slots[0] = 255;
  slots[1] = 128;
  slots[511] = 42;

  const buf = packets.encodeSacnPacket({
    cid: cidUuid,
    sourceName: 'StageForge Studio',
    universe: 0x0102, // 258
    slots,
    sequence: 0xab,
    priority: 150,
    options: packets.SACN_OPT_STREAM_TERMINATED,
  });

  // Total length = 126 header + 512 slots = 638 bytes.
  assert.equal(buf.length, 638);

  // Root Layer (bytes 0..37)
  assert.equal(buf.readUInt16BE(0), 0x0010, 'Preamble Size');
  assert.equal(buf.readUInt16BE(2), 0x0000, 'Post-amble Size');
  assert.deepEqual(
    [...buf.subarray(4, 16)],
    [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00],
    'ACN Packet Identifier ASC-E1.17\\0\\0\\0',
  );
  assert.equal(buf.readUInt16BE(16), 0x726e, 'Root Flags & Length (0x7000 | 622)');
  assert.equal(buf.readUInt32BE(18), 0x00000004, 'VECTOR_ROOT_E131_DATA');
  assert.equal(buf.subarray(22, 38).toString('hex'), '123456789abc4def8123456789abcdef', '16-byte CID');

  // Framing Layer (bytes 38..114)
  assert.equal(buf.readUInt16BE(38), 0x7258, 'Framing Flags & Length (0x7000 | 600)');
  assert.equal(buf.readUInt32BE(40), 0x00000002, 'VECTOR_E131_DATA_PACKET');
  assert.equal(buf.subarray(44, 61).toString('utf8'), 'StageForge Studio');
  assert.equal(buf[61], 0x00, 'Source Name NUL-terminated');
  assert.equal(buf[107], 0x00, 'Source Name byte 64 is NUL');
  assert.equal(buf[108], 150, 'Priority');
  assert.equal(buf.readUInt16BE(109), 0x0000, 'Sync Address');
  assert.equal(buf[111], 0xab, 'Sequence Number');
  assert.equal(buf[112], 0x40, 'Options Stream_Terminated');
  assert.equal(buf.readUInt16BE(113), 258, 'Universe BE');

  // DMP Layer (bytes 115..637)
  assert.equal(buf.readUInt16BE(115), 0x720b, 'DMP Flags & Length (0x7000 | 523)');
  assert.equal(buf[117], 0x02, 'VECTOR_DMP_SET_PROPERTY');
  assert.equal(buf[118], 0xa1, 'Address Type & Data Type');
  assert.equal(buf.readUInt16BE(119), 0x0000, 'First Property Address');
  assert.equal(buf.readUInt16BE(121), 0x0001, 'Address Increment');
  assert.equal(buf.readUInt16BE(123), 0x0201, 'Property Value Count = 513');
  assert.equal(buf[125], 0x00, 'DMX512 Start Code');
  assert.equal(buf[126], 255);
  assert.equal(buf[127], 128);
  assert.equal(buf[637], 42);

  // Round-trip decode and UTF-8 truncation at code-point boundary.
  const decoded = packets.decodeSacnPacket(buf);
  assert.ok(decoded);
  assert.equal(decoded.universe, 258);
  assert.equal(decoded.priority, 150);
  assert.equal(decoded.sequence, 0xab);
  assert.equal(decoded.options, 0x40);
  assert.equal(decoded.sourceName, 'StageForge Studio');
  assert.equal(decoded.slots[0], 255);
  assert.equal(decoded.slots[511], 42);

  // Multibyte UTF-8 source name truncates cleanly without splitting a code point.
  const longEmoji = '🎭'.repeat(20); // 80 UTF-8 bytes (4 bytes per emoji)
  const truncated = packets.truncateUtf8Bytes(longEmoji, 63);
  assert.equal(Buffer.byteLength(truncated, 'utf8'), 60);
  assert.equal([...truncated].length, 15);

  // Multicast IP mapping per E1.31 §9.3.1
  assert.equal(packets.sacnMulticastAddress(1), '239.255.0.1');
  assert.equal(packets.sacnMulticastAddress(256), '239.255.1.0');
  assert.equal(packets.sacnMulticastAddress(63999), '239.255.249.255');
  assert.throws(() => packets.sacnMulticastAddress(0));
  assert.throws(() => packets.sacnMulticastAddress(64000));

  // Malformed packets return null.
  assert.equal(packets.decodeSacnPacket(Buffer.alloc(100)), null);
  const bad = Buffer.from(buf);
  bad[118] = 0x00;
  assert.equal(packets.decodeSacnPacket(bad), null);
});

test('Art-Net 4 ArtDmx, ArtPoll and ArtPollReply match spec byte layouts', () => {
  const slots = new Uint8Array(512);
  slots[0] = 200;
  slots[15] = 77;
  slots[511] = 19;

  // Port-Address = (Net=0x12 << 8) | (SubNet=0x03 << 4) | (Uni=0x05) = 0x1235
  const dmxBuf = packets.encodeArtDmxPacket({
    portAddress: 0x1235,
    slots,
    sequence: 42,
    physical: 1,
  });

  assert.equal(dmxBuf.length, 530);
  assert.equal(dmxBuf.subarray(0, 8).toString('ascii'), 'Art-Net\0');
  assert.equal(dmxBuf[8], 0x00, 'OpCode LE low byte');
  assert.equal(dmxBuf[9], 0x50, 'OpCode LE high byte (0x5000)');
  assert.equal(dmxBuf.readUInt16BE(10), 14, 'ProtVer 14 BE');
  assert.equal(dmxBuf[12], 42, 'Sequence');
  assert.equal(dmxBuf[13], 1, 'Physical');
  assert.equal(dmxBuf[14], 0x35, 'SubUni = (SubNet<<4)|Universe');
  assert.equal(dmxBuf[15], 0x12, 'Net');
  assert.equal(dmxBuf.readUInt16BE(16), 512, 'Length BE');
  assert.equal(dmxBuf[18], 200);
  assert.equal(dmxBuf[33], 77);
  assert.equal(dmxBuf[529], 19);

  const decoded = packets.decodeArtDmxPacket(dmxBuf);
  assert.ok(decoded);
  assert.equal(decoded.portAddress, 0x1235);
  assert.equal(decoded.net, 0x12);
  assert.equal(decoded.subUni, 0x35);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.slots[511], 19);

  // Port-Address bounds & even length enforcement
  assert.throws(() => packets.encodeArtDmxPacket({ portAddress: -1, slots }));
  assert.throws(() => packets.encodeArtDmxPacket({ portAddress: 32768, slots }));
  assert.throws(() => packets.encodeArtDmxPacket({ portAddress: 0, slots: new Uint8Array(511) }));

  // ArtPoll 22-byte header
  const poll = packets.encodeArtPollPacket({ flags: 0x00, diagPriority: 0x00 });
  assert.equal(poll.length, 22);
  assert.equal(poll.subarray(0, 8).toString('ascii'), 'Art-Net\0');
  assert.equal(poll.readUInt16LE(8), 0x2000);
  assert.equal(poll.readUInt16BE(10), 14);

  // ArtPollReply (no ProtVer field!) defensive parsing for 239-byte and 207-byte replies
  const reply239 = buildArtPollReplyFixture({
    ip: [192, 168, 1, 50],
    netSwitch: 2,
    subSwitch: 3,
    shortName: 'QLC\x07Node',
    longName: 'QLC+ Art-Net Node\x00GarbageAfterNul',
    numPorts: 9, // > 4 must clamp to 4
    portTypes: [0x80, 0x40, 0x80, 0x00], // only indices 0 and 2 have output bit 7
    swOut: [1, 2, 5, 7],
  });
  const parsed = packets.parseArtPollReply(reply239);
  assert.ok(parsed);
  assert.equal(parsed.ip, '192.168.1.50');
  assert.equal(parsed.port, 6454);
  assert.equal(parsed.shortName, 'QLCNode');
  assert.equal(parsed.longName, 'QLC+ Art-Net Node');
  assert.deepEqual(parsed.outputs, [(2 << 8) | (3 << 4) | 1, (2 << 8) | (3 << 4) | 5]);
  assert.equal(parsed.mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(parsed.bindIndex, 1);

  const reply207 = buildArtPollReplyFixture({ length: 207, shortName: 'LegacyNode' });
  const parsed207 = packets.parseArtPollReply(reply207);
  assert.ok(parsed207);
  assert.equal(parsed207.shortName, 'LegacyNode');
  assert.equal(parsed207.bindIndex, 0);

  // Truncated and wrong-opcode replies return null
  assert.equal(packets.parseArtPollReply(Buffer.alloc(206)), null);
  assert.equal(packets.parseArtPollReply(dmxBuf), null);
});

test('Enttec DMX USB Pro framing and Web Serial transport send blackout on disable and handle disconnect', async () => {
  const slots = new Uint8Array(512);
  slots[0] = 0xfe;
  slots[511] = 0x11;
  const frame = enttec.encodeEnttecProFrame(slots);
  assert.equal(frame.length, 518);
  assert.equal(frame[0], 0x7e, 'Start of Message');
  assert.equal(frame[1], 0x06, 'Label 6 Output Only Send DMX');
  assert.equal(frame[2], 0x01, 'Length LSB (513 = 0x0201)');
  assert.equal(frame[3], 0x02, 'Length MSB');
  assert.equal(frame[4], 0x00, 'DMX Start Code');
  assert.equal(frame[5], 0xfe);
  assert.equal(frame[516], 0x11);
  assert.equal(frame[517], 0xe7, 'End of Message');

  const decoded = enttec.decodeEnttecProFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.label, 6);
  assert.equal(decoded.startCode, 0);
  assert.equal(decoded.slots.length, 512);
  assert.equal(decoded.slots[0], 0xfe);
  assert.equal(decoded.slots[511], 0x11);
  assert.throws(() => enttec.encodeEnttecProFrame(new Uint8Array(10)));

  // Mock Web Serial port to test lifecycle, blackout on disable, and disconnect handling.
  const written = [];
  let closed = false;
  let disconnectCb = null;
  const mockPort = {
    open: async () => {},
    close: async () => { closed = true; },
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
    addEventListener: (_type, cb) => { disconnectCb = cb; },
    removeEventListener: () => { disconnectCb = null; },
    writable: {
      getWriter: () => ({
        write: async (chunk) => { written.push(new Uint8Array(chunk)); },
        releaseLock: () => {},
      }),
    },
  };
  const statuses = [];
  const transport = new enttec.EnttecProTransport(
    (st) => statuses.push(st),
    () => ({ requestPort: async () => mockPort }),
  );
  assert.equal(transport.isRunning(), false);

  await transport.enable({ universe: 2, rateHz: 44 });
  assert.equal(transport.isRunning(), true);
  const liveSlots = new Uint8Array(512);
  liveSlots[0] = 240;
  transport.update(2, liveSlots);
  await waitFor(() => written.some((f) => enttec.decodeEnttecProFrame(f)?.slots[0] === 240), 1000);

  await transport.disable();
  assert.equal(transport.isRunning(), false);
  assert.equal(closed, true);
  const lastDecoded = enttec.decodeEnttecProFrame(written.at(-1));
  assert.ok(lastDecoded, 'final frame must decode cleanly');
  assert.ok(lastDecoded.slots.every((v) => v === 0), 'disable must send an all-zero blackout frame before closing');

  // Re-enable and simulate USB unplug disconnect event.
  closed = false;
  await transport.enable({ universe: 1, rateHz: 30 });
  assert.ok(disconnectCb);
  disconnectCb();
  assert.equal(transport.isRunning(), false, 'disconnect stops output immediately');
  assert.match(transport.getStatus().error || '', /disconnected/i);
  await waitFor(() => closed, 500);
  assert.equal(closed, true);
});

test('sACN UDP loopback streams both universes, persists CID, and sends zero blackout frames BEFORE Stream_Terminated', async () => {
  const receiver = await bindLoopbackReceiver();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sf-dmx-sacn-'));
  try {
    const cid1 = sender.loadOrCreateCid(tmpDir);
    const cid2 = sender.loadOrCreateCid(tmpDir);
    assert.equal(cid1.uuid, cid2.uuid, 'CID must persist across controller launches');

    const ctrl = sender.createDmxController({
      userDataDir: tmpDir,
      testPorts: { sacn: receiver.port },
      blackoutPaceMs: 24,
    });
    assert.equal(ctrl.isRunning(), false);
    assert.equal(ctrl.getStatus().enabled, false);

    // Must never send while disabled.
    const u1 = new Uint8Array(512);
    const u2 = new Uint8Array(512);
    u1[0] = 199;
    u2[10] = 88;
    assert.equal(ctrl.update(1, u1), false);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(receiver.received.length, 0);

    await ctrl.enable({
      protocol: 'sacn',
      iface: '127.0.0.1',
      rateHz: 40,
      sourceName: 'StageForge Loopback',
      sacn: { mode: 'unicast', universes: [1, 2], priority: 120, ttl: 1, targets: ['127.0.0.1'] },
    }, 7);

    assert.equal(ctrl.update(1, u1), true);
    assert.equal(ctrl.update(2, u2), true);

    await waitFor(() => {
      const dec = receiver.received.map((r) => packets.decodeSacnPacket(r.buf)).filter(Boolean);
      return dec.some((p) => p.universe === 1 && p.slots[0] === 199) &&
             dec.some((p) => p.universe === 2 && p.slots[10] === 88);
    });

    const countBeforeShutdown = receiver.received.length;
    await ctrl.shutdown('disable');
    assert.equal(ctrl.isRunning(), false);
    assert.equal(ctrl.getStatus().enabled, false);

    // Allow the OS loopback UDP receive queue to deliver the final sent datagrams.
    await waitFor(() => {
      const u1Tail = receiver.received
        .slice(countBeforeShutdown)
        .map((r) => packets.decodeSacnPacket(r.buf))
        .filter((p) => p && p.universe === 1);
      const termCount = u1Tail.filter((p) => (p.options & packets.SACN_OPT_STREAM_TERMINATED) !== 0).length;
      return termCount >= 3;
    }, 1000);

    const shutdownPackets = receiver.received
      .slice(countBeforeShutdown)
      .map((r) => packets.decodeSacnPacket(r.buf))
      .filter(Boolean);

    // Filter to Universe 1 to check exact ordering: 3 zero data frames BEFORE 3 Stream_Terminated frames.
    // Skip any in-flight live packet queued in the OS loopback buffer just before shutdown started.
    const u1AllTail = shutdownPackets.filter((p) => p.universe === 1);
    const firstZeroIndex = u1AllTail.findIndex((p) => p.slots.every((v) => v === 0));
    assert.ok(firstZeroIndex >= 0, 'shutdown must emit zero-slot blackout frames');
    const u1Shutdown = u1AllTail.slice(firstZeroIndex);
    assert.ok(u1Shutdown.length >= 6, `expected >= 6 U1 shutdown packets, got ${u1Shutdown.length}`);
    const firstTermIndex = u1Shutdown.findIndex((p) => (p.options & packets.SACN_OPT_STREAM_TERMINATED) !== 0);
    assert.ok(firstTermIndex >= 3, `expected at least 3 zero frames before Stream_Terminated (firstTermIndex=${firstTermIndex})`);
    const zeroFrames = u1Shutdown.slice(0, firstTermIndex);
    const termFrames = u1Shutdown.slice(firstTermIndex);
    assert.equal(termFrames.length, 3, 'must emit exactly 3 Stream_Terminated packets per universe');
    for (const p of zeroFrames) {
      assert.equal(p.options & packets.SACN_OPT_STREAM_TERMINATED, 0);
      assert.ok(p.slots.every((v) => v === 0), 'pre-terminate blackout frames must be all zeros');
    }
    for (const p of termFrames) {
      assert.equal(p.options & packets.SACN_OPT_STREAM_TERMINATED, packets.SACN_OPT_STREAM_TERMINATED);
      assert.ok(p.slots.every((v) => v === 0));
    }

    // Verify complete silence after shutdown.
    const countAfterShutdown = receiver.received.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(receiver.received.length, countAfterShutdown, 'no packets may be sent after shutdown');
  } finally {
    await receiver.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('Art-Net 4 UDP loopback streams ArtDmx (sequence never 0), blackouts on shutdown, and discovers nodes via ArtPoll', async () => {
  const receiver = await bindLoopbackReceiver();
  const mockNode = dgram.createSocket('udp4');
  let pollsSeen = 0;
  mockNode.on('message', (msg, rinfo) => {
    if (msg.length >= 14 && msg.subarray(0, 8).toString('ascii') === 'Art-Net\0' && msg.readUInt16LE(8) === 0x2000) {
      pollsSeen++;
      const reply = buildArtPollReplyFixture({
        ip: [127, 0, 0, 1],
        shortName: 'LoopbackNode',
        longName: 'StageForge Loopback Mock Node',
        netSwitch: 0,
        subSwitch: 0,
        numPorts: 2,
        portTypes: [0x80, 0x80, 0, 0],
        swOut: [0, 1, 0, 0],
      });
      mockNode.send(reply, rinfo.port, rinfo.address);
    }
  });
  await new Promise((resolve) => mockNode.bind(0, '127.0.0.1', resolve));
  const mockNodePort = mockNode.address().port;

  try {
    // 1. ArtPoll discovery loopback
    const discoveryCtrl = sender.createDmxController({
      testPorts: { artnet: mockNodePort, artnetDiscovery: 0 },
      discoverDurationMs: 250,
    });
    const discovery = await discoveryCtrl.discover('127.0.0.1');
    assert.ok(pollsSeen >= 1, 'ArtPoll must be transmitted');
    assert.equal(discovery.nodes.length, 1);
    assert.equal(discovery.nodes[0].shortName, 'LoopbackNode');
    assert.deepEqual(discovery.nodes[0].outputs, [0, 1]);

    // 2. ArtDmx streaming + blackout loopback
    const ctrl = sender.createDmxController({
      testPorts: { artnet: receiver.port },
      blackoutPaceMs: 24,
    });
    await ctrl.enable({
      protocol: 'artnet',
      iface: '127.0.0.1',
      rateHz: 40,
      artnet: { base: 4, targets: ['127.0.0.1'], broadcast: false },
    }, 9);

    const u1 = new Uint8Array(512);
    const u2 = new Uint8Array(512);
    u1[3] = 222;
    u2[7] = 111;
    ctrl.update(1, u1);
    ctrl.update(2, u2);

    await waitFor(() => {
      const dec = receiver.received.map((r) => packets.decodeArtDmxPacket(r.buf)).filter(Boolean);
      return dec.some((p) => p.portAddress === 4 && p.slots[3] === 222) &&
             dec.some((p) => p.portAddress === 5 && p.slots[7] === 111);
    });

    const beforeStop = receiver.received.length;
    await ctrl.shutdown('disable');
    await waitFor(() => {
      const zeroU1 = receiver.received
        .slice(beforeStop)
        .map((r) => packets.decodeArtDmxPacket(r.buf))
        .filter((p) => p && p.portAddress === 4 && p.slots.every((v) => v === 0));
      return zeroU1.length >= 3;
    }, 1000);

    const allDecoded = receiver.received.map((r) => packets.decodeArtDmxPacket(r.buf)).filter(Boolean);
    assert.ok(allDecoded.every((p) => p.sequence >= 1 && p.sequence <= 255), 'ArtDmx sequence must never be 0 while enabled');

    const stopU1All = receiver.received
      .slice(beforeStop)
      .map((r) => packets.decodeArtDmxPacket(r.buf))
      .filter((p) => p && p.portAddress === 4);
    const firstZeroIdx = stopU1All.findIndex((p) => p.slots.every((v) => v === 0));
    assert.ok(firstZeroIdx >= 0, 'Art-Net shutdown must emit zero frames');
    const stopU1 = stopU1All.slice(firstZeroIdx);
    assert.ok(stopU1.length >= 3, 'Art-Net shutdown must send at least 3 zero ticks');
    for (const p of stopU1) {
      assert.ok(p.slots.every((v) => v === 0), 'Art-Net blackout frames must be all zeros');
    }
  } finally {
    await receiver.close();
    await new Promise((resolve) => mockNode.close(() => resolve()));
  }
});

test('DMX controller enforces hard 44 Hz inter-frame ceiling and validates config strictly', async () => {
  const receiver = await bindLoopbackReceiver();
  let fakeNowNs = 1_000_000_000n;
  try {
    const ctrl = sender.createDmxController({
      testPorts: { sacn: receiver.port },
      nowNs: () => fakeNowNs,
    });
    await ctrl.enable({
      protocol: 'sacn',
      iface: '127.0.0.1',
      rateHz: 44,
      sacn: { mode: 'unicast', universes: [1, 2], priority: 100, ttl: 1, targets: ['127.0.0.1'] },
    }, 1);

    // enable() sent initial tick at fakeNowNs = 1_000_000_000n.
    // Advancing only 22.0 ms (< 22.727273 ms) MUST be refused by the hard 44 Hz guard.
    fakeNowNs += 22_000_000n;
    assert.equal(await ctrl._sendTickForTest(), false, 'must refuse frame faster than 44 Hz');

    // Advancing past 22_727_273 ns MUST succeed.
    fakeNowNs += 727_273n;
    assert.equal(await ctrl._sendTickForTest(), true, 'must allow frame at exact 44 Hz boundary');

    await ctrl.shutdown('disable');

    // Config validation rejects invalid rates, unknown keys, bad interfaces, multicast unicast targets, etc.
    const ifaces = ctrl.listInterfaces();
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'sacn', iface: '127.0.0.1', rateHz: 45,
      sacn: { mode: 'multicast', universes: [1, 2], priority: 100, ttl: 1, targets: [] },
    }, ifaces), /1 and 44 Hz/);
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'sacn', iface: '127.0.0.1', rateHz: 40, extraKey: true,
      sacn: { mode: 'multicast', universes: [1, 2], priority: 100, ttl: 1, targets: [] },
    }, ifaces), /Unknown DMX config option/);
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'sacn', iface: '198.51.100.99', rateHz: 40,
      sacn: { mode: 'multicast', universes: [1, 2], priority: 100, ttl: 1, targets: [] },
    }, ifaces), /not available/);
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'sacn', iface: '127.0.0.1', rateHz: 40,
      sacn: { mode: 'multicast', universes: [5, 5], priority: 100, ttl: 1, targets: [] },
    }, ifaces), /distinct/);
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'artnet', iface: '127.0.0.1', rateHz: 40,
      artnet: { base: 0, targets: [], broadcast: true },
    }, ifaces), /loopback/);
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'artnet', iface: '127.0.0.1', rateHz: 40,
      artnet: { base: 0, targets: ['239.255.0.1'], broadcast: false },
    }, ifaces), /Invalid Art-Net unicast target/);
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'artnet', iface: '127.0.0.1', rateHz: 40,
      artnet: { base: 0, targets: ['0.0.0.0'], broadcast: false },
    }, ifaces), /Invalid Art-Net unicast target/);

    // Helper checks in src/dmx/liveDmx.ts
    assert.deepEqual(liveDmx.parseTargetList('127.0.0.1, 10.0.0.2; 10.0.0.3'), ['127.0.0.1', '10.0.0.2', '10.0.0.3']);
    assert.equal(liveDmx.formatArtNetAddress(0), '0 (Net 0 · Sub 0 · Uni 0)');
    assert.equal(liveDmx.formatArtNetAddress(0x0123), '291 (Net 1 · Sub 2 · Uni 3)');

    // M6 & L3: ArtPollReply ignores spoofed reportedIp in favour of rinfo, and validateTargets rejects broadcast/reserved/cross-scope IPs.
    const spoofedReply = buildArtPollReplyFixture({ ip: [8, 8, 8, 8], shortName: 'Rogue' });
    const parsedFromRinfo = packets.parseArtPollReply(spoofedReply, '127.0.0.1');
    assert.ok(parsedFromRinfo);
    assert.equal(parsedFromRinfo.ip, '127.0.0.1', 'must trust rinfo.address over self-reported IP');

    const lanIfaces = [
      { name: 'Ethernet', address: '192.168.1.10', netmask: '255.255.255.0', broadcast: '192.168.1.255', internal: false },
      { name: 'Loopback', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: null, internal: true },
    ];
    for (const badTarget of ['0.1.2.3', '255.255.255.255', '240.0.0.1', '127.0.0.2', '192.168.1.255']) {
      assert.throws(() => sender.validateDmxConfig({
        protocol: 'artnet', iface: '192.168.1.10', rateHz: 40,
        artnet: { base: 0, targets: [badTarget], broadcast: false },
      }, lanIfaces), /Invalid Art-Net unicast target/);
    }
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'sacn', iface: '127.0.0.1', rateHz: 40,
      sacn: { mode: 'unicast', universes: [1, 2], priority: 100, ttl: 1, targets: ['192.168.1.50'] },
    }, lanIfaces), /loopback interface/);
    assert.throws(() => sender.validateDmxConfig({
      protocol: 'artnet', iface: '192.168.1.10', rateHz: 40,
      artnet: { base: 0, targets: Array.from({ length: 9 }, (_, i) => `192.168.1.${i + 20}`), broadcast: false },
    }, lanIfaces), /At most 8/);

    // L9: default settings use safe loopback unicast and corrupt localStorage never enables output.
    const defs = liveDmx.defaultDmxOutputSettings(true);
    assert.equal(defs.iface, '127.0.0.1');
    assert.equal(defs.sacnMode, 'unicast');
    assert.equal('enabled' in defs, false);
  } finally {
    await receiver.close();
  }
});

function createMockDgram({ bindDelayMs = 0, manualBindOn = [], stallSendOnIndex = -1, failFirstSends = 0 } = {}) {
  const sockets = [];
  return {
    sockets,
    createSocket() {
      const idx = sockets.length;
      const listeners = new Map();
      const sent = [];
      let closed = false;
      let sendCount = 0;
      const emit = (ev, ...args) => {
        for (const fn of [...(listeners.get(ev) || [])]) fn(...args);
      };
      const sock = {
        idx,
        sent,
        get closed() { return closed; },
        on(ev, fn) {
          if (!listeners.has(ev)) listeners.set(ev, new Set());
          listeners.get(ev).add(fn);
        },
        once(ev, fn) {
          const wrap = (...args) => { sock.off(ev, wrap); fn(...args); };
          sock.on(ev, wrap);
        },
        off(ev, fn) { listeners.get(ev)?.delete(fn); },
        bind(_opts) {
          if (!manualBindOn.includes(idx)) setTimeout(sock.finishBind, bindDelayMs);
        },
        finishBind() { emit('listening'); },
        setMulticastTTL() {},
        setMulticastInterface() {},
        setBroadcast() {},
        send(packet, port, host, cb) {
          sendCount++;
          sent.push({ packet: Buffer.from(packet), port, host });
          if (idx === stallSendOnIndex) return; // intentionally never invoke cb
          if (idx === 0 && sendCount <= failFirstSends) {
            setImmediate(() => cb?.(Object.assign(new Error('host unreachable'), { code: 'EHOSTUNREACH' })));
            return;
          }
          setImmediate(() => cb?.(null));
        },
        close(cb) {
          closed = true;
          setImmediate(() => cb?.());
        },
      };
      sockets.push(sock);
      return sock;
    },
  };
}

test('QA regressions: mid-bind shutdown (H1), concurrent enable (H2), blackout timeout isolation (M1), degraded recovery (L1) and real-timer 44 Hz ceiling (M7)', async () => {
  const sacnCfg = {
    protocol: 'sacn',
    iface: '127.0.0.1',
    rateHz: 40,
    sacn: { mode: 'unicast', universes: [1, 2], priority: 100, ttl: 1, targets: ['127.0.0.1'] },
  };

  // H1: shutdown called mid-bind cancels startup, closes socket, and leaves controller idle.
  {
    const mockDgram = createMockDgram({ bindDelayMs: 50 });
    const ctrl = sender.createDmxController({ dgramModule: mockDgram });
    const enablePromise = ctrl.enable(sacnCfg, 10);
    assert.equal(ctrl.ownerId, 10, 'ownerId must be reserved before bind completes');
    assert.equal(ctrl.active, true);
    await ctrl.shutdown('navigation');
    await assert.rejects(() => enablePromise, /cancelled/);
    assert.equal(ctrl.isRunning(), false);
    assert.equal(ctrl.ownerId, null);
    assert.equal(mockDgram.sockets.length, 1);
    assert.equal(mockDgram.sockets[0].closed, true, 'cancelled bind socket must be closed');
    assert.equal(mockDgram.sockets[0].sent.length, 0, 'cancelled session must send zero packets');
  }

  // H2 & Pass 2 M1: concurrent enable rejects cleanly, and invalid reconfigure while running NEVER blacks out the live show.
  {
    const mockDgram = createMockDgram({ bindDelayMs: 40 });
    const ctrl = sender.createDmxController({ dgramModule: mockDgram });
    const first = ctrl.enable(sacnCfg, 1);
    const second = ctrl.enable(sacnCfg, 1);
    await assert.rejects(() => second, /already starting/);
    await first;
    assert.equal(mockDgram.sockets.length, 1);

    // Invalid reconfigure while running must throw without shutting down the live session.
    await assert.rejects(() => ctrl.enable({
      ...sacnCfg,
      sacn: { ...sacnCfg.sacn, targets: [] },
    }, 1), /at least one unicast/);
    assert.equal(ctrl.isRunning(), true, 'live show must stay running after invalid reconfigure');
    assert.equal(mockDgram.sockets[0].closed, false);

    await ctrl.shutdown('disable');
    assert.equal(mockDgram.sockets[0].closed, true);
  }

  // M1: timed-out blackout on socket 0 MUST NEVER send zero or Stream_Terminated frames on socket 1.
  {
    const mockDgram = createMockDgram({ bindDelayMs: 0, stallSendOnIndex: 0 });
    const ctrl = sender.createDmxController({
      dgramModule: mockDgram,
      shutdownTimeoutMs: 50,
      blackoutPaceMs: 25,
    });
    await ctrl.enable(sacnCfg, 1);
    await ctrl.shutdown('disable');
    assert.equal(mockDgram.sockets[0].closed, true);

    await ctrl.enable(sacnCfg, 1);
    await new Promise((r) => setTimeout(r, 140));
    const sock1Decoded = mockDgram.sockets[1].sent.map((item) => packets.decodeSacnPacket(item.packet)).filter(Boolean);
    assert.ok(sock1Decoded.length >= 2, 'new session must stream packets on socket 1');
    assert.equal(
      sock1Decoded.some((p) => (p.options & packets.SACN_OPT_STREAM_TERMINATED) !== 0),
      false,
      'stale timed-out blackout must NEVER send Stream_Terminated on the new session socket',
    );
    await ctrl.shutdown('disable');
  }

  // L1: transient UDP send error marks degraded and clears automatically after 10 consecutive successes.
  {
    const mockDgram = createMockDgram({ bindDelayMs: 0, failFirstSends: 1 });
    let fakeNs = 1_000_000_000n;
    const ctrl = sender.createDmxController({ dgramModule: mockDgram, nowNs: () => fakeNs });
    await ctrl.enable(sacnCfg, 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(ctrl.getStatus().degraded, true, 'first send error sets degraded');
    for (let i = 0; i < 6; i++) {
      fakeNs += 25_000_000n;
      await ctrl._sendTickForTest();
    }
    assert.equal(ctrl.getStatus().degraded, false, 'degraded must clear after consecutive successful sends');
    assert.equal(ctrl.getStatus().lastError, null);
    await ctrl.shutdown('disable');
  }

  // M7: real-timer 44 Hz run never emits two consecutive U1 ticks closer than 22.727 ms.
  {
    const receiver = await bindLoopbackReceiver();
    try {
      const ctrl = sender.createDmxController({ testPorts: { sacn: receiver.port } });
      await ctrl.enable({ ...sacnCfg, rateHz: 44 }, 1);
      await new Promise((r) => setTimeout(r, 420));
      await ctrl.shutdown('disable');
      const u1Times = receiver.received
        .filter((item) => {
          const dec = packets.decodeSacnPacket(item.buf);
          return dec && dec.universe === 1 && (dec.options & packets.SACN_OPT_STREAM_TERMINATED) === 0;
        })
        .map((item) => item.at);
      assert.ok(u1Times.length >= 6, `expected sustained frames at 44 Hz, got ${u1Times.length}`);
      // Exclude the final 3 blackout ticks from live-loop spacing check.
      const liveTimes = u1Times.slice(0, Math.max(2, u1Times.length - 3));
      const elapsedSec = Number(liveTimes.at(-1) - liveTimes[0]) / 1e9;
      if (elapsedSec > 0.05) {
        const avgHz = (liveTimes.length - 1) / elapsedSec;
        assert.ok(avgHz <= 44.5, `measured average rate ${avgHz.toFixed(2)} Hz must not exceed 44 Hz ceiling`);
      }
    } finally {
      await receiver.close();
    }
  }
});

test('P2 authenticated Arm and Go bind the current window, configuration and eligibility generation before UDP sends', async (t) => {
  const manualBindOn = [1, 3];
  const mockDgram = createMockDgram({ manualBindOn });
  const statuses = [];
  const controller = sender.createDmxController({
    dgramModule: mockDgram, discoverDurationMs: 2, testPorts: { artnetDiscovery: 0 },
    onStatus(status, owner) {
      statuses.push(status);
      if (status.state === 'idle' && status.lastStopReason && status.authority) interlock.invalidateDmxEligibility(owner, status.authority);
    },
  });
  t.after(async () => {
    const stopped = controller.shutdown('test-end');
    for (const index of manualBindOn) mockDgram.sockets[index]?.finishBind();
    await stopped;
  });
  const interlock = createOutputInterlock({ requireDmxAuthority: true, isDmxActive: () => controller.active });
  const { onControl, onEligibility, onFrame, onHeartbeat } = createDmxIpcHandlers(() => controller, { interlock, requireArmedClaim: true });
  const { onOutputClaim } = createAiBridgeIpcHandlers(() => null, () => interlock);
  const testWindow = id => {
    const frame = { url: 'stageforge://app/' };
    return { senderFrame: frame, sender: { id, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url } };
  };
  const win = testWindow(4);
  const other = testWindow(8);
  const authority = (generation, revision = 'config-a') => ({ revision, generation });
  const eligible = (window, token, allowed) => onEligibility(window, { authority: token, eligible: allowed });
  const arm = (window, token) => onOutputClaim(window, { type: 'claim', kind: 'armed', authority: token });
  const release = token => onOutputClaim(win, { type: 'release', kind: 'armed', authority: token });
  const go = (window, token) => onControl(window, { type: 'enable', authority: token, config: {
    protocol: 'sacn', iface: '127.0.0.1', rateHz: 30,
    sacn: { mode: 'unicast', universes: [3, 4], priority: 100, ttl: 1, targets: ['127.0.0.1'] },
  } });

  const a = authority(1);
  assert.equal((await arm(win, a)).ok, false);
  assert.equal(eligible(win, a, true), true);
  assert.equal((await arm(other, a)).ok, false);
  assert.equal((await arm(win, authority(1, 'wrong config'))).ok, false);
  await assert.rejects(go(win, a), /current pre-flight revision/);
  assert.equal((await arm(win, a)).ok, true);
  await assert.rejects(go(other, a), /current pre-flight revision/);
  const scanA = onControl(win, { type: 'discover', iface: '127.0.0.1' });
  const pending = go(win, a);
  void pending.catch(() => {}); // Teardown can cancel this bind if an earlier assertion fails.
  assert.equal(controller.ownerId, 4);
  await scanA;
  assert.equal(statuses.at(-1).state, 'starting', 'the first Art-Net scan can complete while Go is still binding');
  assert.deepEqual(statuses.at(-1).authority, a);
  assert.equal(interlock.isCurrentDmxAuthority(4, a), true);
  assert.equal(mockDgram.sockets[1].sent.length, 0);
  const fence = authority(2);
  assert.equal(eligible(win, fence, false), true);
  assert.equal(eligible(win, fence, true), false, 'same-revision restoration must advance generation');
  assert.equal(eligible(win, a, true), false, 'old affirmative update cannot undo revocation');
  assert.equal(statuses.at(-1).state, 'stopping');
  assert.equal(controller.active, true, 'the canceled native bind still owns output until its socket closes');
  mockDgram.sockets[1].finishBind();
  await assert.rejects(pending, /cancelled|changed/);
  assert.equal(statuses.at(-1).state, 'idle');
  assert.equal(statuses.at(-1).lastStopReason, 'eligibility-changed');
  assert.equal(mockDgram.sockets[1].sent.length, 0);
  assert.equal(mockDgram.sockets[1].closed, true);

  const b = authority(3);
  assert.equal(eligible(win, b, true), true);
  assert.equal((await arm(win, b)).ok, true);
  await release(a);
  const scanB = onControl(win, { type: 'discover', iface: '127.0.0.1' });
  const startingB = go(win, b);
  void startingB.catch(() => {});
  await release(b); // Go consumed the arm. This UI release cannot cancel the accepted lease.
  await scanB;
  const binding = await onControl(win, { type: 'getStatus' });
  assert.equal(statuses.at(-1).state, 'starting', 'a fresh attempt also survives discovery after the previous stop');
  assert.equal(binding.state, 'starting');
  assert.equal(binding.lastStopReason, null);
  assert.equal(binding.lastStopOwnerId, null);
  assert.deepEqual(binding.authority, b);
  assert.equal(interlock.isCurrentDmxAuthority(4, b), true);
  assert.equal(mockDgram.sockets[3].sent.length, 0);
  mockDgram.sockets[3].finishBind();
  const running = await startingB;
  assert.deepEqual(running.authority, b);
  assert.ok(statuses.some(status => status.state === 'running' && status.authority.generation === b.generation));
  assert.equal(controller.isRunning(), true);
  assert.ok(mockDgram.sockets[3].sent.length > 0, 'logical U1 mapped to wire U3 starts the normal mock sender');
  const slots = new Uint8Array(512).fill(128);
  assert.equal(onFrame(win, 1, slots, a), false);
  assert.equal(onHeartbeat(win, a), false);
  assert.equal(onFrame(other, 1, slots, b), false);
  assert.equal(onHeartbeat(other, b), false);
  assert.equal(onFrame(win, 1, slots, b), true);
  assert.equal(onHeartbeat(win, b), true);
  await onControl(win, { type: 'disable' });
  assert.equal((await arm(win, b)).ok, false, 'Stop invalidates the old eligibility even after physical shutdown');

  const c = authority(4, 'config-c');
  assert.equal(eligible(win, c, true), true);
  assert.equal((await arm(win, c)).ok, true);
  const serial = token => onOutputClaim(win, { type: 'claim', kind: 'serial', authority: token });
  assert.equal((await serial(b)).ok, false);
  assert.equal((await serial(c)).ok, true);
  assert.deepEqual(interlock.currentSerialAuthority(4), c);
  assert.equal(interlock.currentSerialAuthority(8), null);
  assert.equal(eligible(win, authority(5, 'config-c'), false), true);
  assert.equal(interlock.currentSerialAuthority(4), null);
  assert.match(interlock.canEnableBridge(), /Disconnect Enttec/);
  const sibling = authority(1, 'config-sibling');
  assert.equal(eligible(other, sibling, true), true);
  assert.equal((await arm(other, sibling)).ok, true);
  assert.equal((await onOutputClaim(other, { type: 'claim', kind: 'serial', authority: sibling })).ok, false);
  await onOutputClaim(win, { type: 'release', kind: 'serial', authority: c });
  assert.equal((await onOutputClaim(other, { type: 'claim', kind: 'serial', authority: sibling })).ok, true);
  await onOutputClaim(win, { type: 'release', kind: 'serial', authority: c });
  assert.deepEqual(interlock.currentSerialAuthority(8), sibling);
});

test('P2 Enttec rejects canceled eligibility before the chooser, after the chooser, and after pending port open', async (t) => {
  let current = false;
  let chooserCalls = 0;
  let opens = 0;
  let closes = 0;
  let writes = 0;
  let choose;
  let open;
  let deferOpen = false;
  const port = {
    writable: new WritableStream({ write: () => { writes++; } }),
    open: () => { opens++; return deferOpen ? new Promise(resolve => { open = resolve; }) : Promise.resolve(); },
    close: async () => { closes++; },
  };
  const transport = new enttec.EnttecProTransport(() => {}, () => ({ requestPort() {
    chooserCalls++;
    return new Promise(resolve => { choose = resolve; });
  } }));
  t.after(() => transport.disable());
  const enable = () => transport.enable({ universe: 2, rateHz: 30, isEligible: () => current });
  await assert.rejects(enable(), /cancelled/);
  assert.equal(chooserCalls, 0);
  current = true;
  const chooser = enable();
  current = false;
  choose(port);
  await assert.rejects(chooser, /cancelled/);
  assert.equal(opens, 0);

  current = true;
  deferOpen = true;
  const opening = enable();
  choose(port);
  await waitFor(() => opens === 1);
  current = false;
  open();
  await assert.rejects(opening, /cancelled/);
  assert.equal(closes, 1);
  assert.equal(writes, 0);
  assert.equal(transport.isRunning(), false);

  current = true;
  deferOpen = false;
  const fresh = enable();
  choose(port);
  assert.equal((await fresh).universe, 2);
  await waitFor(() => writes > 0);
  await transport.disable();
  assert.equal(closes, 2);
});

test('P2 USB Stop, pagehide and Viewer share terminal blackout and close before another window can claim output', async (t) => {
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const zeroStarted = deferred();
  const allowZero = deferred();
  const closeStarted = deferred();
  const allowClose = deferred();
  const frames = [];
  let draining = false;
  let closes = 0;
  const port = {
    writable: new WritableStream({
      write(frame) {
        const dark = !frame.slice(5, 517).some(Boolean);
        frames.push(dark);
        if (draining && dark) {
          zeroStarted.resolve();
          return allowZero.promise;
        }
      },
    }),
    open: async () => {},
    close() {
      closes++;
      closeStarted.resolve();
      return allowClose.promise;
    },
  };
  const transport = new enttec.EnttecProTransport(() => {}, () => ({ requestPort: async () => port }));
  t.after(async () => {
    allowZero.resolve();
    allowClose.resolve();
    await transport.disable();
  });
  await transport.enable({ universe: 1, rateHz: 30 });
  transport.update(1, new Uint8Array(512).fill(42));
  await waitFor(() => frames.includes(false));

  const interlock = createOutputInterlock({ requireDmxAuthority: true });
  const owner = 14;
  const sibling = 15;
  const owned = { revision: 'usb-owner', generation: 1 };
  const competing = { revision: 'usb-sibling', generation: 1 };
  const reserveArm = (wcId, authority) => {
    assert.equal(interlock.updateDmxEligibility(wcId, authority, true).ok, true);
    assert.equal(interlock.claimOutput(wcId, 'armed', authority).ok, true);
  };
  const claimSibling = () => interlock.claimOutput(sibling, 'serial', competing).ok;
  reserveArm(owner, owned);
  reserveArm(sibling, competing);
  assert.equal(interlock.claimOutput(owner, 'serial', owned).ok, true);

  let releases = 0;
  const releaseAfter = drain => drain.then(() => {
    if (interlock.releaseOutput(owner, 'serial', owned)) releases++;
  });
  const tracker = createViewerModeTracker();
  let viewerDrain;
  const enterViewer = createViewerIpcHandler({
    tracker,
    onEnterViewer: wcId => {
      interlock.revokeWindowDmxEligibility(wcId, (notifiedOwner, authority) => {
        assert.equal(notifiedOwner, owner);
        assert.deepEqual(authority, owned);
        viewerDrain = releaseAfter(transport.disable());
      });
    },
  });
  const frame = { url: 'stageforge://app/' };
  const event = { senderFrame: frame, sender: { id: owner, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url } };

  draining = true;
  const first = transport.disable();
  const stop = releaseAfter(first);
  assert.equal(transport.isRunning(), false, 'Stop detaches serial updates synchronously');
  await zeroStarted.promise;
  assert.deepEqual(await enterViewer(event, true), { viewer: true });
  assert.equal(tracker.isViewerWindow(owner), true);
  transport.emergencyBlackoutBestEffort();
  const joined = transport.disable();
  assert.equal(joined, first, 'duplicate Stop and pagehide join the captured drain');
  const repeatedStop = releaseAfter(joined);
  await Promise.resolve();
  assert.deepEqual(interlock.currentSerialAuthority(owner), null, 'Viewer rejects current chooser permission');
  assert.equal(claimSibling(), false, 'terminal zero has not been delivered yet');
  assert.equal(releases, 0);
  assert.match(interlock.canEnableBridge(), /Disconnect Enttec/);

  allowZero.resolve();
  await closeStarted.promise;
  assert.equal(claimSibling(), false, 'terminal port close is still pending');
  assert.equal(releases, 0);
  allowClose.resolve();
  await Promise.all([stop, viewerDrain, repeatedStop]);
  assert.equal(releases, 1);
  assert.equal(closes, 1);
  assert.deepEqual(frames.slice(frames.lastIndexOf(false) + 1), [true], 'the single terminal packet is black');
  assert.equal(claimSibling(), true);
  assert.equal(interlock.releaseOutput(owner, 'serial', owned), false, 'a late release cannot clear the sibling claim');
  assert.deepEqual(interlock.currentSerialAuthority(sibling), competing);
  interlock.clearWindowClaims(sibling);
  assert.equal(interlock.hasOutputAuthority(), false, 'destroyed windows release their last reservation');
});

test('Enttec Pro aborts a stalled writer and keeps Stop pending through native close', async () => {
  let aborted = false;
  let released = false;
  let finishClose;
  let beginClose;
  const closing = new Promise(resolve => { beginClose = resolve; });
  const statuses = [];
  const stalledPort = {
    open: async () => {},
    close: () => new Promise(resolve => { finishClose = resolve; beginClose(); }),
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
    writable: {
      getWriter: () => ({
        write: () => new Promise(() => {}), // hangs forever
        abort: async () => { aborted = true; },
        releaseLock: () => { released = true; },
      }),
    },
  };
  const transport = new enttec.EnttecProTransport(
    (st) => statuses.push(st),
    () => ({ requestPort: async () => stalledPort }),
  );
  await transport.enable({ universe: 1, rateHz: 30 });
  const start = Date.now();
  const drain = transport.disable();
  let stopped = false;
  void drain.then(() => { stopped = true; });
  await closing;
  assert.equal(stopped, false, 'an unfinished native close keeps the reservation');
  assert.equal(transport.disable(), drain);
  finishClose();
  const finalStatus = await drain;
  const elapsed = Date.now() - start;
  assert.equal(finalStatus.enabled, false);
  assert.equal(aborted, true, 'must abort stalled writer on blackout timeout');
  assert.equal(released, true, 'must release writer lock');
  assert.equal(statuses.at(-1)?.enabled, false, 'must emit disabled status in finally');
  assert.ok(elapsed < 2200, `disable() must finish within timeout bounds (took ${elapsed} ms)`);
});

test('cancelled Enttec native open never gets a writer and keeps the desktop claim through close', async () => {
  let beginOpen, finishOpen, beginClose, finishClose;
  const opening = new Promise(resolve => { beginOpen = resolve; });
  const closing = new Promise(resolve => { beginClose = resolve; });
  const port = {
    open: () => new Promise(resolve => { finishOpen = resolve; beginOpen(); }),
    close: () => new Promise(resolve => { finishClose = resolve; beginClose(); }),
    writable: { getWriter() { assert.fail('cancelled startup must not acquire a writer'); } },
  };
  const transport = new enttec.EnttecProTransport(() => {}, () => ({ requestPort: async () => port }));
  const lock = createOutputInterlock({ requireDmxAuthority: true });
  const key = { revision: 'usb-before-preview', generation: 1 };
  assert.equal(lock.updateDmxEligibility(8, key, true).ok, true);
  assert.equal(lock.claimOutput(8, 'armed', key).ok, true);
  assert.equal(lock.claimOutput(8, 'serial', key).ok, true);
  const unavailable = assert.rejects(transport.enable({ universe: 1, rateHz: 30 }), /startup was cancelled/);
  await opening;
  lock.invalidateDmxEligibility(8, key);
  const stop = transport.disable();
  assert.equal(transport.disable(), stop);
  const released = stop.then(() => lock.releaseOutput(8, 'serial', key));
  assert.throws(() => lock.reservePreview(9), /USB cleanup/);
  finishOpen();
  await closing;
  assert.throws(() => lock.reservePreview(9), /USB cleanup/);
  assert.match(lock.canEnableBridge(), /USB Serial/);
  finishClose();
  assert.equal(await released, true);
  await unavailable;
  const preview = lock.reservePreview(9);
  assert.equal(lock.claimOutput(8, 'serial', key).ok, false);
  lock.releasePreview(preview);
});

test('Enttec does not close a port it failed to open', async () => {
  const port = {
    open: async () => { throw new Error('Port is already open'); },
    close: async () => { assert.fail('this attempt did not open the port'); },
    writable: { getWriter() { assert.fail('failed startup must not acquire a writer'); } },
  };
  const transport = new enttec.EnttecProTransport(() => {}, () => ({ requestPort: async () => port }));
  await assert.rejects(transport.enable({ universe: 1, rateHz: 30 }), /Port is already open/);
  await transport.disable();
});
