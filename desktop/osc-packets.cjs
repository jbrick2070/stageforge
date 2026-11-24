'use strict';

// Pure zero-dependency OSC 1.0 packet codec, Art-Net 4 OpTimeCode (0x9700) codec,
// and SMPTE timecode conversion helpers for Electron main process.

const ARTNET_ID = Buffer.from([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]); // "Art-Net\0"
const ARTNET_OPCODE_TIMECODE = 0x9700;
const ARTNET_PROT_VER = 14;
const ARTNET_TIMECODE_MIN_LEN = 19;
const ARTNET_TIMECODE_MAX_LEN = 530;

const OSC_MAX_PACKET_BYTES = 8192;
const OSC_MAX_BUNDLE_DEPTH = 4;
const OSC_MAX_ELEMENTS = 64;
const OSC_MAX_ARGS = 16;
const OSC_BUNDLE_HEADER = Buffer.from('#bundle\0', 'ascii');
// Reject pattern wildcards, whitespace, control characters and '#' in exact-match addresses.
const OSC_FORBIDDEN_ADDR_RE = /[*?[\]{}#\s\x00-\x1f\x7f]/;

const SMPTE_TYPE_TO_FPS = [24, 25, 29.97, 30];
const DAY_MS = 86_400_000;

const BUMP_ALIASES = {
  '1': 'blinder',
  '2': 'strobe',
  '3': 'co2',
  '4': 'smoke',
  '5': 'laser',
  '6': 'motorDrop',
  blinder: 'blinder',
  strobe: 'strobe',
  co2: 'co2',
  smoke: 'smoke',
  laser: 'laser',
  motorDrop: 'motorDrop',
};

function fpsToSmpteType(fps) {
  if (fps === 24) return 0;
  if (fps === 25) return 1;
  if (fps === 29.97) return 2;
  if (fps === 30) return 3;
  return -1;
}

function isValidSmpteComponents(hours, minutes, seconds, frames, fps) {
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return false;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return false;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) return false;
  const maxFrames = fps === 24 ? 23 : fps === 25 ? 24 : (fps === 29.97 || fps === 30) ? 29 : -1;
  if (maxFrames < 0 || !Number.isInteger(frames) || frames < 0 || frames > maxFrames) return false;
  // 29.97 drop-frame drops frame numbers 00 and 01 at the start of every minute except every 10th minute.
  if (fps === 29.97 && seconds === 0 && (minutes % 10) !== 0 && (frames === 0 || frames === 1)) {
    return false;
  }
  return true;
}

function smpteToMs(hours, minutes, seconds, frames, fps) {
  if (!isValidSmpteComponents(hours, minutes, seconds, frames, fps)) return null;
  if (fps === 29.97) {
    const totalMinutes = hours * 60 + minutes;
    const dropped = 2 * (totalMinutes - Math.floor(totalMinutes / 10));
    const frameNumber = ((hours * 3600 + minutes * 60 + seconds) * 30) + frames - dropped;
    return (frameNumber * 1001) / 30;
  }
  const frameNumber = (((hours * 60 + minutes) * 60 + seconds) * fps) + frames;
  return (frameNumber * 1000) / fps;
}

function msToSmpte(rawMs, fps) {
  if (!Number.isFinite(rawMs) || fpsToSmpteType(fps) < 0) return null;
  const wrappedMs = ((rawMs % DAY_MS) + DAY_MS) % DAY_MS;
  if (fps === 29.97) {
    const framesPerDay = 2_589_408; // 24h at 29.97 DF (17982 * 144)
    const fn = Math.floor((wrappedMs * 30) / 1001 + 1e-6) % framesPerDay;
    const d = Math.floor(fn / 17982);
    const m = fn % 17982;
    const adjusted = fn + 18 * d + (m < 2 ? 0 : 2 * Math.floor((m - 2) / 1798));
    const frames = adjusted % 30;
    const totalSeconds = Math.floor(adjusted / 30);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60) % 24;
    return { hours, minutes, seconds, frames, fps };
  }
  const framesPerDay = 86400 * fps;
  const fn = Math.floor((wrappedMs * fps) / 1000 + 1e-6) % framesPerDay;
  const frames = fn % fps;
  const totalSeconds = Math.floor(fn / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  return { hours, minutes, seconds, frames, fps };
}

