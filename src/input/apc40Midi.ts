import { APC_FADERS, APC_PADS, APC_SCENES, type ApcAction, type ApcFader } from './apc40Pack';

// Akai APC40 Mk2 Communications Protocol v1.2, pages 5–9, 11, 14–20 and 30–35.
export const APC_INQUIRY = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
export const APC_MODE = [0xf0, 0x47, 0x7f, 0x29, 0x60, 0x00, 0x04, 0x42, 0x01, 0x00, 0x00, 0xf7];
const SCENE = 0x52;
const STOP_ALL = 0x51;
const HANDSHAKE_MS = 2000;
const LED_INTERVAL_MS = 30;
const reverseGridRows = (index: number) => (4 - Math.floor(index / 8)) * 8 + index % 8;

function sysex(bytes: ArrayLike<number>, size: number, prefix: number[]): boolean {
  if (bytes.length !== size || bytes[0] !== 0xf0 || bytes[size - 1] !== 0xf7) return false;
  for (let i = 1; i < size - 1; i++) {
    const byte = bytes[i];
    if (!Number.isInteger(byte) || byte < 0 || byte > 0x7f) return false;
  }
  return prefix.every((value, index) => value < 0 || bytes[index + 1] === value);
}

export const isApcIdentity = (bytes: ArrayLike<number>) =>
  sysex(bytes, 35, [0x7e, -1, 0x06, 0x02, 0x47, 0x29, 0x00, 0x19]);
// The documented response declares 04 yet lists all nine fader bytes (17 bytes total).
export const isApcIntroduction = (bytes: ArrayLike<number>) =>
  sysex(bytes, 17, [0x47, 0x7f, 0x29, 0x61, 0x00, 0x04]);

type MidiIntent =
  | { kind: 'note'; key: number; pressed: boolean; action: ApcAction }
  | { kind: 'continuous'; fader: ApcFader; value: number };

export function decodeApcMidi(bytes: ArrayLike<number>): MidiIntent | null {
  if (bytes.length !== 3) return null;
  const [status, key, raw] = [bytes[0], bytes[1], bytes[2]];
  if (![status, key, raw].every(Number.isInteger) || key < 0 || key > 0x7f || raw < 0 || raw > 0x7f) return null;
  const channel = status & 0x0f;
  if (status >= 0xb0 && status <= 0xbf) {
    const index = key === 0x07 && channel < 8 ? channel : key === 0x0e && channel === 0 ? 8 : -1;
    return index < 0 ? null : { kind: 'continuous', fader: APC_FADERS[index][0], value: raw / 127 };
  }
  if (status < 0x80 || status > 0x9f) return null;
  // These global buttons ignore the MIDI channel per the device's inbound note table.
  const action = (key < APC_PADS.length ? APC_PADS[reverseGridRows(key)].action : undefined) ?? APC_SCENES[key - SCENE]?.action ??
    (key === STOP_ALL ? { kind: 'blackout' } as const : null);
  return action ? { kind: 'note', key, pressed: status >= 0x90 && raw > 0, action } : null;
}

export function apcLedMessage(index: number, color: number): number[] {
  return [0x90, index < APC_PADS.length ? reverseGridRows(index) : SCENE + index - APC_PADS.length, color];
}

const matchingName = (port: MIDIPort) => {
  const name = port.name?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';
  return /^apc40(?:mkii|mk2)(?:midi\d*)?$/.test(name) ? name.replace('mk2', 'mkii') : '';
};
export const isApcCandidate = (port: MIDIPort) => port.state === 'connected' && !!matchingName(port);

export function selectApcPair(inputs: readonly MIDIInput[], outputs: readonly MIDIOutput[], inputId: string, outputId: string) {
  const input = inputs.find(port => port.id === inputId && port.state === 'connected');
  const output = outputs.find(port => port.id === outputId && port.state === 'connected');
  const name = input && matchingName(input);
  if (!input || !output || !name || matchingName(output) !== name ||
      inputs.filter(port => port.state === 'connected' && matchingName(port) === name).length !== 1 ||
      outputs.filter(port => port.state === 'connected' && matchingName(port) === name).length !== 1) return null;
  return { input, output };
}

type Pickup = { software: number; last: number; latched: boolean };
const PICKUP_TOLERANCE = 2 / 127;

export function advanceApcPickup(previous: Pickup | undefined, software: number, value: number): Pickup {
  const sameTarget = previous && Math.abs(previous.software - software) < 1e-6;
  const crossed = sameTarget && (previous.last - software) * (value - software) <= 0;
  return { software, last: value, latched: !!(sameTarget && previous.latched || crossed || Math.abs(value - software) <= PICKUP_TOLERANCE) };
}

type ApcPhase = 'opening' | 'identifying' | 'initializing' | 'ready';
type Binding = {
  input: MIDIInput; output: MIDIOutput; epoch: number; phase: ApcPhase;
  listener: (event: MIDIMessageEvent) => void; timer?: ReturnType<typeof setTimeout>; ledTimer?: ReturnType<typeof setTimeout>;
  lastLeds: number[]; held: Set<number>; pickup: Map<ApcFader, { observed: Pickup; pending: number[] }>;
  claims: Map<MIDIPort, { opened: boolean }>;
};

export class ApcMidiSession {
  private binding: Binding | null = null;
  private feedback: readonly number[] = [];
  private readonly portWork = new WeakMap<MIDIPort, Promise<void>>();

  constructor(private readonly desk: {
    current: (epoch: number) => boolean;
    read: (fader: ApcFader) => number | null;
    send: (action: ApcAction, epoch: number) => boolean;
    status: (status: string) => void;
  }) {}

