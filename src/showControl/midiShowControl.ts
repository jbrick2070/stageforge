// Web MIDI MTC (Quarter-Frame 0xF1 + Full-Frame SysEx) and MSC (MIDI Show Control SysEx)
// codecs and browser/Electron Web MIDI session manager.

import type { NormalizedTriggerEvent } from './oscCodec';
import {
  DAY_MS,
  fpsToSmpteType,
  frameDurationMs,
  msToSmpte,
  smpteToMs,
  smpteTypeToFps,
  type SmpteFrameRate,
} from './timecode';

export const MSC_MAX_SYSEX_BYTES = 128;

export interface TimecodeEvent {
  source: 'mtc' | 'artnetTC';
  kind: 'timecode';
  ms: number;
  fps: SmpteFrameRate;
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  locate?: boolean;
  reverse?: boolean;
  at: number;
}

/**
 * Assemble MIDI Time Code (MTC) Quarter-Frame messages (0xF1 0nnn_dddd) and Full-Frame SysEx.
 * - Forward (pieces 0..7): completes on piece 7, adds +2 frames per MIDI MTC spec, then interpolates +1/4 frame per QF.
 * - Reverse (pieces 7..0): completes on piece 0 and marks `reverse: true` (seek-only, never fires cues).
 * - Out-of-sequence piece, out-of-range field, or frame-rate change resets assembly cleanly.
 */
export class MtcDecoder {
  private pieces = new Uint8Array(8);
  private mask = 0;
  private lastPiece = -1;
  private direction: 0 | 1 | -1 = 0;
  private lockedRate: SmpteFrameRate | null = null;
  private lastCompletedMs: number | null = null;
  private qfSinceComplete = 0;

  reset() {
    this.pieces.fill(0);
    this.mask = 0;
    this.lastPiece = -1;
    this.direction = 0;
    this.lastCompletedMs = null;
    this.qfSinceComplete = 0;
  }

  /** Feed a 2-byte MTC Quarter-Frame message `[0xF1, data]` (0 <= data <= 0x7F). */
  feedQuarterFrame(dataByte: number, at = Date.now()): TimecodeEvent | null {
    if (!Number.isInteger(dataByte) || dataByte < 0 || dataByte > 0x7f) {
      this.reset();
      return null;
    }
    const piece = (dataByte >> 4) & 0x07;
    const nibble = dataByte & 0x0f;

    if (this.lastPiece !== -1) {
      const expectedFwd = (this.lastPiece + 1) & 7;
      const expectedRev = (this.lastPiece + 7) & 7;
      if (piece === expectedFwd) {
        if (this.direction === -1) this.reset();
        this.direction = 1;
      } else if (piece === expectedRev) {
        if (this.direction === 1) this.reset();
        this.direction = -1;
      } else {
        // Out-of-sequence piece resets assembly.
        this.reset();
      }
    }

    this.pieces[piece] = nibble;
    this.mask |= 1 << piece;
    this.lastPiece = piece;

    const completedForward = this.direction >= 0 && piece === 7 && this.mask === 0xff;
    const completedReverse = this.direction === -1 && piece === 0 && this.mask === 0xff;

    if (completedForward || completedReverse) {
      const frames = this.pieces[0] | ((this.pieces[1] & 0x01) << 4);
      const seconds = this.pieces[2] | ((this.pieces[3] & 0x03) << 4);
      const minutes = this.pieces[4] | ((this.pieces[5] & 0x03) << 4);
      const hours = this.pieces[6] | ((this.pieces[7] & 0x01) << 4);
      const rateCode = (this.pieces[7] >> 1) & 0x03;
      const fps = smpteTypeToFps(rateCode);
      if (!fps) {
        this.reset();
        return null;
      }
      if (this.lockedRate !== null && this.lockedRate !== fps) {
        // Rate change resets assembly and adopts the new rate on the next full cycle.
        this.lockedRate = fps;
        this.reset();
        return null;
      }
      const rawMs = smpteToMs({ hours, minutes, seconds, frames, fps });
      if (rawMs === null) {
        this.reset();
        return null;
      }
      this.lockedRate = fps;
      // Forward MTC represents the time at piece 0, which is 2 frames behind when piece 7 arrives.
      const offsetMs = completedForward ? 2 * frameDurationMs(fps) : 0;
      const ms = (rawMs + offsetMs) % DAY_MS;
      const display = msToSmpte(ms, fps);
      this.lastCompletedMs = ms;
      this.qfSinceComplete = 0;
      return {
        source: 'mtc',
        kind: 'timecode',
        ms,
        fps,
        hours: display.hours,
        minutes: display.minutes,
        seconds: display.seconds,
        frames: display.frames,
        reverse: completedReverse || undefined,
        at,
      };
    }

    // Smooth quarter-frame interpolation between full 8-piece completions while running forward.
    if (this.direction === 1 && this.lastCompletedMs !== null && this.lockedRate !== null && this.qfSinceComplete < 7) {
      this.qfSinceComplete++;
      const ms = (this.lastCompletedMs + this.qfSinceComplete * (frameDurationMs(this.lockedRate) / 4)) % DAY_MS;
      const display = msToSmpte(ms, this.lockedRate);
      return {
        source: 'mtc',
        kind: 'timecode',
        ms,
        fps: this.lockedRate,
        hours: display.hours,
        minutes: display.minutes,
        seconds: display.seconds,
        frames: display.frames,
        at,
      };
    }

    return null;
  }

