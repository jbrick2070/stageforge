const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
let pending;
ipcRenderer.on('stageforge:rig-command', (_event, command, source) => {
  if (command !== 'export' && !(command === 'open' && typeof source === 'string')) return;
  const args = command === 'open' ? [command, source] : [command];
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
