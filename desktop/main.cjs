const { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, session, shell, systemPreferences, webContents } = require('electron');
const { open: openFileHandle } = require('node:fs/promises');
const path = require('node:path');
const { isAppPage, createRendererHandler, serialDeviceKey, selectVisibleSerialPorts } = require('./protocol.cjs');
const { createDmxController } = require('./dmx-sender.cjs');
const { createDmxIpcHandlers } = require('./dmx-ipc.cjs');

const startUrl = 'stageforge://app/';
const rendererRoot = path.join(__dirname, 'renderer');
const isMac = process.platform === 'darwin';
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const rigFilters = [{ name: 'StageForge rig', extensions: ['json'] }];
const showFilters = [{ name: 'StageForge show JSON', extensions: ['json'] }];
const bundleFilters = [{ name: 'StageForge show bundle', extensions: ['zip'] }];
const openFilters = [{ name: 'StageForge shows, bundles, rigs and MVR scenes', extensions: ['json', 'zip', 'mvr'] }];
const exportsBySuffix = [
  ['.stageforge.zip', 'Save show bundle', bundleFilters],
  ['.mvr', 'Export MVR scene', [{ name: 'MVR scene (DIN SPEC 15801)', extensions: ['mvr'] }]],
  ['.stageforge.show.json', 'Save show', showFilters],
  ['.stageforge.json', 'Export rig', rigFilters],
  ['.dxf', 'Export CAD plan', [{ name: 'DXF drawing', extensions: ['dxf'] }]],
  ['.glb', 'Export 3D scene', [{ name: 'glTF binary', extensions: ['glb'] }]],
  ['.patch.csv', 'Export channel patch', [{ name: 'CSV table', extensions: ['csv'] }]],
];

