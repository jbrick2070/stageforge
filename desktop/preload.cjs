const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
let pending;
// Realm-independent checks: IPC values are created in the preload's isolated world.
const isBytes = value => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
const isBuffer = value => Object.prototype.toString.call(value) === '[object ArrayBuffer]';

ipcRenderer.on('stageforge:rig-command', (_event, command, rawSource) => {
  // Hand the renderer a Uint8Array: contextBridge copies typed arrays reliably.
  const binary = command === 'openBundle' || command === 'openMvr';
  const source = binary && isBuffer(rawSource) ? new Uint8Array(rawSource) : rawSource;
  const opening = (command === 'open' && typeof source === 'string') || (binary && isBytes(source));
  if (!opening && !['export', 'show', 'bundle', 'dxf', 'glb', 'csv', 'mvr'].includes(command)) return;
  const args = opening ? [command, source] : [command];
  if (!listeners.size) pending = args;
  else for (const listener of listeners) listener(...args);
});

contextBridge.exposeInMainWorld('stageforgeDesktop', {
  onRigCommand(listener) {
    if (typeof listener !== 'function') throw new TypeError('Expected a rig command listener');
    listeners.add(listener);
    if (pending) {
      const args = pending;
      pending = undefined;
      listener(...args);
    }
    return () => listeners.delete(listener);
  },
});
