/**
 * Pure, dependency-free ILDA (.ild) laser frame reader, encoder, and built-in demo generator.
 *
 * Supports ILDA Image Data Transfer Format (IDTF) Revision 011:
 *   - Format 0: 3D coordinates with indexed color (8 bytes/record)
 *   - Format 1: 2D coordinates with indexed color (6 bytes/record)
 *   - Format 2: Color palette for subsequent indexed frames (3 bytes/record, up to 256 entries)
 *   - Format 4: 3D coordinates with true color BGR (10 bytes/record)
 *   - Format 5: 2D coordinates with true color BGR (8 bytes/record)
 *
 * All input is treated as hostile: strict byte, frame, and point caps are enforced before allocation,
 * and every structural error throws a readable Error naming the byte offset.
 */

export const ILDA_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
export const ILDA_MAX_FRAMES = 2_000;
export const ILDA_MAX_POINTS_PER_FRAME = 4_000;
export const ILDA_MAX_TOTAL_POINTS_HIGH = 200_000;
export const ILDA_MAX_TOTAL_POINTS_LOW = 60_000;
export const ILDA_HEADER_BYTES = 32;
export const ILDA_STATUS_LAST_POINT = 0x80;
export const ILDA_STATUS_BLANKED = 0x40;

export type IldaFormatCode = 0 | 1 | 2 | 4 | 5;
export type IldaTier = 'high' | 'low';

export interface IldaFrameSlice {
  /** Frame name from the 8-byte ASCII header field (trimmed). */
  readonly name: string;
  /** Company name from the 8-byte ASCII header field (trimmed). */
  readonly company: string;
  /** ILDA format code for this frame (0, 1, 4, or 5). */
  readonly format: 0 | 1 | 4 | 5;
  /** Starting point index in the clip's flat typed arrays. */
  readonly offset: number;
  /** Total point count in this frame (lit + blanked). */
  readonly count: number;
  /** Count of unblanked (visible) points in this frame. */
  readonly litCount: number;
  /** Normalized angular span of lit points in [-1, 1] X/Y coordinates (0 if < 2 lit points). */
  readonly litSpanX: number;
  readonly litSpanY: number;
  /** Minimum normalized Y of lit points in [-1, 1], or 0 when no lit points exist. */
  readonly minLitY: number;
  /** Maximum normalized Y of lit points in [-1, 1], or 0 when no lit points exist. */
  readonly maxLitY: number;
  /** Minimum/maximum normalized X of lit points in [-1, 1]. */
  readonly minLitX: number;
  readonly maxLitX: number;
}

export interface IldaBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly hasLitPoints: boolean;
}

export interface IldaClip {
  readonly name: string;
  readonly frames: readonly IldaFrameSlice[];
  /** Interleaved int16 X, Y coordinates (length = totalPoints * 2). */
  readonly xy: Int16Array;
  /** Optional int16 Z coordinates (present when any 3D format 0/4 frame exists; length = totalPoints). */
  readonly z?: Int16Array;
  /** Interleaved uint8 R, G, B values (length = totalPoints * 3). */
  readonly rgb: Uint8Array;
  /** 1 = blanked, 0 = lit (length = totalPoints). */
  readonly blank: Uint8Array;
  /** Total points across all frames. */
  readonly totalPoints: number;
  /** Normalized lit-point bounds across all frames in [-1, 1]. */
  readonly bounds: IldaBounds;
  /** Non-fatal parse warnings (e.g. trailing bytes after EOF, clamped palette indices). */
  readonly warnings: readonly string[];
}

export interface ParseIldaOptions {
  /** Optional display label for the clip. */
  name?: string;
  /** Render tier sets the total-point cap (200k high / 60k low). Defaults to 'high'. */
  tier?: IldaTier;
}

/**
 * Standard 64-color ILDA default palette (IDTF Revision 011, Section 4.1).
 * Stored as flat [R, G, B] triples (64 * 3 = 192 bytes).
 */
