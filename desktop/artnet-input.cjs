'use strict';

const { isIPv4 } = require('node:net');
const { performance } = require('node:perf_hooks');
const { ARTNET_OPCODE_DMX, ARTNET_PORT, decodeArtDmxPacket } = require('./dmx-packets.cjs');
const { isAuthorizedDmxSender } = require('./dmx-ipc.cjs');
const { isDmxAuthority, sameAuthority } = require('./output-interlock.cjs');

const INPUT_TIMEOUT_MS = 3000;
const INPUT_TICK_MS = 17;
const MAX_COUNTER = 0xffffffff;
const maxCounter = (value, by = 1) => Math.min(MAX_COUNTER, value + by);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const pinIsIPv4 = (address) => typeof address === 'string' && isIPv4(address) &&
  Number(address.split('.', 1)[0]) > 0 && Number(address.split('.', 1)[0]) < 224;

function validateInputConfig(config, interfaces) {
  if (!exact(config, ['binding', 'address', 'mappings']) || typeof config.address !== 'string' ||
      !Array.isArray(config.mappings) || config.mappings.length < 1 || config.mappings.length > 16) {
    throw new Error('Invalid Art-Net input configuration.');
  }
  const { binding, address } = config;
  if ((binding === 'loopback' && address === '127.0.0.1') || (binding === 'all' && address === '0.0.0.0')) {
    // All interfaces is intentional, never inferred from a missing address.
  } else if (binding !== 'interface' || !pinIsIPv4(address) || address.startsWith('127.') ||
      !interfaces.some((entry) => !entry.internal && entry.address === address)) {
    throw new Error('Choose an available local Art-Net interface.');
  }
  const wire = new Set();
  const universes = new Set();
  const mappings = [];
  for (const row of config.mappings) {
    if (!exact(row, ['portAddress', 'universe', 'sender']) || !Number.isInteger(row.portAddress) ||
        row.portAddress < 0 || row.portAddress > 32767 || !Number.isInteger(row.universe) ||
        row.universe < 1 || row.universe > 16 || !pinIsIPv4(row.sender) ||
        wire.has(row.portAddress) || universes.has(row.universe)) {
      throw new Error('Choose unique Art-Net addresses and U1–U16 mappings with a pinned IPv4 sender.');
    }
    wire.add(row.portAddress);
    universes.add(row.universe);
    mappings.push({ portAddress: row.portAddress, universe: row.universe, sender: row.sender });
  }
  return { binding, address, mappings };
}

