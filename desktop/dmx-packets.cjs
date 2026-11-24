'use strict';

// Pure ANSI E1.31-2018 (sACN) and Art-Net 4 packet codecs and IPv4 validation helpers.
// Zero third-party dependencies so Electron's packaged main process ships without runtime node_modules.

const SACN_PORT = 5568;
const ARTNET_PORT = 6454;
const SACN_PACKET_LENGTH = 638;
const ARTDM_HEADER_LENGTH = 18;
const ARTDMX_PACKET_LENGTH = ARTDM_HEADER_LENGTH + 512;

const SACN_OPT_PREVIEW = 0x80;
const SACN_OPT_STREAM_TERMINATED = 0x40;
const SACN_OPT_FORCE_SYNC = 0x20;

const MAX_DMX_HZ = 44;
// 1e9 / 44 = 22_727_272.72... ns; ceiling guarantees rate never exceeds 44.0 Hz.
const MIN_FRAME_INTERVAL_NS = 22_727_273n;

const ACN_PACKET_ID = Buffer.from([
  0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00,
]); // "ASC-E1.17\0\0\0"
const ARTNET_ID = Buffer.from([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]); // "Art-Net\0"

const VECTOR_ROOT_E131_DATA = 0x00000004;
const VECTOR_E131_DATA_PACKET = 0x00000002;
const VECTOR_DMP_SET_PROPERTY = 0x02;

const ARTNET_OPCODE_POLL = 0x2000;
const ARTNET_OPCODE_POLL_REPLY = 0x2100;
const ARTNET_OPCODE_DMX = 0x5000;
const ARTNET_PROT_VER = 14;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4_RE = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/;

