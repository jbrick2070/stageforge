const { app, BrowserWindow, dialog, Menu, net, protocol, session, shell, systemPreferences } = require('electron');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const startUrl = 'stageforge://app/';
const rendererRoot = path.join(__dirname, 'renderer');
const isMac = process.platform === 'darwin';
const rigFilters = [{ name: 'StageForge rig', extensions: ['json'] }];
const showFilters = [{ name: 'StageForge show JSON', extensions: ['json'] }];
const bundleFilters = [{ name: 'StageForge show bundle', extensions: ['zip'] }];
const openFilters = [{ name: 'StageForge shows, bundles and rigs', extensions: ['json','zip'] }];
const exportsBySuffix = [
  ['.stageforge.zip', 'Save show bundle', bundleFilters],
  ['.stageforge.show.json', 'Save show', showFilters],
  ['.stageforge.json', 'Export rig', rigFilters],
  ['.dxf', 'Export CAD plan', [{ name: 'DXF drawing', extensions: ['dxf'] }]],
  ['.glb', 'Export 3D scene', [{ name: 'glTF binary', extensions: ['glb'] }]],
  ['.patch.csv', 'Export channel patch', [{ name: 'CSV table', extensions: ['csv'] }]],
];
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'";

protocol.registerSchemesAsPrivileged([{
  scheme: 'stageforge',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

function isAppPage(rawUrl) {
  if (!URL.canParse(rawUrl)) return false;
  const url = new URL(rawUrl);
  return url.protocol === 'stageforge:' && url.host === 'app' && !url.username && !url.password;
}

async function serveRenderer(request) {
  if (request.method !== 'GET' || !isAppPage(request.url)) return new Response(null, { status: 404 });
  try {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (/[\\:\x00]/.test(pathname)) return new Response(null, { status: 400 });
    const file = path.resolve(rendererRoot, pathname === '/' ? 'index.html' : '.' + pathname);
    const relative = path.relative(rendererRoot, file);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      return new Response(null, { status: 404 });
    }
    const result = await net.fetch(pathToFileURL(file).href);
    if (relative !== 'index.html') return result;
    const headers = new Headers(result.headers);
    headers.set('Content-Security-Policy', csp);
    return new Response(result.body, { status: result.status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 540, minHeight: 420,
    title: 'StageForge', backgroundColor: '#000000', icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
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
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  void win.loadURL(startUrl);
  return win;
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
      if (filename.toLowerCase().endsWith('.zip')) {
        if ((await stat(filename)).size > 512 * 1024 * 1024) throw new Error('This show exceeds the 512 MiB in-memory bundle limit.');
        // Structured clone delivers a Uint8Array to the preload; no extra ArrayBuffer copy.
        source = new Uint8Array(await readFile(filename));
        command = 'openBundle';
      } else source = await readFile(filename, 'utf8');
    } catch (error) {
      dialog.showErrorBox('Could not open file', error.message);
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

app.whenReady().then(() => {
  protocol.handle('stageforge', serveRenderer);
  const ses = session.defaultSession;
  ses.on('will-download', (_event, item, contents) => {
    const choice = exportsBySuffix.find(([suffix]) => item.getFilename().endsWith(suffix));
    if (contents && isAppPage(contents.getURL()) && choice) {
      item.setSaveDialogOptions({
        title: choice[1], filters: choice[2],
        defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())),
      });
    }
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    isAppPage(requestingOrigin) && (!contents || isAppPage(contents.getURL())) && permission === 'media');
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!isAppPage(contents.getURL()) || permission !== 'media' || !details.mediaTypes?.length ||
        !details.mediaTypes.every(type => type === 'audio')) return callback(false);
    if (isMac) {
      void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
    } else callback(true);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open show or rig…', accelerator: 'CmdOrCtrl+O', click: () => runRigCommand('open') },
      { label: 'Save show as…', accelerator: 'CmdOrCtrl+S', click: () => runRigCommand('show') },
      { label: 'Save show bundle…', click: () => runRigCommand('bundle') },
      { label: 'Export rig…', accelerator: 'CmdOrCtrl+Shift+S', click: () => runRigCommand('export') },
      { label: 'Export', submenu: [
        { label: 'CAD plan (DXF)…', click: () => runRigCommand('dxf') },
        { label: '3D scene (GLB)…', click: () => runRigCommand('glb') },
        { label: 'DMX channel patch (CSV)…', click: () => runRigCommand('csv') },
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
