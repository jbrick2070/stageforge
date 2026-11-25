// Pure browser/TypeScript OSC 1.0 packet codec + OSC-over-WebSocket client for web builds.
// Kept byte-for-byte consistent with desktop/osc-packets.cjs via shared tests/fixtures/osc-vectors.json.

export const OSC_MAX_PACKET_BYTES = 8192;
export const OSC_MAX_BUNDLE_DEPTH = 4;
export const OSC_MAX_ELEMENTS = 64;
export const OSC_MAX_ARGS = 16;

const OSC_FORBIDDEN_ADDR_RE = /[*?[\]{}#\s\x00-\x1f\x7f]/;
const BUNDLE_HEADER = [0x23, 0x62, 0x75, 0x6e, 0x64, 0x6c, 0x65, 0x00]; // "#bundle\0"
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export type OscArg =
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 's'; value: string }
  | { type: 'b'; value: Uint8Array }
  | { type: 'h'; value: bigint }
  | { type: 'd'; value: number }
  | { type: 't'; value: bigint }
  | { type: 'T'; value: true }
  | { type: 'F'; value: false }
  | { type: 'N'; value: null };

export interface OscMessage {
  address: string;
  args: OscArg[];
}

export type OscBumpKey = 'blinder' | 'strobe' | 'co2' | 'smoke' | 'laser' | 'motorDrop';

export interface NormalizedTriggerEvent {
  source: 'osc' | 'msc';
  kind: 'trigger';
  command:
    | 'go'
    | 'back'
    | 'stop'
    | 'resume'
    | 'reset'
    | 'blackout'
    | 'master'
    | 'bump'
    | 'tempo_tap'
    | 'tempo_bpm'
    | 'tempo_half'
    | 'tempo_double'
    | 'audio_reactive'
    | 'audio_mapping_amount';
  cue?: { index?: number; ref?: string };
  bumpKey?: OscBumpKey;
  mappingId?: string;
  value?: number;
  sender?: string;
  at: number;
}

const BUMP_ALIASES: Record<string, OscBumpKey> = {
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

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function encodeOscString(value: string): Uint8Array {
  if (value.includes('\0')) throw new Error('OSC string cannot contain NUL characters.');
  const raw = encoder.encode(value);
  const totalLen = raw.length + 1 + pad4(raw.length + 1);
  const out = new Uint8Array(totalLen);
  out.set(raw, 0);
  return out;
}

function readOscString(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  let nul = -1;
  for (let i = offset; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      nul = i;
      break;
    }
  }
  if (nul < 0) return null;
  const next = nul + 1 + pad4(nul - offset + 1);
  if (next > bytes.length) return null;
  for (let i = nul + 1; i < next; i++) {
    if (bytes[i] !== 0) return null;
  }
  return { value: decoder.decode(bytes.subarray(offset, nul)), next };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

export function encodeOscMessage(address: string, args: OscArg[] = []): Uint8Array {
  if (!address.startsWith('/') || OSC_FORBIDDEN_ADDR_RE.test(address)) {
    throw new Error(`Invalid OSC address "${address}".`);
  }
  if (args.length > OSC_MAX_ARGS) {
    throw new Error(`OSC message supports at most ${OSC_MAX_ARGS} arguments.`);
  }
  const tags: string[] = [','];
  const parts: Uint8Array[] = [];
  for (const arg of args) {
    switch (arg.type) {
      case 'i': {
        if (!Number.isInteger(arg.value) || arg.value < -2147483648 || arg.value > 2147483647) {
          throw new Error('OSC int32 argument out of range.');
        }
        tags.push('i');
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, arg.value, false);
        parts.push(b);
        break;
      }
      case 'f': {
        if (!Number.isFinite(arg.value)) throw new Error('OSC float32 argument must be finite.');
        tags.push('f');
        const b = new Uint8Array(4);
        new DataView(b.buffer).setFloat32(0, arg.value, false);
        parts.push(b);
        break;
      }
      case 's': {
        tags.push('s');
        parts.push(encodeOscString(arg.value));
        break;
      }
      case 'b': {
        tags.push('b');
        const len = arg.value.byteLength;
        const b = new Uint8Array(4 + len + pad4(len));
        new DataView(b.buffer).setInt32(0, len, false);
        b.set(arg.value, 4);
        parts.push(b);
        break;
      }
      case 'h': {
        tags.push('h');
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigInt64(0, arg.value, false);
        parts.push(b);
        break;
      }
      case 'd': {
        if (!Number.isFinite(arg.value)) throw new Error('OSC float64 argument must be finite.');
        tags.push('d');
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, arg.value, false);
        parts.push(b);
        break;
      }
      case 't': {
        tags.push('t');
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigUint64(0, arg.value, false);
        parts.push(b);
        break;
      }
      case 'T':
      case 'F':
      case 'N':
        tags.push(arg.type);
        break;
    }
  }
  const out = concatBytes([encodeOscString(address), encodeOscString(tags.join('')), ...parts]);
  if (out.byteLength > OSC_MAX_PACKET_BYTES) {
    throw new Error(`OSC message exceeds ${OSC_MAX_PACKET_BYTES} byte limit.`);
  }
  return out;
}