export const ILDA_DEFAULT_PALETTE: ReadonlyUint8Array = new Uint8Array([
  255,   0,   0, // 00 Red
  255,  16,   0, // 01
  255,  32,   0, // 02
  255,  48,   0, // 03
  255,  64,   0, // 04
  255,  80,   0, // 05
  255,  96,   0, // 06
  255, 112,   0, // 07
  255, 128,   0, // 08 Orange
  255, 144,   0, // 09
  255, 160,   0, // 10
  255, 176,   0, // 11
  255, 192,   0, // 12
  255, 208,   0, // 13
  255, 224,   0, // 14
  255, 240,   0, // 15
  255, 255,   0, // 16 Yellow
  224, 255,   0, // 17
  192, 255,   0, // 18
  160, 255,   0, // 19
  128, 255,   0, // 20
   96, 255,   0, // 21
   64, 255,   0, // 22
   32, 255,   0, // 23
    0, 255,   0, // 24 Green
    0, 255,  36, // 25
    0, 255,  73, // 26
    0, 255, 109, // 27
    0, 255, 146, // 28
    0, 255, 182, // 29
    0, 255, 219, // 30
    0, 255, 255, // 31 Cyan
    0, 227, 255, // 32
    0, 198, 255, // 33
    0, 170, 255, // 34
    0, 142, 255, // 35
    0, 113, 255, // 36
    0,  85, 255, // 37
    0,  56, 255, // 38
    0,  28, 255, // 39
    0,   0, 255, // 40 Blue
   32,   0, 255, // 41
   64,   0, 255, // 42
   96,   0, 255, // 43
  128,   0, 255, // 44
  160,   0, 255, // 45
  192,   0, 255, // 46
  224,   0, 255, // 47
  255,   0, 255, // 48 Magenta
  255,  32, 255, // 49
  255,  64, 255, // 50
  255,  96, 255, // 51
  255, 128, 255, // 52
  255, 160, 255, // 53
  255, 192, 255, // 54
  255, 224, 255, // 55
  255, 255, 255, // 56 White
  255, 224, 224, // 57
  255, 192, 192, // 58
  255, 160, 160, // 59
  255, 128, 128, // 60
  255,  96,  96, // 61
  255,  64,  64, // 62
  255,  32,  32, // 63
]);

type ReadonlyUint8Array = Readonly<Uint8Array>;

const RECORD_SIZES: Record<IldaFormatCode, number> = {
  0: 8,  // 3D indexed: x,y,z (int16 BE), status, colorIdx
  1: 6,  // 2D indexed: x,y (int16 BE), status, colorIdx
  2: 3,  // Color palette: r,g,b (uint8)
  4: 10, // 3D true color: x,y,z (int16 BE), status, B, G, R
  5: 8,  // 2D true color: x,y (int16 BE), status, B, G, R
};

function isKnownFormat(code: number): code is IldaFormatCode {
  return code === 0 || code === 1 || code === 2 || code === 4 || code === 5;
}

function readAscii8(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    const ch = bytes[offset + i];
    if (ch === 0) break;
    if (ch >= 0x20 && ch <= 0x7e) out += String.fromCharCode(ch);
  }
  return out.trim();
}

function writeAscii8(bytes: Uint8Array, offset: number, text: string) {
  for (let i = 0; i < 8; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    bytes[offset + i] = code >= 0x20 && code <= 0x7e ? code : 0x20;
  }
}

/** Normalize an int16 ILDA coordinate [-32768..32767] to [-1, 1]. */
export function normalizeIldaCoord(value: number): number {
  const n = value / 32768;
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
}

class BoundedReader {
  private readonly view: DataView;
  readonly bytes: Uint8Array;
  readonly length: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.length = bytes.byteLength;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  ensure(offset: number, count: number, label: string) {
    if (offset < 0 || count < 0 || offset + count > this.length) {
      throw new Error(`Truncated ILDA ${label} at offset ${offset} (need ${count} bytes, ${Math.max(0, this.length - offset)} remaining).`);
    }
  }

  u8(offset: number): number {
    this.ensure(offset, 1, 'byte');
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    this.ensure(offset, 2, 'uint16');
    return this.view.getUint16(offset, false);
  }

  i16(offset: number): number {
    this.ensure(offset, 2, 'int16');
    return this.view.getInt16(offset, false);
  }
}