  /**
   * Parse an MTC Full-Frame SysEx message:
   * `F0 7F <deviceId> 01 01 <0rrhhhhh> <mm> <ss> <ff> F7` (10 bytes).
   * Immediate locate — no +2 frame offset.
   */
  feedFullFrame(bytes: Uint8Array, deviceId = 0x7f, at = Date.now()): TimecodeEvent | null {
    if (bytes.byteLength !== 10) return null;
    if (bytes[0] !== 0xf0 || bytes[1] !== 0x7f || bytes[3] !== 0x01 || bytes[4] !== 0x01 || bytes[9] !== 0xf7) {
      return null;
    }
    const dev = bytes[2];
    if (dev !== 0x7f && deviceId !== 0x7f && dev !== deviceId) return null;

    const rateCode = (bytes[5] >> 5) & 0x03;
    const hours = bytes[5] & 0x1f;
    const minutes = bytes[6] & 0x3f;
    const seconds = bytes[7] & 0x3f;
    const frames = bytes[8] & 0x1f;
    const fps = smpteTypeToFps(rateCode);
    if (!fps) return null;
    const ms = smpteToMs({ hours, minutes, seconds, frames, fps });
    if (ms === null) return null;

    this.reset();
    this.lockedRate = fps;
    this.lastCompletedMs = ms;
    return {
      source: 'mtc',
      kind: 'timecode',
      ms,
      fps,
      hours,
      minutes,
      seconds,
      frames,
      locate: true,
      at,
    };
  }
}

export function encodeMtcFullFrame(ms: number, fps: SmpteFrameRate, deviceId = 0x7f): Uint8Array {
  const tc = msToSmpte(ms, fps);
  const rateCode = fpsToSmpteType(fps);
  return new Uint8Array([
    0xf0,
    0x7f,
    deviceId & 0x7f,
    0x01,
    0x01,
    ((rateCode & 0x03) << 5) | (tc.hours & 0x1f),
    tc.minutes & 0x3f,
    tc.seconds & 0x3f,
    tc.frames & 0x1f,
    0xf7,
  ]);
}

export function encodeMtcQuarterFrames(ms: number, fps: SmpteFrameRate): Uint8Array[] {
  const tc = msToSmpte(ms, fps);
  const rateCode = fpsToSmpteType(fps);
  const nibbles = [
    tc.frames & 0x0f,
    (tc.frames >> 4) & 0x01,
    tc.seconds & 0x0f,
    (tc.seconds >> 4) & 0x03,
    tc.minutes & 0x0f,
    (tc.minutes >> 4) & 0x03,
    tc.hours & 0x0f,
    ((rateCode & 0x03) << 1) | ((tc.hours >> 4) & 0x01),
  ];
  return nibbles.map((n, piece) => new Uint8Array([0xf1, (piece << 4) | n]));
}

// --- MIDI Show Control (MSC) ---

const MSC_ALLOWED_FORMATS = new Set([0x01, 0x02, 0x7f]); // Lighting, Moving Lights, All-types
const MSC_Q_NUMBER_RE = /^\d+(?:\.\d+)?$/;

export interface MscFilterOptions {
  deviceId: number; // 0..111 individual, or 0x7F all-call
  groupId?: number; // 112..126 optional group
}

function matchesMscDevice(dev: number, filter: MscFilterOptions): boolean {
  if (dev === 0x7f) return true;
  if (filter.deviceId === 0x7f) return true;
  if (dev === filter.deviceId) return true;
  if (filter.groupId !== undefined && filter.groupId >= 0x70 && filter.groupId <= 0x7e && dev === filter.groupId) {
    return true;
  }
  return false;
}