export function encodeOscBundle(elements: Array<Uint8Array | OscMessage>, timetag = 1n): Uint8Array {
  if (elements.length > OSC_MAX_ELEMENTS) {
    throw new Error(`OSC bundle supports at most ${OSC_MAX_ELEMENTS} elements.`);
  }
  const header = new Uint8Array(16);
  header.set(BUNDLE_HEADER, 0);
  new DataView(header.buffer).setBigUint64(8, timetag, false);
  const parts: Uint8Array[] = [header];
  for (const el of elements) {
    const bytes = el instanceof Uint8Array ? el : encodeOscMessage(el.address, el.args);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setInt32(0, bytes.byteLength, false);
    parts.push(len, bytes);
  }
  const out = concatBytes(parts);
  if (out.byteLength > OSC_MAX_PACKET_BYTES) {
    throw new Error(`OSC bundle exceeds ${OSC_MAX_PACKET_BYTES} byte limit.`);
  }
  return out;
}

function isBundleHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== BUNDLE_HEADER[i]) return false;
  }
  return true;
}

function decodeOscMessageBytes(bytes: Uint8Array): OscMessage | null {
  if (bytes.byteLength < 4 || bytes.byteLength % 4 !== 0) return null;
  const addrRes = readOscString(bytes, 0);
  if (!addrRes) return null;
  const address = addrRes.value;
  if (!address.startsWith('/') || OSC_FORBIDDEN_ADDR_RE.test(address)) return null;

  let offset = addrRes.next;
  if (offset >= bytes.byteLength) return null;
  const tagRes = readOscString(bytes, offset);
  if (!tagRes || !tagRes.value.startsWith(',')) return null;
  const tags = tagRes.value.slice(1);
  if (tags.length > OSC_MAX_ARGS) return null;
  offset = tagRes.next;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const args: OscArg[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    switch (tag) {
      case 'i': {
        if (offset + 4 > bytes.byteLength) return null;
        args.push({ type: 'i', value: view.getInt32(offset, false) });
        offset += 4;
        break;
      }
      case 'f': {
        if (offset + 4 > bytes.byteLength) return null;
        const val = view.getFloat32(offset, false);
        if (!Number.isFinite(val)) return null;
        args.push({ type: 'f', value: val });
        offset += 4;
        break;
      }
      case 's': {
        const strRes = readOscString(bytes, offset);
        if (!strRes) return null;
        args.push({ type: 's', value: strRes.value });
        offset = strRes.next;
        break;
      }
      case 'b': {
        if (offset + 4 > bytes.byteLength) return null;
        const size = view.getInt32(offset, false);
        offset += 4;
        if (size < 0 || offset + size > bytes.byteLength) return null;
        const padded = size + pad4(size);
        if (offset + padded > bytes.byteLength) return null;
        args.push({ type: 'b', value: bytes.slice(offset, offset + size) });
        offset += padded;
        break;
      }
      case 'h': {
        if (offset + 8 > bytes.byteLength) return null;
        args.push({ type: 'h', value: view.getBigInt64(offset, false) });
        offset += 8;
        break;
      }
      case 'd': {
        if (offset + 8 > bytes.byteLength) return null;
        const val = view.getFloat64(offset, false);
        if (!Number.isFinite(val)) return null;
        args.push({ type: 'd', value: val });
        offset += 8;
        break;
      }
      case 't': {
        if (offset + 8 > bytes.byteLength) return null;
        args.push({ type: 't', value: view.getBigUint64(offset, false) });
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
        return null;
    }
  }
  if (offset !== bytes.byteLength) return null;
  return { address, args };
}

export function decodeOscPacket(raw: Uint8Array): OscMessage[] | null {
  if (!(raw instanceof Uint8Array) || raw.byteLength < 8 || raw.byteLength > OSC_MAX_PACKET_BYTES) {
    return null;
  }
  const messages: OscMessage[] = [];
  let elementCount = 0;

  function walk(bytes: Uint8Array, depth: number): boolean {
    if (depth > OSC_MAX_BUNDLE_DEPTH || bytes.byteLength < 8 || bytes.byteLength % 4 !== 0) return false;
    if (isBundleHeader(bytes)) {
      if (bytes.byteLength < 16) return false;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 16;
      while (offset < bytes.byteLength) {
        if (offset + 4 > bytes.byteLength) return false;
        const elemSize = view.getInt32(offset, false);
        offset += 4;
        if (elemSize <= 0 || elemSize % 4 !== 0 || offset + elemSize > bytes.byteLength) return false;
        elementCount++;
        if (elementCount > OSC_MAX_ELEMENTS) return false;
        if (!walk(bytes.subarray(offset, offset + elemSize), depth + 1)) return false;
        offset += elemSize;
      }
      return true;
    }
    const msg = decodeOscMessageBytes(bytes);
    if (!msg) return false;
    messages.push(msg);
    return true;
  }

  try {
    return walk(raw, 0) ? messages : null;
  } catch {
    return null;
  }
}

function isRisingEdge(args: OscArg[]): boolean {
  if (args.length === 0) return true;
  const first = args[0];
  if (first.type === 'T') return true;
  if (first.type === 'F' || first.type === 'N') return false;
  if (first.type === 'f' || first.type === 'd' || first.type === 'i') return first.value >= 0.5;
  return false;
}

function toNumberArg(arg?: OscArg): number | null {
  if (!arg) return null;
  if (arg.type === 'f' || arg.type === 'd' || arg.type === 'i') {
    return Number.isFinite(arg.value) ? arg.value : null;
  }
  if (arg.type === 'T') return 1;
  if (arg.type === 'F') return 0;
  return null;
}

export function normalizeOscMessage(msg: OscMessage, at = Date.now()): NormalizedTriggerEvent | null {
  const { address, args } = msg;
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
      return isRisingEdge(args) ? { source: 'osc', kind: 'trigger', command: 'go', at } : null;
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
    case '/stageforge/audio/reactive': {
      if (args.length === 0) return { source: 'osc', kind: 'trigger', command: 'audio_reactive', value: 1, at };
      const n = toNumberArg(args[0]);
      if (n === null) return null;
      return { source: 'osc', kind: 'trigger', command: 'audio_reactive', value: n >= 0.5 ? 1 : 0, at };
    }
    default: {
      if (address.startsWith('/stageforge/audio/mapping/') && address.endsWith('/amount')) {
        const id = address.slice('/stageforge/audio/mapping/'.length, -'/amount'.length);
        if (!/^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_-]{1,32}$/.test(id)) return null;
        const n = toNumberArg(args[0]);
        if (n === null) return null;
        return {
          source: 'osc',
          kind: 'trigger',
          command: 'audio_mapping_amount',
          mappingId: id,
          value: Math.max(-1, Math.min(1, n)),
          at,
        };
      }
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

export function validateOscWsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 256) throw new Error('Enter a valid ws:// or wss:// WebSocket URL.');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid ws:// or wss:// WebSocket URL.');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('OSC WebSocket URL must use ws:// or wss://.');
  }
  return parsed.href;
}

