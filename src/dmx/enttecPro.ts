// Enttec DMX USB Pro packet codec and Web Serial transport.
// Runs in Chromium browsers and sandboxed Electron renderers (where main handles select-serial-port).

export const ENTTEC_START_BYTE = 0x7e;
export const ENTTEC_END_BYTE = 0xe7;
export const ENTTEC_LABEL_SEND_DMX = 0x06;
export const ENTTEC_FRAME_LENGTH = 518; // 4 header + 1 start code + 512 slots + 1 end byte
export const FTDI_VENDOR_ID = 0x0403;
export const FTDI_PRODUCT_ID = 0x6001;
export const MAX_SERIAL_HZ = 44;

export interface WebSerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface WebSerialPortLike {
  open(options: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    flowControl?: 'none' | 'hardware';
  }): Promise<void>;
  close(): Promise<void>;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
  addEventListener?(type: 'disconnect', listener: () => void): void;
  removeEventListener?(type: 'disconnect', listener: () => void): void;
}

export interface WebSerialLike {
  requestPort(options?: { filters?: WebSerialPortFilter[] }): Promise<WebSerialPortLike>;
  addEventListener?(type: 'disconnect', listener: (event: Event) => void): void;
  removeEventListener?(type: 'disconnect', listener: (event: Event) => void): void;
}

/**
 * Encode an Enttec DMX USB Pro "Output Only Send DMX Packet Request" (Label 6) frame.
 * Layout: [0x7E, 0x06, lenLo, lenHi, startCode (0x00), ...slots (24..512), 0xE7].
 */
export function encodeEnttecProFrame(slots: Uint8Array, startCode = 0): Uint8Array {
  if (!(slots instanceof Uint8Array)) {
    throw new Error('Enttec Pro DMX buffer must be a Uint8Array.');
  }
  if (slots.byteLength < 24 || slots.byteLength > 512) {
    throw new Error(`Enttec Pro slot count must be 24..512 (got ${slots.byteLength}).`);
  }
  if (!Number.isInteger(startCode) || startCode < 0 || startCode > 255) {
    throw new Error(`Enttec Pro start code must be 0..255 (got ${String(startCode)}).`);
  }
  const dataLen = 1 + slots.byteLength; // 25..513
  const frame = new Uint8Array(5 + dataLen);
  frame[0] = ENTTEC_START_BYTE;
  frame[1] = ENTTEC_LABEL_SEND_DMX;
  frame[2] = dataLen & 0xff;
  frame[3] = (dataLen >> 8) & 0xff;
  frame[4] = startCode;
  frame.set(slots, 5);
  frame[frame.length - 1] = ENTTEC_END_BYTE;
  return frame;
}

/**
 * Decode an Enttec DMX USB Pro Label 6 frame. Returns null if malformed.
 */
export function decodeEnttecProFrame(frame: Uint8Array): { label: number; startCode: number; slots: Uint8Array } | null {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 30 || frame.byteLength > ENTTEC_FRAME_LENGTH) {
    return null;
  }
  if (frame[0] !== ENTTEC_START_BYTE || frame[frame.length - 1] !== ENTTEC_END_BYTE) return null;
  const label = frame[1];
  const dataLen = frame[2] | (frame[3] << 8);
  if (dataLen < 25 || dataLen > 513 || frame.byteLength !== 5 + dataLen) return null;
  return {
    label,
    startCode: frame[4],
    slots: frame.slice(5, 4 + dataLen),
  };
}

export function getWebSerial(): WebSerialLike | null {
  if (typeof navigator === 'undefined') return null;
  const serial = (navigator as unknown as { serial?: WebSerialLike }).serial;
  return serial && typeof serial.requestPort === 'function' ? serial : null;
}

export function isWebSerialSupported(): boolean {
  return getWebSerial() !== null;
}

export interface SerialTransportStatus {
  enabled: boolean;
  universe: 1 | 2;
  rateHz: number;
  measuredHz: number;
  packetsSent: number;
  error: string | null;
  deviceLabel: string | null;
}

