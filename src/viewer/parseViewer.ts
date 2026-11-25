import { normalizeDesign } from '../data/stageDesign';
import { parseRigJson } from '../data/rigImport';
import { MAX_SHOW_JSON_BYTES, parseShowFile } from '../data/showFile';
import type { BundleAsset } from '../data/showBundle';
import type { RigConfig } from '../types/show';

export type ParsedViewerDocument =
  | { kind: 'show'; file: ReturnType<typeof parseShowFile>; nextRig: RigConfig; bundledMedia: BundleAsset[] }
  | { kind: 'rig'; rig: RigConfig };

/**
 * Pure parser for StageForge show JSON (v1–v7) or rig-only JSON opened in pitch viewer mode.
 * Never mutates desk state or localStorage.
 */
export function parseViewerJson(rawJson: string, bundledMedia: BundleAsset[] = []): ParsedViewerDocument {
  const json = rawJson.charCodeAt(0) === 0xfeff ? rawJson.slice(1) : rawJson;
  if (json.length > MAX_SHOW_JSON_BYTES || new TextEncoder().encode(json).length > MAX_SHOW_JSON_BYTES) {
    throw new Error('This JSON file exceeds the 32 MiB limit.');
  }
  let object: unknown;
  try {
    object = JSON.parse(json);
  } catch {
    throw new Error('Choose a valid StageForge show or rig JSON file.');
  }
  if (!object || typeof object !== 'object' || !('format' in object)) {
    return { kind: 'rig', rig: normalizeDesign(parseRigJson(json)) };
  }
  const file = parseShowFile(json);
  return { kind: 'show', file, nextRig: normalizeDesign(file.rig), bundledMedia };
}

/**
 * Pure async verifier & parser for any viewer input (File, JSON string, or bundle Uint8Array).
 * Bundles run full manifest + SHA-256 verification before returning.
 */
export async function parseViewerSource(source: File | string | Uint8Array): Promise<ParsedViewerDocument> {
  if (typeof source === 'string') {
    return parseViewerJson(source);
  }
  if (source instanceof Uint8Array) {
    const { MAX_BUNDLE_BYTES, openShowBundle } = await import('../data/showBundle');
    if (source.byteLength > MAX_BUNDLE_BYTES) throw new Error('This show exceeds the 512 MiB in-memory bundle limit.');
    const bundle = await openShowBundle(source);
    return parseViewerJson(JSON.stringify(bundle.show), bundle.files);
  }
  const lower = source.name.toLowerCase();
  if (lower.endsWith('.mvr')) {
    throw new Error('Pitch viewer opens StageForge shows (.stageforge.show.json) and bundles (.stageforge.zip). Exit viewer to import MVR files.');
  }
  if (lower.endsWith('.zip')) {
    const { MAX_BUNDLE_BYTES, openShowBundle } = await import('../data/showBundle');
    if (source.size > MAX_BUNDLE_BYTES) throw new Error('This show exceeds the 512 MiB in-memory bundle limit.');
    const bytes = new Uint8Array(await source.arrayBuffer());
    const bundle = await openShowBundle(bytes);
    return parseViewerJson(JSON.stringify(bundle.show), bundle.files);
  }
  if (!lower.endsWith('.json')) {
    throw new Error('Pitch viewer opens StageForge shows (.stageforge.show.json) and bundles (.stageforge.zip).');
  }
  if (source.size > MAX_SHOW_JSON_BYTES) throw new Error('This JSON file exceeds the 32 MiB limit.');
  const text = await source.text();
  return parseViewerJson(text);
}
