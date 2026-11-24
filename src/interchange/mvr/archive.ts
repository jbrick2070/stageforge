import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * MVR / GDTF archives (DIN SPEC 15801 "File Format Definition"): a PKZIP file with every entry
 * in the root, STORE or DEFLATE only, no encryption, names unique ignoring case, and a UTF-8
 * GeneralSceneDescription.xml (MVR) or description.xml (GDTF).
 */

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** XML, JSON and other text entries are far smaller in practice. */
export const MAX_TEXT_ENTRY_BYTES = 64 * 1024 * 1024;
/** Total inflated size and entry count, so a small archive can't expand into gigabytes. */
export const MAX_INFLATED_BYTES = 1024 * 1024 * 1024;
export const MAX_ENTRIES = 4096;

export interface ArchiveEntry {
  name: string;
  data: Uint8Array;
}

/** Entry names must be plain root file names (no folders, drive letters or control characters). */
export function isRootName(name: string): boolean {
  return !!name && name.length <= 255 && !/[\\/:\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..';
}

/** Write a conforming archive. `store` keeps already-compressed media (glb, png) uncompressed. */
export function writeArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  const seen = new Set<string>();
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const { name, data } of entries) {
    if (!isRootName(name)) throw new Error(`"${name}" is not a valid MVR file name.`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Two archive entries are both named "${name}" (names must differ by more than case).`);
    seen.add(key);
    files[name] = [data, { level: /\.(xml|gdtf)$/i.test(name) ? 6 : 0 }];
  }
  return zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') });
}

/**
 * Read an archive into a case-insensitive map. Entries in folders are accepted by their base
 * name (some exporters nest files), but a base-name collision is rejected.
 */
export function readArchive(bytes: Uint8Array, kind = 'MVR'): Map<string, ArchiveEntry> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`This ${kind} file exceeds the 512 MiB limit.`);
  let raw: Record<string, Uint8Array>;
  let entries = 0, inflated = 0;
  try {
    raw = unzipSync(bytes, {
      filter(entry) {
        if (entry.name.endsWith('/')) return false;
        if (++entries > MAX_ENTRIES) throw new Error(`more than ${MAX_ENTRIES} files.`);
        const text = /\.(xml|json|txt)$/i.test(entry.name);
        if (entry.originalSize > (text ? MAX_TEXT_ENTRY_BYTES : MAX_ENTRY_BYTES))
          throw new Error(`"${entry.name}" exceeds ${text ? 64 : 256} MiB.`);
        // fflate stops inflating at the declared size, so declared sizes bound the real total.
        inflated += entry.originalSize;
        if (inflated > MAX_INFLATED_BYTES) throw new Error('its contents exceed 1 GiB.');
        return true;
      },
    });
  } catch (error) {
    const reason = error instanceof Error && /MiB|GiB|files\./.test(error.message) ? ': ' + error.message : '.';
    throw new Error(`Cannot read this ${kind} archive${reason}`);
  }
  const out = new Map<string, ArchiveEntry>();
  for (const [path, data] of Object.entries(raw)) {
    const name = path.split(/[\\/]/).pop()!;
    if (!isRootName(name)) continue;
    const key = name.toLowerCase();
    if (out.has(key)) throw new Error(`This ${kind} archive has two files named "${name}".`);
    out.set(key, { name, data });
  }
  return out;
}

export const utf8 = { encode: strToU8, decode: (data: Uint8Array) => strFromU8(data) };
