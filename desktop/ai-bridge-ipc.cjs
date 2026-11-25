'use strict';

// Pure Electron main-process IPC validators and handlers for the AI bridge
// and output-interlock claims (`stageforge:ai-bridge-control`, `stageforge:ai-bridge-reply`,
// `stageforge:output-claim`).

const { isAppPage } = require('./protocol.cjs');
const { isAuthorizedDmxSender } = require('./dmx-ipc.cjs');

function createAiBridgeIpcHandlers(getBridge, getInterlock, options = {}) {
  const isRestricted = typeof options.isRestricted === 'function' ? options.isRestricted : () => false;

  async function onControl(event, command) {
    const bridge = getBridge();
    if (!bridge || !isAuthorizedDmxSender(event)) {
      throw new Error('Unauthorized AI bridge request.');
    }
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new Error('Invalid AI bridge command.');
    }
    const restricted = isRestricted(event.sender.id);
    const keys = Object.keys(command);

    switch (command.type) {
      case 'getStatus': {
        if (keys.length !== 1) throw new Error('Unexpected fields in getStatus command.');
        if (restricted || (bridge.ownerId !== null && bridge.ownerId !== event.sender.id)) {
          return {
            enabled: false,
            state: 'off',
            generation: bridge.generation,
            port: null,
            url: null,
            token: null,
            activeSessions: 0,
            activeToolCalls: 0,
            lastError: null,
          };
        }
        return bridge.getStatus(true);
      }
      case 'disable': {
        if (keys.length !== 1) throw new Error('Unexpected fields in disable command.');
        if (bridge.ownerId !== null && bridge.ownerId !== event.sender.id) {
          throw new Error('AI bridge is owned by another StageForge window.');
        }
        return bridge.disable('disable');
      }
      case 'quiesced': {
        if (keys.length !== 2 || typeof command.generation !== 'number' || !Number.isInteger(command.generation)) {
          throw new Error('Invalid quiesced acknowledgement.');
        }
        return { ok: bridge.markRendererQuiesced(event.sender.id, command.generation) };
      }
      case 'enable': {
        if (restricted) throw new Error('AI bridge is disabled in pitch viewer mode.');
        if (keys.length > 2 || (command.config !== undefined && (!command.config || typeof command.config !== 'object' || Array.isArray(command.config)))) {
          throw new Error('Invalid AI bridge enable command.');
        }
        if (bridge.active && bridge.ownerId !== null && bridge.ownerId !== event.sender.id) {
          throw new Error('AI bridge is already active in another StageForge window.');
        }
        const status = await bridge.enable(command.config || {}, event.sender.id);
        // Re-verify owning renderer is still alive, on an app page, and not restricted after async bind.
        if (event.sender.isDestroyed() || !isAppPage(event.sender.getURL())) {
          await bridge.disable('owner-gone', { skipQuiesceWait: true });
          throw new Error('Renderer closed or navigated before AI bridge started.');
        }
        if (isRestricted(event.sender.id)) {
          await bridge.disable('viewer-mode', { skipQuiesceWait: true });
          throw new Error('AI bridge is disabled in pitch viewer mode.');
        }
        return status;
      }
      default:
        throw new Error(`Unknown AI bridge command "${String(command.type)}".`);
    }
  }

  async function onReply(event, reply) {
    const bridge = getBridge();
    if (!bridge || !isAuthorizedDmxSender(event)) {
      return false;
    }
    if (isRestricted(event.sender.id)) {
      return false;
    }
    return bridge.handleRendererReply(reply, event.sender.id);
  }

  async function onOutputClaim(event, command) {
    const interlock = getInterlock();
    if (!interlock || !isAuthorizedDmxSender(event)) {
      throw new Error('Unauthorized output claim request.');
    }
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new Error('Invalid output claim command.');
    }
    const keys = Object.keys(command);
    if (keys.length !== 2 || (command.type !== 'claim' && command.type !== 'release')) {
      throw new Error('Invalid output claim command shape.');
    }
    if (!interlock.VALID_CLAIM_KINDS.has(command.kind)) {
      throw new Error(`Unknown output claim kind "${String(command.kind)}".`);
    }
    if (command.type === 'claim') {
      if (isRestricted(event.sender.id)) {
        return { ok: false, reason: 'Live DMX output is disabled in pitch viewer mode.' };
      }
      return interlock.claimOutput(event.sender.id, command.kind);
    }
    interlock.releaseOutput(event.sender.id, command.kind);
    return { ok: true, reason: null };
  }

  return { onControl, onReply, onOutputClaim };
}

module.exports = {
  createAiBridgeIpcHandlers,
};
