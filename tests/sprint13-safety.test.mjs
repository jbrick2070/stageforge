import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const packets = require('../desktop/dmx-packets.cjs');
const sender = require('../desktop/dmx-sender.cjs');
const dmxIpc = require('../desktop/dmx-ipc.cjs');
const showControlSvc = require('../desktop/show-control-service.cjs');
const oscPackets = require('../desktop/osc-packets.cjs');

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const physicalDmx = await compiler.ssrLoadModule('/src/dmx/physicalDmx.ts');
const laserAim = await compiler.ssrLoadModule('/src/data/laserAim.ts');
const catalog = await compiler.ssrLoadModule('/src/data/equipmentCatalog.ts');
const presets = await compiler.ssrLoadModule('/src/data/presets.ts');
const bumpMod = await compiler.ssrLoadModule('/src/input/bumpLedger.ts');
const enttec = await compiler.ssrLoadModule('/src/dmx/enttecPro.ts');
const timelineMod = await compiler.ssrLoadModule('/src/input/useShowTimeline.ts');
const showFileMod = await compiler.ssrLoadModule('/src/data/showFile.ts');
const showClockMod = await compiler.ssrLoadModule('/src/data/showClock.ts');
const cueLookMod = await compiler.ssrLoadModule('/src/data/cueLook.ts');
const clockOwner = await compiler.ssrLoadModule('/src/showControl/clockOwner.ts');
const tempoMod = await compiler.ssrLoadModule('/src/audio/tempoEngine.ts');
const audioMod = await compiler.ssrLoadModule('/src/engine/audioModulation.ts');

