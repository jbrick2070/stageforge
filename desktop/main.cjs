const { app, BrowserWindow, dialog, Menu, net, protocol, session, shell, systemPreferences } = require('electron');
const { open: openFileHandle } = require('node:fs/promises');
const path = require('node:path');
const { isAppPage, createRendererHandler } = require('./protocol.cjs');

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 540, minHeight: 420,
    title: 'StageForge', backgroundColor: '#000000', icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
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

  app.whenReady().then(() => {
    protocol.handle('stageforge', serveRenderer);
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
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      isAppPage(requestingOrigin) &&
      (!contents || isAppPage(contents.getURL())) &&
      permission === 'media' &&
      (!details?.mediaType || details.mediaType === 'audio'));
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
