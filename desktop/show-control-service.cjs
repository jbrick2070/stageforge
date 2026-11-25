'use strict';

// Main-process Show Control service: OSC 1.0 UDP receiver/sender and Art-Net 4 OpTimeCode RX/TX.
// Defaults OFF at launch, binds explicitly to 127.0.0.1 unless allowAllInterfaces is enabled,
// enforces per-source token-bucket rate limits and <= 60 Hz timecode coalescing before IPC,
// and tears down sockets cleanly on stop, navigation, renderer crash, window close or quit.

const dgram = require('node:dgram');
const {
  ARTNET_PORT,
  isValidIpv4,
  isReservedOrBroadcastIpv4,
} = require('./dmx-packets.cjs');
const {
  ARTNET_OPCODE_TIMECODE,
  fpsToSmpteType,
  msToSmpte,
  formatSmpte,
  encodeArtNetTimecode,
  decodeArtNetTimecode,
  encodeOscMessage,
  decodeOscPacket,
  normalizeOscMessage,
} = require('./osc-packets.cjs');

const DEFAULT_OSC_PORT = 8000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const OSC_RATE_LIMIT_PER_SEC = 500;
const OSC_AGGREGATE_RATE_LIMIT_PER_SEC = 1000;
const OSC_DATAGRAM_RATE_LIMIT_PER_SEC = 1000;
const ARTNET_TC_RATE_LIMIT_PER_SEC = 120;
const ARTNET_TC_AGGREGATE_RATE_LIMIT_PER_SEC = 240;
const OVERFLOW_RATE_LIMIT_PER_SEC = 100;
const TC_IPC_MIN_INTERVAL_MS = 1000 / 60; // Coalesce TC to <= 60 Hz before IPC.

const CONFIG_KEYS = new Set([
  'oscRxEnabled',
  'oscPort',
  'oscAllowAllInterfaces',
  'oscTxEnabled',
  'oscTxHost',
  'oscTxPort',
  'artnetTcRxEnabled',
  'artnetTcTxEnabled',
  'artnetTcTxHost',
]);

const SEND_KEYS = new Set(['kind', 'cue', 'timecode', 'bpm', 'clock', 'ms', 'fps']);

function assertOnlyKeys(obj, allowed, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} option "${key}".`);
  }
}

function defaultMonotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function createTokenBucket(ratePerSec, nowMs = defaultMonotonicMs, initialTokens = ratePerSec) {
  let tokens = Math.max(0, Math.min(ratePerSec, initialTokens));
  let lastRefill = nowMs();
  function refill() {
    const now = nowMs();
    if (now < lastRefill) {
      // Guard against backwards system-clock jumps on injected non-monotonic clocks.
      lastRefill = now;
      return;
    }
    const elapsed = now - lastRefill;
    if (elapsed > 0) {
      tokens = Math.min(ratePerSec, tokens + (elapsed / 1000) * ratePerSec);
      lastRefill = now;
    }
  }
  return {
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    refund() {
      tokens = Math.min(ratePerSec, tokens + 1);
    },
    isFull() {
      refill();
      return tokens >= ratePerSec - 1e-6;
    },
    currentTokens() {
      refill();
      return tokens;
    },
  };
}

function validatePort(value, label, allowZero = false) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer port.`);
  if (allowZero && value === 0) return 0;
  if (value < MIN_PORT || value > MAX_PORT) {
    throw new Error(`${label} must be between ${MIN_PORT} and ${MAX_PORT}.`);
  }
  return value;
}

