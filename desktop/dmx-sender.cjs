'use strict';

// Main-process live DMX UDP sender for sACN (ANSI E1.31-2018) and Art-Net 4.
// Keeps frame pacing in the main process (immune to renderer throttling), binds explicitly to
// a validated local IPv4 interface, enforces a hard 44 Hz rate ceiling, monitors a renderer
// heartbeat lease (5 s timeout), and sends paced blackout packets on disable, heartbeat loss,
// renderer crash, navigation, window close and quit.

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SACN_PORT,
  ARTNET_PORT,
  ARTNET_OPCODE_POLL_REPLY,
  SACN_OPT_STREAM_TERMINATED,
  MAX_DMX_HZ,
  MIN_FRAME_INTERVAL_NS,
  isValidIpv4,
  isReservedOrBroadcastIpv4,
  isLoopbackIpv4,
  computeBroadcast,
  isInSubnet,
  uuidToBytes,
  truncateUtf8Bytes,
  sacnMulticastAddress,
  encodeSacnPacket,
  encodeArtDmxPacket,
  encodeArtPollPacket,
  parseArtPollReply,
} = require('./dmx-packets.cjs');

const MAX_TARGETS = 8;
const MAX_DISCOVERED_NODES = 64;
const SHUTDOWN_TIMEOUT_MS = 750;
const BLACKOUT_TICKS = 3;
const SACN_TERMINATE_TICKS = 3;
const BLACKOUT_PACE_MS = 25; // >= 22.73 ms (<= 44 Hz)
const DEGRADED_CLEAR_AFTER_SENDS = 10;
const HEARTBEAT_TIMEOUT_MS = 5000;

const TOP_KEYS = new Set(['protocol', 'iface', 'rateHz', 'sourceName', 'sacn', 'artnet']);
const SACN_KEYS = new Set(['mode', 'universes', 'priority', 'ttl', 'targets']);
const ARTNET_KEYS = new Set(['base', 'targets', 'broadcast']);

