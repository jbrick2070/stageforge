const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
const dmxStatusListeners = new Set();
let pending;
let latestDmxStatus;

// Realm-independent checks: IPC values are created in the preload's isolated world.
const isBytes = value => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
const isBuffer = value => Object.prototype.toString.call(value) === '[object ArrayBuffer]';
const isUniverse = value => value === 1 || value === 2;
const DMX_CONTROL_TYPES = new Set(['listInterfaces', 'getStatus', 'enable', 'disable', 'discover']);

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
  const source = binary && isBuffer(rawSource) ? new Uint8Array(rawSource) : rawSource;
  const opening = (command === 'open' && typeof source === 'string') || (binary && isBytes(source));
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
});
