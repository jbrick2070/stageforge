'use strict';

// Shared exclusive UDP socket for independent Art-Net subscriptions.
const dgram = require('node:dgram');
const { ARTNET_PORT } = require('./dmx-packets.cjs');

const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii');

function bindExclusive(socket, port, address) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('error', onError);
      socket.off('listening', onListening);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    socket.once('error', onError);
    socket.once('listening', onListening);
    try { socket.bind({ port, address, exclusive: true }); } catch (error) { onError(error); }
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    try { socket.close(resolve); } catch { resolve(); }
  });
}

function createArtNetRxMux({ dgramModule = dgram, bindPort = ARTNET_PORT, bindAddress = '0.0.0.0' } = {}) {
  let bound = null;
  let opening = null;
  let closing = null;
  let epoch = 0;

  function beginClose(work) {
    const drain = work.finally(() => { if (closing === drain) closing = null; });
    closing = drain;
    return drain;
  }

  function closeBinding(binding) {
    bound = null;
    binding.handlers.clear();
    binding.closePromise = beginClose(closeSocket(binding.socket));
    return binding.closePromise;
  }

  function open(port, address) {
    const attempt = { port, address, epoch, promise: null };
    opening = attempt;
    attempt.promise = (async () => {
      const socket = dgramModule.createSocket({ type: 'udp4' });
      const handlers = new Map();
      const binding = { socket, port, address, handlers, count: 0, closePromise: null };
      socket.on('error', () => {});
      socket.on('message', (msg, rinfo) => {
        if (bound !== binding || msg.length < 10 || !msg.subarray(0, 8).equals(ARTNET_ID)) return;
        const subscriptions = handlers.get(msg.readUInt16LE(8));
        if (!subscriptions) return;
        for (const entry of subscriptions) {
          try { entry.handler(msg, rinfo); } catch { /* isolate each subscriber */ }
        }
      });
      try {
        await bindExclusive(socket, port, address);
        if (epoch !== attempt.epoch) throw new Error('Art-Net RX startup was cancelled.');
        const effective = socket.address();
        binding.port = effective.port;
        binding.address = effective.address ?? address;
        bound = binding;
        return binding;
      } catch (error) {
        await closeSocket(socket);
        throw error;
      }
    })().finally(() => { if (opening === attempt) opening = null; });
    return attempt.promise;
  }

  async function acquire(opcode, handler, { port = bindPort, address = bindAddress } = {}) {
    if (typeof handler !== 'function') throw new TypeError('Handler must be a function.');
    const requestedEpoch = epoch;
    while (closing) await closing;
    if (requestedEpoch !== epoch) throw new Error('Art-Net RX startup was cancelled.');
    let binding = bound;
    if (binding) {
      if (address !== binding.address || (port !== 0 && port !== binding.port)) {
        throw new Error(`Art-Net RX already uses ${binding.address}:${binding.port}.`);
      }
    } else {
      if (opening && ((port !== 0 && opening.port !== port) || opening.address !== address)) {
        throw new Error(`Art-Net RX is opening ${opening.address}:${opening.port}.`);
      }
      binding = await (opening?.promise ?? open(port, address));
      if (requestedEpoch !== epoch || bound !== binding) throw new Error('Art-Net RX startup was cancelled.');
    }
    // Subscriptions are distinct, even if callers share the same function reference.
    const entry = { handler };
    let subscriptions = binding.handlers.get(opcode);
    if (!subscriptions) binding.handlers.set(opcode, subscriptions = new Set());
    subscriptions.add(entry);
    binding.count++;
    let released = false;
    return {
      port: binding.port,
      release() {
        if (released || bound !== binding) return binding.closePromise ?? Promise.resolve();
        released = true;
        subscriptions.delete(entry);
        if (!subscriptions.size) binding.handlers.delete(opcode);
        if (--binding.count === 0) return closeBinding(binding);
        return Promise.resolve();
      },
    };
  }

  function closeAll() {
    // Repeated global closes invalidate any new waiter and join the actual drain.
    epoch++;
    if (closing) return closing;
    if (bound) return closeBinding(bound);
    if (opening) return beginClose(opening.promise.catch(() => {}));
    return Promise.resolve();
  }

  return {
    get isBound() { return bound !== null; },
    get port() { return bound?.port ?? null; },
    acquire,
    closeAll,
  };
}

module.exports = { createArtNetRxMux };
