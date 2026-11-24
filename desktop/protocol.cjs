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
    try {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
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
      return new Response(null, { status: 404 });
    }
  };
}

module.exports = { CSP, isAppPage, createRendererHandler };