function createMockDgram() {
  const sockets = [];
  return {
    sockets,
    createSocket() {
      const listeners = new Map();
      const sent = [];
      let closed = false;
      const emit = (ev, ...args) => {
        for (const fn of [...(listeners.get(ev) || [])]) fn(...args);
      };
      const sock = {
        sent,
        emit,
        get closed() { return closed; },
        address: () => ({ address: '127.0.0.1', port: 8000, family: 'IPv4' }),
        on(ev, fn) {
          if (!listeners.has(ev)) listeners.set(ev, new Set());
          listeners.get(ev).add(fn);
        },
        once(ev, fn) {
          const wrap = (...args) => { sock.off(ev, wrap); fn(...args); };
          sock.on(ev, wrap);
        },
        off(ev, fn) { listeners.get(ev)?.delete(fn); },
        bind(_opts) { setImmediate(() => emit('listening')); },
        setMulticastTTL() {},
        setMulticastInterface() {},
        setBroadcast() {},
        send(packet, port, host, cb) {
          sent.push({ packet: Buffer.from(packet), port, host });
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

// ---------------------------------------------------------------------------
// H1: Physical DMX personality golden bytes & safe simulation-only zeros
// ---------------------------------------------------------------------------
test('H1: golden bytes for every implemented physical personality, one-channel PAR blackout = 0 (not 128), and simulation-only zeros', () => {
  const mkPod = (id, fixtures) => ({
    id,
    name: id,
    shape: 'box',
    x: 0,
    z: 0,
    baseY: 6,
    width: 6,
    depth: 1,
    rotationY: 0,
    motorized: false,
    motorMinY: 4,
    motorMaxY: 8,
    fixtures,
  });

  // Rig combining:
  // 1) ETC ColorSource PAR 1-Ch (U1.001)
  // 2) ETC ColorSource PAR RGB 3-Ch (U1.002..004)
  // 3) ETC ColorSource PAR 5-Ch Default (U1.005..009)
  // 4) CHAUVET STRIKE 4 1-Ch (U1.010)
  // 5) CHAUVET STRIKE 4 4-Ch (U1.011..014)
  // 6) Unimplemented catalogue moving head: Claypaky Sharpy Standard 16-Ch (U1.015..030)
  // 7) Unimplemented catalogue laser: KVANT Clubmax FB4 16-Ch (U1.031..046)
  // 8) Generic non-catalogue beam 8-Ch (U1.047..054)
  // 9) Floor Martin JEM ZR45 1-Ch (U2.001)
  // 10) Floor MagicFX CO2Jet II 1-Ch (U2.002 — unimplemented external switchpack -> neutral 0)
  const rig = {
    ...structuredClone(presets.RIG_TEMPLATES.club_intimate),
    trussPods: [
      mkPod('pod-test', [
        { id: 'par-1ch', type: 'wash', modelName: 'ETC ColorSource PAR', catalogId: 'etc-colorsource-par', dmxMode: '1-Ch', dmxChannels: 1, count: 1, dmxUniverse: 1, dmxStartChannel: 1 },
        { id: 'par-rgb', type: 'wash', modelName: 'ETC ColorSource PAR', catalogId: 'etc-colorsource-par', dmxMode: 'RGB (3-Ch)', dmxChannels: 3, count: 1, dmxUniverse: 1, dmxStartChannel: 2 },
        { id: 'par-5ch', type: 'wash', modelName: 'ETC ColorSource PAR', catalogId: 'etc-colorsource-par', dmxMode: '5-Ch (Default)', dmxChannels: 5, count: 1, dmxUniverse: 1, dmxStartChannel: 5 },
        { id: 'strike-1ch', type: 'blinder', modelName: 'CHAUVET STRIKE 4', catalogId: 'chauvet-strike-4', dmxMode: '1-Ch', dmxChannels: 1, count: 1, dmxUniverse: 1, dmxStartChannel: 10 },
        { id: 'strike-4ch', type: 'blinder', modelName: 'CHAUVET STRIKE 4', catalogId: 'chauvet-strike-4', dmxMode: '4-Ch', dmxChannels: 4, count: 1, dmxUniverse: 1, dmxStartChannel: 11 },
        { id: 'sharpy', type: 'beam', modelName: 'Claypaky Sharpy', catalogId: 'claypaky-sharpy', dmxMode: 'Standard', dmxChannels: 16, count: 1, dmxUniverse: 1, dmxStartChannel: 15 },
        { id: 'kvant', type: 'laser', modelName: 'KVANT Clubmax 6000 FB4', catalogId: 'kvant-clubmax', dmxMode: 'FB4 16-Ch (FB3 Profile)', dmxChannels: 16, count: 1, dmxUniverse: 1, dmxStartChannel: 31 },
        { id: 'generic-beam', type: 'beam', modelName: 'Generic Beam', count: 1, dmxUniverse: 1, dmxStartChannel: 47 },
      ]),
    ],
    floorFx: [
      { id: 'zr45', type: 'smoke', modelName: 'Martin JEM ZR45', catalogId: 'martin-jem-zr45', dmxMode: '1-Ch', dmxChannels: 1, count: 1, x: 0, z: 0, spread: 0, dmxUniverse: 2, dmxStartChannel: 1 },
      { id: 'co2jet', type: 'co2', modelName: 'MagicFX CO2Jet II', catalogId: 'magicfx-co2jet-ii', dmxMode: '1-Ch (External DMX Switchpack)', dmxChannels: 1, count: 1, x: 1, z: 0, spread: 0, dmxUniverse: 2, dmxStartChannel: 2 },
    ],
  };

  // Verify every single registered personality is tested by this suite.
  const registeredKeys = physicalDmx.listImplementedPhysicalPersonalities().map((p) => p.key).sort();
  assert.deepEqual(registeredKeys, [
    'chauvet-strike-4::1-Ch',
    'chauvet-strike-4::4-Ch',
    'etc-colorsource-par::1-Ch',
    'etc-colorsource-par::5-Ch (Default)',
    'etc-colorsource-par::RGB (3-Ch)',
    'martin-jem-zr45::1-Ch',
  ]);

  // Simulate non-zero sim buffers (including centered pan=128 at U1.001, U1.015, and U1.047!)
  const simU1 = new Uint8Array(512);
  const simU2 = new Uint8Array(512);
  simU1[0] = 128; // Old bug: sim pan=128 on 1-Ch PAR!
  simU1.set([128, 128, 255, 255, 100, 50, 200, 99], 14); // Sharpy sim channels
  simU1.set([255, 0, 64, 128, 255, 200, 180, 140, 64, 128, 128, 100, 255, 0, 0, 0], 30); // KVANT sim channels
  simU1.set([128, 64, 200, 255, 128, 32, 180, 12], 46); // Generic beam sim channels
  simU2[0] = 128;
  simU2[1] = 255;

  // Case 1: Active look (blackout = false)
  const activeOut = physicalDmx.buildPhysicalUniverses(rig, simU1, simU2, () => ({
    blackout: false,
    dimmer: 0.5,
    r: 1.0,
    g: 0.5,
    b: 0.25,
    blinder: 0.8,
    smoke: 0.5,
  }));

  // Golden bytes:
  assert.equal(activeOut.u1[0], 128, 'ETC ColorSource PAR 1-Ch at 50% -> 128');
  assert.deepEqual([...activeOut.u1.slice(1, 4)], [128, 64, 32], 'ETC ColorSource PAR RGB 3-Ch scales RGB by dimmer');
  assert.deepEqual([...activeOut.u1.slice(4, 9)], [128, 255, 128, 64, 0], 'ETC ColorSource PAR 5-Ch: Intensity, R, G, B, Strobe=0 (dimmer not double-applied)');
  assert.equal(activeOut.u1[9], 204, 'CHAUVET STRIKE 4 1-Ch at 80% -> 204');
  assert.deepEqual([...activeOut.u1.slice(10, 14)], [204, 204, 204, 204], 'CHAUVET STRIKE 4 4-Ch drives all 4 pods');
  assert.ok(activeOut.u1.slice(14, 30).every((b) => b === 0), 'Unimplemented Claypaky Sharpy outputs neutral zeros');
  assert.ok(activeOut.u1.slice(30, 46).every((b) => b === 0), 'Unverified catalogue laser outputs neutral zeros on physical wire');
  assert.deepEqual([...activeOut.u1.slice(46, 54)], [128, 64, 200, 255, 128, 32, 180, 12], 'Generic non-catalogue beam keeps simulated layout');
  // Martin JEM ZR45: 0.5 -> 13 + round(0.5 * 227) = 127 (within 13..240 proportional band)
  assert.equal(activeOut.u2[0], 127, 'Martin JEM ZR45 1-Ch proportional curve at 50% -> 127');
  assert.equal(activeOut.u2[1], 0, 'MagicFX CO2Jet II (external switchpack) is simulation-only -> neutral 0');

  // Martin JEM ZR45 full output = 255, zero = 0
  const fullSmoke = physicalDmx.buildPhysicalUniverses(rig, simU1, simU2, () => ({ blackout: false, smoke: 1.0 }));
  assert.equal(fullSmoke.u2[0], 255, 'Martin JEM ZR45 1-Ch at 100% -> 255');
  const zeroSmoke = physicalDmx.buildPhysicalUniverses(rig, simU1, simU2, () => ({ blackout: false, smoke: 0 }));
  assert.equal(zeroSmoke.u2[0], 0, 'Martin JEM ZR45 1-Ch at 0% -> 0 (idle)');

  // Case 2: Blackout ON — ETC ColorSource PAR 1-Ch MUST emit 0 (NOT 128!), and every implemented fixture emits 0.
  const blackoutOut = physicalDmx.buildPhysicalUniverses(rig, simU1, simU2, () => ({
    blackout: true,
    dimmer: 0.9,
    r: 1,
    g: 1,
    b: 1,
    blinder: 1,
    smoke: 1,
  }));
  assert.deepEqual([...blackoutOut.u1.slice(0, 46)], new Array(46).fill(0), 'All catalogue fixtures (implemented and simulation-only) output 0 on blackout');
  assert.equal(blackoutOut.u2[0], 0, 'ZR45 outputs 0 on blackout');
  assert.equal(blackoutOut.u2[1], 0, 'CO2Jet II outputs 0 on blackout');

  // Classification summary matches policy wording
  const summary = physicalDmx.summarizePhysicalDrive(rig);
  assert.equal(summary.implemented.length, 6);
  assert.equal(summary.genericSimulated.length, 1);
  assert.equal(summary.genericSimulated[0].classification.reason, physicalDmx.GENERIC_SIMULATED_LABEL);
  assert.equal(summary.simulationOnly.length, 3);
  assert.ok(summary.simulationOnly.every((item) => item.classification.label === physicalDmx.SIMULATION_ONLY_LABEL));

  // Laser encoder: disabled / blacked-out verified layouts emit all zeros (including posX, never 128).
  const clubmax = catalog.getCatalogEntry('kvant-clubmax');
  const ds3000 = catalog.getCatalogEntry('laserworld-ds-3000rgb');
  for (const mode of [clubmax.modes[0], clubmax.modes[1], ds3000.modes[1]]) {
    const offBytes = laserAim.encodeLaserDmxChannels(mode, {
      enabled: false,
      intensity: 1,
      patternIndex: 3,
      spreadX: 0.8,
      spreadY: 0.7,
      speed: 0.5,
      rotation: 0.5,
      tilt: 0.2,
      beamCount: 16,
      strobe: 0.9,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      colorModeIndex: 2,
      scanRateNorm: 1,
    });
    assert.equal(offBytes.length, mode.channels);
    assert.ok(offBytes.every((b) => b === 0), `${mode.name} disabled must emit all-zero footprint (including posX)`);
  }
});

// ---------------------------------------------------------------------------
// H2: Renderer heartbeat lease stops frozen output with paced blackout
// ---------------------------------------------------------------------------
test('H2: DMX sender expires 5 s heartbeat lease on frozen renderer (even on unchanged cues), sends paced blackout + terminate, and rejects late heartbeats', async () => {
  const mockDgram = createMockDgram();
  let fakeNowNs = 10_000_000_000n;
  const statuses = [];
  const ctrl = sender.createDmxController({
    dgramModule: mockDgram,
    nowNs: () => fakeNowNs,
    heartbeatTimeoutMs: 5000,
    blackoutPaceMs: 24,
    onStatus: (st) => statuses.push(st),
  });

  await ctrl.enable({
    protocol: 'sacn',
    iface: '127.0.0.1',
    rateHz: 40,
    sacn: { mode: 'unicast', universes: [1, 2], priority: 100, ttl: 1, targets: ['127.0.0.1'] },
  }, 42);

  // Submit non-zero hazardous slots (e.g., laser/CO2/strobe = 255)
  const hot = new Uint8Array(512);
  hot[0] = 255;
  hot[5] = 255;
  assert.equal(ctrl.update(1, hot), true);

  // Unchanged cue: no more update() calls, but heartbeats every 1 s keep output alive past 8 s.
  for (let sec = 1; sec <= 8; sec++) {
    fakeNowNs += 1_000_000_000n;
    assert.equal(ctrl.heartbeat(), true, `heartbeat at ${sec}s must succeed`);
    assert.equal(await ctrl._sendTickForTest(), true, `tick at ${sec}s must emit live frame`);
  }
  assert.equal(ctrl.isRunning(), true);

  // Stop heartbeats, advance 4,999 ms: STILL running (even if update() is called, frames must NOT renew lease!).
  fakeNowNs += 4_999_000_000n;
  assert.equal(ctrl.update(1, hot), true);
  assert.equal(await ctrl._sendTickForTest(), true, 'at 4,999 ms lease is still valid');
  assert.equal(ctrl.isRunning(), true);

  // Advance 1 more ms (5,000 ms since last heartbeat — despite recent update()): lease MUST expire!
  fakeNowNs += 1_000_000n;
  assert.equal(ctrl.heartbeat(), false, 'late heartbeat after 5,000 ms must not revive expired lease');
  const shutdownPromise = ctrl._getShutdownPromiseForTest();
  assert.ok(shutdownPromise, 'expired lease must trigger shutdown');
  await shutdownPromise;

  assert.equal(ctrl.isRunning(), false);
  const finalStatus = ctrl.getStatus();
  assert.equal(finalStatus.enabled, false);
  assert.equal(finalStatus.lastStopReason, 'heartbeat-timeout');
  assert.equal(finalStatus.lastStopOwnerId, 42);
  assert.ok(finalStatus.stopEventId >= 1);

  // Verify socket emitted 3 paced all-zero data frames BEFORE 3 Stream_Terminated frames on U1.
  const u1Packets = mockDgram.sockets[0].sent
    .map((item) => packets.decodeSacnPacket(item.packet))
    .filter((p) => p && p.universe === 1);
  const lastLiveIdx = u1Packets.findLastIndex((p) => p.slots[0] === 255);
  assert.ok(lastLiveIdx >= 0);
  const tail = u1Packets.slice(lastLiveIdx + 1);
  const firstTerm = tail.findIndex((p) => (p.options & packets.SACN_OPT_STREAM_TERMINATED) !== 0);
  assert.equal(firstTerm, 3, 'must emit 3 all-zero data frames before Stream_Terminated');
  assert.equal(tail.length, 6, 'must emit 3 zero + 3 terminate frames');
  for (let i = 0; i < 3; i++) assert.ok(tail[i].slots.every((v) => v === 0));
  for (let i = 3; i < 6; i++) {
    assert.equal(tail[i].options & packets.SACN_OPT_STREAM_TERMINATED, packets.SACN_OPT_STREAM_TERMINATED);
    assert.ok(tail[i].slots.every((v) => v === 0));
  }

  // IPC handler validation for onHeartbeat
  const fakeCtrl = { ownerId: 7, isRunning: () => true, heartbeat: () => true, getStatus: () => ({ enabled: true, lastStopReason: null, lastStopOwnerId: null }) };
  const handlers = dmxIpc.createDmxIpcHandlers(() => fakeCtrl, { isRestricted: (id) => id === 99 });
  const mkEv = (id, url = 'stageforge://app/index.html', isMain = true) => {
    const mainFrame = { url };
    return {
      senderFrame: isMain ? mainFrame : { url },
      sender: { id, mainFrame, isDestroyed: () => false, getURL: () => url },
    };
  };
  assert.equal(handlers.onHeartbeat(mkEv(7)), true);
  assert.equal(handlers.onHeartbeat(mkEv(8)), false, 'wrong owner rejected');
  assert.equal(handlers.onHeartbeat(mkEv(99)), false, 'restricted viewer rejected');
  assert.equal(handlers.onHeartbeat(mkEv(7, 'https://evil.test/')), false, 'foreign origin rejected');
  assert.equal(handlers.onHeartbeat(mkEv(7, 'stageforge://app/index.html', false)), false, 'subframe rejected');
});

// ---------------------------------------------------------------------------
// H3: Source-owned bump leases & remote laser authority
// ---------------------------------------------------------------------------
test('H3: BumpLedger enforces 2 s leases on all remote bumps, blocks remote laser enable when desk laser is off, and clears on disconnect/blur', () => {
  const ledger = new bumpMod.BumpLedger({ remoteLeaseMs: 2000, gamepadLeaseMs: 2000 });

  // Remote hazardous & non-hazardous bumps expire after 2,000 ms unless refreshed
  ledger.setHold('osc-udp:127.0.0.1', 'remote', 'co2', true, 1000);
  ledger.setHold('osc-udp:127.0.0.1', 'remote', 'strobe', true, 1000);
  ledger.setHold('osc-udp:127.0.0.1', 'remote', 'motorDrop', true, 1000);
  assert.equal(ledger.resolve({}, 2999).effective.co2, true);
  assert.equal(ledger.resolve({}, 2999).effective.motorDrop, true);
  // Refresh strobe at t=2500 -> stays alive until t=4500 while co2 & motorDrop expire at t=3000
  ledger.setHold('osc-udp:127.0.0.1', 'remote', 'strobe', true, 2500);
  const at3000 = ledger.resolve({}, 3000).effective;
  assert.equal(at3000.co2, false, 'un-refreshed remote co2 expires at 2 s');
  assert.equal(at3000.motorDrop, false, 'un-refreshed remote motorDrop expires at 2 s');
  assert.equal(at3000.strobe, true, 'refreshed remote strobe remains active');
  assert.equal(ledger.resolve({}, 4500).effective.strobe, false, 'refreshed strobe expires 2 s after last refresh');

  // Remote laser bump NEVER enables laser when desk toggle is off, but works when desk laser is on
  ledger.setHold('osc-ws:1', 'remote', 'laser', true, 5000);
  assert.equal(ledger.resolve({ laserDeskEnabled: false }, 5100).effective.laser, false, 'remote laser bump blocked when desk laser off');
  assert.equal(ledger.resolve({ laserDeskEnabled: true }, 5100).effective.laser, true, 'remote laser bump allowed when desk laser on');

  // Local keyboard laser bump still allows manual flash even when desk toggle is off
  ledger.setHold('keyboard', 'local', 'laser', true, 5100);
  assert.equal(ledger.resolve({ laserDeskEnabled: false }, 5200).effective.laser, true);
  ledger.setHold('keyboard', 'local', 'laser', false, 5300);
  assert.equal(ledger.resolve({ laserDeskEnabled: false }, 5300).effective.laser, false);

  // Source prefix clear (e.g., WS disconnect) clears only that transport's holds
  ledger.setHold('osc-udp:10.0.0.2', 'remote', 'smoke', true, 5400);
  ledger.setHold('osc-ws:1', 'remote', 'blinder', true, 5400);
  ledger.clearSourcePrefix('osc-ws:');
  const afterWsDrop = ledger.resolve({ laserDeskEnabled: true }, 5500).effective;
  assert.equal(afterWsDrop.blinder, false);
  assert.equal(afterWsDrop.laser, false);
  assert.equal(afterWsDrop.smoke, true, 'other transport holds remain intact');

  // Blur / clock-mode change / viewer entry clears everything
  ledger.clearAll();
  assert.deepEqual(ledger.resolve({ laserDeskEnabled: true }, 5600).effective, bumpMod.EMPTY_BUMP_STATE);
});

// ---------------------------------------------------------------------------
// M1: EnttecProTransport session generation isolates stale write failures
// ---------------------------------------------------------------------------
test('M1: late write rejection and disconnect from an old USB session never close or error a reconnected session', async () => {
  let rejectOldWrite;
  let oldDisconnectCb = null;
  let oldClosed = false;
  let newClosed = false;
  const newWritten = [];

  const oldPort = {
    open: async () => {},
    close: async () => { oldClosed = true; },
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
    addEventListener: (_t, cb) => { oldDisconnectCb = cb; },
    removeEventListener: () => {}, // intentionally keep oldDisconnectCb to test stale event delivery
    writable: {
      getWriter: () => ({
        write: () => new Promise((_res, rej) => { rejectOldWrite = rej; }),
        abort: async () => {},
        releaseLock: () => {},
      }),
    },
  };
  const newPort = {
    open: async () => {},
    close: async () => { newClosed = true; },
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    writable: {
      getWriter: () => ({
        write: async (chunk) => { newWritten.push(new Uint8Array(chunk)); },
        abort: async () => {},
        releaseLock: () => {},
      }),
    },
  };

  let callCount = 0;
  const transport = new enttec.EnttecProTransport(
    () => {},
    () => ({ requestPort: async () => (callCount++ === 0 ? oldPort : newPort) }),
  );

  await transport.enable({ universe: 1, rateHz: 40 });
  // Wait for initial tick to enter stalled write()
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(rejectOldWrite, 'old write must be in flight');

  // Disable via timeout path, then reconnect to newPort
  await transport.disable();
  assert.equal(oldClosed, true);
  await transport.enable({ universe: 1, rateHz: 40 });
  assert.equal(transport.isRunning(), true);

  // Now reject the stale write from oldPort AND fire stale disconnect from oldPort!
  rejectOldWrite(new Error('stale port I/O error'));
  oldDisconnectCb?.();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(transport.isRunning(), true, 'new session must stay running');
  assert.equal(newClosed, false, 'new port must NOT be closed by stale session failure');
  assert.equal(transport.getStatus().error, null, 'stale error must NOT clobber new session');
  assert.ok(newWritten.length >= 1, 'new session must continue writing frames');

  await transport.disable();
  assert.equal(newClosed, true);
});

// ---------------------------------------------------------------------------
// M2: Explicit cleared audioMap survives record, save, reopen, replay, seek & cues
// ---------------------------------------------------------------------------
test('M2: removing the last audio mapping records { mappings: [] }, saves as v8, replays & seeks cleanly, and preserves v1–v7', () => {
  const baseLook = structuredClone(presets.INITIAL_SHOW_STATE);
  const kickMapping = {
    id: 'm-kick',
    name: 'Kick -> Wash',
    enabled: true,
    source: 'bass',
    target: { group: 'wash', param: 'dimmer' },
    amount: 0.7,
    attackMs: 25,
    releaseMs: 180,
    threshold: 0.1,
    curve: 'linear',
  };
  const lookWithMap = { ...structuredClone(baseLook), audioMap: { mappings: [kickMapping] } };
  const lookCleared = structuredClone(baseLook);
  delete lookCleared.audioMap;

  const mkFrame = (look) => ({
    look,
    cueId: null,
    cueModified: false,
    camera: 'foh',
    volume: 0.7,
    bump: bumpMod.EMPTY_BUMP_STATE,
    music: { kind: 'none', name: '', playing: false },
    screen: { target: 'main-led', kind: 'none', name: '', playing: false },
  });

  // 1. frameDelta emits `{ mappings: [] }` when last mapping is removed (returned null on old code!)
  const deltaAdd = timelineMod.frameDelta(mkFrame(lookCleared), mkFrame(lookWithMap), 500, 500);
  assert.deepEqual(deltaAdd?.look?.audioMap, { mappings: [kickMapping] });
  const deltaClear = timelineMod.frameDelta(mkFrame(lookWithMap), mkFrame(lookCleared), 1000, 500);
  assert.ok(deltaClear, 'removing last audioMap must record a delta event');
  assert.deepEqual(deltaClear.look?.audioMap, { mappings: [] });

  // 2. Save -> reopen preserves clear marker and selects v8 even when top-level look has no mappings
  const take = {
    durationMs: 2000,
    events: [
      { atMs: 0, look: lookCleared, cueId: null, camera: 'foh', volume: 0.7, bump: bumpMod.EMPTY_BUMP_STATE, music: { kind: 'none', name: '', playing: false }, screen: { target: 'main-led', kind: 'none', name: '', playing: false } },
      deltaAdd,
      deltaClear,
    ],
  };
  const saved = showFileMod.makeShowFile(presets.RIG_TEMPLATES.arena_mainstage, presets.SHOW_CUES, lookCleared, null, undefined, take);
  assert.equal(saved.version, 8, 'timeline clear marker requires v8');
  assert.deepEqual(saved.timeline.events[2].look.audioMap, { mappings: [] });
  const reopened = showFileMod.parseShowFile(JSON.stringify(saved));
  assert.deepEqual(reopened.timeline.events[2].look.audioMap, { mappings: [] });

  // 3. Seek forward & backward (including from a mapped base.look back to an unmapped t=0 snapshot)
  const mappedBase = mkFrame(lookWithMap);
  const at0 = showClockMod.resolveTakeFrame(reopened.timeline, 0, mappedBase, false);
  assert.equal(Object.hasOwn(at0.look, 'audioMap'), false, 'full snapshot at t=0 without audioMap must not inherit base.look.audioMap');
  const at600 = showClockMod.resolveTakeFrame(reopened.timeline, 600, mappedBase, false);
  assert.deepEqual(at600.look.audioMap, { mappings: [kickMapping] });
  const at1500 = showClockMod.resolveTakeFrame(reopened.timeline, 1500, mappedBase, false);
  assert.equal(Object.hasOwn(at1500.look, 'audioMap'), false, 'explicit clear at t=1000 must delete audioMap at t=1500');

  // 4. Master-only partial cue must preserve live audioMap; explicit clear cue clears it cleanly
  const masterCue = { id: 'c-m', name: 'Half master', tag: 'PART', accent: '#fff', state: { masterDimmer: 0.5 } };
  const afterMaster = cueLookMod.cueLook(lookWithMap, masterCue);
  assert.deepEqual(afterMaster.audioMap, { mappings: [kickMapping] }, 'master-only partial cue must NOT wipe audioMap');
  const clearCue = { id: 'c-clr', name: 'Clear audio', tag: 'PART', accent: '#fff', state: { audioMap: { mappings: [] } } };
  const afterClear = cueLookMod.cueLook(lookWithMap, clearCue);
  assert.equal(Object.hasOwn(afterClear, 'audioMap'), false);
  assert.equal(cueLookMod.differsFromCue(afterClear, clearCue, { target: 'main-led', kind: 'none', name: '', playing: false }), false);
});

// ---------------------------------------------------------------------------
// M3: Stationary timecode emits hold once & resumes cleanly with resync
// ---------------------------------------------------------------------------
test('M3: ChaseEngine ignores single duplicate packet, emits hold once after >= 120 ms stationary, and resumes with resumedFromHold + resyncMusic', () => {
  const chase = new clockOwner.ChaseEngine({ dropoutMs: 300, freewheelMs: 500, timecodeOffsetMs: 0 });
  chase.onTimecode({ ms: 1000, fps: 30, source: 'artnetTC' }, 1000);
  const locked = chase.onTimecode({ ms: 1033.333, fps: 30, source: 'artnetTC' }, 1033);
  assert.equal(locked.lockState, 'LOCKED');

  // Single duplicate packet 10 ms later must NOT stutter into hold
  const dup = chase.onTimecode({ ms: 1033.333, fps: 30, source: 'artnetTC' }, 1043);
  assert.equal(dup.action, 'none');

  // Repeated identical timestamp every 33 ms for 1 s: emits 'hold' EXACTLY once once >= 120 ms elapsed
  let holdCount = 0;
  for (let k = 1; k <= 15; k++) {
    const t = 1043 + k * 33;
    const step = chase.onTimecode({ ms: 1033.333, fps: 30, source: 'artnetTC' }, t);
    if (step.action === 'hold') {
      holdCount++;
      assert.equal(step.lockState, 'LOCKED');
    } else {
      assert.equal(step.action, 'none');
    }
  }
  assert.equal(holdCount, 1, 'stationary timecode must emit exactly one hold transition');

  // While held, tick() never creeps forward
  assert.equal(chase.tick(1580).action, 'none');

  // Resuming progression (small 1-frame step < 40 ms drift): emits 'advance' with resumedFromHold + resyncMusic
  const resumed = chase.onTimecode({ ms: 1066.666, fps: 30, source: 'artnetTC' }, 1600);
  assert.equal(resumed.action, 'advance');
  assert.equal(resumed.resumedFromHold, true);
  assert.equal(resumed.resyncMusic, true);

  // Hold -> dropout stops cleanly
  for (let k = 0; k < 6; k++) chase.onTimecode({ ms: 1066.666, fps: 30, source: 'artnetTC' }, 1633 + k * 33);
  const dropped = chase.tick(2500);
  assert.equal(dropped.action, 'stop');
  assert.equal(dropped.lockState, 'STOPPED');
});

// ---------------------------------------------------------------------------
// M4: Downbeat anchoring preserves 4-beat bar phase across beats, nudges & BPM changes
// ---------------------------------------------------------------------------
test('M4: setBeatGridDownbeat preserves bar phase on all 4 beats, fractional anchors, nudges across beat boundaries, and BPM retiming', () => {
  const base = { bpm: 120, offsetMs: 0, source: 'offline' }; // beat = 500 ms, bar = 2000 ms
  for (const anchorMs of [0, 500, 1000, 1500, 12345.67]) {
    const anchored = tempoMod.setBeatGridDownbeat(base, anchorMs);
    const phase = tempoMod.beatGridPhase(anchored, anchorMs);
    assert.equal(phase.isDownbeat, true, `anchor at ${anchorMs} ms must evaluate isDownbeat: true`);
    assert.ok(phase.phase < 1e-6, `anchor at ${anchorMs} ms must have phase ~0 (got ${phase.phase})`);
    // 1 beat later = beat 2 (not downbeat); 4 beats later = next downbeat!
    assert.equal(tempoMod.beatGridPhase(anchored, anchorMs + 500).isDownbeat, false);
    assert.equal(tempoMod.beatGridPhase(anchored, anchorMs + 2000).isDownbeat, true);
  }

  // Nudging across a beat boundary preserves bar phase (offset wraps mod 2000 ms, not 500 ms)
  const anchored = tempoMod.setBeatGridDownbeat(base, 480);
  const nudged = tempoMod.nudgeBeatGrid(anchored, 50); // crosses 500 ms beat boundary -> 530 ms!
  assert.equal(Math.round(nudged.offsetMs), 530);
  assert.equal(tempoMod.beatGridPhase(nudged, 530).isDownbeat, true);
  assert.equal(tempoMod.beatGridPhase(nudged, 30).isDownbeat, false);

  // Retiming to a new BPM keeps the original anchor timestamp aligned to Beat 1
  const retimed = tempoMod.retimeBeatGrid(tempoMod.setBeatGridDownbeat(base, 1500), 140);
  assert.equal(tempoMod.beatGridPhase(retimed, 1500).isDownbeat, true);
});

// ---------------------------------------------------------------------------
// M5: OSC rate limiting cannot be sidestepped by cycling > 64 source addresses or bundles
// ---------------------------------------------------------------------------
test('M5: OSC ingress enforces aggregate budget before decode, overflow cap across > 64 sources, and bundle message cap', async () => {
  const mockDgram = createMockDgram();
  let frozenNow = 50_000;
  const accepted = [];
  const svc = showControlSvc.createShowControlService({
    dgramModule: mockDgram,
    nowMs: () => frozenNow,
    onEvent: (ev) => accepted.push(ev),
  });

  await svc.configure({ oscRxEnabled: true, oscPort: 8000, oscAllowAllInterfaces: true }, 1);
  const sock = mockDgram.sockets[0];
  const validPkt = oscPackets.encodeOscMessage('/stageforge/go', [{ type: 'f', value: 1 }]);

  // 1. Cycle 100 distinct source IPs sending 2,500 packets at frozen time (old code admitted 100%!)
  for (let i = 0; i < 2500; i++) {
    const ip = `10.0.${Math.floor((i % 100) / 25)}.${(i % 25) + 1}`;
    sock.emit('message', validPkt, { address: ip, port: 9000 });
  }
  assert.ok(
    accepted.length <= showControlSvc.OSC_AGGREGATE_RATE_LIMIT_PER_SEC,
    `cycling 100 IPs must cap at aggregate limit <= ${showControlSvc.OSC_AGGREGATE_RATE_LIMIT_PER_SEC}, got ${accepted.length}`,
  );
  assert.ok(svc.getStatus().oscDroppedCount >= 1500, 'excess packets must be counted as dropped');
  assert.equal(accepted[0].sender, '10.0.0.1', 'emitted OSC events carry sender IP for H3 bump ownership');

  // 2. Advance 1 s and test 64-element bundle flood cannot bypass aggregate message limit
  frozenNow += 1500;
  const beforeBundle = accepted.length;
  const elems = Array.from({ length: 32 }, () => validPkt);
  // Build valid OSC bundle header "#bundle\0" + 8-byte timetag + [len, pkt]...
  const parts = [Buffer.from('#bundle\0', 'ascii'), Buffer.alloc(8)];
  for (const el of elems) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(el.length, 0);
    parts.push(len, el);
  }
  const bundle = Buffer.concat(parts);
  for (let i = 0; i < 60; i++) {
    const ip = `192.168.5.${(i % 80) + 1}`;
    sock.emit('message', bundle, { address: ip, port: 9001 });
  }
  const bundleAccepted = accepted.length - beforeBundle;
  assert.ok(
    bundleAccepted <= showControlSvc.OSC_AGGREGATE_RATE_LIMIT_PER_SEC,
    `bundled messages must respect aggregate message limit (got ${bundleAccepted})`,
  );

  await svc.shutdown();
});

// ---------------------------------------------------------------------------
// Sprint 13 QA Regressions (H-1, H-2, M-3, M-4, L-2, L-3)
// ---------------------------------------------------------------------------
test('QA H-1: one noisy OSC host flooding 5,000/s cannot starve a second legitimate host at 50/s', async () => {
  const mockDgram = createMockDgram();
  let frozenNow = 100_000;
  const accepted = [];
  const svc = showControlSvc.createShowControlService({
    dgramModule: mockDgram,
    nowMs: () => frozenNow,
    onEvent: (ev) => accepted.push(ev),
  });

  await svc.configure({ oscRxEnabled: true, oscPort: 8000, oscAllowAllInterfaces: true }, 1);
  const sock = mockDgram.sockets[0];
  const pkt = oscPackets.encodeOscMessage('/stageforge/go', [{ type: 'f', value: 1 }]);

  // Host A floods 5,000 packets at frozenNow while Host B sends 50 packets interleaved.
  for (let i = 0; i < 5000; i++) {
    sock.emit('message', pkt, { address: '10.1.1.1', port: 9000 });
    if (i % 100 === 50) {
      sock.emit('message', pkt, { address: '10.1.1.2', port: 9000 });
    }
  }
  const fromA = accepted.filter((e) => e.sender === '10.1.1.1').length;
  const fromB = accepted.filter((e) => e.sender === '10.1.1.2').length;
  assert.equal(fromA, showControlSvc.OSC_RATE_LIMIT_PER_SEC, 'noisy host A capped at per-source limit');
  assert.equal(fromB, 50, 'legitimate host B must NOT be starved by host A draining aggregate');

  await svc.shutdown();
});

test('QA H-2: backwards clock step (NTP jump) never stalls OSC token buckets', async () => {
  const mockDgram = createMockDgram();
  let now = 1_000_000;
  const accepted = [];
  const svc = showControlSvc.createShowControlService({
    dgramModule: mockDgram,
    nowMs: () => now,
    onEvent: (ev) => accepted.push(ev),
  });

  await svc.configure({ oscRxEnabled: true, oscPort: 8000, oscAllowAllInterfaces: true }, 1);
  const sock = mockDgram.sockets[0];
  const pkt = oscPackets.encodeOscMessage('/stageforge/go', [{ type: 'f', value: 1 }]);

  // Drain host bucket completely at t = 1,000,000 ms
  for (let i = 0; i < showControlSvc.OSC_RATE_LIMIT_PER_SEC + 5; i++) {
    sock.emit('message', pkt, { address: '10.2.2.2', port: 9000 });
  }
  const drainedCount = accepted.length;
  assert.equal(drainedCount, showControlSvc.OSC_RATE_LIMIT_PER_SEC);

  // Clock steps BACKWARD by 60 seconds (e.g. NTP correction)
  now -= 60_000;
  sock.emit('message', pkt, { address: '10.2.2.2', port: 9000 }); // re-anchors datagram bucket
  now += 1000;
  sock.emit('message', pkt, { address: '10.2.2.2', port: 9000 }); // passes datagram bucket & re-anchors message bucket
  now += 1000;
  sock.emit('message', pkt, { address: '10.2.2.2', port: 9000 }); // both buckets refilled (2 s total vs 60 s stall!)
  assert.equal(accepted.length, drainedCount + 1, 'buckets must refill after backward clock step instead of stalling 60 s');

  await svc.shutdown();
});

test('QA M-3 & M-4: legacy full snapshots preserve omitted ShowState fields, and legacy master+motors cues keep captured podTargets while preserving audioMap', () => {
  const baseLook = structuredClone(presets.INITIAL_SHOW_STATE);
  const mapping = {
    id: 'm1',
    name: 'Bass -> Wash',
    enabled: true,
    source: 'bass',
    target: { group: 'wash', param: 'dimmer' },
    amount: 0.5,
    attackMs: 25,
    releaseMs: 180,
    threshold: 0.1,
    curve: 'linear',
  };
  const liveWithMap = {
    ...structuredClone(baseLook),
    bpm: 132,
    movingGroups: { beam: { beamIntensity: 0.4 } },
    focusMarkId: 'mark-center',
    audioMap: { mappings: [mapping] },
  };

  // M-3: legacy full timeline snapshot with laser/motors/atmo/led but omitted bpm must keep prior.bpm AND clear stale optional fields
  const legacyFullPatch = {
    laser: structuredClone(baseLook.laser),
    motors: structuredClone(baseLook.motors),
    atmo: structuredClone(baseLook.atmo),
    led: structuredClone(baseLook.led),
  };
  const applied = cueLookMod.applyTimelineLookPatch(liveWithMap, legacyFullPatch);
  assert.equal(applied.bpm, 132, 'legacy full snapshot missing bpm must inherit prior.bpm');
  assert.equal(Object.hasOwn(applied, 'audioMap'), false, 'full snapshot without audioMap still clears stale audioMap');
  assert.equal(Object.hasOwn(applied, 'movingGroups'), false, 'full snapshot without movingGroups clears stale movingGroups');
  assert.equal(Object.hasOwn(applied, 'focusMarkId'), false, 'full snapshot without focusMarkId clears stale focusMarkId');

  // M-4: legacy cue with masterDimmer + motors (no led/atmo) still replaces podTargets (captured=true) AND preserves live audioMap!
  const withPodTarget = {
    ...liveWithMap,
    motors: { ...liveWithMap.motors, podTargets: { 'pod-front': { height: 7, tilt: 0 } } },
  };
  const legacyMotorsCue = {
    id: 'c-legacy',
    name: 'Legacy Motors',
    tag: 'PART',
    accent: '#fff',
    state: {
      masterDimmer: 0.85,
      motors: { mode: 'high', speed: 0.5, podTargets: {} },
    },
  };
  const afterLegacy = cueLookMod.cueLook(withPodTarget, legacyMotorsCue);
  assert.deepEqual(afterLegacy.motors.podTargets, {}, 'legacy master+motors cue must still clear podTargets');
  assert.deepEqual(afterLegacy.audioMap, { mappings: [mapping] }, 'partial legacy cue must NOT wipe live audioMap');
});

test('QA L-2: BumpLedger at 64 active remote sources rejects new spoofed IPs without evicting active holds, while local/gamepad evicts earliest expiry', () => {
  const ledger = new bumpMod.BumpLedger({ remoteLeaseMs: 2000, gamepadLeaseMs: 2000 });
  // Fill all 64 slots with active remote sources, staggered expiry times; source #1 holds motorDrop with earliest expiry.
  assert.equal(ledger.setHold('osc-udp:10.0.0.1', 'remote', 'motorDrop', true, 1000), true);
  for (let i = 1; i < bumpMod.MAX_BUMP_SOURCES; i++) {
    assert.equal(ledger.setHold(`osc-udp:10.0.0.${i + 1}`, 'remote', 'blinder', true, 1000 + i * 10), true);
  }
  // 65th remote source at t=1700 (all 64 still live) MUST be rejected so spoofed flood cannot evict an active hold
  assert.equal(ledger.setHold('osc-udp:10.0.99.99', 'remote', 'strobe', true, 1700), false);
  const afterSpoof = ledger.resolve({ laserDeskEnabled: true }, 1700).effective;
  assert.equal(afterSpoof.strobe, false);
  assert.equal(afterSpoof.motorDrop, true);
  assert.equal(afterSpoof.blinder, true);

  // Local source MUST still succeed by evicting the earliest-expiring remote source (10.0.0.1 holding motorDrop)
  assert.equal(ledger.setHold('keyboard', 'local', 'co2', true, 1700), true);
  const afterLocal = ledger.resolve({ laserDeskEnabled: true }, 1700).effective;
  assert.equal(afterLocal.co2, true);
  assert.equal(afterLocal.motorDrop, false, 'earliest-expiring remote source should be evicted for local hold');
  assert.equal(afterLocal.blinder, true, 'newer active remote holds survive');
});

test('QA L-3: nudgeBeatGrid sets anchorMs on an unanchored grid so subsequent retimeBeatGrid preserves the nudged downbeat', () => {
  const unanchored = { bpm: 120, offsetMs: 1250, source: 'manual' }; // no anchorMs
  const nudged = tempoMod.nudgeBeatGrid(unanchored, 50); // -> 1300 ms
  assert.equal(nudged.anchorMs, 1300);
  const retimed = tempoMod.retimeBeatGrid(nudged, 140);
  assert.equal(tempoMod.beatGridPhase(retimed, 1300).isDownbeat, true, 'retimed grid must keep Beat 1 at nudged 1300 ms');
});

// ---------------------------------------------------------------------------
// Codex review-01-sprint-13-2acf960 regressions (R1, R2, R3, R4)
// ---------------------------------------------------------------------------

test('Codex R1: combined strobe bump + audio mapping caps final ETC ColorSource PAR physical dimmer flashes to <= 3/s', () => {
  const state = audioMod.createAudioModulationState();
  const frame = audioMod.createAudioModulationFrame();
  const washStrobeMapping = {
    id: 'w-st',
    name: 'Hats -> wash strobe',
    enabled: true,
    source: 'high',
    target: { group: 'wash', param: 'strobe' },
    amount: 0.9,
    attackMs: 5,
    releaseMs: 40,
    threshold: 0.1,
    curve: 'linear',
  };
  const look = {
    ...presets.INITIAL_SHOW_STATE,
    masterDimmer: 1,
    washIntensity: 0.5,
    audioReactive: true,
    audioMap: { mappings: [washStrobeMapping] },
  };
  const par1ChClass = physicalDmx.classifyPhysicalGroup({
    id: 'w1',
    type: 'wash',
    modelName: 'ETC ColorSource PAR',
    catalogId: 'etc-colorsource-par',
    dmxMode: '1-Ch',
    dmxChannels: 1,
    count: 1,
    dmxUniverse: 1,
    dmxStartChannel: 1,
  });
  assert.equal(par1ChClass.status, 'implemented');

  const uBuf = new Uint8Array(512);
  const physBuf = new Uint8Array(512);
  const scratch = [];
  const dt = 1 / 60;
  let prevBright = false;
  const risingEdgeMs = [];
  let sawLimited = false;

  // Simulate 1.0 s at 60 fps with both audio-mapped wash strobe AND strobe bump held (effectiveStrobe = 0.92 -> 25.58 Hz raw).
  for (let i = 0; i < 60; i++) {
    const tSec = i * dt;
    const metrics = {
      playing: true,
      bass: 0.2,
      mid: 0.2,
      high: i % 6 < 3 ? 0.95 : 0.0,
      energy: 0.5,
      beat: false,
      beatPulse: 0,
      drop: false,
      spectrum: new Float32Array(32),
    };
    const mod = audioMod.evaluateAudioModulation(look, metrics, state, dt, frame);
    const combined = audioMod.stepCombinedStrobeGate(state, 0.92, tSec, false);
    if (combined.limited || mod.flashLimited) sawLimited = true;
    const finalInt = Math.min(1.6, look.washIntensity * look.masterDimmer * combined.gate);
    physicalDmx.writePhysicalUnitBytes(
      physBuf,
      uBuf,
      1,
      1,
      par1ChClass,
      { blackout: false, dimmer: Math.min(1, finalInt), r: 1, g: 1, b: 1, blinder: 0, smoke: 0 },
      scratch,
    );
    const bright = physBuf[0] > 100;
    if (bright && !prevBright) risingEdgeMs.push(state.clockMs);
    prevBright = bright;
  }

  assert.equal(sawLimited, true, 'flash limiter must flag suppression under 25.58 Hz strobe bump');
  assert.ok(
    risingEdgeMs.length <= 3,
    `physical PAR dimmer must produce <= 3 bright edges in 1 s, got ${risingEdgeMs.length}`,
  );
  for (let i = 1; i < risingEdgeMs.length; i++) {
    assert.ok(
      risingEdgeMs[i] - risingEdgeMs[i - 1] >= audioMod.FLASH_REFRACTORY_MS - 1,
      `consecutive flashes must be >= ${audioMod.FLASH_REFRACTORY_MS} ms apart`,
    );
  }
});

test('Codex R2: timecode chase stop and stationary hold immediately clear recorded replay hazardous bumps', () => {
  const ledger = new bumpMod.BumpLedger({ remoteLeaseMs: 2000, gamepadLeaseMs: 2000 });
  const engineBumpHistory = [];
  const syncLiveBump = () => {
    engineBumpHistory.push(ledger.resolve({ laserDeskEnabled: true }, 2000).effective);
  };
  const held = { audio: false, screen: false };
  const handlers = clockOwner.createChaseTransportHandlers({
    held,
    getEndMs: () => 8000,
    setReplaying: () => {},
    clearFollow: () => {},
    prepareSeek: () => {},
    chaseSeekTimeline: () => {},
    chaseAdvanceTimeline: () => {},
    resolveTimelineFrame: () => null,
    restoreTimelineMusic: () => {},
    restoreTimelineScreen: () => {},
    isAudioPlaying: () => false,
    pauseAudio: () => {},
    resumeAudio: () => {},
    stopAudio: () => {},
    isScreenVideoPlaying: () => false,
    setScreenPlaying: () => {},
    setWallClock: () => {},
    getWallClockPos: () => 2000,
    clearReplayBumps: () => {
      ledger.clearSource('replay');
      syncLiveBump();
    },
  });

  // Recorded CO2 + laser bump active during take chase at t=2000 ms
  ledger.setHold('replay', 'local', 'co2', true, 1000);
  ledger.setHold('replay', 'local', 'laser', true, 1000);
  assert.equal(ledger.resolve({ laserDeskEnabled: true }, 2000).effective.co2, true);

  // Chase dropout -> STOPPED must clear replay bumps immediately (even 60 s later, never stuck)
  handlers.onChaseStop();
  assert.equal(ledger.resolve({ laserDeskEnabled: true }, 60_000).effective.co2, false, 'CO2 must clear on chase stop');
  assert.equal(ledger.resolve({ laserDeskEnabled: true }, 60_000).effective.laser, false, 'laser bump must clear on chase stop');
  assert.equal(engineBumpHistory.at(-1).co2, false, 'cleared bump state must propagate to engine immediately');

  // Re-engage replay CO2 bump and verify stationary hold clears it too
  ledger.setHold('replay', 'local', 'co2', true, 3000);
  handlers.onChaseHold(3000);
  assert.equal(ledger.resolve({ laserDeskEnabled: true }, 3100).effective.co2, false, 'CO2 must clear on stationary hold');
  assert.equal(engineBumpHistory.at(-1).co2, false);
});

test('Codex R3: four-subsystem frameDelta preserves unchanged audioMap, movingGroups, and focusMarkId through save, reopen, replay, and seek', () => {
  const mapping = {
    id: 'm-keep',
    name: 'Keep Me',
    enabled: true,
    source: 'bass',
    target: { group: 'wash', param: 'dimmer' },
    amount: 0.6,
    attackMs: 10,
    releaseMs: 120,
    threshold: 0.05,
    curve: 'linear',
  };
  const sharedMoving = { beam: { movementMode: 'figure8', movementSpeed: 0.7 } };
  const beforeLook = {
    ...presets.INITIAL_SHOW_STATE,
    bpm: 126,
    audioReactive: true,
    audioMap: { mappings: [mapping] },
    movingGroups: sharedMoving,
    focusMarkId: 'audience',
  };
  // Change all four subsystems (laser, motors, atmo, led) while keeping audioMap, movingGroups, and focusMarkId identical.
  const afterLook = {
    ...beforeLook,
    laser: { ...beforeLook.laser, intensity: 0.9 },
    motors: { ...beforeLook.motors, speed: 0.8 },
    atmo: { ...beforeLook.atmo, hazeDensity: 0.7 },
    led: { ...beforeLook.led, brightness: 0.6 },
  };
  const baseFrame = {
    look: beforeLook,
    cueId: 'c1',
    cueModified: false,
    camera: 'foh',
    volume: 0.8,
    bump: { blinder: false, strobe: false, co2: false, smoke: false, laser: false, motorDrop: false },
    music: { kind: 'none', name: '', playing: false },
    screen: { target: 'main-led', kind: 'none', name: '', playing: false },
  };
  const delta = timelineMod.frameDelta(baseFrame, { ...baseFrame, look: afterLook, cueId: 'c2' }, 2000, 1000);
  assert.ok(delta?.look, 'delta must contain look changes');
  assert.equal(cueLookMod.isFullLookSnapshot(delta.look), true, '4-subsystem delta satisfies snapshot predicate');
  assert.deepEqual(delta.look.audioMap, { mappings: [mapping] }, '4-subsystem delta must retain unchanged audioMap');
  assert.deepEqual(delta.look.movingGroups, sharedMoving, '4-subsystem delta must retain unchanged movingGroups');
  assert.equal(delta.look.focusMarkId, 'audience', '4-subsystem delta must retain unchanged focusMarkId');

  // Round-trip through show file v8 save -> parse -> replay -> seek
  const rig = structuredClone(presets.RIG_TEMPLATES.arena_mainstage);
  const take = {
    durationMs: 4000,
    events: [
      { atMs: 0, look: beforeLook, cueId: 'c1', camera: 'foh', volume: 0.8, bump: baseFrame.bump, music: baseFrame.music, screen: baseFrame.screen },
      delta,
    ],
  };
  const saved = showFileMod.makeShowFile(rig, [], beforeLook, null, undefined, take);
  const reopened = showFileMod.parseShowFile(JSON.stringify(saved));
  const at3s = showClockMod.resolveTakeFrame(reopened.timeline, 3000, baseFrame, false);
  assert.deepEqual(at3s.look.audioMap, { mappings: [mapping] }, 'seek after 4-subsystem delta must preserve audioMap');
  assert.deepEqual(at3s.look.movingGroups, sharedMoving, 'seek after 4-subsystem delta must preserve movingGroups');
  assert.equal(at3s.look.focusMarkId, 'audience', 'seek after 4-subsystem delta must preserve focusMarkId');
});

test('Codex R4: stationary timecode hold followed by forward jump (>10 frames -> seek) resumes held audio and video without a timeline', () => {
  const chase = new clockOwner.ChaseEngine({ offsetMs: 0, dropoutMs: 300, freewheelMs: 1000 });
  let audioPlaying = true;
  let screenPlaying = true;
  const held = { audio: false, screen: false };
  const handlers = clockOwner.createChaseTransportHandlers({
    held,
    getEndMs: () => 0,
    setReplaying: () => {},
    clearFollow: () => {},
    prepareSeek: () => {},
    chaseSeekTimeline: () => {},
    chaseAdvanceTimeline: () => {},
    resolveTimelineFrame: () => null, // no recorded timeline
    restoreTimelineMusic: () => {},
    restoreTimelineScreen: () => {},
    isAudioPlaying: () => audioPlaying,
    pauseAudio: () => { audioPlaying = false; },
    resumeAudio: () => { audioPlaying = true; },
    stopAudio: () => { audioPlaying = false; },
    isScreenVideoPlaying: () => screenPlaying,
    setScreenPlaying: (p) => { screenPlaying = p; },
    setWallClock: () => {},
    getWallClockPos: () => 0,
    clearReplayBumps: () => {},
  });

  const dispatch = (step) => {
    if (step.action === 'seek') handlers.onChaseSeek(step.takeMs, true, step.resyncMusic, { resumedFromHold: step.resumedFromHold });
    else if (step.action === 'advance') handlers.onChaseAdvance(step.takeMs, { resumedFromHold: step.resumedFromHold, resyncMusic: step.resyncMusic });
    else if (step.action === 'hold') handlers.onChaseHold(step.takeMs);
    else if (step.action === 'stop') handlers.onChaseStop();
  };

  // Lock onto progressing 30 fps timecode
  dispatch(chase.onTimecode({ ms: 1000, fps: 30, source: 'mtc' }, 1000));
  dispatch(chase.onTimecode({ ms: 1033, fps: 30, source: 'mtc' }, 1033));
  dispatch(chase.onTimecode({ ms: 1067, fps: 30, source: 'mtc' }, 1067));
  assert.equal(audioPlaying, true);
  assert.equal(screenPlaying, true);

  // Repeat stationary timestamp until hold fires
  dispatch(chase.onTimecode({ ms: 1067, fps: 30, source: 'mtc' }, 1100));
  const holdStep = chase.onTimecode({ ms: 1067, fps: 30, source: 'mtc' }, 1250);
  assert.equal(holdStep.action, 'hold');
  dispatch(holdStep);
  assert.equal(audioPlaying, false, 'audio must pause on stationary hold');
  assert.equal(screenPlaying, false, 'screen video must pause on stationary hold');

  // Resume with a 1-second forward jump (> 10 frames -> action === 'seek' with resumedFromHold: true)
  const jumpStep = chase.onTimecode({ ms: 2067, fps: 30, source: 'mtc' }, 1300);
  assert.equal(jumpStep.action, 'seek');
  assert.equal(jumpStep.resumedFromHold, true);
  dispatch(jumpStep);
  assert.equal(audioPlaying, true, 'audio must resume on forward-jump seek out of stationary hold');
  assert.equal(screenPlaying, true, 'screen video must resume on forward-jump seek out of stationary hold');
});