interface PendingFrame {
  name: string;
  company: string;
  format: 0 | 1 | 4 | 5;
  dataOffset: number;
  recordCount: number;
  palette: Uint8Array;
}

/**
 * Parse a binary ILDA (.ild) file into flat typed arrays with strict security caps.
 * Throws a readable Error on malformed, unsupported, or oversized input.
 */
export function parseIlda(input: Uint8Array | ArrayBuffer, options: ParseIldaOptions = {}): IldaClip {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0) {
    throw new Error('ILDA file is empty.');
  }
  if (bytes.byteLength > ILDA_MAX_BYTES) {
    throw new Error(
      `ILDA file is too large (${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; limit is ${ILDA_MAX_BYTES / (1024 * 1024)} MB).`,
    );
  }

  const maxTotalPoints = options.tier === 'low' ? ILDA_MAX_TOTAL_POINTS_LOW : ILDA_MAX_TOTAL_POINTS_HIGH;
  const reader = new BoundedReader(bytes);
  const warnings: string[] = [];
  const pendingFrames: PendingFrame[] = [];

  let activePalette: Uint8Array = new Uint8Array(ILDA_DEFAULT_PALETTE);
  let has3d = false;
  let offset = 0;
  let estimatedTotalPoints = 0;

  // Pass 1: validate every section header, bounds, and caps before allocating large output buffers.
  while (offset < reader.length) {
    if (reader.length - offset < ILDA_HEADER_BYTES && pendingFrames.length > 0) {
      warnings.push(
        `Ignored ${reader.length - offset} trailing byte(s) after last frame at offset ${offset} (missing EOF header).`,
      );
      break;
    }
    reader.ensure(offset, ILDA_HEADER_BYTES, 'section header');

    if (
      bytes[offset] !== 0x49 || // 'I'
      bytes[offset + 1] !== 0x4c || // 'L'
      bytes[offset + 2] !== 0x44 || // 'D'
      bytes[offset + 3] !== 0x41 // 'A'
    ) {
      throw new Error(`Invalid ILDA magic header at offset ${offset} (expected "ILDA").`);
    }

    const format = reader.u8(offset + 7);
    if (!isKnownFormat(format)) {
      throw new Error(`Unsupported ILDA format code ${format} at offset ${offset}.`);
    }

    const name = readAscii8(bytes, offset + 8);
    const company = readAscii8(bytes, offset + 16);
    const numberOfRecords = reader.u16(offset + 24);
    const dataOffset = offset + ILDA_HEADER_BYTES;

    if (format === 2) {
      if (numberOfRecords === 0) {
        // Palette header with 0 records acts as end-of-file per IDTF.
        offset = dataOffset;
        if (offset < reader.length) {
          warnings.push(`Ignored ${reader.length - offset} trailing byte(s) after EOF header at offset ${offset}.`);
        }
        break;
      }
      if (numberOfRecords > 256) {
        throw new Error(`ILDA color palette at offset ${offset} has ${numberOfRecords} entries (maximum is 256).`);
      }
      const payloadBytes = numberOfRecords * RECORD_SIZES[2];
      reader.ensure(dataOffset, payloadBytes, 'palette records');
      const nextPalette = new Uint8Array(numberOfRecords * 3);
      nextPalette.set(bytes.subarray(dataOffset, dataOffset + payloadBytes));
      activePalette = nextPalette;
      offset = dataOffset + payloadBytes;
      continue;
    }

    // End-of-file record for coordinate formats (0, 1, 4, 5): numberOfRecords === 0.
    if (numberOfRecords === 0) {
      offset = dataOffset;
      if (offset < reader.length) {
        warnings.push(`Ignored ${reader.length - offset} trailing byte(s) after EOF header at offset ${offset}.`);
      }
      break;
    }

    if (pendingFrames.length >= ILDA_MAX_FRAMES) {
      throw new Error(`ILDA file exceeds the ${ILDA_MAX_FRAMES}-frame limit at offset ${offset}.`);
    }
    if (numberOfRecords > ILDA_MAX_POINTS_PER_FRAME) {
      throw new Error(
        `ILDA frame ${pendingFrames.length} at offset ${offset} has ${numberOfRecords} points (limit is ${ILDA_MAX_POINTS_PER_FRAME} per frame).`,
      );
    }

    const stride = RECORD_SIZES[format];
    const payloadBytes = numberOfRecords * stride;
    reader.ensure(dataOffset, payloadBytes, `frame ${pendingFrames.length} records`);

    // Determine effective count up to and including the first point with last-point bit (0x80) set.
    let actualCount = 0;
    const statusRelOffset = format === 0 || format === 4 ? 6 : 4;
    for (let i = 0; i < numberOfRecords; i++) {
      const status = bytes[dataOffset + i * stride + statusRelOffset];
      actualCount = i + 1;
      if (status & ILDA_STATUS_LAST_POINT) break;
    }

    estimatedTotalPoints += actualCount;
    if (estimatedTotalPoints > maxTotalPoints) {
      throw new Error(
        `ILDA file exceeds the ${maxTotalPoints.toLocaleString()}-point limit for ${options.tier === 'low' ? 'mobile/low' : 'desktop'} tier at frame ${pendingFrames.length}.`,
      );
    }

    if (format === 0 || format === 4) has3d = true;
    pendingFrames.push({
      name,
      company,
      format,
      dataOffset,
      recordCount: actualCount,
      palette: activePalette,
    });
    offset = dataOffset + payloadBytes;
  }

  if (pendingFrames.length === 0) {
    throw new Error('ILDA file contains no coordinate frames.');
  }

  // Pass 2: unpack points into contiguous flat typed arrays.
  const xy = new Int16Array(estimatedTotalPoints * 2);
  const z = has3d ? new Int16Array(estimatedTotalPoints) : undefined;
  const rgb = new Uint8Array(estimatedTotalPoints * 3);
  const blank = new Uint8Array(estimatedTotalPoints);
  const frames: IldaFrameSlice[] = [];

  let cursor = 0;
  let globalMinX = Infinity;
  let globalMaxX = -Infinity;
  let globalMinY = Infinity;
  let globalMaxY = -Infinity;
  let anyLit = false;
  let paletteClampWarned = false;

  for (const pf of pendingFrames) {
    const stride = RECORD_SIZES[pf.format];
    const paletteLen = Math.max(1, Math.floor(pf.palette.length / 3));
    const frameStart = cursor;
    let litCount = 0;
    let fMinX = Infinity;
    let fMaxX = -Infinity;
    let fMinY = Infinity;
    let fMaxY = -Infinity;

    for (let i = 0; i < pf.recordCount; i++) {
      const recOff = pf.dataOffset + i * stride;
      const x = reader.i16(recOff);
      const y = reader.i16(recOff + 2);
      xy[cursor * 2] = x;
      xy[cursor * 2 + 1] = y;

      let status: number;
      let r: number;
      let g: number;
      let b: number;

      if (pf.format === 0) {
        if (z) z[cursor] = reader.i16(recOff + 4);
        status = bytes[recOff + 6];
        let colorIdx = bytes[recOff + 7];
        if (colorIdx >= paletteLen) {
          if (!paletteClampWarned) {
            warnings.push(`Palette color index ${colorIdx} exceeds palette size ${paletteLen}; clamped to last entry.`);
            paletteClampWarned = true;
          }
          colorIdx = paletteLen - 1;
        }
        r = pf.palette[colorIdx * 3];
        g = pf.palette[colorIdx * 3 + 1];
        b = pf.palette[colorIdx * 3 + 2];
      } else if (pf.format === 1) {
        status = bytes[recOff + 4];
        let colorIdx = bytes[recOff + 5];
        if (colorIdx >= paletteLen) {
          if (!paletteClampWarned) {
            warnings.push(`Palette color index ${colorIdx} exceeds palette size ${paletteLen}; clamped to last entry.`);
            paletteClampWarned = true;
          }
          colorIdx = paletteLen - 1;
        }
        r = pf.palette[colorIdx * 3];
        g = pf.palette[colorIdx * 3 + 1];
        b = pf.palette[colorIdx * 3 + 2];
      } else if (pf.format === 4) {
        if (z) z[cursor] = reader.i16(recOff + 4);
        status = bytes[recOff + 6];
        // Format 4/5 store true color in B, G, R byte order per IDTF spec.
        b = bytes[recOff + 7];
        g = bytes[recOff + 8];
        r = bytes[recOff + 9];
      } else {
        status = bytes[recOff + 4];
        b = bytes[recOff + 5];
        g = bytes[recOff + 6];
        r = bytes[recOff + 7];
      }

      const isBlanked = (status & ILDA_STATUS_BLANKED) !== 0;
      blank[cursor] = isBlanked ? 1 : 0;
      rgb[cursor * 3] = isBlanked ? 0 : r;
      rgb[cursor * 3 + 1] = isBlanked ? 0 : g;
      rgb[cursor * 3 + 2] = isBlanked ? 0 : b;

      if (!isBlanked) {
        const nx = normalizeIldaCoord(x);
        const ny = normalizeIldaCoord(y);
        litCount++;
        anyLit = true;
        if (nx < fMinX) fMinX = nx;
        if (nx > fMaxX) fMaxX = nx;
        if (ny < fMinY) fMinY = ny;
        if (ny > fMaxY) fMaxY = ny;
        if (nx < globalMinX) globalMinX = nx;
        if (nx > globalMaxX) globalMaxX = nx;
        if (ny < globalMinY) globalMinY = ny;
        if (ny > globalMaxY) globalMaxY = ny;
      }

      cursor++;
    }

    frames.push({
      name: pf.name,
      company: pf.company,
      format: pf.format,
      offset: frameStart,
      count: pf.recordCount,
      litCount,
      litSpanX: litCount >= 2 ? fMaxX - fMinX : 0,
      litSpanY: litCount >= 2 ? fMaxY - fMinY : 0,
      minLitX: litCount > 0 ? fMinX : 0,
      maxLitX: litCount > 0 ? fMaxX : 0,
      minLitY: litCount > 0 ? fMinY : 0,
      maxLitY: litCount > 0 ? fMaxY : 0,
    });
  }

  return {
    name: options.name ?? (frames[0]?.name || 'ILDA Clip'),
    frames,
    xy,
    ...(z ? { z } : {}),
    rgb,
    blank,
    totalPoints: cursor,
    bounds: {
      minX: anyLit ? globalMinX : 0,
      maxX: anyLit ? globalMaxX : 0,
      minY: anyLit ? globalMinY : 0,
      maxY: anyLit ? globalMaxY : 0,
      hasLitPoints: anyLit,
    },
    warnings,
  };
}