  get pair() { return this.binding; }

  connect(input: MIDIInput, output: MIDIOutput, epoch: number) {
    this.disconnect();
    const binding: Binding = {
      input, output, epoch, phase: 'opening',
      listener: event => this.onMessage(binding, event), lastLeds: [], held: new Set(), pickup: new Map(),
      claims: new Map(),
    };
    this.binding = binding;
    input.addEventListener('midimessage', binding.listener);
    this.desk.status('Identifying the selected APC40 mkII…');
    binding.timer = setTimeout(() => {
      if (this.binding === binding) this.disconnect('The selected pair did not complete APC40 mkII identification.');
    }, HANDSHAKE_MS);
    void this.open(binding);
  }

  private async open(binding: Binding) {
    try {
      await this.openPort(binding, binding.input);
      if (!this.current(binding)) return;
      await this.openPort(binding, binding.output);
    } catch {
      if (this.binding === binding) this.disconnect('The selected APC40 mkII ports could not be opened.');
      return;
    }
    if (!this.current(binding)) return;
    binding.phase = 'identifying';
    this.transmit(binding, APC_INQUIRY);
  }

  private queuePort(port: MIDIPort, work: () => Promise<void>): Promise<void> {
    const operation = (this.portWork.get(port) ?? Promise.resolve()).then(work);
    this.portWork.set(port, operation.catch(() => {}));
    return operation;
  }

  private openPort(binding: Binding, port: MIDIPort): Promise<void> {
    return this.queuePort(port, async () => {
      if (!this.current(binding) || port.connection === 'open') return;
      const claim = { opened: false };
      binding.claims.set(port, claim);
      await port.open();
      claim.opened = true;
    });
  }

  disconnect(status?: string) {
    const binding = this.binding;
    this.binding = null;
    if (binding) {
      binding.input.removeEventListener('midimessage', binding.listener);
      clearTimeout(binding.timer);
      clearTimeout(binding.ledTimer);
      for (const [port, claim] of binding.claims) {
        void this.queuePort(port, async () => { if (claim.opened) await port.close(); }).catch(() => {});
      }
    }
    if (status) this.desk.status(status);
  }

  rearm() { this.binding?.pickup.clear(); }

  setFeedback(values: readonly number[]) {
    this.feedback = values;
    if (this.binding?.phase === 'ready') this.queueLeds(this.binding);
  }

  private current(binding: Binding): boolean {
    if (this.binding !== binding) return false;
    if (binding.input.state !== 'connected' || binding.output.state !== 'connected' || !this.desk.current(binding.epoch)) {
      this.disconnect('APC40 mkII disconnected. Select Connect to bind again.');
      return false;
    }
    return true;
  }

  private transmit(binding: Binding, bytes: number[]): boolean {
    if (!this.current(binding)) return false;
    try {
      binding.output.send(bytes);
      return true;
    } catch {
      this.disconnect('The selected APC40 mkII output is unavailable.');
      return false;
    }
  }

  private onMessage(binding: Binding, event: MIDIMessageEvent) {
    if (event.currentTarget !== binding.input || !event.data || !this.current(binding)) return;
    if (binding.phase === 'opening') return;
    if (binding.phase === 'identifying') {
      if (!isApcIdentity(event.data)) return;
      binding.phase = 'initializing';
      this.transmit(binding, APC_MODE);
      return;
    }
    if (binding.phase === 'initializing') {
      if (!isApcIntroduction(event.data)) return;
      clearTimeout(binding.timer);
      binding.phase = 'ready';
      this.desk.status('APC40 mkII ready');
      this.queueLeds(binding);
      return;
    }
    const decoded = decodeApcMidi(event.data);
    if (!decoded) return;
    if (decoded.kind === 'note') {
      if (!decoded.pressed) { binding.held.delete(decoded.key); return; }
      if (binding.held.has(decoded.key)) return;
      binding.held.add(decoded.key);
      if (this.desk.send(decoded.action, binding.epoch)) binding.pickup.clear();
      return;
    }
    const { fader, value } = decoded;
    const software = this.desk.read(fader);
    if (software === null) { binding.pickup.delete(fader); return; }
    const previous = binding.pickup.get(fader);
    const echo = previous?.pending.lastIndexOf(software) ?? -1;
    const unchanged = previous?.observed.software === software;
    const observed = advanceApcPickup(echo >= 0 && previous ? { ...previous.observed, software } : previous?.observed, software, value);
    const pending = echo >= 0 && previous ? previous.pending.slice(echo + 1) : unchanged && previous ? previous.pending : [];
    if (observed.latched && this.desk.send({ kind: 'fader', fader, value }, binding.epoch) &&
        value !== software && pending.at(-1) !== value) {
      pending.push(value);
      if (pending.length > 128) pending.shift();
    }
    binding.pickup.set(fader, { observed, pending });
  }

  private queueLeds(binding: Binding) {
    if (binding.ledTimer !== undefined) return;
    binding.ledTimer = setTimeout(() => {
      binding.ledTimer = undefined;
      if (!this.current(binding)) return;
      const count = Math.min(this.feedback.length, APC_PADS.length + APC_SCENES.length);
      for (let i = 0; i < count; i++) {
        const color = this.feedback[i];
        if (binding.lastLeds[i] === color) continue;
        if (!this.transmit(binding, apcLedMessage(i, color))) return;
        binding.lastLeds[i] = color;
      }
    }, LED_INTERVAL_MS);
  }
}
