const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
const dmxStatusListeners = new Set();
const showControlEventListeners = new Set();
const showControlStatusListeners = new Set();
const aiBridgeStatusListeners = new Set();
const aiBridgeRequestListeners = new Set();
const dmxRevocationListeners = new Set();
let pending;
let latestDmxStatus;
let latestShowControlStatus;
let latestAiBridgeStatus;

// Realm-independent checks: IPC values are created in the preload's isolated world.
const isBytes = value => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
const isBuffer = value => Object.prototype.toString.call(value) === '[object ArrayBuffer]';
const isUniverse = value => value === 1 || value === 2;
const isAuthority = value => value && typeof value.revision === 'string' && Number.isSafeInteger(value.generation);
const DMX_CONTROL_TYPES = new Set(['listInterfaces', 'getStatus', 'enable', 'disable', 'discover']);
const SHOW_CONTROL_TYPES = new Set(['getStatus', 'configure', 'stop', 'send']);
const AI_BRIDGE_CONTROL_TYPES = new Set(['getStatus', 'enable', 'disable', 'quiesced']);
const OUTPUT_CLAIM_TYPES = new Set(['claim', 'release']);
const OUTPUT_CLAIM_KINDS = new Set(['armed', 'serial']);

function deliver(listener, args) {
  try {
    listener(...args);
  } catch {
    // Isolate throwing listeners so remaining subscribers still receive the command.
  }
}

ipcRenderer.on('stageforge:rig-command', (_event, command, rawSource) => {
  // Hand the renderer a Uint8Array: contextBridge copies typed arrays reliably.
  const binary = command === 'openBundle' || command === 'openMvr';
  const source = (binary || command === 'openViewer') && isBuffer(rawSource)
    ? new Uint8Array(rawSource)
    : rawSource;
  const opening =
    (command === 'open' && typeof source === 'string') ||
    (binary && isBytes(source)) ||
    (command === 'openViewer' && (typeof source === 'string' || isBytes(source)));
  if (!opening && !['export', 'show', 'bundle', 'dxf', 'glb', 'csv', 'mvr'].includes(command)) return;
  const args = opening ? [command, source] : [command];
  if (!listeners.size) pending = args;
  else for (const listener of [...listeners]) deliver(listener, args);
});

ipcRenderer.on('stageforge:dmx-status', (_event, status) => {
  if (!status || typeof status !== 'object') return;
  latestDmxStatus = status;
  for (const listener of [...dmxStatusListeners]) deliver(listener, [status]);
});

ipcRenderer.on('stageforge:dmx-authority-revoked', (_event, authority, reason) => {
  if (!isAuthority(authority) || typeof reason !== 'string') return;
  for (const listener of [...dmxRevocationListeners]) deliver(listener, [authority, reason]);
});

ipcRenderer.on('stageforge:show-control-event', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (payload.kind !== 'trigger' && payload.kind !== 'timecode') return;
  for (const listener of [...showControlEventListeners]) deliver(listener, [payload]);
});

ipcRenderer.on('stageforge:show-control-status', (_event, status) => {
  if (!status || typeof status !== 'object') return;
  latestShowControlStatus = status;
  for (const listener of [...showControlStatusListeners]) deliver(listener, [status]);
});

ipcRenderer.on('stageforge:ai-bridge-status', (_event, status) => {
  if (!status || typeof status !== 'object') return;
  latestAiBridgeStatus = status;
  for (const listener of [...aiBridgeStatusListeners]) deliver(listener, [status]);
});

ipcRenderer.on('stageforge:ai-bridge-request', (_event, request) => {
  if (!request || typeof request !== 'object') return;
  if (typeof request.requestId !== 'string' || typeof request.tool !== 'string') return;
  for (const listener of [...aiBridgeRequestListeners]) deliver(listener, [request]);
});