export interface IldaEncodePoint {
  x: number; // int16 [-32768..32767]
  y: number; // int16 [-32768..32767]
  z?: number; // int16 [-32768..32767]
  blanked?: boolean;
  /** RGB [0..255] for format 4/5, or palette index [0..255] for format 0/1. */
  r?: number;
  g?: number;
  b?: number;
  colorIndex?: number;
}

export interface IldaEncodeFrame {
  name?: string;
  company?: string;
  format?: 0 | 1 | 4 | 5;
  points: readonly IldaEncodePoint[];
}

export interface IldaEncodePalette {
  name?: string;
  company?: string;
  /** Flat RGB triples (length = 3 * N, N <= 256). */
  colors: Uint8Array;
}

function clampI16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

function clampU8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Encode ILDA frames (and optional leading Format 2 palette) into valid big-endian IDTF bytes
 * terminated by an EOF header. Useful for built-in demo clips and parser round-trip tests.
 */
export function encodeIlda(
  frames: readonly IldaEncodeFrame[],
  options: { palette?: IldaEncodePalette; omitEof?: boolean } = {},
): Uint8Array {
  const paletteCount = options.palette ? Math.min(256, Math.floor(options.palette.colors.length / 3)) : 0;
  let totalBytes = paletteCount > 0 ? ILDA_HEADER_BYTES + paletteCount * 3 : 0;
  for (const f of frames) {
    const fmt = f.format ?? 5;
    totalBytes += ILDA_HEADER_BYTES + f.points.length * RECORD_SIZES[fmt];
  }
  if (!options.omitEof) {
    totalBytes += ILDA_HEADER_BYTES;
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let pos = 0;

  const writeHeader = (format: IldaFormatCode, name: string, company: string, records: number, frameNo: number, totalFrames: number) => {
    out[pos] = 0x49; // I
    out[pos + 1] = 0x4c; // L
    out[pos + 2] = 0x44; // D
    out[pos + 3] = 0x41; // A
    out[pos + 4] = 0;
    out[pos + 5] = 0;
    out[pos + 6] = 0;
    out[pos + 7] = format;
    writeAscii8(out, pos + 8, name);
    writeAscii8(out, pos + 16, company);
    view.setUint16(pos + 24, records, false);
    view.setUint16(pos + 26, frameNo, false);
    view.setUint16(pos + 28, totalFrames, false);
    out[pos + 30] = 0;
    out[pos + 31] = 0;
    pos += ILDA_HEADER_BYTES;
  };

  if (options.palette && paletteCount > 0) {
    writeHeader(2, options.palette.name ?? 'PALETTE', options.palette.company ?? 'STGFORGE', paletteCount, 0, 0);
    out.set(options.palette.colors.subarray(0, paletteCount * 3), pos);
    pos += paletteCount * 3;
  }

  const totalFrames = frames.length;
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const fmt = f.format ?? 5;
    writeHeader(fmt, f.name ?? `FRM${fi + 1}`, f.company ?? 'STGFORGE', f.points.length, fi, totalFrames);
    for (let pi = 0; pi < f.points.length; pi++) {
      const pt = f.points[pi];
      const status =
        (pt.blanked ? ILDA_STATUS_BLANKED : 0) |
        (pi === f.points.length - 1 ? ILDA_STATUS_LAST_POINT : 0);
      view.setInt16(pos, clampI16(pt.x), false);
      view.setInt16(pos + 2, clampI16(pt.y), false);
      if (fmt === 0) {
        view.setInt16(pos + 4, clampI16(pt.z ?? 0), false);
        out[pos + 6] = status;
        out[pos + 7] = clampU8(pt.colorIndex ?? 0);
        pos += 8;
      } else if (fmt === 1) {
        out[pos + 4] = status;
        out[pos + 5] = clampU8(pt.colorIndex ?? 0);
        pos += 6;
      } else if (fmt === 4) {
        view.setInt16(pos + 4, clampI16(pt.z ?? 0), false);
        out[pos + 6] = status;
        out[pos + 7] = clampU8(pt.b ?? 0);
        out[pos + 8] = clampU8(pt.g ?? 0);
        out[pos + 9] = clampU8(pt.r ?? 0);
        pos += 10;
      } else {
        out[pos + 4] = status;
        out[pos + 5] = clampU8(pt.b ?? 0);
        out[pos + 6] = clampU8(pt.g ?? 0);
        out[pos + 7] = clampU8(pt.r ?? 0);
        pos += 8;
      }
    }
  }

  if (!options.omitEof) {
    const lastFmt = frames[frames.length - 1]?.format ?? 5;
    writeHeader(lastFmt, 'EOF', 'STGFORGE', 0, 0, totalFrames);
  }

  return out;
}