function parseMscCueData(data: Uint8Array): { index?: number; ref?: string } | null | 'invalid' {
  if (data.byteLength === 0) return null;
  // Data layout: ASCII Q_number [0x00 Q_list [0x00 Q_path]]
  let end = data.indexOf(0x00);
  if (end < 0) end = data.byteLength;
  if (end === 0) return null;
  let qNum = '';
  for (let i = 0; i < end; i++) {
    const ch = data[i];
    if (ch < 0x20 || ch > 0x7e) return 'invalid';
    qNum += String.fromCharCode(ch);
  }
  const trimmed = qNum.trim();
  if (!MSC_Q_NUMBER_RE.test(trimmed)) return 'invalid';
  if (!trimmed.includes('.')) {
    const idx = Number(trimmed);
    if (!Number.isInteger(idx) || idx < 1 || idx > 4096) return 'invalid';
    return { index: idx };
  }
  return { ref: trimmed };
}

/**
 * Decode an MSC SysEx message: `F0 7F <dev> 02 <fmt> <cmd> [data...] F7`.
 * Supports GO (0x01), STOP (0x02), RESUME (0x03), TIMED_GO (0x04),
 * SET (0x06, ctrl 1 -> grand master), ALL_OFF (0x08), RESTORE (0x09), RESET (0x0A).
 */
export function decodeMscSysex(
  bytes: Uint8Array,
  filter: MscFilterOptions = { deviceId: 0x7f },
  at = Date.now(),
): NormalizedTriggerEvent | null {
  if (bytes.byteLength < 7 || bytes.byteLength > MSC_MAX_SYSEX_BYTES) return null;
  if (bytes[0] !== 0xf0 || bytes[1] !== 0x7f || bytes[3] !== 0x02 || bytes[bytes.byteLength - 1] !== 0xf7) {
    return null;
  }
  const dev = bytes[2];
  if (!matchesMscDevice(dev, filter)) return null;
  const cmdFormat = bytes[4];
  if (!MSC_ALLOWED_FORMATS.has(cmdFormat)) return null;

  const cmd = bytes[5];
  const data = bytes.subarray(6, bytes.byteLength - 1);

  switch (cmd) {
    case 0x01: { // GO
      const cue = parseMscCueData(data);
      if (cue === 'invalid') return null;
      return { source: 'msc', kind: 'trigger', command: 'go', ...(cue ? { cue } : {}), at };
    }
    case 0x02: // STOP
      return { source: 'msc', kind: 'trigger', command: 'stop', at };
    case 0x03: // RESUME
      return { source: 'msc', kind: 'trigger', command: 'resume', at };
    case 0x04: { // TIMED_GO: 5-byte time (hr, mn, sc, fr, ff) followed by optional Q_number
      if (data.byteLength < 5) return null;
      const cue = parseMscCueData(data.subarray(5));
      if (cue === 'invalid') return null;
      return { source: 'msc', kind: 'trigger', command: 'go', ...(cue ? { cue } : {}), at };
    }
    case 0x06: { // SET: ctrl LSB, ctrl MSB, val LSB, val MSB (optional 5-byte time)
      if (data.byteLength < 4) return null;
      const ctrl = (data[0] & 0x7f) | ((data[1] & 0x7f) << 7);
      const val14 = (data[2] & 0x7f) | ((data[3] & 0x7f) << 7);
      if (ctrl !== 1) return null; // Ctrl 1 = grand master
      return { source: 'msc', kind: 'trigger', command: 'master', value: Math.max(0, Math.min(1, val14 / 16383)), at };
    }
    case 0x08: // ALL_OFF (blackout on)
      return { source: 'msc', kind: 'trigger', command: 'blackout', value: 1, at };
    case 0x09: // RESTORE (blackout off)
      return { source: 'msc', kind: 'trigger', command: 'blackout', value: 0, at };
    case 0x0a: // RESET
      return { source: 'msc', kind: 'trigger', command: 'reset', at };
    default:
      return null;
  }
}

export function encodeMscGo(cueNumber?: string, deviceId = 0x7f, cmdFormat = 0x01): Uint8Array {
  const ascii = cueNumber ? Array.from(cueNumber, (ch) => ch.charCodeAt(0) & 0x7f) : [];
  return new Uint8Array([0xf0, 0x7f, deviceId & 0x7f, 0x02, cmdFormat & 0x7f, 0x01, ...ascii, 0xf7]);
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
  manufacturer: string;
}

export interface MidiStatus {
  supported: boolean;
  connected: boolean;
  sysexEnabled: boolean;
  inputs: MidiDeviceInfo[];
  outputs: MidiDeviceInfo[];
  error: string | null;
}

