const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'";

function isAppPage(rawUrl) {
  if (typeof rawUrl !== 'string' || !URL.canParse(rawUrl)) return false;
  const url = new URL(rawUrl);
  return url.protocol === 'stageforge:' && url.host === 'app' && !url.port && !url.username && !url.password;
}

/**
 * Create the stageforge:// protocol handler. Sets CSP and X-Content-Type-Options on every
 * response so case-insensitive filesystems (Windows/macOS) can never serve index.html without CSP.
 */
function createRendererHandler({ fetchFile, rendererRoot, csp = CSP }) {
  const root = path.resolve(rendererRoot);
  return async function serveRenderer(request) {
    if (request.method !== 'GET' || !isAppPage(request.url)) {
      return new Response(null, { status: 404 });
    }
    let pathname = '';
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
      if (/[\\:\x00]/.test(pathname)) return new Response(null, { status: 400 });
      const file = path.resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        return new Response(null, { status: 404 });
      }
      const result = await fetchFile(pathToFileURL(file).href);
      const headers = new Headers(result.headers);
      headers.set('Content-Security-Policy', csp);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    } catch {
      if (pathname === '/demo/track.json') {
        return new Response(null, {
          status: 204,
          headers: {
            'Content-Security-Policy': csp,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        });
      }
      return new Response(null, { status: 404 });
    }
  };
}

const FTDI_VENDOR_ID = 0x0403;

function parseUsbId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^0x[0-9a-f]{1,4}$/i.test(trimmed)) return parseInt(trimmed, 16);
    if (/^0[0-9a-f]{3}$/i.test(trimmed) || (/^[0-9a-f]{1,4}$/i.test(trimmed) && /[a-f]/i.test(trimmed))) {
      return parseInt(trimmed, 16);
    }
    if (/^(?:0|[1-9]\d{0,4})$/.test(trimmed)) {
      const n = Number(trimmed);
      if (n >= 0 && n <= 0xffff) return n;
    }
  }
  return null;
}

function isFtdiSerialPort(port) {
  if (!port || typeof port !== 'object') return false;
  return parseUsbId(port.vendorId) === FTDI_VENDOR_ID;
}

/**
 * Stable per-session identity key for an approved serial port.
 * Uses vendorId:productId:serialNumber when available, falling back to portId.
 */
function serialDeviceKey(device) {
  if (!device || typeof device !== 'object') return '';
  const vid = parseUsbId(device.vendorId);
  const pid = parseUsbId(device.productId);
  const serial = typeof device.serialNumber === 'string' ? device.serialNumber.trim() : '';
  if (vid !== null && pid !== null && serial) {
    return `${vid.toString(16)}:${pid.toString(16)}:${serial}`;
  }
  const portName = typeof device.portName === 'string' ? device.portName.trim() : '';
  if (vid !== null && pid !== null && portName) {
    return `${vid.toString(16)}:${pid.toString(16)}:${portName}`;
  }
  const id = typeof device.deviceId === 'string' ? device.deviceId : (typeof device.portId === 'string' ? device.portId : '');
  return id ? `id:${id}` : '';
}

/**
 * Order serial ports for the chooser: FTDI USB DMX devices first, capped at 8 entries.
 */
function selectVisibleSerialPorts(portList, maxPorts = 8) {
  if (!Array.isArray(portList)) return [];
  const ftdi = [];
  const others = [];
  for (const port of portList) {
    if (!port || typeof port.portId !== 'string' || !port.portId) continue;
    if (isFtdiSerialPort(port)) ftdi.push(port);
    else others.push(port);
  }
  return [...ftdi, ...others].slice(0, maxPorts);
}

module.exports = {
  CSP,
  FTDI_VENDOR_ID,
  isAppPage,
  createRendererHandler,
  parseUsbId,
  isFtdiSerialPort,
  serialDeviceKey,
  selectVisibleSerialPorts,
};