export type DemoIldaKind = 'tour_show' | 'circle_tunnel' | 'graphic_star' | 'static_spot';

export const DEMO_ILDA_PRESETS: readonly { id: DemoIldaKind; label: string; desc: string }[] = [
  { id: 'tour_show', label: 'Tour Showreel (36 frames)', desc: 'Animated tunnel, wave & geometric graphic frames' },
  { id: 'circle_tunnel', label: 'Liquid Tunnel (24 frames)', desc: 'Rotating cyan/magenta beam tunnel' },
  { id: 'graphic_star', label: 'Vector Star (18 frames)', desc: 'Spinning multi-color laser graphic' },
  { id: 'static_spot', label: 'Static Dwell Test (1 frame)', desc: 'Single-point test frame (triggers stationary safety alert)' },
];

/**
 * Generate a real binary ILDA Format 5 (.ild) demo clip through our own encoder.
 * Zero third-party assets or licences required.
 */
export function generateDemoIlda(kind: DemoIldaKind = 'tour_show'): Uint8Array {
  const S = 26000;
  const frames: IldaEncodeFrame[] = [];

  if (kind === 'static_spot') {
    frames.push({
      name: 'STATIC1',
      format: 5,
      points: [
        { x: 0, y: 0, r: 0, g: 255, b: 80, blanked: false },
        { x: 10, y: 0, r: 0, g: 255, b: 80, blanked: false },
      ],
    });
    return encodeIlda(frames);
  }

  const pushCircleFrame = (frameIdx: number, total: number, segs: number, radiusScale: number) => {
    const pts: IldaEncodePoint[] = [];
    const rot = (frameIdx / total) * Math.PI * 2;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2 + rot;
      const r = S * radiusScale * (0.85 + 0.15 * Math.sin(a * 4 - rot * 2));
      const mix = 0.5 + 0.5 * Math.sin(a + rot);
      pts.push({
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        r: Math.round(255 * mix),
        g: Math.round(240 * (1 - mix)),
        b: 255,
        blanked: false,
      });
    }
    frames.push({ name: `TUN${frameIdx}`, format: 5, points: pts });
  };

  const pushWaveFrame = (frameIdx: number, total: number, segs: number) => {
    const pts: IldaEncodePoint[] = [];
    const phase = (frameIdx / total) * Math.PI * 2;
    for (let i = 0; i < segs; i++) {
      const u = i / (segs - 1);
      const x = (u * 2 - 1) * S;
      const y = Math.sin(u * Math.PI * 4 + phase) * S * 0.45;
      pts.push({
        x,
        y,
        r: Math.round(40 + 215 * u),
        g: 255,
        b: Math.round(255 * (1 - u)),
        blanked: false,
      });
    }
    frames.push({ name: `WAV${frameIdx}`, format: 5, points: pts });
  };

  const pushStarFrame = (frameIdx: number, total: number) => {
    const pts: IldaEncodePoint[] = [];
    const rot = (frameIdx / total) * Math.PI * 2;
    const spikes = 5;
    const stepsPerEdge = 6;
    const verts: Array<[number, number]> = [];
    for (let k = 0; k < spikes * 2; k++) {
      const a = (k / (spikes * 2)) * Math.PI * 2 + rot;
      const r = k % 2 === 0 ? S * 0.92 : S * 0.38;
      verts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    for (let k = 0; k < verts.length; k++) {
      const [x0, y0] = verts[k];
      const [x1, y1] = verts[(k + 1) % verts.length];
      for (let s = 0; s < stepsPerEdge; s++) {
        const f = s / stepsPerEdge;
        pts.push({
          x: x0 + (x1 - x0) * f,
          y: y0 + (y1 - y0) * f,
          r: 255,
          g: k % 2 === 0 ? 220 : 60,
          b: k % 2 === 0 ? 40 : 255,
          blanked: false,
        });
      }
    }
    // Close contour back to start
    pts.push({ x: verts[0][0], y: verts[0][1], r: 255, g: 220, b: 40, blanked: false });
    // Blanked jump to inner diamond
    pts.push({ x: 0, y: S * 0.2, r: 0, g: 0, b: 0, blanked: true });
    for (let d = 0; d <= 4; d++) {
      const a = (d / 4) * Math.PI * 2 - rot;
      pts.push({ x: Math.cos(a) * S * 0.2, y: Math.sin(a) * S * 0.2, r: 0, g: 255, b: 220, blanked: false });
    }
    frames.push({ name: `STR${frameIdx}`, format: 5, points: pts });
  };

  if (kind === 'circle_tunnel') {
    for (let i = 0; i < 24; i++) pushCircleFrame(i, 24, 36, 0.85);
  } else if (kind === 'graphic_star') {
    for (let i = 0; i < 18; i++) pushStarFrame(i, 18);
  } else {
    // 'tour_show': 12 tunnel + 12 wave + 12 graphic star = 36 frames
    for (let i = 0; i < 12; i++) pushCircleFrame(i, 12, 32, 0.85);
    for (let i = 0; i < 12; i++) pushWaveFrame(i, 12, 36);
    for (let i = 0; i < 12; i++) pushStarFrame(i, 12);
  }

  return encodeIlda(frames);
}