function isValidIpv4(value) {
  if (typeof value !== 'string' || !IPV4_RE.test(value)) return false;
  const parts = value.split('.');
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function ipv4ToInt(ip) {
  if (!isValidIpv4(ip)) throw new Error(`Invalid IPv4 address: ${String(ip)}`);
  const parts = ip.split('.').map(Number);
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIpv4(value) {
  const n = value >>> 0;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

function isMulticastIpv4(ip) {
  if (!isValidIpv4(ip)) return false;
  const first = Number(ip.split('.')[0]);
  return first >= 224 && first <= 239;
}

function isReservedOrBroadcastIpv4(ip) {
  if (!isValidIpv4(ip)) return true;
  const first = Number(ip.split('.')[0]);
  // 0.0.0.0/8 ("this network"), 224.0.0.0/4 multicast, 240.0.0.0/4 reserved / 255.255.255.255 broadcast
  return first === 0 || first >= 224;
}

function isUnspecifiedIpv4(ip) {
  return ip === '0.0.0.0';
}

function isLoopbackIpv4(ip) {
  if (!isValidIpv4(ip)) return false;
  return Number(ip.split('.')[0]) === 127;
}

function computeBroadcast(address, netmask) {
  if (!isValidIpv4(address) || !isValidIpv4(netmask)) return null;
  if (isLoopbackIpv4(address)) return null;
  const addrInt = ipv4ToInt(address);
  const maskInt = ipv4ToInt(netmask);
  return intToIpv4((addrInt | (~maskInt >>> 0)) >>> 0);
}

function isInSubnet(candidateIp, ifaceAddress, netmask) {
  if (!isValidIpv4(candidateIp) || !isValidIpv4(ifaceAddress) || !isValidIpv4(netmask)) return false;
  const maskInt = ipv4ToInt(netmask);
  return ((ipv4ToInt(candidateIp) & maskInt) >>> 0) === ((ipv4ToInt(ifaceAddress) & maskInt) >>> 0);
}

function uuidToBytes(uuid) {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    throw new Error('Invalid CID UUID.');
  }
  const hex = uuid.replace(/-/g, '');
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a Unicode code point.
 */
function truncateUtf8Bytes(input, maxBytes) {
  const text = typeof input === 'string' ? input : '';
  let out = '';
  let used = 0;
  for (const ch of text) {
    // Strip NUL and C0 control chars so C-string parsers never truncate unexpectedly.
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    const len = Buffer.byteLength(ch, 'utf8');
    if (used + len > maxBytes) break;
    out += ch;
    used += len;
  }
  return out;
}

function sacnMulticastAddress(universe) {
  if (!Number.isInteger(universe) || universe < 1 || universe > 63999) {
    throw new Error(`sACN universe must be an integer between 1 and 63999 (got ${String(universe)}).`);
  }
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

function assertSlots(slots, minLen, maxLen, requireEven = false) {
  if (!(slots instanceof Uint8Array)) {
    throw new Error('DMX slot buffer must be a Uint8Array.');
  }
  if (slots.byteLength < minLen || slots.byteLength > maxLen) {
    throw new Error(`DMX slot buffer length must be ${minLen}..${maxLen} (got ${slots.byteLength}).`);
  }
  if (requireEven && (slots.byteLength & 1) !== 0) {
    throw new Error(`ArtDmx slot buffer length must be even (got ${slots.byteLength}).`);
  }
}

/**
 * Encode an ANSI E1.31-2018 (sACN) Data Packet.
 * Layout for 512 slots (638 bytes total, big-endian):
 *   Root Layer    [0..37]   (38 bytes; Flags&Length = 0x7000 | (len - 16))
 *   Framing Layer [38..114] (77 bytes; Flags&Length = 0x7000 | (len - 38))
 *   DMP Layer     [115..125 + slots] (Flags&Length = 0x7000 | (len - 115))
 */
function encodeSacnPacket({
  cid,
  sourceName = 'StageForge',
  universe,
  slots,
  sequence = 0,
  priority = 100,
  options = 0,
  syncAddress = 0,
  startCode = 0,
}) {
  const cidBytes = typeof cid === 'string' ? uuidToBytes(cid) : cid;
  if (!(cidBytes instanceof Uint8Array) || cidBytes.byteLength !== 16) {
    throw new Error('sACN CID must be a 16-byte Uint8Array or UUID string.');
  }
  if (!Number.isInteger(universe) || universe < 1 || universe > 63999) {
    throw new Error(`sACN universe must be 1..63999 (got ${String(universe)}).`);
  }
  if (!Number.isInteger(priority) || priority < 0 || priority > 200) {
    throw new Error(`sACN priority must be 0..200 (got ${String(priority)}).`);
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 255) {
    throw new Error(`sACN sequence must be 0..255 (got ${String(sequence)}).`);
  }
  if (!Number.isInteger(options) || options < 0 || options > 255) {
    throw new Error(`sACN options must be 0..255 (got ${String(options)}).`);
  }
  if (!Number.isInteger(syncAddress) || syncAddress < 0 || syncAddress > 65535) {
    throw new Error(`sACN syncAddress must be 0..65535 (got ${String(syncAddress)}).`);
  }
  if (!Number.isInteger(startCode) || startCode < 0 || startCode > 255) {
    throw new Error(`sACN startCode must be 0..255 (got ${String(startCode)}).`);
  }
  assertSlots(slots, 1, 512);

  const slotCount = slots.byteLength;
  const totalLen = 126 + slotCount;
  const buf = Buffer.alloc(totalLen);

  // Root Layer (bytes 0..37)
  buf.writeUInt16BE(0x0010, 0); // Preamble Size
  buf.writeUInt16BE(0x0000, 2); // Post-amble Size
  ACN_PACKET_ID.copy(buf, 4); // ACN Packet Identifier (12 bytes)
  buf.writeUInt16BE(0x7000 | (totalLen - 16), 16); // Flags & Length
  buf.writeUInt32BE(VECTOR_ROOT_E131_DATA, 18); // Vector
  Buffer.from(cidBytes.buffer, cidBytes.byteOffset, 16).copy(buf, 22); // CID (16 bytes)

  // Framing Layer (bytes 38..114)
  buf.writeUInt16BE(0x7000 | (totalLen - 38), 38); // Flags & Length
  buf.writeUInt32BE(VECTOR_E131_DATA_PACKET, 40); // Vector
  const safeName = truncateUtf8Bytes(sourceName || 'StageForge', 63);
  buf.write(safeName, 44, 63, 'utf8'); // Source Name (64 bytes, remaining bytes already NUL)
  buf[108] = priority;
  buf.writeUInt16BE(syncAddress, 109);
  buf[111] = sequence & 0xff;
  buf[112] = options & 0xff;
  buf.writeUInt16BE(universe, 113);

  // DMP Layer (bytes 115..125 + slots)
  buf.writeUInt16BE(0x7000 | (totalLen - 115), 115); // Flags & Length
  buf[117] = VECTOR_DMP_SET_PROPERTY;
  buf[118] = 0xa1; // Address Type & Data Type
  buf.writeUInt16BE(0x0000, 119); // First Property Address
  buf.writeUInt16BE(0x0001, 121); // Address Increment
  buf.writeUInt16BE(1 + slotCount, 123); // Property Value Count (start code + slots)
  buf[125] = startCode;
  buf.set(slots, 126);

  return buf;
}

/**
 * Decode and validate an ANSI E1.31-2018 Data Packet. Returns null if malformed.
 */
function decodeSacnPacket(raw) {
  if (!(raw instanceof Uint8Array) || raw.byteLength < 127 || raw.byteLength > 638) return null;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.readUInt16BE(0) !== 0x0010 || buf.readUInt16BE(2) !== 0x0000) return null;
  if (!buf.subarray(4, 16).equals(ACN_PACKET_ID)) return null;
  const rootFl = buf.readUInt16BE(16);
  if ((rootFl & 0xf000) !== 0x7000 || (rootFl & 0x0fff) !== buf.length - 16) return null;
  if (buf.readUInt32BE(18) !== VECTOR_ROOT_E131_DATA) return null;

  const framingFl = buf.readUInt16BE(38);
  if ((framingFl & 0xf000) !== 0x7000 || (framingFl & 0x0fff) !== buf.length - 38) return null;
  if (buf.readUInt32BE(40) !== VECTOR_E131_DATA_PACKET) return null;

  const dmpFl = buf.readUInt16BE(115);
  if ((dmpFl & 0xf000) !== 0x7000 || (dmpFl & 0x0fff) !== buf.length - 115) return null;
  if (buf[117] !== VECTOR_DMP_SET_PROPERTY || buf[118] !== 0xa1) return null;
  if (buf.readUInt16BE(119) !== 0x0000 || buf.readUInt16BE(121) !== 0x0001) return null;

  const propCount = buf.readUInt16BE(123);
  if (propCount < 2 || propCount > 513 || 125 + propCount !== buf.length) return null;

  const nameBuf = buf.subarray(44, 108);
  const nulIdx = nameBuf.indexOf(0);
  const sourceName = nameBuf.subarray(0, nulIdx === -1 ? 64 : nulIdx).toString('utf8');

  return {
    cid: new Uint8Array(buf.subarray(22, 38)),
    sourceName,
    priority: buf[108],
    syncAddress: buf.readUInt16BE(109),
    sequence: buf[111],
    options: buf[112],
    universe: buf.readUInt16BE(113),
    startCode: buf[125],
    slots: new Uint8Array(buf.subarray(126, 125 + propCount)),
  };
}

/**
 * Encode an Art-Net 4 ArtDmx packet (OpCode 0x5000 little-endian, 530 bytes for 512 slots).
 */
function encodeArtDmxPacket({ portAddress, slots, sequence = 1, physical = 0 }) {
  if (!Number.isInteger(portAddress) || portAddress < 0 || portAddress > 32767) {
    throw new Error(`Art-Net portAddress must be 0..32767 (got ${String(portAddress)}).`);
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 255) {
    throw new Error(`Art-Net sequence must be 0..255 (got ${String(sequence)}).`);
  }
  if (!Number.isInteger(physical) || physical < 0 || physical > 255) {
    throw new Error(`Art-Net physical must be 0..255 (got ${String(physical)}).`);
  }
  assertSlots(slots, 2, 512, true);

  const len = slots.byteLength;
  const buf = Buffer.alloc(ARTDM_HEADER_LENGTH + len);
  ARTNET_ID.copy(buf, 0);
  buf.writeUInt16LE(ARTNET_OPCODE_DMX, 8);
  buf.writeUInt16BE(ARTNET_PROT_VER, 10);
  buf[12] = sequence & 0xff;
  buf[13] = physical & 0xff;
  buf[14] = portAddress & 0xff; // SubUni: (SubNet << 4) | Universe
  buf[15] = (portAddress >> 8) & 0x7f; // Net (7 bits)
  buf.writeUInt16BE(len, 16); // Length (big-endian, even, 2..512)
  buf.set(slots, 18);
  return buf;
}

/**
 * Decode an Art-Net 4 ArtDmx packet. Returns null if malformed.
 */
function decodeArtDmxPacket(raw) {
  if (!(raw instanceof Uint8Array) || raw.byteLength < ARTDM_HEADER_LENGTH + 2 || raw.byteLength > ARTDMX_PACKET_LENGTH) {
    return null;
  }
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!buf.subarray(0, 8).equals(ARTNET_ID)) return null;
  if (buf.readUInt16LE(8) !== ARTNET_OPCODE_DMX) return null;
  const protVer = buf.readUInt16BE(10);
  if (protVer < ARTNET_PROT_VER) return null;
  const length = buf.readUInt16BE(16);
  if (length < 2 || length > 512 || (length & 1) !== 0 || ARTDM_HEADER_LENGTH + length !== buf.length) return null;
  const subUni = buf[14];
  const net = buf[15] & 0x7f;
  return {
    protVer,
    sequence: buf[12],
    physical: buf[13],
    subUni,
    net,
    portAddress: (net << 8) | subUni,
    length,
    slots: new Uint8Array(buf.subarray(18, 18 + length)),
  };
}

/**
 * Encode an Art-Net 4 ArtPoll packet (22 bytes; backwards-compatible with Art-Net 2/3 receivers).
 */
function encodeArtPollPacket({
  flags = 0x00,
  diagPriority = 0x00,
  targetPortAddressTop = 0x0000,
  targetPortAddressBottom = 0x0000,
  estaMan = 0x0000,
  oem = 0x0000,
} = {}) {
  const buf = Buffer.alloc(22);
  ARTNET_ID.copy(buf, 0);
  buf.writeUInt16LE(ARTNET_OPCODE_POLL, 8);
  buf.writeUInt16BE(ARTNET_PROT_VER, 10);
  buf[12] = flags & 0xff;
  buf[13] = diagPriority & 0xff;
  buf.writeUInt16BE(targetPortAddressTop & 0x7fff, 14);
  buf.writeUInt16BE(targetPortAddressBottom & 0x7fff, 16);
  buf.writeUInt16BE(estaMan & 0xffff, 18);
  buf.writeUInt16BE(oem & 0xffff, 20);
  return buf;
}

function readFixedAscii(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  const raw = slice.subarray(0, nul === -1 ? length : nul).toString('utf8');
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/**
 * Defensively parse an untrusted Art-Net ArtPollReply packet (OpCode 0x2100, no ProtVer field).
 * Accepts packets >= 207 bytes (Art-Net 1..4). Returns null if invalid.
 */
function parseArtPollReply(raw, fallbackIp = '') {
  if (!(raw instanceof Uint8Array) || raw.byteLength < 207) return null;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!buf.subarray(0, 8).equals(ARTNET_ID)) return null;
  if (buf.readUInt16LE(8) !== ARTNET_OPCODE_POLL_REPLY) return null;

  const reportedIp = `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`;
  // Never trust a spoofed IP in an untrusted UDP payload over the actual sender address (rinfo).
  let ip = null;
  if (isValidIpv4(fallbackIp) && !isReservedOrBroadcastIpv4(fallbackIp)) {
    ip = fallbackIp;
  } else if (!isReservedOrBroadcastIpv4(reportedIp)) {
    ip = reportedIp;
  }
  if (!ip) return null;

  const port = buf.readUInt16LE(14);
  const netSwitch = buf[18] & 0x7f;
  const subSwitch = buf[19] & 0x0f;
  const shortName = readFixedAscii(buf, 26, 18);
  const longName = readFixedAscii(buf, 44, 64);
  const numPorts = Math.min(4, buf.readUInt16BE(172));

  const outputs = [];
  for (let i = 0; i < numPorts; i++) {
    const portType = buf[174 + i];
    // Bit 7 (0x80) = Port can output data from the Art-Net network.
    if ((portType & 0x80) !== 0) {
      const swOut = buf[190 + i] & 0x0f;
      outputs.push((netSwitch << 8) | (subSwitch << 4) | swOut);
    }
  }

  const mac = Array.from(buf.subarray(201, 207), (b) => b.toString(16).padStart(2, '0')).join(':');
  const bindIp = buf.length >= 211 ? `${buf[207]}.${buf[208]}.${buf[209]}.${buf[210]}` : reportedIp;
  const bindIndex = buf.length >= 212 ? buf[211] : 0;

  return {
    ip,
    port: port || ARTNET_PORT,
    shortName: shortName || ip,
    longName: longName || shortName || ip,
    netSwitch,
    subSwitch,
    outputs,
    mac,
    bindIp,
    bindIndex,
  };
}

module.exports = {
  SACN_PORT,
  ARTNET_PORT,
  SACN_PACKET_LENGTH,
  ARTDMX_PACKET_LENGTH,
  SACN_OPT_PREVIEW,
  SACN_OPT_STREAM_TERMINATED,
  SACN_OPT_FORCE_SYNC,
  MAX_DMX_HZ,
  MIN_FRAME_INTERVAL_NS,
  ARTNET_OPCODE_POLL,
  ARTNET_OPCODE_POLL_REPLY,
  ARTNET_OPCODE_DMX,
  isValidIpv4,
  ipv4ToInt,
  intToIpv4,
  isMulticastIpv4,
  isReservedOrBroadcastIpv4,
  isUnspecifiedIpv4,
  isLoopbackIpv4,
  computeBroadcast,
  isInSubnet,
  uuidToBytes,
  truncateUtf8Bytes,
  sacnMulticastAddress,
  encodeSacnPacket,
  decodeSacnPacket,
  encodeArtDmxPacket,
  decodeArtDmxPacket,
  encodeArtPollPacket,
  parseArtPollReply,
};
