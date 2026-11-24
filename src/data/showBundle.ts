import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parseShowFile, referencedFiles, type StageForgeShowFile } from './showFile';

type AssetKind = 'file' | 'image' | 'video';
type MediaEntry = { kind: AssetKind; name: string; path: string; mime: string; bytes: number; sha256: string; durationSec: number | null };
type Manifest = { format: 'stageforge-bundle'; version: 1; show: { bytes: number; sha256: string }; media: MediaEntry[] };
export type BundleAsset = { kind: AssetKind; file: File };

// The browser implementation holds the archive in memory during import/export.
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_META = 32 * 1024 * 1024;
const MAX_ENTRIES = 8192;
const portableName = (name: string) => !!name.trim() && name !== '.' && name !== '..' && !/[\\/:\x00-\x1f\x7f]/u.test(name);
const sizeError = () => new Error('This show exceeds the 512 MiB in-memory bundle limit.');

function keyParts(key: string) {
  const split = key.indexOf(':');
  const kind = key.slice(0, split) as AssetKind;
  const name = key.slice(split + 1);
  if (!['file','image','video'].includes(kind) || !portableName(name))
    throw new Error(`"${name}" cannot be stored in a bundle. Rename it without slashes, colons or control characters and relink it.`);
  return { kind, name, path: 'media/' + kind + '/' + name };
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  if (!globalThis.crypto?.subtle) throw new Error('Show bundles need a secure context (https, localhost or the desktop app).');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('');
}

function readDuration(kind: AssetKind, file: File): Promise<number | null> {
  if (kind === 'image' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    const finish = (time: number | null) => {
      clearTimeout(timeout);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(time);
    };
    const timeout = setTimeout(() => finish(null), 2000);
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => finish(null);
    el.preload = 'metadata';
    el.src = url;
  });
}

export async function createShowBundle(show: StageForgeShowFile, assets: ReadonlyMap<string, { file: File }>): Promise<Blob> {
  const refs = [...referencedFiles(show.media, show.cues, show.timeline, show.stage)];
  const missing = refs.filter(key => !assets.has(key));
  if (missing.length) throw new Error('Relink these files before saving the bundle: ' + missing.map(key => keyParts(key).name).join(', '));
  const showBytes = new Uint8Array(strToU8(JSON.stringify(show, null, 2) + '\n'));
  if (showBytes.length > MAX_META || refs.length + 2 > MAX_ENTRIES) throw new Error('Too many show entries or too much JSON for this bundle.');
  if (refs.reduce((n,key) => n + assets.get(key)!.file.size, showBytes.length) > MAX_BUNDLE_BYTES) throw sizeError();
  const manifest: Manifest = { format: 'stageforge-bundle', version: 1, show: { bytes: showBytes.length, sha256: await sha256(showBytes) }, media: [] };
  const files: Record<string, Uint8Array> = { 'show.json': showBytes };
  for (const key of refs) {
    const ref = keyParts(key);
    const file = assets.get(key)!.file;
    const [buffer,durationSec] = await Promise.all([file.arrayBuffer(), readDuration(ref.kind, file)]);
    const bytes = new Uint8Array(buffer);
    files[ref.path] = bytes;
    manifest.media.push({ ...ref, mime: file.type, durationSec, bytes: bytes.length, sha256: await sha256(bytes) });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  // A fixed timestamp keeps bundles of identical shows byte-identical.
  const zip = zipSync(files, { level: 0, mtime: '2000-01-01T00:00:00Z' });
  if (zip.length > MAX_BUNDLE_BYTES) throw sizeError();
  return new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

// Only types the desk can decode for each kind survive; anything else becomes untyped bytes.
const MIME_FOR: Record<AssetKind, RegExp> = { file: /^audio\/[\w.+-]+$/i, image: /^image\/[\w.+-]+$/i, video: /^video\/[\w.+-]+$/i };
const DIRECTORIES = new Set(['media/', 'media/file/', 'media/image/', 'media/video/']);

export async function openShowBundle(archive: Uint8Array) {
  if (archive.length > MAX_BUNDLE_BYTES) throw sizeError();
  let total = 0;
  const seen = new Set<string>();
  const files = unzipSync(archive, { filter(entry) {
    if (seen.has(entry.name)) throw new Error('Duplicate bundle entry: ' + entry.name);
    // Archivers that re-zip an extracted bundle add folder entries; they carry no data.
    if (DIRECTORIES.has(entry.name) && entry.originalSize === 0) return false;
    seen.add(entry.name);
    const elements = entry.name.split('/');
    const meta = entry.name === 'manifest.json' || entry.name === 'show.json';
    if (!meta && !(elements.length === 3 && elements[0] === 'media' && ['video','image','file'].includes(elements[1]) && portableName(elements[2])))
      throw new Error('Unexpected path in bundle: ' + entry.name);
    if (meta && entry.originalSize > MAX_META) throw new Error('Bundle metadata is too large.');
    total += entry.originalSize;
    if (seen.size > MAX_ENTRIES || total > MAX_BUNDLE_BYTES) throw sizeError();
    return true;
  }});
  if (!files['manifest.json'] || !files['show.json']) throw new Error('Choose a StageForge bundle containing manifest.json and show.json.');
  let manifest: Manifest;
  try { manifest = JSON.parse(strFromU8(files['manifest.json'])); } catch { throw new Error('The StageForge bundle manifest is not valid JSON.'); }
  if (manifest?.format !== 'stageforge-bundle' || manifest.version !== 1 || !Array.isArray(manifest.media))
    throw new Error('Unsupported StageForge bundle manifest.');
  async function verify(bytes: Uint8Array | undefined, info: { bytes: number; sha256: string } | undefined, name: string) {
    if (!bytes || !info || info.bytes !== bytes.length || typeof info.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.sha256)
        || await sha256(bytes as Uint8Array<ArrayBuffer>) !== info.sha256) throw new Error('Bundle integrity check failed for ' + name + '.');
  }
  await verify(files['show.json'], manifest.show, 'show.json');
  const show = parseShowFile(strFromU8(files['show.json']));
  const needed = referencedFiles(show.media, show.cues, show.timeline, show.stage);
  const media: BundleAsset[] = [];
  for (const entry of manifest.media) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.mime !== 'string' ||
        !(entry.durationSec === null || Number.isFinite(entry.durationSec) && entry.durationSec >= 0))
      throw new Error('Invalid media entry in the StageForge manifest.');
    const key = entry.kind + ':' + entry.name;
    if (!needed.delete(key) || keyParts(key).path !== entry.path) throw new Error('Unexpected or repeated media reference: ' + entry.name);
    const bytes = files[entry.path];
    await verify(bytes, entry, entry.name);
    media.push({ kind: entry.kind, file: new File([bytes as Uint8Array<ArrayBuffer>], entry.name, { type: MIME_FOR[entry.kind].test(entry.mime) ? entry.mime : '' }) });
  }
  if (needed.size || seen.size !== media.length + 2) throw new Error('The bundle does not match all media referenced by its show.');
  return { show, files: media };
}
