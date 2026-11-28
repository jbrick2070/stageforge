// Evaluated on page creation. No native MIDI, IPC, or real port is touched.
export function installApcMidiMock() {
  const calls = [];
  const priorSync = { events: 0 };
  class Port extends EventTarget {
    constructor(id, name = 'APC40 mkII') {
      super();
      this.id = id;
      this.name = name;
      this.state = 'connected';
      this.connection = 'closed';
    }
    async open() { calls.push(['open', this.id]); this.connection = 'open'; return this; }
    async close() { calls.push(['close', this.id]); this.connection = 'closed'; return this; }
    emit(bytes) {
      const event = new Event('midimessage');
      Object.defineProperty(event, 'data', { value: Uint8Array.from(bytes) });
      this.dispatchEvent(event);
    }
    send(bytes) {
      calls.push(['send', this.id, Array.from(bytes)]);
      if (bytes[0] !== 0xf0 || this.id !== 'out-a') return;
      if (bytes[1] === 0x7e && !mock.deferIdentity) queueMicrotask(() => first.emit(identity()));
      if (bytes[1] === 0x47) queueMicrotask(() => first.emit([0xf0, 0x47, 0x7f, 0x29, 0x61, 0, 4, ...Array(9).fill(0), 0xf7]));
    }
  }
  const identity = () => [0xf0, 0x7e, 0, 0x06, 0x02, 0x47, 0x29, 0, 0x19, ...Array(25).fill(0), 0xf7];
  const first = new Port('in-a');
  const output = new Port('out-a');
  const unrelated = new Port('in-other', 'Unrelated controller');
  unrelated.addEventListener('midimessage', () => { priorSync.events++; });
  const access = new EventTarget();
  Object.assign(access, { inputs: new Map([[first.id, first], [unrelated.id, unrelated]]),
    outputs: new Map([[output.id, output]]), sysexEnabled: true });
  const mock = {
    calls, priorSync, deferIdentity: false, deny: false,
    emit: (bytes, id = 'in-a') => access.inputs.get(id)?.emit(bytes),
    identity: () => first.emit(identity()),
    addDuplicate: () => { access.inputs.set('in-b', new Port('in-b')); access.dispatchEvent(new Event('statechange')); },
    unplug: () => { first.state = 'disconnected'; access.dispatchEvent(new Event('statechange')); },
    replug: () => { first.state = 'connected'; access.dispatchEvent(new Event('statechange')); },
  };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async options => {
    calls.push(['access', options.sysex]);
    if (mock.deny) throw new DOMException('Denied', 'NotAllowedError');
    return access;
  } });
  window.apcTest = mock;
}
