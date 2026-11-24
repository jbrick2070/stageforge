import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';

const source = new URL('./', import.meta.url);
const app = new URL('build/app/', source);
const root = new URL('../', source);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
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

/**
 * Licence texts of every runtime dependency Vite bundles into the renderer (the production
 * dependency tree), so the desktop build carries the notices MIT, ISC and Apache-2.0 require.
 */
async function thirdPartyNotices() {
  const seen = new Map();
  const visit = async (name, required = false) => {
    if (seen.has(name)) return;
    const dir = new URL(`node_modules/${name}/`, root);
    let info;
    try {
      info = JSON.parse(await readFile(new URL('package.json', dir), 'utf8'));
    } catch (error) {
      // A direct dependency must be installed; a transitive one may be optional or platform-specific.
      if (required) throw new Error(`Cannot write third-party notices: ${name} is not installed (run npm ci).`, { cause: error });
      return;
    }
    // LICENSE, LICENCE.md, LICENSE-MIT, COPYING, NOTICE…
    const files = (await readdir(dir)).filter((file) => /^(licen[cs]e|copying|notice)/i.test(file)).sort();
    const texts = await Promise.all(files.map((file) => readFile(new URL(file, dir), 'utf8')));
    seen.set(name, { version: info.version, license: info.license ?? 'UNKNOWN', texts });
    for (const dependency of Object.keys(info.dependencies ?? {})) await visit(dependency);
  };
  for (const name of Object.keys(pkg.dependencies ?? {})) await visit(name, true);
  const sections = [...seen].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) =>
    `${'='.repeat(78)}\n${name} ${entry.version} — ${entry.license}\n${'='.repeat(78)}\n\n` +
    (entry.texts.length ? entry.texts.map((text) => text.trim()).join('\n\n') : `Licensed under ${entry.license}. No licence file is published with this package.`));
  return `StageForge ${version} bundles the following third-party software.\n\n${sections.join('\n\n')}\n`;
}

await Promise.all([
  writeFile(new URL('package.json', app), JSON.stringify(manifest, null, 2) + '\n'),
  copyFile(new URL('main.cjs', source), new URL('main.cjs', app)),
  copyFile(new URL('preload.cjs', source), new URL('preload.cjs', app)),
  copyFile(new URL('resources/icon.png', source), new URL('icon.png', app)),
  copyFile(new URL('LICENSE', root), new URL('LICENSE', app)),
  thirdPartyNotices().then((text) => writeFile(new URL('THIRD_PARTY_NOTICES.txt', app), text)),
]);
