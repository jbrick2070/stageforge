'use strict';

// Pure Electron main-process DMX IPC validators and handlers.
// Extracted so Node security tests can exercise sender/frame/owner validation directly.

const { isAppPage } = require('./protocol.cjs');

function isAuthorizedDmxSender(event) {
  const frame = event && event.senderFrame;
  const sender = event && event.sender;
  if (!frame || !sender || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) return false;
  if (frame !== sender.mainFrame) return false;
  return isAppPage(frame.url) && isAppPage(sender.getURL());
}

function isExactUint8Array512(value) {
  return ArrayBuffer.isView(value) &&
    value.BYTES_PER_ELEMENT === 1 &&
    Object.prototype.toString.call(value) === '[object Uint8Array]' &&
    value.byteLength === 512;
}

function createDmxIpcHandlers(getDmx, options = {}) {
  const isRestricted = typeof options.isRestricted === 'function' ? options.isRestricted : () => false;

  function onFrame(event, universe, data) {
    const dmx = getDmx();
    if (!dmx || !isAuthorizedDmxSender(event)) return false;
    if (isRestricted(event.sender.id)) return false;
    if (event.sender.id !== dmx.ownerId) return false;
    if (!dmx.isRunning()) return false;
    if ((universe !== 1 && universe !== 2) || !isExactUint8Array512(data)) return false;
    return dmx.update(universe, data);
  }

  function onHeartbeat(event) {
    const dmx = getDmx();
    if (!dmx || !isAuthorizedDmxSender(event)) return false;
    if (isRestricted(event.sender.id)) return false;
    if (event.sender.id !== dmx.ownerId) return false;
    if (!dmx.isRunning()) return false;
    return dmx.heartbeat();
  }

  async function onControl(event, command) {
    const dmx = getDmx();
    if (!dmx || !isAuthorizedDmxSender(event)) {
      throw new Error('Unauthorized DMX control request.');
    }
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new Error('Invalid DMX control command.');
    }
    const restricted = isRestricted(event.sender.id);
    const keys = Object.keys(command);
    switch (command.type) {
      case 'listInterfaces':
        if (keys.length !== 1) throw new Error('Unexpected fields in listInterfaces command.');
        return dmx.listInterfaces();
      case 'getStatus': {
        if (keys.length !== 1) throw new Error('Unexpected fields in getStatus command.');
        const status = dmx.getStatus();
        // Scope live status and stop reason to the owning window so a second window never falsely displays LIVE or another window's stop notice.
        if (restricted || (dmx.ownerId !== null && dmx.ownerId !== event.sender.id)) {
          return { ...status, enabled: false, state: 'idle', lastStopReason: null };
        }
        if (dmx.ownerId === null && status.lastStopOwnerId !== null && status.lastStopOwnerId !== event.sender.id) {
          return { ...status, lastStopReason: null };
        }
        return status;
      }
      case 'disable':
        if (keys.length !== 1) throw new Error('Unexpected fields in disable command.');
        if (dmx.ownerId !== null && dmx.ownerId !== event.sender.id) {
          throw new Error('Live DMX output is owned by another StageForge window.');
        }
        return dmx.shutdown('disable');
      case 'discover':
        if (restricted) throw new Error('DMX output is disabled in pitch viewer mode.');
        if (keys.length !== 2 || typeof command.iface !== 'string') {
          throw new Error('Invalid Art-Net discover command.');
        }
        return dmx.discover(command.iface);
      case 'enable': {
        if (restricted) throw new Error('DMX output is disabled in pitch viewer mode.');
        if (keys.length !== 2 || !command.config || typeof command.config !== 'object') {
          throw new Error('Invalid DMX enable command.');
        }
        if (dmx.active && dmx.ownerId !== null && dmx.ownerId !== event.sender.id) {
          throw new Error('Live DMX output is already active in another StageForge window.');
        }
        const status = await dmx.enable(command.config, event.sender.id);
        // Re-verify the owning renderer is still alive, on an app page, and not restricted after the async bind.
        if (event.sender.isDestroyed() || !isAppPage(event.sender.getURL())) {
          await dmx.shutdown('owner-gone');
          throw new Error('Renderer closed or navigated before DMX output started.');
        }
        if (isRestricted(event.sender.id)) {
          await dmx.shutdown('viewer-mode');
          throw new Error('DMX output is disabled in pitch viewer mode.');
        }
        try { event.sender.setBackgroundThrottling(false); } catch { /* ignore */ }
        return status;
      }
      default:
        throw new Error(`Unknown DMX control command "${String(command.type)}".`);
    }
  }

  return { onFrame, onHeartbeat, onControl };
}

module.exports = {
  isAuthorizedDmxSender,
  isExactUint8Array512,
  createDmxIpcHandlers,
};