protocol.registerSchemesAsPrivileged([{
  scheme: 'stageforge',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const serveRenderer = createRendererHandler({
  fetchFile: (fileUrl) => net.fetch(fileUrl),
  rendererRoot,
});

function parseTestPort(raw) {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function resolveTestPorts() {
  // Never honour test port overrides in packaged production builds.
  if (app.isPackaged) return null;
  const sacn = parseTestPort(process.env.STAGEFORGE_DMX_TEST_PORT);
  const artnet = parseTestPort(process.env.STAGEFORGE_DMX_TEST_ARTNET_PORT || process.env.STAGEFORGE_DMX_TEST_PORT);
  const artnetDiscovery = parseTestPort(process.env.STAGEFORGE_DMX_TEST_DISCOVERY_PORT);
  if (!sacn && !artnet && !artnetDiscovery) return null;
  return { sacn, artnet, artnetDiscovery };
}

let dmx = null;
let quittingAfterDmx = false;
// Serial device grants live only in memory for this session (never persisted across launches).
const grantedSerialDevices = new Set();

function restoreBackgroundThrottling(wcId) {
  if (typeof wcId !== 'number') return;
  const wc = webContents.fromId(wcId);
  if (wc && !wc.isDestroyed()) {
    try { wc.setBackgroundThrottling(true); } catch { /* ignore */ }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 540, minHeight: 420,
    title: 'StageForge', backgroundColor: '#000000', icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  const wc = win.webContents;
  const wcId = wc.id;
  wc.on('will-navigate', (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  wc.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument && dmx && dmx.ownerId === wcId) {
      void dmx.shutdown('navigation');
    }
  });
  wc.on('render-process-gone', () => {
    if (dmx && dmx.ownerId === wcId) {
      void dmx.shutdown('renderer-crash');
    }
  });
  wc.on('destroyed', () => {
    if (dmx && dmx.ownerId === wcId) {
      void dmx.shutdown('window-destroyed');
    }
  });
  win.on('closed', () => {
    if (dmx && dmx.ownerId === wcId) {
      void dmx.shutdown('window-closed');
    }
  });
  win.on('session-end', () => {
    if (dmx && dmx.active) {
      void dmx.shutdown('session-end');
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    // The rig drawer links to the speaker manufacturer's product specifications.
    if (URL.canParse(url) && (new URL(url).origin === 'https://www.l-acoustics.com' ||
        url === 'https://github.com/jbrick2070/stageforge/blob/main/docs/show-format.md')) {
      void shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  void win.loadURL(startUrl);
  return win;
}

async function readBoundedFile(filename, binary) {
  const fh = await openFileHandle(filename, 'r');
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error('Choose a regular file.');
    const limit = binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
    if (info.size > limit) {
      throw new Error(binary
        ? 'This show exceeds the 512 MiB in-memory bundle limit.'
        : 'This JSON file exceeds the 32 MiB limit.');
    }
    const buf = await fh.readFile();
    if (buf.byteLength > limit) {
      throw new Error(binary
        ? 'This show exceeds the 512 MiB in-memory bundle limit.'
        : 'This JSON file exceeds the 32 MiB limit.');
    }
    if (binary) {
      // View the Buffer's own bytes without making an extra copy before IPC structured clone.
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const text = buf.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } finally {
    await fh.close();
  }
}

async function runRigCommand(command) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || createWindow();
  let source;
  if (command === 'open') {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Open show or rig', filters: openFilters, properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return;
    try {
      const filename = filePaths[0];
      const lower = filename.toLowerCase();
      if (lower.endsWith('.zip') || lower.endsWith('.mvr')) {
        source = await readBoundedFile(filename, true);
        command = lower.endsWith('.mvr') ? 'openMvr' : 'openBundle';
      } else {
        source = await readBoundedFile(filename, false);
      }
    } catch (error) {
      dialog.showErrorBox('Could not open file', error instanceof Error ? error.message : 'Could not read this file.');
      return;
    }
  }
  if (win.isDestroyed()) return;
  const contents = win.webContents;
  const send = () => {
    if (!contents.isDestroyed() && isAppPage(contents.getURL())) {
      contents.send('stageforge:rig-command', command, source);
    }
  };
  if (contents.isLoadingMainFrame()) contents.once('did-finish-load', send);
  else send();
}

function registerDmxIpc() {
  const { onFrame, onControl } = createDmxIpcHandlers(() => dmx);
  ipcMain.on('stageforge:dmx-frame', onFrame);
  ipcMain.handle('stageforge:dmx-control', onControl);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('before-quit', (event) => {
    if (!dmx) return;
    dmx.cancelDiscover();
    if (!quittingAfterDmx && dmx.active) {
      event.preventDefault();
      quittingAfterDmx = true;
      void dmx.shutdown('quit').finally(() => app.quit());
    }
  });

  app.whenReady().then(() => {
    protocol.handle('stageforge', serveRenderer);

    dmx = createDmxController({
      userDataDir: app.getPath('userData'),
      testPorts: resolveTestPorts(),
      onStatus: (status, targetOwnerId) => {
        if (status.state === 'idle') {
          restoreBackgroundThrottling(targetOwnerId);
        }
        if (typeof targetOwnerId === 'number') {
          const wc = webContents.fromId(targetOwnerId);
          if (wc && !wc.isDestroyed() && isAppPage(wc.getURL())) {
            wc.send('stageforge:dmx-status', status);
          }
        }
      },
    });
    registerDmxIpc();

    powerMonitor.on('suspend', () => {
      if (dmx && dmx.active) void dmx.shutdown('suspend');
    });
    powerMonitor.on('shutdown', () => {
      if (dmx && dmx.active) void dmx.shutdown('os-shutdown');
    });

    const ses = session.defaultSession;
    ses.on('will-download', (_event, item, contents) => {
      const choice = exportsBySuffix.find(([suffix]) => item.getFilename().endsWith(suffix));
      if (!contents || !isAppPage(contents.getURL()) || !choice) {
        item.cancel();
        return;
      }
      item.setSaveDialogOptions({
        title: choice[1], filters: choice[2],
        defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())),
      });
      item.once('done', (_e, state) => {
        if (state === 'interrupted') {
          dialog.showErrorBox('Could not save file', `Saving ${path.basename(item.getFilename())} was interrupted.`);
        }
      });
    });

    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (!isAppPage(requestingOrigin) || (contents && !isAppPage(contents.getURL()))) return false;
      if (permission === 'media') {
        return !details?.mediaType || details.mediaType === 'audio';
      }
      if (permission === 'serial') {
        return true;
      }
      return false;
    });

    ses.setDevicePermissionHandler((details) => {
      if (details.deviceType !== 'serial' || !isAppPage(details.origin)) return false;
      const key = serialDeviceKey(details.device);
      return Boolean(key && grantedSerialDevices.has(key));
    });

    ses.on('select-serial-port', (event, portList, contents, callback) => {
      event.preventDefault();
      if (!contents || contents.isDestroyed() || !isAppPage(contents.getURL())) {
        callback('');
        return;
      }
      const visible = selectVisibleSerialPorts(portList, 8);
      if (!visible.length) {
        callback('');
        return;
      }
      const win = BrowserWindow.fromWebContents(contents) || BrowserWindow.getFocusedWindow() || undefined;
      const labels = visible.map((port) => {
        const name = port.displayName || port.portName || port.portId;
        const serial = port.serialNumber ? ` (${port.serialNumber})` : '';
        return `${name}${serial}`;
      });
      // Always require explicit user confirmation; never auto-select a serial device.
      void dialog.showMessageBox(win, {
        type: 'question',
        title: 'Select DMX USB interface',
        message: 'Choose a serial port for Enttec DMX USB Pro output:',
        buttons: [...labels, 'Cancel'],
        cancelId: labels.length,
        defaultId: labels.length,
        noLink: true,
      }).then(({ response }) => {
        if (response >= 0 && response < visible.length) {
          const chosen = visible[response];
          const key = serialDeviceKey(chosen);
          if (key) grantedSerialDevices.add(key);
          callback(chosen.portId);
        } else {
          callback('');
        }
      }).catch(() => {
        callback('');
      });
    });

    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (!isAppPage(contents.getURL()) || permission !== 'media' || !details.mediaTypes?.length ||
          !details.mediaTypes.every(type => type === 'audio')) return callback(false);
      if (isMac) {
        void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
      } else callback(true);
    });

    const run = (cmd) => { void runRigCommand(cmd).catch(() => {}); };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [
        { label: 'Open show or rig…', accelerator: 'CmdOrCtrl+O', click: () => run('open') },
        { label: 'Save show as…', accelerator: 'CmdOrCtrl+S', click: () => run('show') },
        { label: 'Save show bundle…', click: () => run('bundle') },
        { label: 'Export rig…', accelerator: 'CmdOrCtrl+Shift+S', click: () => run('export') },
        { label: 'Export', submenu: [
          { label: 'MVR scene for consoles and visualizers…', click: () => run('mvr') },
          { label: 'CAD plan (DXF)…', click: () => run('dxf') },
          { label: '3D scene (GLB)…', click: () => run('glb') },
          { label: 'DMX channel patch (CSV)…', click: () => run('csv') },
        ] },
        { type: 'separator' }, { role: isMac ? 'close' : 'quit' },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