export class EnttecProTransport {
  private port: WebSerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private statsTimerId: ReturnType<typeof setInterval> | null = null;
  private writing = false;
  private enabled = false;
  private universe: 1 | 2 = 1;
  private rateHz = 35;
  private measuredHz = 0;
  private framesInWindow = 0;
  private packetsSent = 0;
  private error: string | null = null;
  private deviceLabel: string | null = null;
  private lastSendMs = 0;
  private readonly slots = new Uint8Array(512);
  private readonly zeroFrame = encodeEnttecProFrame(new Uint8Array(512));
  private readonly onDisconnectBound: () => void;
  private readonly onStatus: (status: SerialTransportStatus) => void;
  private readonly serialProvider: () => WebSerialLike | null;

  constructor(
    onStatus: (status: SerialTransportStatus) => void,
    serialProvider: () => WebSerialLike | null = getWebSerial,
  ) {
    this.onStatus = onStatus;
    this.serialProvider = serialProvider;
    this.onDisconnectBound = () => {
      if (!this.enabled && !this.port) return;
      this.error = 'USB DMX interface disconnected.';
      void this.forceCloseAfterError();
    };
  }

  public getStatus(): SerialTransportStatus {
    return {
      enabled: this.enabled,
      universe: this.universe,
      rateHz: this.rateHz,
      measuredHz: this.measuredHz,
      packetsSent: this.packetsSent,
      error: this.error,
      deviceLabel: this.deviceLabel,
    };
  }

  public isRunning(): boolean {
    return this.enabled;
  }

  public getUniverse(): 1 | 2 {
    return this.universe;
  }

  public update(universe: 1 | 2, data: Uint8Array): void {
    if (!this.enabled || universe !== this.universe || data.byteLength !== 512) return;
    this.slots.set(data);
  }

  public async enable(options: { universe: 1 | 2; rateHz: number; allowAllDevices?: boolean }): Promise<SerialTransportStatus> {
    if (this.enabled) await this.disable();
    const serial = this.serialProvider();
    if (!serial) {
      throw new Error('Web Serial is not available in this browser. Use Chromium/Edge or the StageForge desktop app.');
    }
    const clampedHz = Math.min(MAX_SERIAL_HZ, Math.max(1, Math.round(options.rateHz || 35)));
    const filters: WebSerialPortFilter[] | undefined = options.allowAllDevices
      ? undefined
      : [{ usbVendorId: FTDI_VENDOR_ID, usbProductId: FTDI_PRODUCT_ID }, { usbVendorId: FTDI_VENDOR_ID }];

    let port: WebSerialPortLike;
    try {
      port = await serial.requestPort(filters ? { filters } : undefined);
    } catch (err) {
      if (err instanceof Error && err.name === 'NotFoundError') {
        throw new Error('No USB DMX port selected.');
      }
      throw new Error(err instanceof Error ? err.message : 'Could not select serial port.');
    }

    try {
      await port.open({
        baudRate: 57600,
        dataBits: 8,
        stopBits: 2,
        parity: 'none',
        flowControl: 'none',
      });
    } catch (err) {
      throw new Error(`Could not open serial port: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!port.writable) {
      try { await port.close(); } catch { /* ignore */ }
      throw new Error('Selected serial port is not writable.');
    }

    const info = port.getInfo?.();
    const label = info?.usbVendorId
      ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`
      : 'Enttec DMX USB Pro';

    this.port = port;
    this.writer = port.writable.getWriter();
    this.universe = options.universe;
    this.rateHz = clampedHz;
    this.enabled = true;
    this.error = null;
    this.deviceLabel = label;
    this.packetsSent = 0;
    this.framesInWindow = 0;
    this.measuredHz = 0;
    this.lastSendMs = 0;
    this.slots.fill(0);

    port.addEventListener?.('disconnect', this.onDisconnectBound);

    this.statsTimerId = setInterval(() => {
      this.measuredHz = this.framesInWindow;
      this.framesInWindow = 0;
      this.emit();
    }, 1000);

    this.scheduleLoop();
    this.emit();
    return this.getStatus();
  }

  public async disable(): Promise<SerialTransportStatus> {
    if (!this.enabled && !this.port) return this.getStatus();
    this.enabled = false;
    this.clearTimers();

    const port = this.port;
    const writer = this.writer;
    this.port = null;
    this.writer = null;
    this.measuredHz = 0;
    this.framesInWindow = 0;

    if (port) {
      port.removeEventListener?.('disconnect', this.onDisconnectBound);
    }

    try {
      if (writer) {
        // Send a full-universe zero blackout frame before closing so the widget does not hold the last look.
        let timedOut = false;
        try {
          await Promise.race([
            writer.write(this.zeroFrame),
            new Promise<void>((resolve) => setTimeout(() => {
              timedOut = true;
              resolve();
            }, 400)),
          ]);
        } catch {
          // Best-effort blackout if port already dropped.
        }
        if (timedOut) {
          // Abort stalled stream before releasing lock so port.close() cannot hang indefinitely.
          try {
            await Promise.race([
              writer.abort(),
              new Promise<void>((resolve) => setTimeout(resolve, 250)),
            ]);
          } catch { /* ignore */ }
        }
        try { writer.releaseLock(); } catch { /* ignore */ }
      }

      if (port) {
        try {
          await Promise.race([
            port.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 1000)),
          ]);
        } catch { /* ignore */ }
      }
    } finally {
      this.emit();
    }
    return this.getStatus();
  }

