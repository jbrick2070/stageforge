const { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, session, shell, systemPreferences, webContents } = require('electron');
const { open: openFileHandle } = require('node:fs/promises');
const path = require('node:path');
const { isAppPage, createRendererHandler, serialDeviceKey, selectVisibleSerialPorts } = require('./protocol.cjs');
const { createArtNetRxMux } = require('./artnet-rx.cjs');
const { createDmxController } = require('./dmx-sender.cjs');
const { createDmxIpcHandlers } = require('./dmx-ipc.cjs');
const { createShowControlService } = require('./show-control-service.cjs');
const { createShowControlIpcHandlers } = require('./show-control-ipc.cjs');
const { createViewerModeTracker, createViewerIpcHandler } = require('./viewer-ipc.cjs');

const startUrl = 'stageforge://app/';
const rendererRoot = path.join(__dirname, 'renderer');
const isMac = process.platform === 'darwin';
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const rigFilters = [{ name: 'StageForge rig', extensions: ['json'] }];
const showFilters = [{ name: 'StageForge show JSON', extensions: ['json'] }];
const bundleFilters = [{ name: 'StageForge show bundle', extensions: ['zip'] }];
const openFilters = [{ name: 'StageForge shows, bundles, rigs and MVR scenes', extensions: ['json', 'zip', 'mvr'] }];
const viewerOpenFilters = [{ name: 'StageForge shows and bundles', extensions: ['json', 'zip'] }];
const exportsBySuffix = [
  ['.stageforge.zip', 'Save show bundle', bundleFilters],
  ['.mvr', 'Export MVR scene', [{ name: 'MVR scene (DIN SPEC 15801)', extensions: ['mvr'] }]],
  ['.stageforge.show.json', 'Save show', showFilters],
  ['.stageforge.json', 'Export rig', rigFilters],
  ['.dxf', 'Export CAD plan', [{ name: 'DXF drawing', extensions: ['dxf'] }]],
  ['.glb', 'Export 3D scene', [{ name: 'glTF binary', extensions: ['glb'] }]],
  ['.patch-sheet.csv', 'Export patch sheet', [{ name: 'CSV table', extensions: ['csv'] }]],
  ['.instrument-schedule.csv', 'Export instrument schedule', [{ name: 'CSV table', extensions: ['csv'] }]],
  ['.channel-hookup.csv', 'Export channel hookup', [{ name: 'CSV table', extensions: ['csv'] }]],
  ['.cue-sheet.csv', 'Export cue sheet', [{ name: 'CSV table', extensions: ['csv'] }]],
  ['.commissioning-record.csv', 'Export commissioning record', [{ name: 'CSV table', extensions: ['csv'] }]],
  ['.patch.csv', 'Export channel patch', [{ name: 'CSV table', extensions: ['csv'] }]],
  ['.equipment.csv', 'Export equipment list', [{ name: 'CSV table', extensions: ['csv'] }]],
  ['.rigging-power.csv', 'Export rigging and power report', [{ name: 'CSV table', extensions: ['csv'] }]],
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
  const artnetRx = parseTestPort(process.env.STAGEFORGE_ARTNET_RX_TEST_PORT);
  const artnetTcTx = parseTestPort(process.env.STAGEFORGE_ARTNET_TC_TX_TEST_PORT);
  if (!sacn && !artnet && !artnetDiscovery && !artnetRx && !artnetTcTx) return null;
  return { sacn, artnet, artnetDiscovery, artnetRx, artnetTcTx };
}

let dmx = null;
let artnetRx = null;
let showControl = null;
let quittingAfterShutdown = false;
const viewerTracker = createViewerModeTracker();
// Serial device grants live only in memory for this session (never persisted across launches).
const grantedSerialDevices = new Set();

