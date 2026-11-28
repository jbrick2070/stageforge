'use strict';

// Pure Electron main-process DMX IPC validators and handlers.
// Extracted so Node security tests can exercise sender/frame/owner validation directly.

const { isAppPage } = require('./protocol.cjs');
const { isDmxAuthority, sameAuthority } = require('./output-interlock.cjs');
const { isIPv4 } = require('node:net');

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
  const interlock = options.interlock || null;

  function onFrame(event, universe, data, authority) {
    const dmx = getDmx();
    if (!dmx || !isAuthorizedDmxSender(event)) return false;
    if (isRestricted(event.sender.id)) return false;
    if (event.sender.id !== dmx.ownerId) return false;
    if (!dmx.isRunning()) return false;
    if (interlock?.requireDmxAuthority && (!isDmxAuthority(authority) || !sameAuthority(dmx.authority, authority) ||
      !interlock.isCurrentDmxAuthority(event.sender.id, authority))) return false;
    if ((universe !== 1 && universe !== 2) || !isExactUint8Array512(data)) return false;
    return dmx.update(universe, data);
  }

  function onHeartbeat(event, authority) {
    const dmx = getDmx();
    if (!dmx || !isAuthorizedDmxSender(event)) return false;
    if (isRestricted(event.sender.id)) return false;
    if (event.sender.id !== dmx.ownerId) return false;
    if (!dmx.isRunning()) return false;
    if (interlock?.requireDmxAuthority && (!isDmxAuthority(authority) || !sameAuthority(dmx.authority, authority) ||
      !interlock.isCurrentDmxAuthority(event.sender.id, authority))) return false;
    return dmx.heartbeat();
  }

  function onEligibility(event, command) {
    const dmx = getDmx();
    if (!dmx || !interlock || !isAuthorizedDmxSender(event) || !command || typeof command !== 'object' ||
        Array.isArray(command) || Object.keys(command).length !== 2 || !isDmxAuthority(command.authority) ||
        typeof command.eligible !== 'boolean' || (command.eligible && isRestricted(event.sender.id))) return false;
    const wcId = event.sender.id;
    const result = interlock.updateDmxEligibility(wcId, command.authority, command.eligible);
    if (result.changed && dmx.ownerId === wcId && dmx.active) void dmx.shutdown('eligibility-changed');
    return result.ok;
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
        interlock?.invalidateDmxEligibility(event.sender.id);
        return dmx.shutdown('disable');
      case 'discover':
        if (restricted) throw new Error('DMX output is disabled in pitch viewer mode.');
        if (keys.length !== 2 || typeof command.iface !== 'string' || !isIPv4(command.iface)) {
          throw new Error('Invalid Art-Net discover command.');
        }
        return dmx.discover(command.iface, {
          wcId: event.sender.id,
          isEligible: () => isAuthorizedDmxSender(event) && !isRestricted(event.sender.id),
          reserve: () => {
            const lease = interlock?.reserveDiscovery(event.sender.id);
            return () => interlock?.releaseDiscovery(lease);
          },
        });
      case 'enable': {
        if (restricted) throw new Error('DMX output is disabled in pitch viewer mode.');
        const strict = Boolean(interlock?.requireDmxAuthority);
        if (keys.length !== (strict ? 3 : 2) || !command.config || typeof command.config !== 'object' ||
          (strict && !isDmxAuthority(command.authority))) {
          throw new Error('Invalid DMX enable command.');
        }
        if (dmx.active && dmx.ownerId !== null && dmx.ownerId !== event.sender.id) {
          throw new Error('Live DMX output is already active in another StageForge window.');
        }
        let lease;
        if (interlock) {
          const check = interlock.tryBeginDmxEnable(event.sender.id, {
            requireArmedClaim: Boolean(options.requireArmedClaim),
            authority: command.authority,
          });
          if (!check.ok) {
            throw new Error(check.reason);
          }
          lease = check.lease;
        }
        const eligible = () => isAuthorizedDmxSender(event) && !isRestricted(event.sender.id) &&
          !(interlock?.isBridgeHoldingAuthority()) && (!strict || interlock.dmxEnableIsCurrent(lease));
        try {
          const status = strict
            ? await dmx.enable(command.config, event.sender.id, eligible, command.authority)
            : await dmx.enable(command.config, event.sender.id);
          if (strict && !eligible()) {
            if (dmx.ownerId === event.sender.id && sameAuthority(dmx.authority, command.authority)) await dmx.shutdown('disarmed');
            throw new Error('Physical DMX eligibility changed before startup completed.');
          }
          // Re-verify the owning renderer is still alive, on an app page, and not restricted after the async bind.
          if (event.sender.isDestroyed() || !isAppPage(event.sender.getURL())) {
            await dmx.shutdown('owner-gone');
            throw new Error('Renderer closed or navigated before DMX output started.');
          }
          if (isRestricted(event.sender.id)) {
            await dmx.shutdown('viewer-mode');
            throw new Error('DMX output is disabled in pitch viewer mode.');
          }
          if (interlock && interlock.isBridgeHoldingAuthority()) {
            await dmx.shutdown('ai-bridge-active');
            throw new Error('Disable the AI bridge before enabling live DMX output.');
          }
          if (!strict && interlock && options.requireArmedClaim && !interlock.hasWindowClaim(event.sender.id, 'armed')) {
            await dmx.shutdown('disarmed');
            throw new Error('Arm live DMX output before enabling it.');
          }
          try { event.sender.setBackgroundThrottling(false); } catch { /* ignore */ }
          return status;
        } finally {
          if (interlock) interlock.finishDmxEnableAttempt(lease);
        }
      }
      default:
        throw new Error(`Unknown DMX control command "${String(command.type)}".`);
    }
  }

  return { onFrame, onHeartbeat, onControl, onEligibility };
}

module.exports = {
  isAuthorizedDmxSender,
  isExactUint8Array512,
  createDmxIpcHandlers,
};