function validateTargetHost(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an IPv4 address.`);
  const ip = value.trim();
  if (!isValidIpv4(ip) || isReservedOrBroadcastIpv4(ip)) {
    throw new Error(`Invalid ${label} IPv4 address "${value}".`);
  }
  return ip;
}

const MAX_RATE_BUCKET_SOURCES = 64;
const TX_RATE_LIMIT_PER_SEC = 120;
const DAY_MS = 86_400_000;

function createPerSourceTokenBuckets(ratePerSec, aggregateRatePerSec, nowMs = defaultMonotonicMs, overflowRatePerSec = OVERFLOW_RATE_LIMIT_PER_SEC) {
  const buckets = new Map();
  const aggregate = createTokenBucket(aggregateRatePerSec, nowMs);
  const overflow = createTokenBucket(overflowRatePerSec, nowMs);
  return function take(sourceKey) {
    const key = typeof sourceKey === 'string' && sourceKey ? sourceKey : 'unknown';
    let bucket = buckets.get(key);
    if (bucket) {
      // Known source: enforce per-source limit BEFORE aggregate so one noisy host cannot drain the shared aggregate bucket.
      if (!bucket.take()) return false;
      if (!aggregate.take()) {
        bucket.refund();
        return false;
      }
      return true;
    }
    // New source: enforce aggregate budget BEFORE mutating the map so spoofed IPs cannot churn memory,
    // and refund aggregate if the new/overflow bucket rejects so legitimate tracked hosts are not starved.
    if (!aggregate.take()) return false;
    if (buckets.size < MAX_RATE_BUCKET_SOURCES) {
      bucket = createTokenBucket(ratePerSec, nowMs);
      buckets.set(key, bucket);
    } else {
      // Only evict an idle source whose bucket has refilled to full; otherwise route to the shared overflow bucket.
      let idleKey = null;
      for (const [k, b] of buckets) {
        if (b.isFull()) {
          idleKey = k;
          break;
        }
      }
      if (idleKey !== null) {
        buckets.delete(idleKey);
        // Carry overflow pressure into promoted entries so rotating 65+ addresses cannot regain full fresh budgets.
        const seedTokens = Math.min(ratePerSec, overflow.currentTokens());
        bucket = createTokenBucket(ratePerSec, nowMs, seedTokens);
        buckets.set(key, bucket);
      } else {
        if (!overflow.take()) {
          aggregate.refund();
          return false;
        }
        return true;
      }
    }
    if (!bucket.take()) {
      aggregate.refund();
      return false;
    }
    return true;
  };
}

function validateBool(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function validateShowControlConfig(raw, { allowZeroPort = false } = {}) {
  assertOnlyKeys(raw, CONFIG_KEYS, 'Show control config');
  const oscRxEnabled = validateBool(raw.oscRxEnabled, 'oscRxEnabled', false);
  const oscPort = raw.oscPort === undefined ? DEFAULT_OSC_PORT : validatePort(raw.oscPort, 'OSC receive port', allowZeroPort);
  const oscAllowAllInterfaces = validateBool(raw.oscAllowAllInterfaces, 'oscAllowAllInterfaces', false);
  const oscTxEnabled = validateBool(raw.oscTxEnabled, 'oscTxEnabled', false);
  // Only reject bad TX hosts/ports when the matching TX path is actually enabled (M-C).
  let oscTxHost = '127.0.0.1';
  if (raw.oscTxHost !== undefined) {
    if (oscTxEnabled) oscTxHost = validateTargetHost(raw.oscTxHost, 'OSC feedback host');
    else {
      try { oscTxHost = validateTargetHost(raw.oscTxHost, 'OSC feedback host'); } catch { oscTxHost = '127.0.0.1'; }
    }
  }
  const oscTxPort = raw.oscTxPort === undefined
    ? 9000
    : (oscTxEnabled ? validatePort(raw.oscTxPort, 'OSC feedback port', false) : (Number.isInteger(raw.oscTxPort) && raw.oscTxPort >= MIN_PORT && raw.oscTxPort <= MAX_PORT ? raw.oscTxPort : 9000));
  const artnetTcRxEnabled = validateBool(raw.artnetTcRxEnabled, 'artnetTcRxEnabled', false);
  const artnetTcTxEnabled = validateBool(raw.artnetTcTxEnabled, 'artnetTcTxEnabled', false);
  let artnetTcTxHost = '127.0.0.1';
  if (raw.artnetTcTxHost !== undefined) {
    if (artnetTcTxEnabled) artnetTcTxHost = validateTargetHost(raw.artnetTcTxHost, 'Art-Net TC host');
    else {
      try { artnetTcTxHost = validateTargetHost(raw.artnetTcTxHost, 'Art-Net TC host'); } catch { artnetTcTxHost = '127.0.0.1'; }
    }
  }
  return {
    oscRxEnabled,
    oscPort,
    oscAllowAllInterfaces,
    oscTxEnabled,
    oscTxHost,
    oscTxPort,
    artnetTcRxEnabled,
    artnetTcTxEnabled,
    artnetTcTxHost,
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

function createShowControlService({
  artnetRx,
  onEvent = () => {},
  onStatus = () => {},
  dgramModule = dgram,
  testPorts = null,
  allowZeroPort = false,
  nowMs = null,
} = {}) {
  const monotonicNowMs = typeof nowMs === 'function' ? nowMs : defaultMonotonicMs;
  const eventNowMs = typeof nowMs === 'function' ? nowMs : () => Date.now();
  let ownerId = null;
  let configGen = 0;
  let oscRxSocket = null;
  let oscRxBoundPort = null;
  let oscRxBindAddress = null;
  let txSocket = null;
  let artnetTcRelease = null;
  let artnetTcBoundPort = null;
  let activeConfig = {
    oscRxEnabled: false,
    oscPort: DEFAULT_OSC_PORT,
    oscAllowAllInterfaces: false,
    oscTxEnabled: false,
    oscTxHost: '127.0.0.1',
    oscTxPort: 9000,
    artnetTcRxEnabled: false,
    artnetTcTxEnabled: false,
    artnetTcTxHost: '127.0.0.1',
  };
  let oscError = null;
  let artnetTcError = null;
  let oscRxCount = 0;
  let oscDroppedCount = 0;
  let artnetTcRxCount = 0;
  let lastTcEmitAt = 0;
  let pendingTcEvent = null;
  let tcCoalesceTimer = null;
  let opQueue = Promise.resolve();

  // Per-sender IP + aggregate + shared overflow token buckets so neither a noisy host nor 65+ spoofed IPs can bypass limits.
  const takeOscDatagramToken = createPerSourceTokenBuckets(OSC_RATE_LIMIT_PER_SEC, OSC_DATAGRAM_RATE_LIMIT_PER_SEC, monotonicNowMs);
  const takeOscToken = createPerSourceTokenBuckets(OSC_RATE_LIMIT_PER_SEC, OSC_AGGREGATE_RATE_LIMIT_PER_SEC, monotonicNowMs);
  const takeTcToken = createPerSourceTokenBuckets(ARTNET_TC_RATE_LIMIT_PER_SEC, ARTNET_TC_AGGREGATE_RATE_LIMIT_PER_SEC, monotonicNowMs);
  const txBucket = createTokenBucket(TX_RATE_LIMIT_PER_SEC, monotonicNowMs);
  const takeTxToken = () => txBucket.take();

  function isActive() {
    return Boolean(oscRxSocket || artnetTcRelease || txSocket);
  }

  function getStatus() {
    return {
      active: isActive(),
      oscRxListening: oscRxSocket !== null,
      oscRxPort: oscRxBoundPort,
      oscRxAddress: oscRxBindAddress,
      oscTxEnabled: Boolean(activeConfig.oscTxEnabled && txSocket),
      oscTxHost: activeConfig.oscTxHost,
      oscTxPort: activeConfig.oscTxPort,
      artnetTcRxListening: artnetTcRelease !== null,
      artnetTcRxPort: artnetTcBoundPort,
      artnetTcTxEnabled: Boolean(activeConfig.artnetTcTxEnabled && txSocket),
      artnetTcTxHost: activeConfig.artnetTcTxHost,
      oscRxCount,
      oscDroppedCount,
      artnetTcRxCount,
      oscError,
      artnetTcError,
    };
  }

  function emitStatus(targetOwner = ownerId) {
    try {
      onStatus(getStatus(), targetOwner);
    } catch {
      // Never let a subscriber error crash main.
    }
  }

  function emitEvent(event, targetOwner = ownerId) {
    if (targetOwner === null) return;
    try {
      onEvent(event, targetOwner);
    } catch {
      // Isolate subscriber errors.
    }
  }

  function clearTcCoalesce() {
    if (tcCoalesceTimer) {
      clearTimeout(tcCoalesceTimer);
      tcCoalesceTimer = null;
    }
    pendingTcEvent = null;
  }

  function queueTimecodeEvent(event) {
    const now = monotonicNowMs();
    if (now < lastTcEmitAt) lastTcEmitAt = now;
    const elapsed = now - lastTcEmitAt;
    if (elapsed >= TC_IPC_MIN_INTERVAL_MS) {
      lastTcEmitAt = now;
      pendingTcEvent = null;
      emitEvent(event);
      return;
    }
    pendingTcEvent = event;
    if (!tcCoalesceTimer) {
      const wait = Math.max(1, Math.ceil(TC_IPC_MIN_INTERVAL_MS - elapsed));
      tcCoalesceTimer = setTimeout(() => {
        tcCoalesceTimer = null;
        if (!pendingTcEvent || !artnetTcRelease) return;
        const next = pendingTcEvent;
        pendingTcEvent = null;
        lastTcEmitAt = monotonicNowMs();
        emitEvent(next);
      }, wait);
      if (typeof tcCoalesceTimer.unref === 'function') tcCoalesceTimer.unref();
    }
  }

  function handleOscDatagram(msg, rinfo) {
    const senderKey = rinfo && rinfo.address ? rinfo.address : 'unknown';
    // Budget datagrams BEFORE decoding so malformed UDP floods are dropped cheaply.
    if (!takeOscDatagramToken(senderKey)) {
      oscDroppedCount++;
      return;
    }
    const packets = decodeOscPacket(msg);
    if (!packets) {
      oscDroppedCount++;
      return;
    }
    const at = eventNowMs();
    for (const oscMsg of packets) {
      if (!takeOscToken(senderKey)) {
        oscDroppedCount++;
        return;
      }
      const normalized = normalizeOscMessage(oscMsg, at);
      if (normalized) {
        normalized.sender = senderKey;
        oscRxCount++;
        emitEvent(normalized);
      } else {
        oscDroppedCount++;
      }
    }
  }

  function handleArtNetTcDatagram(msg, rinfo) {
    const senderKey = rinfo && rinfo.address ? rinfo.address : 'unknown';
    if (!takeTcToken(senderKey)) return;
    const decoded = decodeArtNetTimecode(msg);
    if (!decoded) return;
    artnetTcRxCount++;
    queueTimecodeEvent({
      source: 'artnetTC',
      kind: 'timecode',
      ms: decoded.ms,
      fps: decoded.fps,
      hours: decoded.hours,
      minutes: decoded.minutes,
      seconds: decoded.seconds,
      frames: decoded.frames,
      at: eventNowMs(),
    });
  }

  async function teardownSockets() {
    clearTcCoalesce();
    const prevOsc = oscRxSocket;
    const prevTx = txSocket;
    const prevRelease = artnetTcRelease;
    oscRxSocket = null;
    oscRxBoundPort = null;
    oscRxBindAddress = null;
    txSocket = null;
    artnetTcRelease = null;
    artnetTcBoundPort = null;
    await Promise.all([
      closeSocket(prevOsc),
      closeSocket(prevTx),
      prevRelease ? prevRelease().catch(() => {}) : Promise.resolve(),
    ]);
  }

  function configure(rawConfig, windowOwnerId) {
    // Validate synchronously before queueing so invalid input never tears down active listeners.
    const nextConfig = validateShowControlConfig(rawConfig, { allowZeroPort });
    const run = opQueue.then(() => applyConfigure(nextConfig, windowOwnerId));
    opQueue = run.catch(() => {});
    return run;
  }

  async function applyConfigure(nextConfig, windowOwnerId) {
    if (isActive() && ownerId !== null && windowOwnerId !== undefined && ownerId !== windowOwnerId) {
      throw new Error('Show control is already owned by another StageForge window.');
    }
    const myGen = ++configGen;

    await teardownSockets();
    if (configGen !== myGen) {
      throw new Error('Show control configuration was superseded.');
    }

    activeConfig = nextConfig;
    oscError = null;
    artnetTcError = null;
    const wantsAny = nextConfig.oscRxEnabled || nextConfig.oscTxEnabled ||
      nextConfig.artnetTcRxEnabled || nextConfig.artnetTcTxEnabled;
    ownerId = wantsAny ? (windowOwnerId ?? null) : null;

    if (nextConfig.oscRxEnabled) {
      const bindAddr = nextConfig.oscAllowAllInterfaces ? '0.0.0.0' : '127.0.0.1';
      const sock = dgramModule.createSocket({ type: 'udp4' });
      sock.on('error', (err) => {
        if (oscRxSocket !== sock) return;
        oscError = err && err.message ? err.message : 'OSC UDP error';
        emitStatus();
      });
      sock.on('message', handleOscDatagram);
      try {
        await bindSocket(sock, { port: nextConfig.oscPort, address: bindAddr, exclusive: true });
        if (configGen !== myGen) {
          await closeSocket(sock);
          throw new Error('Show control configuration was superseded.');
        }
        oscRxSocket = sock;
        const addr = sock.address();
        oscRxBoundPort = addr && typeof addr === 'object' ? addr.port : nextConfig.oscPort;
        oscRxBindAddress = bindAddr;
      } catch (err) {
        await closeSocket(sock);
        if (err instanceof Error && err.message === 'Show control configuration was superseded.') throw err;
        oscError = err && err.code === 'EADDRINUSE'
          ? `OSC port ${nextConfig.oscPort} is busy (another app owns it).`
          : `Could not bind OSC UDP ${bindAddr}:${nextConfig.oscPort}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (nextConfig.artnetTcRxEnabled) {
      if (!artnetRx) {
        artnetTcError = 'Art-Net receiver is unavailable.';
      } else {
        const tcPort = (testPorts && testPorts.artnetRx !== undefined) ? testPorts.artnetRx : ARTNET_PORT;
        try {
          const handle = await artnetRx.acquire(ARTNET_OPCODE_TIMECODE, handleArtNetTcDatagram, { port: tcPort });
          if (configGen !== myGen) {
            await handle.release();
            throw new Error('Show control configuration was superseded.');
          }
          artnetTcRelease = handle.release;
          artnetTcBoundPort = handle.port;
        } catch (err) {
          if (err instanceof Error && err.message === 'Show control configuration was superseded.') throw err;
          artnetTcError = err && err.code === 'EADDRINUSE'
            ? 'Art-Net timecode port 6454 is busy (another Art-Net app owns UDP 6454).'
            : `Could not bind Art-Net UDP ${tcPort}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    if (nextConfig.oscTxEnabled || nextConfig.artnetTcTxEnabled) {
      const sock = dgramModule.createSocket({ type: 'udp4' });
      sock.on('error', () => {});
      try {
        await bindSocket(sock, { port: 0, address: '0.0.0.0' });
        if (configGen !== myGen) {
          await closeSocket(sock);
          throw new Error('Show control configuration was superseded.');
        }
        txSocket = sock;
      } catch (err) {
        await closeSocket(sock);
        if (err instanceof Error && err.message === 'Show control configuration was superseded.') throw err;
        oscError = oscError || `Could not open outbound UDP socket: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (!isActive()) ownerId = null;
    emitStatus(windowOwnerId ?? ownerId);
    return getStatus();
  }

  function sendUdp(packet, port, host) {
    if (!txSocket) return false;
    try {
      txSocket.send(packet, port, host, () => {});
      return true;
    } catch {
      return false;
    }
  }

  function send(payload) {
    assertOnlyKeys(payload, SEND_KEYS, 'Show control send');
    if (payload.kind === 'timecode') {
      // Validate arguments BEFORE spending TX token or checking enabled state (H-A).
      if (typeof payload.ms !== 'number' || !Number.isFinite(payload.ms) || payload.ms < 0 || payload.ms >= DAY_MS) {
        throw new Error('Invalid timecode ms.');
      }
      if (fpsToSmpteType(payload.fps) < 0) {
        throw new Error('Invalid SMPTE frame rate.');
      }
      if (!activeConfig.artnetTcTxEnabled || !txSocket || !takeTxToken()) return false;
      const tc = msToSmpte(payload.ms, payload.fps);
      if (!tc) return false;
      const pkt = encodeArtNetTimecode(tc);
      const port = (testPorts && testPorts.artnetTcTx) || ARTNET_PORT;
      return sendUdp(pkt, port, activeConfig.artnetTcTxHost);
    }
    if (payload.kind === 'feedback') {
      if (!activeConfig.oscTxEnabled || !txSocket || !takeTxToken()) return false;
      let sent = false;
      if (typeof payload.cue === 'string' && payload.cue.length <= 256) {
        sent = sendUdp(encodeOscMessage('/stageforge/state/cue', [{ type: 's', value: payload.cue }]), activeConfig.oscTxPort, activeConfig.oscTxHost) || sent;
      }
      if (typeof payload.timecode === 'string' && payload.timecode.length <= 32) {
        sent = sendUdp(encodeOscMessage('/stageforge/state/timecode', [{ type: 's', value: payload.timecode }]), activeConfig.oscTxPort, activeConfig.oscTxHost) || sent;
      }
      if (typeof payload.bpm === 'number' && Number.isFinite(payload.bpm) && payload.bpm >= 70 && payload.bpm <= 180) {
        sent = sendUdp(encodeOscMessage('/stageforge/state/bpm', [{ type: 'f', value: payload.bpm }]), activeConfig.oscTxPort, activeConfig.oscTxHost) || sent;
      }
      if (typeof payload.clock === 'string' && ['master', 'chase', 'caller'].includes(payload.clock)) {
        sent = sendUdp(encodeOscMessage('/stageforge/state/clock', [{ type: 's', value: payload.clock }]), activeConfig.oscTxPort, activeConfig.oscTxHost) || sent;
      }
      return sent;
    }
    throw new Error(`Unknown show control send kind "${String(payload.kind)}".`);
  }

  function shutdown() {
    configGen++;
    const run = opQueue.then(async () => {
      const prevOwner = ownerId;
      activeConfig = {
        ...activeConfig,
        oscRxEnabled: false,
        oscTxEnabled: false,
        artnetTcRxEnabled: false,
        artnetTcTxEnabled: false,
      };
      ownerId = null;
      oscError = null;
      artnetTcError = null;
      await teardownSockets();
      emitStatus(prevOwner);
      return getStatus();
    });
    opQueue = run.catch(() => {});
    return run;
  }

  return {
    get ownerId() { return ownerId; },
    get active() { return isActive(); },
    getStatus,
    configure,
    send,
    shutdown,
    formatSmpte,
  };
}

module.exports = {
  DEFAULT_OSC_PORT,
  OSC_RATE_LIMIT_PER_SEC,
  OSC_AGGREGATE_RATE_LIMIT_PER_SEC,
  OSC_DATAGRAM_RATE_LIMIT_PER_SEC,
  ARTNET_TC_RATE_LIMIT_PER_SEC,
  ARTNET_TC_AGGREGATE_RATE_LIMIT_PER_SEC,
  validateShowControlConfig,
  createShowControlService,
};
