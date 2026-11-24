import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const compiler = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true } });
after(() => compiler.close());
const { createShowBundle, openShowBundle } = await compiler.ssrLoadModule('/src/data/showBundle.ts');
const { parseShowFile, referencedFiles } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const show = parseShowFile(await readFile(new URL('./fixtures/native-authoring-v3.stageforge.show.json', import.meta.url), 'utf8'));
const refs = [...referencedFiles(show.media, show.cues, show.timeline, show.stage)];
const media = new Map(refs.map(key => [key, { file: new File([key], key.slice(6), { type: 'video/mp4' }) }]));
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());

test('portable bundle indexes secondary-only media and preserves original bytes and wall controls', async () => {
  assert.deepEqual(refs.sort(), ['video:amber-clouds.mp4','video:blue-raster.mp4','video:guest-surface.mp4']);
  const archive = await bytes(await createShowBundle(show, media));
  const unpacked = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(unpacked['manifest.json']));
  assert.equal(manifest.media.length, 3);
  assert.ok(manifest.media.every(x => x.sha256.length === 64 && x.bytes > 0 && x.durationSec === null));
  const reopened = await openShowBundle(archive);
  assert.deepEqual(reopened.show, show);
  for (const {file,kind} of reopened.files) assert.equal(await file.text(), kind + ':' + file.name);
  const missing = new Map(media);
  missing.delete('video:guest-surface.mp4');
  await assert.rejects(createShowBundle(show, missing), /Relink.*guest-surface/);
});

test('incomplete, unexpected and damaged media bundles fail before exposing any media', async () => {
  const contents = unzipSync(await bytes(await createShowBundle(show, media)));
  const file = 'media/video/guest-surface.mp4';
  const changed = new Uint8Array(contents[file]);
  changed[0] ^= 1;
  await assert.rejects(openShowBundle(zipSync({...contents, [file]: changed})), /integrity.*guest-surface/);
  const missing = {...contents};
  delete missing[file];
  await assert.rejects(openShowBundle(zipSync(missing)), /integrity.*guest-surface/);
  await assert.rejects(openShowBundle(zipSync({...contents, 'nested/extra.txt': strToU8('extra')})), /Unexpected path/);
  const manifest = JSON.parse(strFromU8(contents['manifest.json']));
  manifest.media.push(manifest.media[0]);
  await assert.rejects(openShowBundle(zipSync({...contents,'manifest.json': strToU8(JSON.stringify(manifest))})), /repeated media/);
});

test('bundles reopen after re-zipping with folder entries, are byte-reproducible and reject a tampered show.json', async () => {
  const first = await bytes(await createShowBundle(show, media));
  const second = await bytes(await createShowBundle(show, media));
  assert.deepEqual(first, second, 'identical shows produce identical bundles');
  const contents = unzipSync(first);
  const empty = new Uint8Array(0);
  const rezipped = zipSync({ 'media/': empty, 'media/video/': empty, ...contents });
  assert.equal((await openShowBundle(rezipped)).files.length, 3);
  const json = new Uint8Array(contents['show.json']);
  json[json.length - 2] ^= 1;
  await assert.rejects(openShowBundle(zipSync({ ...contents, 'show.json': json })), /integrity.*show\.json/);
  await assert.rejects(openShowBundle(zipSync({ ...contents, 'manifest.json': strToU8('{') })), /manifest is not valid JSON/);
});

test('manifest MIME types that do not match the media kind are dropped', async () => {
  const contents = unzipSync(await bytes(await createShowBundle(show, media)));
  const manifest = JSON.parse(strFromU8(contents['manifest.json']));
  manifest.media[0].mime = 'text/html';
  const reopened = await openShowBundle(zipSync({ ...contents, 'manifest.json': strToU8(JSON.stringify(manifest)) }));
  assert.deepEqual(reopened.files.map(f => f.file.type).sort(), ['', 'video/mp4', 'video/mp4']);
});

test('media names that cannot be packaged fail with the offending name', async () => {
  const named = structuredClone(show);
  named.media.screen = { ...named.media.screen, kind: 'video', name: 'Act 1: open.mp4' };
  const assets = new Map(media);
  assets.set('video:Act 1: open.mp4', { file: new File(['x'], 'Act 1: open.mp4', { type: 'video/mp4' }) });
  await assert.rejects(createShowBundle(named, assets), /"Act 1: open\.mp4" cannot be stored in a bundle/);
});
