'use strict';

// Pure Electron main-process Show Control IPC validators and handlers.
// Enforces senderFrame === mainFrame, isAppPage(url), window ownership, and strict command allowlists.

const { isAppPage } = require('./protocol.cjs');
const { isAuthorizedDmxSender } = require('./dmx-ipc.cjs');

function createShowControlIpcHandlers(getService) {
  async function onControl(event, command) {
    const svc = getService();
    if (!svc || !isAuthorizedDmxSender(event)) {
      throw new Error('Unauthorized show control request.');
    }
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new Error('Invalid show control command.');
    }
    const keys = Object.keys(command);
    switch (command.type) {
      case 'getStatus': {
        if (keys.length !== 1) throw new Error('Unexpected fields in getStatus command.');
        const status = svc.getStatus();
        if (svc.ownerId !== null && svc.ownerId !== event.sender.id) {
          return {
            active: false,
            oscRxListening: false,
            oscRxPort: null,
            oscRxAddress: null,
            oscTxEnabled: false,
            oscTxHost: '',
            oscTxPort: 0,
            artnetTcRxListening: false,
            artnetTcRxPort: null,
            artnetTcTxEnabled: false,
            artnetTcTxHost: '',
            oscRxCount: 0,
            oscDroppedCount: 0,
            artnetTcRxCount: 0,
            oscError: null,
            artnetTcError: null,
          };
        }
        return status;
      }
      case 'stop': {
        if (keys.length !== 1) throw new Error('Unexpected fields in stop command.');
        if (svc.ownerId !== null && svc.ownerId !== event.sender.id) {
          throw new Error('Show control is owned by another StageForge window.');
        }
        return svc.shutdown();
      }
      case 'configure': {
        if (keys.length !== 2 || !command.config || typeof command.config !== 'object') {
          throw new Error('Invalid show control configure command.');
        }
        if (svc.active && svc.ownerId !== null && svc.ownerId !== event.sender.id) {
          throw new Error('Show control is already owned by another StageForge window.');
        }
        const status = await svc.configure(command.config, event.sender.id);
        if (event.sender.isDestroyed() || !isAppPage(event.sender.getURL())) {
          await svc.shutdown();
          throw new Error('Renderer closed or navigated before show control started.');
        }
        return status;
      }
      case 'send': {
        if (keys.length !== 2 || !command.payload || typeof command.payload !== 'object') {
          throw new Error('Invalid show control send command.');
        }
        if (svc.ownerId !== event.sender.id) {
          return false;
        }
        return svc.send(command.payload);
      }
      default:
        throw new Error(`Unknown show control command "${String(command.type)}".`);
    }
  }

  return { onControl };
}

module.exports = {
  createShowControlIpcHandlers,
};