function assertOnlyKeys(obj, allowed, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} option "${key}".`);
  }
}

function listNetworkInterfaces(osModule = os) {
  const raw = osModule.networkInterfaces();
  const seen = new Set();
  const list = [];
  for (const [name, entries] of Object.entries(raw || {})) {
    for (const entry of entries || []) {
      const isV4 = entry && (entry.family === 'IPv4' || entry.family === 4);
      if (!isV4 || !isValidIpv4(entry.address) || seen.has(entry.address)) continue;
      seen.add(entry.address);
      const internal = Boolean(entry.internal) || isLoopbackIpv4(entry.address);
      const netmask = isValidIpv4(entry.netmask) ? entry.netmask : (internal ? '255.0.0.0' : '255.255.255.0');
      list.push({
        name,
        address: entry.address,
        netmask,
        broadcast: computeBroadcast(entry.address, netmask),
        internal,
      });
    }
  }
  if (!seen.has('127.0.0.1')) {
    list.push({
      name: 'Loopback',
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      broadcast: null,
      internal: true,
    });
  }
  list.sort((a, b) => Number(a.internal) - Number(b.internal) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  return list;
}

function loadOrCreateCid(userDataDir) {
  const filePath = userDataDir ? path.join(userDataDir, 'dmx-cid.txt') : null;
  if (filePath) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8').trim();
      const bytes = uuidToBytes(existing);
      return { uuid: existing, bytes };
    } catch {
      // Missing or corrupted file — generate a fresh persistent CID below.
    }
  }
  const uuid = crypto.randomUUID();
  const bytes = uuidToBytes(uuid);
  if (filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, uuid + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Non-fatal: still use the generated CID for this session.
    }
  }
  return { uuid, bytes };
}

function validateTargets(rawTargets, label, ifaceEntry) {
  if (rawTargets === undefined) return [];
  if (!Array.isArray(rawTargets)) throw new Error(`${label} targets must be an array of IPv4 addresses.`);
  if (rawTargets.length > MAX_TARGETS) throw new Error(`At most ${MAX_TARGETS} ${label} targets are allowed.`);
  const out = [];
  const seen = new Set();
  for (const item of rawTargets) {
    if (typeof item !== 'string') throw new Error(`Invalid ${label} target IP.`);
    const ip = item.trim();
    if (!isValidIpv4(ip) || isReservedOrBroadcastIpv4(ip)) {
      throw new Error(`Invalid ${label} unicast target IP "${item}".`);
    }
    if (ifaceEntry) {
      if (ifaceEntry.broadcast && ip === ifaceEntry.broadcast) {
        throw new Error(`Invalid ${label} unicast target IP "${item}" (use Directed broadcast instead).`);
      }
      if (!ifaceEntry.internal && isLoopbackIpv4(ip)) {
        throw new Error(`Invalid ${label} unicast target IP "${item}" on non-loopback interface ${ifaceEntry.address}.`);
      }
      if (ifaceEntry.internal && !isLoopbackIpv4(ip)) {
        throw new Error(`Invalid ${label} unicast target IP "${item}" on loopback interface ${ifaceEntry.address}.`);
      }
    }
    if (!seen.has(ip)) {
      seen.add(ip);
      out.push(ip);
    }
  }
  return out;
}

function validateDmxConfig(raw, interfaces) {
  assertOnlyKeys(raw, TOP_KEYS, 'DMX config');
  const protocol = raw.protocol;
  if (protocol !== 'sacn' && protocol !== 'artnet') {
    throw new Error('DMX protocol must be "sacn" or "artnet".');
  }
  if (typeof raw.iface !== 'string') throw new Error('Choose a local network interface.');
  const ifaceEntry = interfaces.find((item) => item.address === raw.iface);
  if (!ifaceEntry) {
    throw new Error(`Network interface "${raw.iface}" is not available on this machine.`);
  }
  const rateHz = raw.rateHz === undefined ? 40 : raw.rateHz;
  if (typeof rateHz !== 'number' || !Number.isFinite(rateHz) || rateHz < 1 || rateHz > MAX_DMX_HZ) {
    throw new Error(`Refresh rate must be between 1 and ${MAX_DMX_HZ} Hz.`);
  }
  const clampedRateHz = Math.min(MAX_DMX_HZ, Math.max(1, Math.round(rateHz)));
  const sourceName = raw.sourceName === undefined ? 'StageForge' : truncateUtf8Bytes(raw.sourceName, 63) || 'StageForge';

  let sacn = null;
  let artnet = null;

  if (protocol === 'sacn') {
    assertOnlyKeys(raw.sacn, SACN_KEYS, 'sACN config');
    const mode = raw.sacn.mode;
    if (mode !== 'multicast' && mode !== 'unicast') {
      throw new Error('sACN mode must be "multicast" or "unicast".');
    }
    if (!Array.isArray(raw.sacn.universes) || raw.sacn.universes.length !== 2) {
      throw new Error('sACN universes must be a pair [u1, u2].');
    }
    const [u1, u2] = raw.sacn.universes;
    if (!Number.isInteger(u1) || u1 < 1 || u1 > 63999 || !Number.isInteger(u2) || u2 < 1 || u2 > 63999) {
      throw new Error('sACN universes must be integers between 1 and 63999.');
    }
    if (u1 === u2) {
      throw new Error('Universe 1 and Universe 2 must map to distinct sACN universes.');
    }
    const priority = raw.sacn.priority === undefined ? 100 : raw.sacn.priority;
    if (!Number.isInteger(priority) || priority < 0 || priority > 200) {
      throw new Error('sACN priority must be an integer between 0 and 200.');
    }
    const ttl = raw.sacn.ttl === undefined ? 1 : raw.sacn.ttl;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 255) {
      throw new Error('sACN multicast TTL must be an integer between 1 and 255.');
    }
    const targets = validateTargets(raw.sacn.targets, 'sACN', ifaceEntry);
    if (mode === 'unicast' && targets.length === 0) {
      throw new Error('Add at least one unicast IPv4 target for sACN unicast mode.');
    }
    sacn = { mode, universes: [u1, u2], priority, ttl, targets };
  } else {
    assertOnlyKeys(raw.artnet, ARTNET_KEYS, 'Art-Net config');
    const base = raw.artnet.base === undefined ? 0 : raw.artnet.base;
    if (!Number.isInteger(base) || base < 0 || base > 32766) {
      throw new Error('Art-Net base Port-Address must be an integer between 0 and 32766.');
    }
    const broadcast = Boolean(raw.artnet.broadcast);
    const targets = validateTargets(raw.artnet.targets, 'Art-Net', ifaceEntry);
    if (broadcast && !ifaceEntry.broadcast) {
      throw new Error('Art-Net directed broadcast is not available on the loopback interface. Use unicast 127.0.0.1.');
    }
    if (!broadcast && targets.length === 0) {
      throw new Error('Add at least one Art-Net node IPv4 address or enable directed broadcast.');
    }
    artnet = { base, targets, broadcast };
  }

  return {
    protocol,
    iface: ifaceEntry.address,
    ifaceInfo: ifaceEntry,
    rateHz: clampedRateHz,
    sourceName,
    sacn,
    artnet,
  };
}

function bindSocket(socket, options) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      socket.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      socket.off('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(options);
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket) return resolve();
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDmxController({
  userDataDir = null,
  onStatus = () => {},
  testPorts = null,
  artnetRx = null,
  osModule = os,
  dgramModule = dgram,
  nowNs = () => process.hrtime.bigint(),
  discoverDurationMs = 2600,
  blackoutPaceMs = BLACKOUT_PACE_MS,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
} = {}) {
  const cid = loadOrCreateCid(userDataDir);
  const ZERO_SLOTS = new Uint8Array(512);
  const heartbeatTimeoutNs = BigInt(Math.max(50, Math.round(heartbeatTimeoutMs))) * 1_000_000n;

  let state = 'idle'; // 'idle' | 'starting' | 'running' | 'stopping'
  let sessionGen = 0;
  let ownerId = null;
  let activeConfig = null;
  let socket = null;
  let loopTimer = null;
  let statsTimer = null;
  let nextDeadlineMs = 0;
  let lastSendNs = null;
  let lastHeartbeatNs = null;
  let lastStopReason = null;
  let lastStopOwnerId = null;
  let stopEventId = 0;
  let packetsSent = 0;
  let consecutiveSuccessSends = 0;
  let ticksInWindow = 0;
  let measuredHz = 0;
  let lastError = null;
  let degraded = false;
  let shutdownPromise = null;
  let discoverPromise = null;
  let activeDiscoverCancel = null;

  const buffers = [new Uint8Array(512), new Uint8Array(512)];
  const sacnSeq = [0, 0];
  const artnetSeq = [1, 1];
  const discoveredNodes = new Map();

  function hasHeartbeatExpired(now) {
    if (lastHeartbeatNs === null) return false;
    return (now - lastHeartbeatNs) >= heartbeatTimeoutNs;
  }

  function getStatus() {
    return {
      enabled: state === 'running',
      state: state === 'starting' ? 'idle' : state,
      protocol: activeConfig ? activeConfig.protocol : null,
      iface: activeConfig ? activeConfig.iface : null,
      rateHz: activeConfig ? activeConfig.rateHz : 0,
      measuredHz,
      packetsSent,
      degraded,
      lastError,
      lastStopReason,
      lastStopOwnerId,
      stopEventId,
      cid: cid.uuid,
      universes: activeConfig
        ? (activeConfig.protocol === 'sacn'
          ? [...activeConfig.sacn.universes]
          : [activeConfig.artnet.base, activeConfig.artnet.base + 1])
        : null,
      nodes: [...discoveredNodes.values()],
    };
  }

  function emitStatus(targetOwner = ownerId) {
    try {
      onStatus(getStatus(), targetOwner);
    } catch {
      // Never let a status subscriber break DMX pacing.
    }
  }

  function recordSendError(err) {
    degraded = true;
    consecutiveSuccessSends = 0;
    lastError = err && err.message ? `${err.code ? err.code + ': ' : ''}${err.message}` : 'UDP send error';
  }

  function sendPacket(sock, packet, port, host, trackHealth = true) {
    return new Promise((resolve) => {
      if (!sock) return resolve(false);
      try {
        sock.send(packet, port, host, (err) => {
          if (err) {
            if (trackHealth) recordSendError(err);
            resolve(false);
          } else {
            if (trackHealth) {
              packetsSent++;
              if (degraded) {
                consecutiveSuccessSends++;
                if (consecutiveSuccessSends >= DEGRADED_CLEAR_AFTER_SENDS) {
                  degraded = false;
                  lastError = null;
                }
              }
            }
            resolve(true);
          }
        });
      } catch (err) {
        if (trackHealth) recordSendError(err);
        resolve(false);
      }
    });
  }

  function buildUniversePackets(cfg, slotPair, optionsOverride = 0) {
    const out = [];
    const sacnPort = (testPorts && testPorts.sacn) || SACN_PORT;
    const artnetPort = (testPorts && testPorts.artnet) || ARTNET_PORT;

    if (cfg.protocol === 'sacn') {
      for (let idx = 0; idx < 2; idx++) {
        const universe = cfg.sacn.universes[idx];
        const seq = sacnSeq[idx];
        sacnSeq[idx] = (seq + 1) & 0xff;
        const packet = encodeSacnPacket({
          cid: cid.bytes,
          sourceName: cfg.sourceName,
          universe,
          slots: slotPair[idx],
          sequence: seq,
          priority: cfg.sacn.priority,
          options: optionsOverride,
        });
        if (cfg.sacn.mode === 'multicast') {
          out.push({ packet, port: sacnPort, host: sacnMulticastAddress(universe) });
        } else {
          for (const target of cfg.sacn.targets) {
            out.push({ packet, port: sacnPort, host: target });
          }
        }
      }
    } else {
      for (let idx = 0; idx < 2; idx++) {
        const portAddress = cfg.artnet.base + idx;
        const seq = artnetSeq[idx];
        // Art-Net sequence runs 1..255 and wraps to 1; 0 disables sequencing.
        artnetSeq[idx] = seq >= 255 ? 1 : seq + 1;
        const packet = encodeArtDmxPacket({
          portAddress,
          slots: slotPair[idx],
          sequence: seq,
          physical: idx,
        });
        for (const target of cfg.artnet.targets) {
          out.push({ packet, port: artnetPort, host: target });
        }
        if (cfg.artnet.broadcast && cfg.ifaceInfo.broadcast) {
          out.push({ packet, port: artnetPort, host: cfg.ifaceInfo.broadcast });
        }
      }
    }
    return out;
  }

  /**
   * Send one live tick if and only if the heartbeat lease is valid and the hard 44 Hz
   * inter-frame interval has elapsed.
   */
  function sendTick(optionsOverride = 0) {
    if (state !== 'running' || !socket || !activeConfig) return Promise.resolve(false);
    const now = nowNs();
    if (hasHeartbeatExpired(now)) {
      void shutdown('heartbeat-timeout');
      return Promise.resolve(false);
    }
    if (lastSendNs !== null && (now - lastSendNs) < MIN_FRAME_INTERVAL_NS) {
      return Promise.resolve(false);
    }
    lastSendNs = now;
    ticksInWindow++;
    const items = buildUniversePackets(activeConfig, buffers, optionsOverride);
    const sock = socket;
    return Promise.all(items.map((item) => sendPacket(sock, item.packet, item.port, item.host, true)))
      .then(() => true);
  }

  function scheduleNextTick(explicitDelayMs = null) {
    if (state !== 'running' || !activeConfig) return;
    const periodMs = Math.max(1000 / MAX_DMX_HZ, 1000 / activeConfig.rateHz);
    const nowMs = Number(nowNs()) / 1e6;
    let waitMs;
    if (explicitDelayMs !== null) {
      waitMs = Math.max(1, Math.ceil(explicitDelayMs));
    } else {
      if (nextDeadlineMs === 0 || nowMs - nextDeadlineMs > periodMs * 2) {
        nextDeadlineMs = nowMs + periodMs;
      } else {
        nextDeadlineMs += periodMs;
      }
      // Ceil ensures a scheduled tick never wakes early and gets dropped by the 44 Hz guard.
      waitMs = Math.max(1, Math.ceil(nextDeadlineMs - nowMs));
    }
    loopTimer = setTimeout(() => {
      loopTimer = null;
      if (state !== 'running' || !activeConfig) return;
      const now = nowNs();
      if (hasHeartbeatExpired(now)) {
        void shutdown('heartbeat-timeout');
        return;
      }
      if (lastSendNs !== null) {
        const elapsedNs = now - lastSendNs;
        if (elapsedNs < MIN_FRAME_INTERVAL_NS) {
          const remainMs = Number(MIN_FRAME_INTERVAL_NS - elapsedNs) / 1e6;
          scheduleNextTick(remainMs);
          return;
        }
      }
      void sendTick(0);
      scheduleNextTick();
    }, waitMs);
    if (typeof loopTimer.unref === 'function') loopTimer.unref();
  }

  async function enable(rawConfig, windowOwnerId) {
    // Reject overlapping start attempts so two callers can never bind sockets concurrently.
    if (state === 'starting') {
      throw new Error('DMX output is already starting.');
    }
    if (state === 'stopping' && shutdownPromise) {
      await shutdownPromise;
    }
    if (state === 'starting') {
      throw new Error('DMX output is already starting.');
    }
    if (state === 'running' && ownerId !== null && windowOwnerId !== undefined && ownerId !== windowOwnerId) {
      throw new Error('Live DMX output is already active in another StageForge window.');
    }

    // Validate BEFORE tearing down a running session so a bad reconfigure never blacks out a live show.
    const config = validateDmxConfig(rawConfig, listNetworkInterfaces(osModule));

    if (state === 'running') {
      await shutdown('reconfigure');
    }
    if (state !== 'idle') {
      throw new Error('DMX output is busy; try again.');
    }

    // Reserve ownership & session generation synchronously BEFORE any await so navigation/crash/
    // close/shutdown during bindSocket can cancel this enable cleanly.
    const myGen = ++sessionGen;
    state = 'starting';
    ownerId = windowOwnerId ?? null;

    const sock = dgramModule.createSocket({ type: 'udp4' });
    sock.on('error', (err) => {
      if (socket !== sock) return;
      recordSendError(err);
      emitStatus();
    });

    try {
      await bindSocket(sock, { port: 0, address: config.iface });
      if (state !== 'starting' || sessionGen !== myGen) {
        await closeSocket(sock);
        throw new Error('DMX output startup was cancelled.');
      }
      if (config.protocol === 'sacn' && config.sacn.mode === 'multicast') {
        sock.setMulticastTTL(config.sacn.ttl);
        sock.setMulticastInterface(config.iface);
      }
      if (config.protocol === 'artnet' && config.artnet.broadcast) {
        sock.setBroadcast(true);
      }
    } catch (err) {
      await closeSocket(sock);
      if (state === 'starting' && sessionGen === myGen) {
        state = 'idle';
        ownerId = null;
      }
      if (err instanceof Error && err.message === 'DMX output startup was cancelled.') throw err;
      throw new Error(`Could not bind UDP socket on ${config.iface}: ${err instanceof Error ? err.message : String(err)}`);
    }

    socket = sock;
    activeConfig = config;
    state = 'running';
    lastSendNs = null;
    lastHeartbeatNs = nowNs();
    lastStopReason = null;
    lastStopOwnerId = null;
    nextDeadlineMs = 0;
    packetsSent = 0;
    consecutiveSuccessSends = 0;
    ticksInWindow = 0;
    measuredHz = 0;
    lastError = null;
    degraded = false;

    // Emit the initial tick right away (starts at zeros until renderer sends a frame).
    void sendTick(0);
    scheduleNextTick();

    statsTimer = setInterval(() => {
      if (state === 'running' && hasHeartbeatExpired(nowNs())) {
        void shutdown('heartbeat-timeout');
        return;
      }
      measuredHz = ticksInWindow;
      ticksInWindow = 0;
      emitStatus();
    }, 1000);
    if (typeof statsTimer.unref === 'function') statsTimer.unref();

    emitStatus();
    return getStatus();
  }

  function heartbeat() {
    if (state !== 'running') return false;
    const now = nowNs();
    // Never let a late heartbeat revive an already-expired lease.
    if (hasHeartbeatExpired(now)) {
      void shutdown('heartbeat-timeout');
      return false;
    }
    lastHeartbeatNs = now;
    return true;
  }

  function update(universe, data) {
    if (state !== 'running') return false;
    if (universe !== 1 && universe !== 2) return false;
    if (!(data instanceof Uint8Array) || data.byteLength !== 512) return false;
    buffers[universe - 1].set(data);
    return true;
  }

  function shutdown(reason = 'disable') {
    if (state === 'stopping' && shutdownPromise) return shutdownPromise;

    // If an enable() is currently mid-bind, invalidate its generation so it aborts and closes.
    if (state === 'starting') {
      const prevOwner = ownerId;
      sessionGen++;
      state = 'idle';
      ownerId = null;
      lastHeartbeatNs = null;
      lastStopReason = reason;
      lastStopOwnerId = prevOwner;
      stopEventId++;
      emitStatus(prevOwner);
      return Promise.resolve(getStatus());
    }

    if (state === 'idle') return Promise.resolve(getStatus());

    sessionGen++;
    state = 'stopping';
    lastHeartbeatNs = null;
    lastStopReason = reason;
    lastStopOwnerId = ownerId;
    stopEventId++;
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }

    const closingSocket = socket;
    const closingConfig = activeConfig;
    const prevOwner = ownerId;
    const prevLastSendNs = lastSendNs;
    // Detach global references immediately so nothing in blackout can ever touch a future session.
    socket = null;
    activeConfig = null;
    emitStatus(prevOwner);

    let cancelled = false;
    const zeroPair = [ZERO_SLOTS, ZERO_SLOTS];

    // Self-contained send bound strictly to closingSocket & closingConfig.
    const sendClosingTick = (optionsOverride) => {
      if (cancelled || !closingSocket || !closingConfig) return Promise.resolve();
      const items = buildUniversePackets(closingConfig, zeroPair, optionsOverride);
      return Promise.all(items.map((item) => sendPacket(closingSocket, item.packet, item.port, item.host, false)))
        .then(() => undefined);
    };

    const runBlackout = async () => {
      try {
        buffers[0].fill(0);
        buffers[1].fill(0);

        // Respect the hard 44 Hz ceiling even on the transition from the last live tick to blackout.
        if (prevLastSendNs !== null) {
          const elapsedNs = nowNs() - prevLastSendNs;
          if (elapsedNs >= 0n && elapsedNs < MIN_FRAME_INTERVAL_NS) {
            const waitMs = Math.ceil(Number(MIN_FRAME_INTERVAL_NS - elapsedNs) / 1e6);
            if (waitMs > 0) await delay(waitMs);
            if (cancelled) return;
          }
        }

        // 1. Send 3 paced all-zero data ticks FIRST (sACN receivers ignore slot data inside
        //    Stream_Terminated packets and many fixtures hold the last look on termination).
        const pace = Math.max(23, Math.round(blackoutPaceMs));
        for (let i = 0; i < BLACKOUT_TICKS; i++) {
          if (cancelled) return;
          if (i > 0) await delay(pace);
          if (cancelled) return;
          await sendClosingTick(0);
        }

        // 2. For sACN, follow with 3 Stream_Terminated (0x40) packets per ANSI E1.31-2018.
        if (closingConfig && closingConfig.protocol === 'sacn') {
          for (let i = 0; i < SACN_TERMINATE_TICKS; i++) {
            if (cancelled) return;
            await delay(pace);
            if (cancelled) return;
            await sendClosingTick(SACN_OPT_STREAM_TERMINATED);
          }
        }
      } catch {
        // Best-effort blackout even if socket errored mid-shutdown.
      } finally {
        await closeSocket(closingSocket);
      }
    };

    const timeoutGuard = delay(shutdownTimeoutMs).then(() => {
      cancelled = true;
      return closeSocket(closingSocket);
    });

    const timed = Promise.race([runBlackout(), timeoutGuard]).finally(() => {
      cancelled = true;
      ownerId = null;
      measuredHz = 0;
      ticksInWindow = 0;
      consecutiveSuccessSends = 0;
      lastSendNs = null;
      nextDeadlineMs = 0;
      state = 'idle';
      shutdownPromise = null;
      emitStatus(prevOwner);
    });

    shutdownPromise = timed.then(() => getStatus());
    return shutdownPromise;
  }

  function discover(ifaceAddress) {
    // Coalesce concurrent discovery scans so two binds never fight over UDP 6454.
    if (discoverPromise) return discoverPromise;
    discoverPromise = runDiscover(ifaceAddress).finally(() => {
      discoverPromise = null;
    });
    return discoverPromise;
  }

  async function runDiscover(ifaceAddress) {
    const interfaces = listNetworkInterfaces(osModule);
    const ifaceEntry = interfaces.find((item) => item.address === ifaceAddress);
    if (!ifaceEntry) {
      throw new Error(`Network interface "${String(ifaceAddress)}" is not available on this machine.`);
    }

    discoveredNodes.clear();
    const sendSock = dgramModule.createSocket({ type: 'udp4' });
    let listenSock = null;
    let warning = null;

    const handleReply = (msg, rinfo) => {
      if (discoveredNodes.size >= MAX_DISCOVERED_NODES) return;
      if (!ifaceEntry.internal && !isInSubnet(rinfo.address, ifaceEntry.address, ifaceEntry.netmask)) {
        return;
      }
      if (ifaceEntry.internal && !isLoopbackIpv4(rinfo.address)) return;
      const node = parseArtPollReply(msg, rinfo.address);
      if (!node) return;
      const key = `${node.ip}:${node.bindIndex}`;
      discoveredNodes.set(key, node);
    };

    sendSock.on('error', () => {});
    sendSock.on('message', handleReply);

    try {
      await bindSocket(sendSock, { port: 0, address: ifaceEntry.address });
      if (ifaceEntry.broadcast) {
        sendSock.setBroadcast(true);
      }
    } catch (err) {
      await closeSocket(sendSock);
      throw new Error(`Could not open discovery socket on ${ifaceEntry.address}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Attempt exclusive bind on UDP 6454 (0.0.0.0) so directed broadcasts arrive on all OSes.
    // If the shared Art-Net RX multiplexer already holds port 6454 (e.g., Art-Net TC RX active),
    // subscribe to OpPollReply (0x2100) on that socket instead of colliding with ourselves.
    // Never set reuseAddr: on Windows SO_REUSEADDR can steal port 6454 from a running QLC+/console.
    const discoveryBindPort = (testPorts && testPorts.artnetDiscovery !== undefined)
      ? testPorts.artnetDiscovery
      : ARTNET_PORT;
    let releaseSharedRx = null;
    if (discoveryBindPort > 0) {
      if (artnetRx && artnetRx.isBound && (artnetRx.port === discoveryBindPort || (testPorts && testPorts.artnetDiscovery === undefined))) {
        try {
          const handle = await artnetRx.acquire(ARTNET_OPCODE_POLL_REPLY, handleReply, { port: discoveryBindPort });
          releaseSharedRx = handle.release;
        } catch {
          // Fall back to direct ephemeral reply listening.
        }
      } else {
        const candidate = dgramModule.createSocket({ type: 'udp4' });
        candidate.on('error', () => {});
        candidate.on('message', handleReply);
        try {
          await bindSocket(candidate, { port: discoveryBindPort, address: '0.0.0.0', exclusive: true });
          listenSock = candidate;
        } catch (err) {
          await closeSocket(candidate);
          if (err && err.code === 'EADDRINUSE') {
            warning = 'Discovery unavailable on UDP 6454 — another Art-Net app owns port 6454 on this machine. Enter node IPs manually.';
          }
        }
      }
    }

    const pollPacket = encodeArtPollPacket({ flags: 0x00, diagPriority: 0x00 });
    const targetIp = ifaceEntry.broadcast || ifaceEntry.address;
    const targetPort = (testPorts && testPorts.artnet) || ARTNET_PORT;

    const sendPoll = () => {
      try {
        sendSock.send(pollPacket, targetPort, targetIp, () => {});
      } catch {
        // ignore transient send errors during discovery
      }
    };

    sendPoll();
    const secondPollDelay = Math.min(1500, Math.floor(discoverDurationMs / 2));

    await new Promise((resolve) => {
      const secondTimer = setTimeout(sendPoll, secondPollDelay);
      const endTimer = setTimeout(() => {
        activeDiscoverCancel = null;
        resolve();
      }, discoverDurationMs);
      activeDiscoverCancel = () => {
        clearTimeout(secondTimer);
        clearTimeout(endTimer);
        resolve();
      };
    });

    await Promise.all([
      closeSocket(sendSock),
      closeSocket(listenSock),
      releaseSharedRx ? releaseSharedRx().catch(() => {}) : Promise.resolve(),
    ]);
    const nodes = [...discoveredNodes.values()];
    emitStatus();
    return { nodes, warning };
  }

  function cancelDiscover() {
    if (activeDiscoverCancel) {
      activeDiscoverCancel();
      activeDiscoverCancel = null;
    }
  }

  return {
    get cid() { return cid.uuid; },
    get ownerId() { return ownerId; },
    get active() { return state === 'starting' || state === 'running' || state === 'stopping'; },
    isRunning() { return state === 'running'; },
    listInterfaces: () => listNetworkInterfaces(osModule),
    getStatus,
    enable,
    heartbeat,
    update,
    shutdown,
    discover,
    cancelDiscover,
    // Exposed for direct unit testing of the hard 44 Hz guard and heartbeat lease without OS timer jitter.
    _sendTickForTest: () => sendTick(0),
    _getShutdownPromiseForTest: () => shutdownPromise,
  };
}

module.exports = {
  MAX_TARGETS,
  MAX_DISCOVERED_NODES,
  BLACKOUT_TICKS,
  SACN_TERMINATE_TICKS,
  HEARTBEAT_TIMEOUT_MS,
  listNetworkInterfaces,
  loadOrCreateCid,
  validateDmxConfig,
  createDmxController,
};