function createArtNetInput({
  mux, interlock, listInterfaces, port = ARTNET_PORT, isRestricted = () => false,
  onDocumentChange = () => {}, now = () => performance.now(),
  schedule = setInterval, unschedule = clearInterval,
}) {
  let current = null;
  const lastByWindow = new Map();

  function authorized(event) {
    return isAuthorizedDmxSender(event) && !isRestricted(event.sender.id) &&
      !new URL(event.senderFrame.url).searchParams.has('view');
  }

  function publish(session, channel, payload) {
    if (!authorized(session.event)) return;
    try {
      session.event.sender.send(channel, { authority: session.authority, ...payload });
    } catch { /* closed renderer */ }
  }

  function status(session, phase, error = null) {
    const update = { phase, port: phase === 'listening' ? session.handle.port : null, error };
    publish(session, 'stageforge:artnet-input-status', update);
    return { authority: session.authority, ...update };
  }

  function expire(session, clock) {
    for (const row of session.rows.values()) {
      if (!row.stale && row.lastAt !== null && clock - row.lastAt >= INPUT_TIMEOUT_MS) {
        row.stale = true;
        row.data.fill(0);
        row.sequence = 0;
        session.dirty = true;
      }
    }
  }

  function receive(session, raw, rinfo) {
    if (current !== session || session.phase !== 'listening' || !authorized(session.event)) return;
    const clock = now();
    const packet = (raw?.[15] & 0x80) === 0 ? decodeArtDmxPacket(raw) : null;
    session.dirty = true;
    if (!packet) {
      session.drops.invalid = maxCounter(session.drops.invalid);
      return;
    }
    const row = session.rows.get(packet.portAddress);
    if (!row) {
      session.drops.unmapped = maxCounter(session.drops.unmapped);
      return;
    }
    if (rinfo?.address !== row.sender) {
      session.drops.unselected = maxCounter(session.drops.unselected);
      return;
    }
    expire(session, clock);
    if (packet.sequence !== 0 && row.sequence !== 0) {
      const delta = (packet.sequence - row.sequence + 255) % 255;
      if (delta === 0 || delta > 127) {
        session.drops.sequence = maxCounter(session.drops.sequence);
        return;
      }
      row.lost = maxCounter(row.lost, delta - 1);
    }
    row.sequence = packet.sequence;
    row.lastAt = clock;
    row.stale = false;
    row.received = maxCounter(row.received);
    row.data.fill(0);
    row.data.set(packet.slots);
  }

  function tick(session) {
    if (current !== session || session.phase !== 'listening') return;
    if (!authorized(session.event)) { void stopForWindow(session.wcId); return; }
    const clock = now();
    expire(session, clock);
    if (!session.dirty || session.inFlight !== null) return;
    session.dirty = false;
    const batchId = ++session.batchId;
    session.inFlight = batchId;
    const rows = [...session.rows.values()].map((row) => ({
      portAddress: row.portAddress, universe: row.universe, sender: row.sender,
      state: row.stale ? 'stale' : row.lastAt === null ? 'awaiting' : 'active',
      ageMs: row.lastAt === null ? null : Math.max(0, Math.floor(clock - row.lastAt)),
      received: row.received, lost: row.lost, data: new Uint8Array(row.data),
    }));
    publish(session, 'stageforge:artnet-input-batch', { batchId, rows, drops: { ...session.drops } });
  }

  function finish(session, error) {
    if (!session.closePromise) {
      session.closePromise = (async () => {
        try { await session.handle?.release(); } finally {
          if (current === session) current = null;
          interlock.releasePreview(session.lease);
          status(session, 'off', error);
        }
      })();
    }
    return session.closePromise;
  }

  function stopForWindow(wcId) {
    const session = current;
    if (!session || (wcId !== undefined && session.wcId !== wcId)) return Promise.resolve();
    if (session.stopPromise) return session.stopPromise;
    session.phase = 'stopping';
    if (session.timer !== null) unschedule(session.timer);
    session.rows.clear();
    session.inFlight = null;
    status(session, 'stopping');
    session.stopPromise = session.ready.catch(() => {}).then(() => finish(session, null));
    return session.stopPromise;
  }

  function start(event, authority, rawConfig) {
    const config = validateInputConfig(rawConfig, listInterfaces());
    const signature = JSON.stringify(config);
    const wcId = event.sender.id;
    if (current && current.wcId === wcId && sameAuthority(current.authority, authority) &&
        current.signature === signature && current.phase !== 'stopping') return current.ready;
    const prior = lastByWindow.get(wcId);
    if (prior && (prior.revision !== authority.revision || prior.generation >= authority.generation)) {
      throw new Error('Stale Art-Net input request. Start again from the current show.');
    }
    const lease = interlock.reservePreview(wcId);
    const session = {
      event, authority, signature, wcId, lease, phase: 'starting', timer: null,
      handle: null, closePromise: null, stopPromise: null, ready: null,
      rows: new Map(config.mappings.map((row) => [row.portAddress, {
        ...row, lastAt: null, sequence: 0, stale: false, received: 0, lost: 0, data: new Uint8Array(512),
      }])),
      drops: { invalid: 0, unmapped: 0, unselected: 0, sequence: 0 },
      dirty: true, inFlight: null, batchId: 0,
    };
    current = session;
    lastByWindow.set(wcId, authority);
    session.ready = (async () => {
      try {
        session.handle = await mux.acquire(ARTNET_OPCODE_DMX,
          (raw, info) => receive(session, raw, info), { port, address: config.address });
        if (current !== session || session.phase !== 'starting' || !authorized(event)) {
          throw new Error('Art-Net input startup was cancelled.');
        }
        session.phase = 'listening';
        session.timer = schedule(() => tick(session), INPUT_TICK_MS);
        session.timer?.unref?.();
        return status(session, 'listening');
      } catch (error) {
        const cancelled = session.phase === 'stopping';
        session.phase = 'stopping';
        await finish(session, cancelled ? null : String(error?.message ?? error).slice(0, 240));
        throw error;
      }
    })();
    status(session, 'starting');
    return session.ready;
  }

  async function onControl(event, command) {
    if (!authorized(event)) throw new Error('Art-Net input requires an authorized desktop editor.');
    if (exact(command, ['type']) && command.type === 'listInterfaces') {
      return listInterfaces().filter((iface) => !iface.internal).map(({ name, address }) => ({ name, address }));
    }
    if (!isDmxAuthority(command?.authority)) throw new Error('Invalid Art-Net input authority.');
    const wcId = event.sender.id;
    if (exact(command, ['type', 'authority', 'config']) && command.type === 'start') {
      return start(event, command.authority, command.config);
    }
    if (!exact(command, ['type', 'authority'])) throw new Error('Invalid Art-Net input command.');
    if (command.type === 'stop' && (current?.wcId === wcId && sameAuthority(current.authority, command.authority) ||
        sameAuthority(lastByWindow.get(wcId), command.authority))) {
      if (current?.wcId === wcId && sameAuthority(current.authority, command.authority)) await stopForWindow(wcId);
      return true;
    }
    if (command.type === 'document') {
      const prior = lastByWindow.get(wcId);
      if (prior && command.authority.generation <= prior.generation) {
        if (sameAuthority(prior, command.authority) && (!current || current.wcId !== wcId ||
            !sameAuthority(current.authority, command.authority))) return true;
        throw new Error('Stale Art-Net document change.');
      }
      lastByWindow.set(wcId, command.authority);
      await Promise.all([stopForWindow(wcId), onDocumentChange(wcId)]);
      return true;
    }
    throw new Error('Invalid or stale Art-Net input command.');
  }

  function onAck(event, ack) {
    const session = current;
    if (!session || session.phase !== 'listening' || !authorized(event) || session.wcId !== event.sender.id ||
        !exact(ack, ['authority', 'batchId']) || !isDmxAuthority(ack.authority) || !sameAuthority(session.authority, ack.authority) ||
        !Number.isSafeInteger(ack.batchId) || ack.batchId !== session.inFlight) return false;
    session.inFlight = null;
    return true;
  }

  function forgetWindow(wcId) {
    lastByWindow.delete(wcId);
    return stopForWindow(wcId);
  }

  return { onControl, onAck, stopForWindow, forgetWindow, get active() { return current !== null; } };
}

module.exports = { createArtNetInput, validateInputConfig, INPUT_TIMEOUT_MS, INPUT_TICK_MS, MAX_COUNTER };