export class MidiShowControlClient {
  private access: MIDIAccess | null = null;
  private sysexEnabled = false;
  private selectedInputId: string = 'all';
  private selectedOutputId: string = '';
  private mscFilter: MscFilterOptions = { deviceId: 0x7f };
  private mtcDecoder = new MtcDecoder();
  private mtcTokens = 500;
  private mtcLastRefill = Date.now();
  private mscTokens = 500;
  private mscLastRefill = Date.now();
  private mtcEnabled = false;
  private mscEnabled = false;
  private onEvent: (event: NormalizedTriggerEvent | TimecodeEvent) => void;
  private onStatus: (status: MidiStatus) => void;
  private boundInputs = new Set<MIDIInput>();
  private mtcSendTimer: number | null = null;
  private mtcSendPiece = 0;
  private mtcSendFrames = new Uint8Array(8);
  private mtcWasPlaying = false;

  constructor(
    onEvent: (event: NormalizedTriggerEvent | TimecodeEvent) => void,
    onStatus: (status: MidiStatus) => void,
  ) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  private takeMtcToken(): boolean {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.mtcLastRefill);
    if (elapsed > 0) {
      this.mtcTokens = Math.min(500, this.mtcTokens + (elapsed / 1000) * 500);
      this.mtcLastRefill = now;
    }
    if (this.mtcTokens < 1) return false;
    this.mtcTokens -= 1;
    return true;
  }

  private takeMscToken(): boolean {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.mscLastRefill);
    if (elapsed > 0) {
      this.mscTokens = Math.min(500, this.mscTokens + (elapsed / 1000) * 500);
      this.mscLastRefill = now;
    }
    if (this.mscTokens < 1) return false;
    this.mscTokens -= 1;
    return true;
  }

  private snapshotStatus(error: string | null = null): MidiStatus {
    const inputs: MidiDeviceInfo[] = [];
    const outputs: MidiDeviceInfo[] = [];
    if (this.access) {
      this.access.inputs.forEach((p) => {
        inputs.push({ id: p.id, name: p.name || p.id, manufacturer: p.manufacturer || '' });
      });
      this.access.outputs.forEach((p) => {
        outputs.push({ id: p.id, name: p.name || p.id, manufacturer: p.manufacturer || '' });
      });
    }
    return {
      supported: MidiShowControlClient.isSupported(),
      connected: this.access !== null,
      sysexEnabled: this.sysexEnabled,
      inputs,
      outputs,
      error,
    };
  }

  private handleMidiMessage = (ev: MIDIMessageEvent) => {
    const data = ev.data;
    if (!data || data.byteLength === 0) return;
    const status = data[0];
    // Classify by status byte FIRST so unrelated CC/0xF8 MIDI clock floods cannot starve MTC/MSC (M4).
    if (status === 0xf1 && data.byteLength >= 2) {
      if (!this.mtcEnabled || !this.takeMtcToken()) return;
      const tc = this.mtcDecoder.feedQuarterFrame(data[1], Date.now());
      if (tc) this.onEvent(tc);
      return;
    }
    if (status === 0xf0 && data.byteLength >= 7 && data.byteLength <= MSC_MAX_SYSEX_BYTES) {
      if (this.mtcEnabled && data.byteLength === 10 && data[3] === 0x01 && data[4] === 0x01) {
        if (!this.takeMtcToken()) return;
        const tc = this.mtcDecoder.feedFullFrame(data, this.mscFilter.deviceId, Date.now());
        if (tc) this.onEvent(tc);
        return;
      }
      if (this.mscEnabled && data[3] === 0x02) {
        if (!this.takeMscToken()) return;
        const trigger = decodeMscSysex(data, this.mscFilter, Date.now());
        if (trigger) this.onEvent(trigger);
      }
    }
  };

  private rebindInputs() {
    for (const input of this.boundInputs) {
      input.removeEventListener('midimessage', this.handleMidiMessage);
    }
    this.boundInputs.clear();
    if (!this.access || (!this.mtcEnabled && !this.mscEnabled)) return;
    this.access.inputs.forEach((input) => {
      if (this.selectedInputId === 'all' || input.id === this.selectedInputId) {
        input.addEventListener('midimessage', this.handleMidiMessage);
        this.boundInputs.add(input);
      }
    });
  }

  async connect(): Promise<MidiStatus> {
    if (!MidiShowControlClient.isSupported()) {
      const st = this.snapshotStatus('Web MIDI is not supported in this browser.');
      this.onStatus(st);
      return st;
    }
    if (this.access) {
      const st = this.snapshotStatus(null);
      this.onStatus(st);
      return st;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysexEnabled = true;
    } catch {
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        this.sysexEnabled = false;
      } catch (err) {
        const st = this.snapshotStatus(err instanceof Error ? err.message : 'MIDI permission denied.');
        this.onStatus(st);
        return st;
      }
    }
    this.access.onstatechange = () => {
      this.rebindInputs();
      this.onStatus(this.snapshotStatus(null));
    };
    this.rebindInputs();
    const st = this.snapshotStatus(this.sysexEnabled ? null : 'SysEx unavailable — MSC and MTC Full-Frame require SysEx.');
    this.onStatus(st);
    return st;
  }

  configure(opts: {
    mtcEnabled: boolean;
    mscEnabled: boolean;
    inputId: string;
    outputId: string;
    deviceId: number;
  }) {
    this.mtcEnabled = opts.mtcEnabled;
    this.mscEnabled = opts.mscEnabled;
    this.selectedInputId = opts.inputId || 'all';
    this.selectedOutputId = opts.outputId || '';
    this.mscFilter = { deviceId: opts.deviceId };
    if (!opts.mtcEnabled) this.mtcDecoder.reset();
    this.rebindInputs();
  }

  sendMtcFullFrame(ms: number, fps: SmpteFrameRate): boolean {
    if (!this.access || !this.sysexEnabled || !this.selectedOutputId) return false;
    const out = this.access.outputs.get(this.selectedOutputId);
    if (!out) return false;
    try {
      out.send(encodeMtcFullFrame(ms, fps, this.mscFilter.deviceId));
      return true;
    } catch {
      return false;
    }
  }

  startMtcOutput(getPositionMs: () => number, fps: SmpteFrameRate, isPlaying: () => boolean = () => true) {
    this.stopMtcOutput();
    if (!this.access || !this.selectedOutputId) return;
    const qfIntervalMs = frameDurationMs(fps) / 4;
    this.mtcSendPiece = 0;
    this.mtcWasPlaying = false;
    let nextDeadline = performance.now();

    const refresh = () => {
      const qfs = encodeMtcQuarterFrames(getPositionMs(), fps);
      for (let i = 0; i < 8; i++) this.mtcSendFrames[i] = qfs[i][1];
    };

    // Schedule from floating-point performance.now() deadlines so 24/29.97/30 fps never drift ~4% fast (M9),
    // and only emit quarter-frames while the take transport is actually playing (H2).
    const step = () => {
      this.mtcSendTimer = null;
      const currentOut = this.access?.outputs.get(this.selectedOutputId);
      if (!currentOut) {
        this.stopMtcOutput();
        return;
      }
      const playing = isPlaying();
      if (!playing) {
        this.mtcWasPlaying = false;
        this.mtcSendPiece = 0;
        nextDeadline = performance.now() + 50;
        this.mtcSendTimer = window.setTimeout(step, 50);
        return;
      }
      if (!this.mtcWasPlaying) {
        this.mtcWasPlaying = true;
        this.mtcSendPiece = 0;
        if (this.sysexEnabled) {
          try { currentOut.send(encodeMtcFullFrame(getPositionMs(), fps, this.mscFilter.deviceId)); } catch { /* ignore */ }
        }
        nextDeadline = performance.now();
      }
      if (this.mtcSendPiece === 0) refresh();
      try {
        currentOut.send(new Uint8Array([0xf1, this.mtcSendFrames[this.mtcSendPiece]]));
      } catch {
        // ignore transient send errors
      }
      this.mtcSendPiece = (this.mtcSendPiece + 1) & 7;
      nextDeadline += qfIntervalMs;
      const now = performance.now();
      if (now - nextDeadline > qfIntervalMs * 4) nextDeadline = now + qfIntervalMs;
      this.mtcSendTimer = window.setTimeout(step, Math.max(1, Math.round(nextDeadline - now)));
    };

    step();
  }

  stopMtcOutput() {
    if (this.mtcSendTimer !== null) {
      window.clearTimeout(this.mtcSendTimer);
      this.mtcSendTimer = null;
    }
    this.mtcWasPlaying = false;
  }

  dispose() {
    this.stopMtcOutput();
    for (const input of this.boundInputs) {
      input.removeEventListener('midimessage', this.handleMidiMessage);
    }
    this.boundInputs.clear();
    if (this.access) {
      this.access.onstatechange = null;
      this.access = null;
    }
    this.mtcDecoder.reset();
  }
}
