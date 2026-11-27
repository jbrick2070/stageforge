import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const ALLOWED_LICENSES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0']);

export function readLicenseField(info) {
  if (typeof info.license === 'string' && info.license.trim()) return info.license.trim();
  if (info.license && typeof info.license === 'object' && typeof info.license.type === 'string' && info.license.type.trim()) {
    return info.license.type.trim();
  }
  if (Array.isArray(info.licenses)) {
    const types = info.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter((t) => typeof t === 'string' && t.trim());
    if (types.length) return types.join(' AND ');
  }
  return 'UNKNOWN';
}

/** Validate a simple SPDX expression (parentheses, AND, OR, single IDs) against ALLOWED_LICENSES. */
export function isPermissiveSpdx(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g);
  if (!tokens || !tokens.length) return false;
  let pos = 0;
  function parseOr() {
    let ok = parseAnd();
    while (tokens[pos] === 'OR') {
      pos++;
      const right = parseAnd();
      ok = ok || right;
    }
    return ok;
  }
  function parseAnd() {
    let ok = parsePrimary();
    while (tokens[pos] === 'AND') {
      pos++;
      const right = parsePrimary();
      ok = ok && right;
    }
    return ok;
  }
  function parsePrimary() {
    const tok = tokens[pos++];
    if (!tok) throw new Error('Unexpected end of SPDX expression');
    if (tok === '(') {
      const inner = parseOr();
      if (tokens[pos++] !== ')') throw new Error('Unclosed parenthesis in SPDX expression');
      return inner;
    }
    if (tok === ')' || tok === 'AND' || tok === 'OR' || tok === 'WITH') {
      throw new Error(`Unexpected token "${tok}" in SPDX expression`);
    }
    if (tokens[pos] === 'WITH') {
      // Do not blindly allow unknown license exceptions.
      return false;
    }
    return ALLOWED_LICENSES.has(tok);
  }
  try {
    const result = parseOr();
    return result && pos === tokens.length;
  } catch {
    return false;
  }
}

