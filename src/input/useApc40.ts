import { useCallback, useEffect, useRef, useState } from 'react';
import { ApcMidiSession, isApcCandidate, selectApcPair } from './apc40Midi';
import type { ApcAction, ApcFader } from './apc40Pack';

const CLOSED = 'MIDI disconnected';
const ports = (access: MIDIAccess) => ({
  inputs: [...access.inputs.values()].filter(isApcCandidate),
  outputs: [...access.outputs.values()].filter(isApcCandidate),
});
type Ports = ReturnType<typeof ports>;

export function useApc40(options: {
  open: boolean; eligible: boolean; epoch: number; feedback: readonly number[];
  current: (epoch: number) => boolean;
  read: (fader: ApcFader) => number | null;
  send: (action: ApcAction, epoch: number) => boolean;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [status, setStatus] = useState(CLOSED);
  const [availablePorts, setPorts] = useState<Ports | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [connected, setConnected] = useState(false);
  const request = useRef(0);
  const active = useRef<{ access: MIDIAccess; listener: () => void } | null>(null);
  const [session] = useState(() => new ApcMidiSession({
    current: epoch => latest.current.open && latest.current.current(epoch),
    read: fader => latest.current.read(fader),
    send: (action, epoch) => latest.current.send(action, epoch),
    status: message => { setStatus(message); setConnected(message === 'APC40 mkII ready' || message.startsWith('Identifying')); },
  }));

  const revoke = useCallback(() => {
    request.current++;
    const bound = active.current;
    active.current = null;
    bound?.access.removeEventListener('statechange', bound.listener);
    session.disconnect();
  }, [session]);
  const invalidate = useCallback(() => {
    revoke();
    setPorts(null);
    setRequesting(false);
    setConnected(false);
    setStatus(CLOSED);
  }, [revoke]);

  useEffect(() => {
    if (!options.open || !options.eligible) invalidate();
  }, [options.open, options.eligible, invalidate]);
  useEffect(() => {
    window.addEventListener('pagehide', revoke);
    return () => { window.removeEventListener('pagehide', revoke); revoke(); };
  }, [revoke]);
  useEffect(() => { session.setFeedback(options.feedback); }, [options.feedback, session]);

  const enable = async () => {
    const { epoch, current } = latest.current;
    if (!latest.current.open || !current(epoch) || active.current) return;
    if (typeof navigator.requestMIDIAccess !== 'function') {
      setStatus('Web MIDI is unavailable here. Use the on-screen controls.');
      return;
    }
    const id = ++request.current;
    setRequesting(true);
    try {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      if (id !== request.current) return;
      if (!latest.current.open || !latest.current.current(epoch)) { invalidate(); return; }
      if (!access.sysexEnabled) {
        setStatus('MIDI SysEx permission is required for APC40 mkII identification.');
        return;
      }
      const listener = () => {
        if (active.current?.access !== access) return;
        const next = ports(access);
        setPorts(next);
        const pair = session.pair;
        if (pair) {
          const matched = selectApcPair(next.inputs, next.outputs, pair.input.id, pair.output.id);
          if (!matched || matched.input !== pair.input || matched.output !== pair.output) {
            session.disconnect('APC40 mkII disconnected. Select Connect to bind again.');
          }
        }
      };
      active.current = { access, listener };
      access.addEventListener('statechange', listener);
      const available = ports(access);
      setPorts(available);
      setStatus(available.inputs.length && available.outputs.length
        ? 'Select one APC40 mkII input and output.' : 'No APC40 mkII input and output pair is available.');
    } catch {
      if (id === request.current) setStatus('MIDI SysEx access was denied or is unavailable. Use the on-screen controls.');
    } finally {
      if (id === request.current) setRequesting(false);
    }
  };

  const connect = (inputId: string, outputId: string) => {
    const { epoch, current } = latest.current;
    if (!latest.current.open || !current(epoch) || !active.current) return;
    const available = ports(active.current.access);
    const pair = selectApcPair(available.inputs, available.outputs, inputId, outputId);
    if (!pair) {
      session.disconnect('Select a matching, unambiguous APC40 mkII input and output.');
      return;
    }
    session.connect(pair.input, pair.output, epoch);
  };

  return {
    status, ports: availablePorts, requesting, connected, enable, connect, invalidate,
    disconnect: () => session.disconnect(CLOSED), rearm: () => session.rearm(),
  };
}