function syncMenuForWindow(win) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const target = win && !win.isDestroyed()
    ? win
    : (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null);
  const restricted = Boolean(
    target && !target.isDestroyed() && viewerTracker.isViewerWindow(target.webContents.id)
  );
  viewerTracker.applyMenuRestrictions(menu, restricted);
}

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
    if (details && details.isMainFrame && !details.isSameDocument) {
      viewerTracker.clearWindow(wcId);
      syncMenuForWindow();
      if (dmx && dmx.ownerId === wcId) void dmx.shutdown('navigation');
      if (showControl && showControl.ownerId === wcId) void showControl.shutdown();
    }
  });
  wc.on('render-process-gone', () => {
    viewerTracker.clearWindow(wcId);
    syncMenuForWindow();
    if (dmx && dmx.ownerId === wcId) void dmx.shutdown('renderer-crash');
    if (showControl && showControl.ownerId === wcId) void showControl.shutdown();
  });
  win.on('unresponsive', () => {
    if (dmx && dmx.ownerId === wcId && dmx.active) void dmx.shutdown('heartbeat-timeout');
  });
  wc.on('destroyed', () => {
    viewerTracker.clearWindow(wcId);
    syncMenuForWindow();
    if (dmx && dmx.ownerId === wcId) void dmx.shutdown('window-destroyed');
    if (showControl && showControl.ownerId === wcId) void showControl.shutdown();
  });
  win.on('closed', () => {
    viewerTracker.clearWindow(wcId);
    syncMenuForWindow();
    if (dmx && dmx.ownerId === wcId) void dmx.shutdown('window-closed');
    if (showControl && showControl.ownerId === wcId) void showControl.shutdown();
  });
  win.on('session-end', () => {
    if (dmx && dmx.active) void dmx.shutdown('session-end');
    if (showControl && showControl.active) void showControl.shutdown();
  });
  wc.setWindowOpenHandler(({ url }) => {
    // The rig drawer links to the speaker manufacturer's product specifications,
    // and the show format / experimental DMX note link to this repository.
    if (URL.canParse(url) && (new URL(url).origin === 'https://www.l-acoustics.com' ||
        url === 'https://github.com/jbrick2070/stageforge' ||
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
  if (win.isDestroyed()) return;
  const wcId = win.webContents.id;
  // Never dispatch mutating/export commands to a window currently in read-only pitch viewer mode.
  if (command !== 'openViewer' && viewerTracker.isViewerWindow(wcId)) return;
  let source;
  if (command === 'open' || command === 'openViewer') {
    const isViewer = command === 'openViewer';
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: isViewer ? 'Open show in pitch viewer' : 'Open show or rig',
      filters: isViewer ? viewerOpenFilters : openFilters,
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return;
    try {
      const filename = filePaths[0];
      const lower = filename.toLowerCase();
      if (isViewer) {
        if (lower.endsWith('.zip')) {
          source = await readBoundedFile(filename, true);
        } else if (lower.endsWith('.json')) {
          source = await readBoundedFile(filename, false);
        } else {
          throw new Error('Pitch viewer opens StageForge shows (.stageforge.show.json) and bundles (.stageforge.zip).');
        }
      } else if (lower.endsWith('.zip') || lower.endsWith('.mvr')) {
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
    if (contents.isDestroyed() || !isAppPage(contents.getURL())) return;
    if (command !== 'openViewer' && viewerTracker.isViewerWindow(contents.id)) return;
    contents.send('stageforge:rig-command', command, source);
  };
  if (contents.isLoadingMainFrame()) contents.once('did-finish-load', send);
  else send();
}

function registerDmxIpc() {
  const isRestricted = (wcId) => viewerTracker.isViewerWindow(wcId);
  const { onFrame, onHeartbeat, onControl } = createDmxIpcHandlers(() => dmx, { isRestricted });
  ipcMain.on('stageforge:dmx-frame', onFrame);
  ipcMain.on('stageforge:dmx-heartbeat', onHeartbeat);
  ipcMain.handle('stageforge:dmx-control', onControl);
  const { onControl: onShowControl } = createShowControlIpcHandlers(() => showControl, { isRestricted });
  ipcMain.handle('stageforge:show-control', onShowControl);
  const onSetViewerMode = createViewerIpcHandler({
    tracker: viewerTracker,
    onEnterViewer: async (wcId) => {
      const shutdowns = [];
      if (dmx && dmx.ownerId === wcId) shutdowns.push(dmx.shutdown('viewer-mode'));
      if (showControl && showControl.ownerId === wcId) shutdowns.push(showControl.shutdown());
      if (shutdowns.length) await Promise.all(shutdowns);
    },
    onStateChanged: () => {
      syncMenuForWindow();
    },
  });
  ipcMain.handle('stageforge:viewer-mode', onSetViewerMode);
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
    if (dmx) dmx.cancelDiscover();
    const needsShutdown = Boolean((dmx && dmx.active) || (showControl && showControl.active));
    if (!quittingAfterShutdown && needsShutdown) {
      event.preventDefault();
      quittingAfterShutdown = true;
      void Promise.all([
        dmx && dmx.active ? dmx.shutdown('quit') : Promise.resolve(),
        showControl && showControl.active ? showControl.shutdown() : Promise.resolve(),
      ]).finally(() => app.quit());
    }
  });

  app.whenReady().then(() => {
    protocol.handle('stageforge', serveRenderer);

    const testPorts = resolveTestPorts();
    artnetRx = createArtNetRxMux();
    dmx = createDmxController({
      userDataDir: app.getPath('userData'),
      testPorts,
      artnetRx,
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
    showControl = createShowControlService({
      artnetRx,
      testPorts,
      allowZeroPort: !app.isPackaged,
      onEvent: (payload, targetOwnerId) => {
        if (typeof targetOwnerId === 'number') {
          const wc = webContents.fromId(targetOwnerId);
          if (wc && !wc.isDestroyed() && isAppPage(wc.getURL())) {
            wc.send('stageforge:show-control-event', payload);
          }
        }
      },
      onStatus: (status, targetOwnerId) => {
        if (typeof targetOwnerId === 'number') {
          const wc = webContents.fromId(targetOwnerId);
          if (wc && !wc.isDestroyed() && isAppPage(wc.getURL())) {
            wc.send('stageforge:show-control-status', status);
          }
        }
      },
    });
    registerDmxIpc();

    powerMonitor.on('suspend', () => {
      if (dmx && dmx.active) void dmx.shutdown('suspend');
      if (showControl && showControl.active) void showControl.shutdown();
    });
    powerMonitor.on('shutdown', () => {
      if (dmx && dmx.active) void dmx.shutdown('os-shutdown');
      if (showControl && showControl.active) void showControl.shutdown();
    });

    const ses = session.defaultSession;
    ses.on('will-download', (_event, item, contents) => {
      const choice = exportsBySuffix.find(([suffix]) => item.getFilename().endsWith(suffix));
      if (!contents || !isAppPage(contents.getURL()) || viewerTracker.isViewerWindow(contents.id) || !choice) {
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
      if (details && details.isMainFrame === false) return false;
      if (contents && viewerTracker.isViewerWindow(contents.id)) return false;
      if (permission === 'media') {
        return !details?.mediaType || details.mediaType === 'audio';
      }
      if (permission === 'serial' || permission === 'midi' || permission === 'midiSysex') {
        return true;
      }
      return false;
    });

    // Note: Electron's setDevicePermissionHandler receives no WebContents, so serial denial in
    // viewer mode is enforced by setPermissionCheckHandler, select-serial-port, and renderer liveOutput: false.
    ses.setDevicePermissionHandler((details) => {
      if (details.deviceType !== 'serial' || !isAppPage(details.origin)) return false;
      const key = serialDeviceKey(details.device);
      return Boolean(key && grantedSerialDevices.has(key));
    });

    ses.on('select-serial-port', (event, portList, contents, callback) => {
      event.preventDefault();
      if (!contents || contents.isDestroyed() || !isAppPage(contents.getURL()) || viewerTracker.isViewerWindow(contents.id)) {
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
      if (!isAppPage(contents.getURL())) return callback(false);
      if (details && details.isMainFrame === false) return callback(false);
      if (details?.requestingUrl && !isAppPage(details.requestingUrl)) return callback(false);
      if (viewerTracker.isViewerWindow(contents.id)) return callback(false);
      if (permission === 'midi' || permission === 'midiSysex') {
        return callback(true);
      }
      if (permission !== 'media' || !details.mediaTypes?.length ||
          !details.mediaTypes.every(type => type === 'audio')) return callback(false);
      if (isMac) {
        void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
      } else callback(true);
    });

    const run = (cmd) => { void runRigCommand(cmd).catch(() => {}); };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [
        { id: 'file-open', label: 'Open show or rig…', accelerator: 'CmdOrCtrl+O', click: () => run('open') },
        { id: 'file-open-viewer', label: 'Open in viewer…', accelerator: 'CmdOrCtrl+Shift+O', click: () => run('openViewer') },
        { type: 'separator' },
        { id: 'file-save-show', label: 'Save show as…', accelerator: 'CmdOrCtrl+S', click: () => run('show') },
        { id: 'file-save-bundle', label: 'Save show bundle…', click: () => run('bundle') },
        { id: 'file-export-rig', label: 'Export rig…', accelerator: 'CmdOrCtrl+Shift+S', click: () => run('export') },
        { id: 'file-export-submenu', label: 'Export', submenu: [
          { id: 'file-export-mvr', label: 'MVR scene for consoles and visualizers…', click: () => run('mvr') },
          { id: 'file-export-dxf', label: 'CAD plan (DXF)…', click: () => run('dxf') },
          { id: 'file-export-glb', label: '3D scene (GLB)…', click: () => run('glb') },
          { id: 'file-export-csv', label: 'DMX channel patch (CSV)…', click: () => run('csv') },
        ] },
        { type: 'separator' }, { role: isMac ? 'close' : 'quit' },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]));
    app.on('browser-window-focus', (_event, win) => syncMenuForWindow(win));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