async function resolvePackageDir(name, fromDir, rootDir) {
  let current = path.resolve(fromDir);
  const stop = path.resolve(rootDir);
  while (true) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'));
    try {
      const info = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'));
      return { dir: candidate, info };
    } catch {
      if (current === stop) return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

const asciiCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Licence texts of every runtime dependency Vite bundles into the renderer (the production
 * dependency tree), so the desktop build carries the notices MIT, ISC, BSD and Apache-2.0 require.
 */
export async function thirdPartyNotices(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const pkg = JSON.parse(await readFile(path.join(resolvedRoot, 'package.json'), 'utf8'));
  const seen = new Map();
  const visit = async (name, fromDir, optional = false) => {
    const found = await resolvePackageDir(name, fromDir, resolvedRoot);
    if (!found) {
      if (optional) return;
      throw new Error(`Cannot write third-party notices: ${name} is not installed (run npm ci).`);
    }
    const { dir, info } = found;
    const key = `${info.name || name}@${info.version}`;
    if (seen.has(key)) return;
    const license = readLicenseField(info);
    if (!isPermissiveSpdx(license)) {
      throw new Error(`Refusing to bundle ${key} with non-permissive licence "${license}".`);
    }
    // LICENSE, LICENCE.md, LICENSE-MIT, COPYING, NOTICE… (skip directories like licenses/)
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(asciiCompare);
    const texts = await Promise.all(files.map((file) => readFile(path.join(dir, file), 'utf8')));
    seen.set(key, { name: info.name || name, version: info.version, license, texts });
    const optionalDeps = new Set(Object.keys(info.optionalDependencies ?? {}));
    for (const dependency of Object.keys(info.dependencies ?? {})) {
      await visit(dependency, dir, optionalDeps.has(dependency));
    }
  };
  const rootOptional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    await visit(name, resolvedRoot, rootOptional.has(name));
  }
  const sections = [...seen.values()]
    .sort((a, b) => asciiCompare(a.name, b.name) || asciiCompare(a.version, b.version))
    .map((entry) =>
      `${'='.repeat(78)}\n${entry.name} ${entry.version} — ${entry.license}\n${'='.repeat(78)}\n\n` +
      (entry.texts.length ? entry.texts.map((text) => text.trim()).join('\n\n') : `Licensed under ${entry.license}. No licence file is published with this package.`));
  return `StageForge ${pkg.version} bundles the following third-party software.\n\n${sections.join('\n\n')}\n`;
}

async function main() {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const app = path.join(source, 'build', 'app');
  const root = path.resolve(source, '..');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const { version, license } = pkg;
  const manifest = {
    name: 'stageforge',
    productName: 'StageForge',
    version,
    description: 'Concert stage, lighting and show designer',
    author: 'StageForge contributors',
    license,
    main: 'main.cjs',
  };
  await mkdir(app, { recursive: true });
  await Promise.all([
    writeFile(path.join(app, 'package.json'), JSON.stringify(manifest, null, 2) + '\n'),
    copyFile(path.join(source, 'main.cjs'), path.join(app, 'main.cjs')),
    copyFile(path.join(source, 'protocol.cjs'), path.join(app, 'protocol.cjs')),
    copyFile(path.join(source, 'dmx-packets.cjs'), path.join(app, 'dmx-packets.cjs')),
    copyFile(path.join(source, 'dmx-sender.cjs'), path.join(app, 'dmx-sender.cjs')),
    copyFile(path.join(source, 'dmx-ipc.cjs'), path.join(app, 'dmx-ipc.cjs')),
    copyFile(path.join(source, 'osc-packets.cjs'), path.join(app, 'osc-packets.cjs')),
    copyFile(path.join(source, 'artnet-rx.cjs'), path.join(app, 'artnet-rx.cjs')),
    copyFile(path.join(source, 'show-control-service.cjs'), path.join(app, 'show-control-service.cjs')),
    copyFile(path.join(source, 'show-control-ipc.cjs'), path.join(app, 'show-control-ipc.cjs')),
    copyFile(path.join(source, 'viewer-ipc.cjs'), path.join(app, 'viewer-ipc.cjs')),
    copyFile(path.join(source, 'output-interlock.cjs'), path.join(app, 'output-interlock.cjs')),
    copyFile(path.join(source, 'ai-bridge-tools.cjs'), path.join(app, 'ai-bridge-tools.cjs')),
    copyFile(path.join(source, 'ai-bridge-service.cjs'), path.join(app, 'ai-bridge-service.cjs')),
    copyFile(path.join(source, 'ai-bridge-ipc.cjs'), path.join(app, 'ai-bridge-ipc.cjs')),
    copyFile(path.join(root, 'src', 'schemas', 'show-v8.schema.json'), path.join(app, 'show-v8.schema.json')),
    copyFile(path.join(root, 'src', 'schemas', 'show-v9.schema.json'), path.join(app, 'show-v9.schema.json')),
    copyFile(path.join(root, 'src', 'schemas', 'show-v10.schema.json'), path.join(app, 'show-v10.schema.json')),
    copyFile(path.join(root, 'src', 'schemas', 'show-v11.schema.json'), path.join(app, 'show-v11.schema.json')),
    copyFile(path.join(source, 'preload.cjs'), path.join(app, 'preload.cjs')),
    copyFile(path.join(source, 'resources', 'icon.png'), path.join(app, 'icon.png')),
    copyFile(path.join(root, 'LICENSE'), path.join(app, 'LICENSE')),
    thirdPartyNotices(root).then((text) => writeFile(path.join(app, 'THIRD_PARTY_NOTICES.txt'), text)),
  ]);
  await viteBuild({
    configFile: false,
    logLevel: 'warn',
    ssr: {
      target: 'node',
      noExternal: true,
    },
    build: {
      ssr: path.join(source, 'mcp-sdk-entry.mjs'),
      outDir: app,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'mcp-sdk.cjs',
        },
      },
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
