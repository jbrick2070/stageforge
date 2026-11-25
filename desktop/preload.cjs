const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
const dmxStatusListeners = new Set();
const showControlEventListeners = new Set();
const showControlStatusListeners = new Set();
let pending;
let latestDmxStatus;
let latestShowControlStatus;

// Realm-independent checks: IPC values are created in the preload's isolated world.
const isBytes = value => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
const isBuffer = value => Object.prototype.toString.call(value) === '[object ArrayBuffer]';
const isUniverse = value => value === 1 || value === 2;
const DMX_CONTROL_TYPES = new Set(['listInterfaces', 'getStatus', 'enable', 'disable', 'discover']);
const SHOW_CONTROL_TYPES = new Set(['getStatus', 'configure', 'stop', 'send']);

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

contextBridge.exposeInMainWorld('stageforgeDesktop', {
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
  sendDmxFrame(universe, data) {
    if (!isUniverse(universe) || !isBytes(data) || data.byteLength !== 512) return false;
    ipcRenderer.send('stageforge:dmx-frame', universe, data);
    return true;
  },
  sendDmxHeartbeat() {
    ipcRenderer.send('stageforge:dmx-heartbeat');
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
});
