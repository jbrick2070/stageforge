'use strict';

// Shared UDP 6454 (Art-Net) receive multiplexer for Electron main process.
// Holds a single exclusive-bind socket (never reuseAddr, respecting Windows port isolation)
// when Art-Net Timecode RX is active, allowing Art-Net discovery (OpCode 0x2100) to subscribe
// to the same socket without EADDRINUSE collisions.

const dgram = require('node:dgram');
const { ARTNET_PORT } = require('./dmx-packets.cjs');

const ARTNET_ID = Buffer.from([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]);

function bindExclusive(socket, port, address = '0.0.0.0') {
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
    socket.bind({ port, address, exclusive: true });
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

function createArtNetRxMux({ dgramModule = dgram, bindPort = ARTNET_PORT, bindAddress = '0.0.0.0' } = {}) {
  let socket = null;
  let boundPort = null;
  let opening = null;
  let closing = null;
  let refs = 0;
  let generation = 0;
  let epoch = 0;
  const handlersByOpCode = new Map(); // opcode -> Set<{ fn: (msg, rinfo) => void }>

  function dispatch(msg, rinfo) {
    if (!msg || msg.byteLength < 10) return;
    if (!msg.subarray(0, 8).equals(ARTNET_ID)) return;
    const opcode = msg.readUInt16LE(8);
    const set = handlersByOpCode.get(opcode);
    if (!set || set.size === 0) return;
    for (const entry of [...set]) {
      try {
        entry.fn(msg, rinfo);
      } catch {
        // Isolate subscriber errors so other Art-Net listeners keep running.
      }
    }
  }

  async function ensureBound(portOverride, addressOverride) {
    if (closing) await closing;
    const targetPort = portOverride !== undefined ? portOverride : bindPort;
    const targetAddr = addressOverride !== undefined ? addressOverride : bindAddress;
    if (socket) {
      if (portOverride === undefined || targetPort === 0 || boundPort === targetPort) return boundPort;
      throw new Error(`Art-Net RX is already bound on UDP port ${boundPort}.`);
    }
    if (opening) return opening;
    const myGen = ++generation;
    opening = (async () => {
      const candidate = dgramModule.createSocket({ type: 'udp4' });
      candidate.on('error', () => {});
      candidate.on('message', dispatch);
      try {
        await bindExclusive(candidate, targetPort, targetAddr);
        if (generation !== myGen) {
          await closeSocket(candidate);
          throw new Error('Art-Net RX startup was cancelled.');
        }
        socket = candidate;
        const addr = candidate.address();
        boundPort = addr && typeof addr === 'object' ? addr.port : targetPort;
        return boundPort;
      } catch (err) {
        await closeSocket(candidate);
        throw err;
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  async function acquire(opcode, handler, opts = {}) {
    if (typeof handler !== 'function') throw new TypeError('Handler must be a function.');
    // Wrap each acquire in a unique token object so overlapping acquires with the same
    // callback reference never delete each other's subscription on release (H1).
    const entry = { fn: handler };
    const myEpoch = epoch;
    let set = handlersByOpCode.get(opcode);
    if (!set) {
      set = new Set();
      handlersByOpCode.set(opcode, set);
    }
    set.add(entry);
    refs++;
    try {
      const port = await ensureBound(opts.port, opts.address);
      let released = false;
      const release = async () => {
        if (released || myEpoch !== epoch) return;
        released = true;
        const currentSet = handlersByOpCode.get(opcode);
        if (currentSet) {
          currentSet.delete(entry);
          if (currentSet.size === 0) handlersByOpCode.delete(opcode);
        }
        refs = Math.max(0, refs - 1);
        if (refs === 0) {
          generation++;
          const sock = socket;
          socket = null;
          boundPort = null;
          const p = closeSocket(sock).finally(() => {
            if (closing === p) closing = null;
          });
          closing = p;
          await p;
        }
      };
      return { port, release };
    } catch (err) {
      if (myEpoch === epoch) {
        set.delete(entry);
        if (set.size === 0) handlersByOpCode.delete(opcode);
        refs = Math.max(0, refs - 1);
      }
      throw err;
    }
  }

  async function closeAll() {
    generation++;
    epoch++;
    handlersByOpCode.clear();
    refs = 0;
    const sock = socket;
    socket = null;
    boundPort = null;
    const p = closeSocket(sock).finally(() => {
      if (closing === p) closing = null;
    });
    closing = p;
    await p;
  }

  return {
    get isBound() { return socket !== null; },
    get port() { return boundPort; },
    acquire,
    closeAll,
  };
}

module.exports = {
  createArtNetRxMux,
};