  /**
   * Best-effort synchronous blackout kick for browser `pagehide` events.
   */
  public emergencyBlackoutBestEffort(): void {
    if (!this.enabled || !this.writer) return;
    this.enabled = false;
    this.clearTimers();
    try {
      void this.writer.write(this.zeroFrame).catch(() => {});
    } catch {
      // ignore
    }
  }

  private async forceCloseAfterError(): Promise<void> {
    this.enabled = false;
    this.clearTimers();
    const port = this.port;
    const writer = this.writer;
    this.port = null;
    this.writer = null;
    this.measuredHz = 0;
    this.framesInWindow = 0;
    if (port) port.removeEventListener?.('disconnect', this.onDisconnectBound);
    if (writer) {
      try { writer.releaseLock(); } catch { /* ignore */ }
    }
    if (port) {
      try { await port.close(); } catch { /* ignore */ }
    }
    this.emit();
  }

  private clearTimers(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.statsTimerId !== null) {
      clearInterval(this.statsTimerId);
      this.statsTimerId = null;
    }
  }

  private scheduleLoop(): void {
    if (!this.enabled) return;
    const minIntervalMs = Math.max(1000 / MAX_SERIAL_HZ, 1000 / this.rateHz);
    const now = performance.now();
    const waitMs = this.lastSendMs === 0 ? 0 : Math.max(1, Math.ceil(this.lastSendMs + minIntervalMs - now));
    this.timerId = setTimeout(() => {
      this.timerId = null;
      void this.tick();
    }, waitMs);
  }

  private async tick(): Promise<void> {
    if (!this.enabled || !this.writer) return;
    if (this.writing) {
      this.scheduleLoop();
      return;
    }
    const minIntervalMs = 1000 / MAX_SERIAL_HZ;
    const now = performance.now();
    if (this.lastSendMs > 0 && now - this.lastSendMs < minIntervalMs) {
      this.scheduleLoop();
      return;
    }
    this.writing = true;
    this.lastSendMs = now;
    try {
      const frame = encodeEnttecProFrame(this.slots);
      await this.writer.write(frame);
      this.packetsSent++;
      this.framesInWindow++;
    } catch (err) {
      if (this.enabled) {
        this.error = `USB DMX write failed: ${err instanceof Error ? err.message : String(err)}`;
        this.writing = false;
        await this.forceCloseAfterError();
        return;
      }
    } finally {
      this.writing = false;
    }
    if (this.enabled) this.scheduleLoop();
  }

  private emit(): void {
    this.onStatus(this.getStatus());
  }
}