contextBridge.exposeInMainWorld('stageforgeDesktop', {
  setRigExportState(hasExtendedPatch) {
    if (typeof hasExtendedPatch === 'boolean') ipcRenderer.send('stageforge:rig-export-state', hasExtendedPatch);
  },
  setDmxEligibility(command) {
    return ipcRenderer.invoke('stageforge:dmx-eligibility', command);
  },
  onDmxAuthorityRevoked(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected an output revocation listener');
    dmxRevocationListeners.add(listener);
    return () => dmxRevocationListeners.delete(listener);
  },
  onRigCommand(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected a rig command listener');
    listeners.add(listener);
    if (pending) {
      const args = pending;
      pending = undefined;
      deliver(listener, args);
    }
    return () => listeners.delete(listener);
  },
  sendDmxFrame(universe, data, authority) {
    if (!isUniverse(universe) || !isBytes(data) || data.byteLength !== 512 || !isAuthority(authority)) return false;
    ipcRenderer.send('stageforge:dmx-frame', universe, data, authority);
    return true;
  },
  sendDmxHeartbeat(authority) {
    if (!isAuthority(authority)) return false;
    ipcRenderer.send('stageforge:dmx-heartbeat', authority);
    return true;
  },
  dmxControl(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || !DMX_CONTROL_TYPES.has(command.type)) {
      return Promise.reject(new TypeError('Expected a valid DMX control command'));
    }
    return ipcRenderer.invoke('stageforge:dmx-control', command);
  },
  onDmxStatus(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected a DMX status listener');
    dmxStatusListeners.add(listener);
    if (latestDmxStatus) deliver(listener, [latestDmxStatus]);
    return () => dmxStatusListeners.delete(listener);
  },
  showControl(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || !SHOW_CONTROL_TYPES.has(command.type)) {
      return Promise.reject(new TypeError('Expected a valid show control command'));
    }
    return ipcRenderer.invoke('stageforge:show-control', command);
  },
  onShowControlEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected a show control event listener');
    showControlEventListeners.add(listener);
    return () => showControlEventListeners.delete(listener);
  },
  onShowControlStatus(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected a show control status listener');
    showControlStatusListeners.add(listener);
    if (latestShowControlStatus) deliver(listener, [latestShowControlStatus]);
    return () => showControlStatusListeners.delete(listener);
  },
  setViewerMode(active) {
    if (typeof active !== 'boolean') {
      return Promise.reject(new TypeError('Expected a boolean viewer mode flag'));
    }
    return ipcRenderer.invoke('stageforge:viewer-mode', active);
  },
  aiBridgeControl(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || !AI_BRIDGE_CONTROL_TYPES.has(command.type)) {
      return Promise.reject(new TypeError('Expected a valid AI bridge control command'));
    }
    return ipcRenderer.invoke('stageforge:ai-bridge-control', command);
  },
  onAiBridgeStatus(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected an AI bridge status listener');
    aiBridgeStatusListeners.add(listener);
    if (latestAiBridgeStatus) deliver(listener, [latestAiBridgeStatus]);
    return () => aiBridgeStatusListeners.delete(listener);
  },
  onAiBridgeRequest(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected an AI bridge request listener');
    aiBridgeRequestListeners.add(listener);
    return () => aiBridgeRequestListeners.delete(listener);
  },
  replyAiBridgeRequest(reply) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) || typeof reply.requestId !== 'string') {
      return Promise.reject(new TypeError('Expected a valid AI bridge reply'));
    }
    return ipcRenderer.invoke('stageforge:ai-bridge-reply', reply);
  },
  outputClaim(command) {
    if (
      !command ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      !OUTPUT_CLAIM_TYPES.has(command.type) ||
      !OUTPUT_CLAIM_KINDS.has(command.kind)
    ) {
      return Promise.reject(new TypeError('Expected a valid output claim command'));
    }
    return ipcRenderer.invoke('stageforge:output-claim', command);
  },
});