export type OscWsState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class OscWebSocketClient {
  private ws: WebSocket | null = null;
  private state: OscWsState = 'disconnected';
  private error: string | null = null;
  private rxCount = 0;
  private droppedCount = 0;
  private tokens = 500;
  private lastRefill = Date.now();
  private onTrigger: (event: NormalizedTriggerEvent) => void;
  private onStatus: (status: { state: OscWsState; error: string | null; rxCount: number; droppedCount: number }) => void;

  constructor(
    onTrigger: (event: NormalizedTriggerEvent) => void,
    onStatus: (status: { state: OscWsState; error: string | null; rxCount: number; droppedCount: number }) => void,
  ) {
    this.onTrigger = onTrigger;
    this.onStatus = onStatus;
  }

  private emitStatus() {
    this.onStatus({
      state: this.state,
      error: this.error,
      rxCount: this.rxCount,
      droppedCount: this.droppedCount,
    });
  }

  private takeToken(): boolean {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed > 0) {
      this.tokens = Math.min(500, this.tokens + (elapsed / 1000) * 500);
      this.lastRefill = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  connect(rawUrl: string) {
    const url = validateOscWsUrl(rawUrl);
    this.disconnect();
    this.state = 'connecting';
    this.error = null;
    this.emitStatus();

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof Error ? err.message : 'Could not open WebSocket connection.';
      this.emitStatus();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.state = 'connected';
      this.error = null;
      this.emitStatus();
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      if (!(ev.data instanceof ArrayBuffer)) {
        this.droppedCount++;
        return;
      }
      const packets = decodeOscPacket(new Uint8Array(ev.data));
      if (!packets) {
        this.droppedCount++;
        return;
      }
      const at = Date.now();
      for (const msg of packets) {
        if (!this.takeToken()) {
          this.droppedCount++;
          return;
        }
        const normalized = normalizeOscMessage(msg, at);
        if (normalized) {
          this.rxCount++;
          this.onTrigger(normalized);
        } else {
          this.droppedCount++;
        }
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.state = 'error';
      this.error = 'WebSocket OSC connection error.';
      this.emitStatus();
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.state !== 'error') {
        this.state = 'disconnected';
      }
      this.emitStatus();
    });
  }

  sendMessage(address: string, args: OscArg[] = []): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      const bytes = encodeOscMessage(address, args);
      this.ws.send(bytes as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.state = 'disconnected';
    this.error = null;
    this.emitStatus();
  }
}
