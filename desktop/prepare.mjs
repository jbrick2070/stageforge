import { copyFile, readFile, writeFile } from 'node:fs/promises';

const source = new URL('./', import.meta.url);
const app = new URL('build/app/', source);
const { version, license } = JSON.parse(await readFile(new URL('../package.json', source), 'utf8'));
const manifest = {
  name: 'stageforge',
  productName: 'StageForge',
  version,
  description: 'Concert stage, lighting and show designer',
  author: 'StageForge contributors',
  license,
  main: 'main.cjs',
};
await Promise.all([
  writeFile(new URL('package.json', app), JSON.stringify(manifest, null, 2) + '\n'),
  copyFile(new URL('main.cjs', source), new URL('main.cjs', app)),
  copyFile(new URL('preload.cjs', source), new URL('preload.cjs', app)),
  copyFile(new URL('resources/icon.png', source), new URL('icon.png', app)),
  copyFile(new URL('../LICENSE', source), new URL('LICENSE', app)),
]);