function formatSmpte(tc) {
  const sep = tc.fps === 29.97 ? ';' : ':';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(tc.hours)}:${p(tc.minutes)}:${p(tc.seconds)}${sep}${p(tc.frames)}`;
}

// --- Art-Net 4 OpTimeCode (0x9700) ---

function encodeArtNetTimecode({ hours, minutes, seconds, frames, fps, streamId = 0 }) {
  const type = fpsToSmpteType(fps);
  if (type < 0 || !isValidSmpteComponents(hours, minutes, seconds, frames, fps)) {
    throw new Error('Invalid SMPTE timecode for Art-Net OpTimeCode.');
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 255) {
    throw new Error('Art-Net OpTimeCode streamId must be 0..255.');
  }
  const buf = Buffer.alloc(ARTNET_TIMECODE_MIN_LEN);
  ARTNET_ID.copy(buf, 0);
  buf.writeUInt16LE(ARTNET_OPCODE_TIMECODE, 8);
  buf.writeUInt16BE(ARTNET_PROT_VER, 10);
  buf[12] = 0; // Filler1
  buf[13] = streamId & 0xff; // StreamId (0 = standard)
  buf[14] = frames;
  buf[15] = seconds;
  buf[16] = minutes;
  buf[17] = hours;
  buf[18] = type;
  return buf;
}

function decodeArtNetTimecode(raw) {
  if (!(raw instanceof Uint8Array) || raw.byteLength < ARTNET_TIMECODE_MIN_LEN || raw.byteLength > ARTNET_TIMECODE_MAX_LEN) {
    return null;
  }
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!buf.subarray(0, 8).equals(ARTNET_ID)) return null;
  if (buf.readUInt16LE(8) !== ARTNET_OPCODE_TIMECODE) return null;
  if (buf.readUInt16BE(10) < ARTNET_PROT_VER) return null;
  const streamId = buf[13];
  if (streamId !== 0) return null; // Filter to StreamId 0 per spec.
  const frames = buf[14];
  const seconds = buf[15];
  const minutes = buf[16];
  const hours = buf[17];
  const type = buf[18];
  if (type < 0 || type > 3) return null;
  const fps = SMPTE_TYPE_TO_FPS[type];
  const ms = smpteToMs(hours, minutes, seconds, frames, fps);
  if (ms === null) return null;
  return { hours, minutes, seconds, frames, fps, type, streamId, ms };
}

// --- OSC 1.0 Codec ---

function pad4(length) {
  return (4 - (length % 4)) % 4;
}

function encodeOscString(value) {
  if (typeof value !== 'string') throw new Error('OSC string must be a string.');
  if (value.includes('\0')) throw new Error('OSC string cannot contain NUL characters.');
  const raw = Buffer.from(value, 'utf8');
  // OSC strings always end with at least one NUL byte, then pad to a 4-byte boundary.
  const totalLen = raw.length + 1 + pad4(raw.length + 1);
  const out = Buffer.alloc(totalLen);
  raw.copy(out, 0);
  return out;
}

function readOscString(buf, offset) {
  const nul = buf.indexOf(0, offset);
  if (nul < 0) return null;
  const next = nul + 1 + pad4(nul - offset + 1);
  if (next > buf.length) return null;
  // Verify padding bytes are NULs.
  for (let i = nul + 1; i < next; i++) {
    if (buf[i] !== 0) return null;
  }
  return { value: buf.subarray(offset, nul).toString('utf8'), next };
}

function normalizeArgSpec(arg) {
  if (arg && typeof arg === 'object' && !ArrayBuffer.isView(arg) && typeof arg.type === 'string') {
    return arg;
  }
  if (typeof arg === 'string') return { type: 's', value: arg };
  if (typeof arg === 'boolean') return { type: arg ? 'T' : 'F' };
  if (arg === null || arg === undefined) return { type: 'N' };
  if (typeof arg === 'number') {
    if (!Number.isFinite(arg)) throw new Error('OSC numeric argument must be finite.');
    return Number.isInteger(arg) && arg >= -2147483648 && arg <= 2147483647
      ? { type: 'i', value: arg }
      : { type: 'f', value: arg };
  }
  if (arg instanceof Uint8Array) return { type: 'b', value: arg };
  throw new Error('Unsupported OSC argument type.');
}

function encodeOscMessage(address, args = []) {
  if (typeof address !== 'string' || !address.startsWith('/') || OSC_FORBIDDEN_ADDR_RE.test(address)) {
    throw new Error(`Invalid OSC address "${String(address)}".`);
  }
  if (!Array.isArray(args) || args.length > OSC_MAX_ARGS) {
    throw new Error(`OSC message supports at most ${OSC_MAX_ARGS} arguments.`);
  }
  const specs = args.map(normalizeArgSpec);
  const tagChars = [','];
  const payloadParts = [];
  for (const spec of specs) {
    switch (spec.type) {
      case 'i': {
        if (!Number.isInteger(spec.value) || spec.value < -2147483648 || spec.value > 2147483647) {
          throw new Error('OSC int32 argument out of range.');
        }
        tagChars.push('i');
        const b = Buffer.alloc(4);
        b.writeInt32BE(spec.value, 0);
        payloadParts.push(b);
        break;
      }
      case 'f': {
        if (typeof spec.value !== 'number' || !Number.isFinite(spec.value)) {
          throw new Error('OSC float32 argument must be finite.');
        }
        tagChars.push('f');
        const b = Buffer.alloc(4);
        b.writeFloatBE(spec.value, 0);
        payloadParts.push(b);
        break;
      }
      case 's': {
        tagChars.push('s');
        payloadParts.push(encodeOscString(spec.value));
        break;
      }
      case 'b': {
        if (!(spec.value instanceof Uint8Array)) throw new Error('OSC blob must be a Uint8Array.');
        tagChars.push('b');
        const len = spec.value.byteLength;
        const b = Buffer.alloc(4 + len + pad4(len));
        b.writeInt32BE(len, 0);
        Buffer.from(spec.value.buffer, spec.value.byteOffset, len).copy(b, 4);
        payloadParts.push(b);
        break;
      }
      case 'h': {
        const val = typeof spec.value === 'bigint' ? spec.value : BigInt(spec.value);
        tagChars.push('h');
        const b = Buffer.alloc(8);
        b.writeBigInt64BE(val, 0);
        payloadParts.push(b);
        break;
      }
      case 'd': {
        if (typeof spec.value !== 'number' || !Number.isFinite(spec.value)) {
          throw new Error('OSC float64 argument must be finite.');
        }
        tagChars.push('d');
        const b = Buffer.alloc(8);
        b.writeDoubleBE(spec.value, 0);
        payloadParts.push(b);
        break;
      }
      case 't': {
        const val = typeof spec.value === 'bigint' ? spec.value : BigInt(spec.value);
        tagChars.push('t');
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(val, 0);
        payloadParts.push(b);
        break;
      }
      case 'T':
      case 'F':
      case 'N':
        tagChars.push(spec.type);
        break;
      default:
        throw new Error(`Unsupported OSC type tag "${String(spec.type)}".`);
    }
  }
  const out = Buffer.concat([encodeOscString(address), encodeOscString(tagChars.join('')), ...payloadParts]);
  if (out.byteLength > OSC_MAX_PACKET_BYTES) {
    throw new Error(`OSC message exceeds ${OSC_MAX_PACKET_BYTES} byte limit.`);
  }
  return out;
}

function encodeOscBundle(elements, timetag = 1n) {
  if (!Array.isArray(elements) || elements.length > OSC_MAX_ELEMENTS) {
    throw new Error(`OSC bundle supports at most ${OSC_MAX_ELEMENTS} elements.`);
  }
  const tt = Buffer.alloc(8);
  tt.writeBigUInt64BE(typeof timetag === 'bigint' ? timetag : BigInt(timetag), 0);
  const parts = [OSC_BUNDLE_HEADER, tt];
  for (const el of elements) {
    const bytes = el instanceof Uint8Array
      ? (Buffer.isBuffer(el) ? el : Buffer.from(el.buffer, el.byteOffset, el.byteLength))
      : encodeOscMessage(el.address, el.args);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(bytes.length, 0);
    parts.push(lenBuf, bytes);
  }
  const out = Buffer.concat(parts);
  if (out.byteLength > OSC_MAX_PACKET_BYTES) {
    throw new Error(`OSC bundle exceeds ${OSC_MAX_PACKET_BYTES} byte limit.`);
  }
  return out;
}

function decodeOscMessageBuffer(buf) {
  if (buf.length < 4 || (buf.length % 4) !== 0) return null;
  const addrRes = readOscString(buf, 0);
  if (!addrRes) return null;
  const address = addrRes.value;
  if (!address.startsWith('/') || OSC_FORBIDDEN_ADDR_RE.test(address)) return null;

  let offset = addrRes.next;
  if (offset >= buf.length) return null; // OSC 1.0 requires a type tag string starting with ','
  const tagRes = readOscString(buf, offset);
  if (!tagRes || !tagRes.value.startsWith(',')) return null;
  const tags = tagRes.value.slice(1);
  if (tags.length > OSC_MAX_ARGS) return null;
  offset = tagRes.next;

  const args = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    switch (tag) {
      case 'i': {
        if (offset + 4 > buf.length) return null;
        args.push({ type: 'i', value: buf.readInt32BE(offset) });
        offset += 4;
        break;
      }
      case 'f': {
        if (offset + 4 > buf.length) return null;
        const val = buf.readFloatBE(offset);
        if (!Number.isFinite(val)) return null;
        args.push({ type: 'f', value: val });
        offset += 4;
        break;
      }
      case 's': {
        const strRes = readOscString(buf, offset);
        if (!strRes) return null;
        args.push({ type: 's', value: strRes.value });
        offset = strRes.next;
        break;
      }
      case 'b': {
        if (offset + 4 > buf.length) return null;
        const size = buf.readInt32BE(offset);
        offset += 4;
        if (size < 0 || offset + size > buf.length) return null;
        const padded = size + pad4(size);
        if (offset + padded > buf.length) return null;
        args.push({ type: 'b', value: new Uint8Array(buf.subarray(offset, offset + size)) });
        offset += padded;
        break;
      }
      case 'h': {
        if (offset + 8 > buf.length) return null;
        args.push({ type: 'h', value: buf.readBigInt64BE(offset) });
        offset += 8;
        break;
      }
      case 'd': {
        if (offset + 8 > buf.length) return null;
        const val = buf.readDoubleBE(offset);
        if (!Number.isFinite(val)) return null;
        args.push({ type: 'd', value: val });
        offset += 8;
        break;
      }
      case 't': {
        if (offset + 8 > buf.length) return null;
        args.push({ type: 't', value: buf.readBigUInt64BE(offset) });
        offset += 8;
        break;
      }
      case 'T':
        args.push({ type: 'T', value: true });
        break;
      case 'F':
        args.push({ type: 'F', value: false });
        break;
      case 'N':
        args.push({ type: 'N', value: null });
        break;
      default:
        // Reject unknown type tags — their byte length is unknown.
        return null;
    }
  }
  if (offset !== buf.length) return null;
  return { address, args };
}

function decodeOscPacket(raw) {
  if (!(raw instanceof Uint8Array) || raw.byteLength < 8 || raw.byteLength > OSC_MAX_PACKET_BYTES) {
    return null;
  }
  const rootBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const messages = [];
  let elementCount = 0;

  function walk(buf, depth) {
    if (depth > OSC_MAX_BUNDLE_DEPTH || buf.length < 8 || (buf.length % 4) !== 0) return false;
    if (buf.subarray(0, 8).equals(OSC_BUNDLE_HEADER)) {
      if (buf.length < 16) return false;
      let offset = 16; // 8-byte "#bundle\0" + 8-byte timetag (dispatched immediately)
      while (offset < buf.length) {
        if (offset + 4 > buf.length) return false;
        const elemSize = buf.readInt32BE(offset);
        offset += 4;
        if (elemSize <= 0 || (elemSize % 4) !== 0 || offset + elemSize > buf.length) return false;
        elementCount++;
        if (elementCount > OSC_MAX_ELEMENTS) return false;
        if (!walk(buf.subarray(offset, offset + elemSize), depth + 1)) return false;
        offset += elemSize;
      }
      return true;
    }
    const msg = decodeOscMessageBuffer(buf);
    if (!msg) return false;
    messages.push(msg);
    return true;
  }

  if (!walk(rootBuf, 0)) return null;
  return messages;
}

function isRisingEdge(args) {
  if (!args || args.length === 0) return true;
  const first = args[0];
  if (first.type === 'T') return true;
  if (first.type === 'F' || first.type === 'N') return false;
  if (first.type === 'f' || first.type === 'd' || first.type === 'i') return first.value >= 0.5;
  return false;
}

function toNumberArg(arg) {
  if (!arg) return null;
  if (arg.type === 'f' || arg.type === 'd' || arg.type === 'i') {
    return Number.isFinite(arg.value) ? arg.value : null;
  }
  if (arg.type === 'T') return 1;
  if (arg.type === 'F') return 0;
  return null;
}

/**
 * Normalize a decoded StageForge OSC message into a renderer-safe trigger event.
 * Returns null for unrecognized addresses or release-edge (0) button presses.
 */
function normalizeOscMessage(msg, at = Date.now()) {
  if (!msg || typeof msg.address !== 'string') return null;
  const { address, args = [] } = msg;

  switch (address) {
    case '/stageforge/go': {
      if (args.length === 0) return { source: 'osc', kind: 'trigger', command: 'go', at };
      const first = args[0];
      if (first.type === 'i') {
        if (first.value >= 1 && first.value <= 4096) {
          return { source: 'osc', kind: 'trigger', command: 'go', cue: { index: first.value }, at };
        }
        return null;
      }
      if (first.type === 's') {
        const ref = first.value.trim();
        if (!ref || ref.length > 256) return null;
        return { source: 'osc', kind: 'trigger', command: 'go', cue: { ref }, at };
      }
      if (isRisingEdge(args)) return { source: 'osc', kind: 'trigger', command: 'go', at };
      return null;
    }
    case '/stageforge/back':
      return isRisingEdge(args) ? { source: 'osc', kind: 'trigger', command: 'back', at } : null;
    case '/stageforge/stop':
      return isRisingEdge(args) ? { source: 'osc', kind: 'trigger', command: 'stop', at } : null;
    case '/stageforge/resume':
      return isRisingEdge(args) ? { source: 'osc', kind: 'trigger', command: 'resume', at } : null;
    case '/stageforge/blackout': {
      if (args.length === 0) return { source: 'osc', kind: 'trigger', command: 'blackout', value: 1, at };
      const n = toNumberArg(args[0]);
      if (n === null) return null;
      return { source: 'osc', kind: 'trigger', command: 'blackout', value: n >= 0.5 ? 1 : 0, at };
    }
    case '/stageforge/master': {
      const n = toNumberArg(args[0]);
      if (n === null) return null;
      return { source: 'osc', kind: 'trigger', command: 'master', value: Math.max(0, Math.min(1, n)), at };
    }
    case '/stageforge/tempo/tap':
      return isRisingEdge(args) ? { source: 'osc', kind: 'trigger', command: 'tempo_tap', at } : null;
    case '/stageforge/tempo/bpm': {
      const n = toNumberArg(args[0]);
      if (n === null || n <= 0 || n > 600) return null;
      return { source: 'osc', kind: 'trigger', command: 'tempo_bpm', value: n, at };
    }
    case '/stageforge/tempo/half':
      return isRisingEdge(args) ? { source: 'osc', kind: 'trigger', command: 'tempo_half', at } : null;
    case '/stageforge/tempo/double':
      return isRisingEdge(args) ? { source: 'osc', kind: 'trigger', command: 'tempo_double', at } : null;
    default: {
      if (address.startsWith('/stageforge/bump/')) {
        const key = address.slice('/stageforge/bump/'.length);
        const bumpKey = Object.hasOwn(BUMP_ALIASES, key) ? BUMP_ALIASES[key] : null;
        if (!bumpKey) return null;
        const n = args.length === 0 ? 1 : toNumberArg(args[0]);
        if (n === null) return null;
        return { source: 'osc', kind: 'trigger', command: 'bump', bumpKey, value: n >= 0.5 ? 1 : 0, at };
      }
      return null;
    }
  }
}

module.exports = {
  ARTNET_OPCODE_TIMECODE,
  OSC_MAX_PACKET_BYTES,
  OSC_MAX_BUNDLE_DEPTH,
  OSC_MAX_ELEMENTS,
  OSC_MAX_ARGS,
  SMPTE_TYPE_TO_FPS,
  fpsToSmpteType,
  isValidSmpteComponents,
  smpteToMs,
  msToSmpte,
  formatSmpte,
  encodeArtNetTimecode,
  decodeArtNetTimecode,
  encodeOscMessage,
  encodeOscBundle,
  decodeOscPacket,
  normalizeOscMessage,
};
