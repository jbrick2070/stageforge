import { useEffect, useState } from 'react';
import { LOGICAL_DMX_UNIVERSES } from '../data/dmxUniverses';
import type { ArtNetInputApi } from '../dmx/useArtNetInput';
import { useLive } from '../state/liveTelemetry';
import { LevelSourceControl } from './LevelSourceControl';

const DEFAULT_CONFIG: ArtNetInputConfigBridge = {
  binding: 'loopback', address: '127.0.0.1',
  mappings: [
    { portAddress: 0, universe: 1, sender: '127.0.0.1' },
    { portAddress: 2, universe: 3, sender: '127.0.0.1' },
  ],
};
const ZERO = new Uint8Array(512);
const INPUT_TIMEOUT_MS = 3000;
const controlClass = 'min-w-0 rounded border border-white/15 bg-zinc-900 p-1 text-zinc-100';

export function ArtNetInputSection({ input }: { input: ArtNetInputApi }) {
  const snapshot = useLive(input.store);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [interfaces, setInterfaces] = useState<Pick<DmxNetworkInterfaceBridge, 'name' | 'address'>[]>([]);
  const [interfaceError, setInterfaceError] = useState<string | null>(null);
  const [universe, setUniverse] = useState(3);
  const [clock, setClock] = useState(() => performance.now());

  useEffect(() => {
    let alive = true;
    void window.stageforgeDesktop?.artNetInput({ type: 'listInterfaces' }).then(
      entries => { if (alive) setInterfaces(entries); },
      error => { if (alive) setInterfaceError(String(error?.message ?? error)); },
    );
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (snapshot.phase !== 'listening') return;
    const timer = window.setInterval(() => setClock(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [snapshot.phase]);

  const shown = snapshot.config ?? config;
  const mapping = shown.mappings.find(row => row.universe === universe) ?? shown.mappings[0];
  const row = snapshot.batch?.rows.find(entry => entry.universe === mapping.universe);
  const age = row?.ageMs == null ? null : row.ageMs + Math.max(0, clock - snapshot.batchAt);
  const listening = snapshot.phase === 'listening';
  const stale = row?.state === 'stale' || (age !== null && age >= INPUT_TIMEOUT_MS);
  const data = listening && !stale && row?.state === 'active' ? row.data : ZERO;
  const label = snapshot.phase === 'off' ? 'Off'
    : snapshot.phase === 'starting' ? 'Starting'
    : snapshot.phase === 'stopping' ? 'Stopping'
    : stale ? 'Stale'
    : row?.state === 'active' ? 'Receiving'
    : 'Awaiting first frame';
  const canConfigure = snapshot.phase === 'off';

  const changeMapping = (index: number, patch: Partial<ArtNetInputMappingBridge>) => {
    setConfig(current => ({ ...current, mappings: current.mappings.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  };
  const addMapping = () => {
    const nextUniverse = LOGICAL_DMX_UNIVERSES.find(candidate => !config.mappings.some(item => item.universe === candidate));
    if (nextUniverse === undefined) return;
    let portAddress = nextUniverse - 1;
    while (config.mappings.some(item => item.portAddress === portAddress)) portAddress++;
    setConfig(current => ({ ...current, mappings: [...current.mappings, { universe: nextUniverse, portAddress, sender: '127.0.0.1' }] }));
  };

  return (
    <section aria-label="Art-Net input monitor" className="min-h-0 flex-1 space-y-2 overflow-auto bg-black/50 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-white">Art-Net input</h3>
          <p className="text-[10px] text-zinc-400">Receive-only levels for this monitor.</p>
        </div>
        <button type="button" className="transport-btn"
          disabled={snapshot.phase === 'stopping'} onClick={() => canConfigure ? input.start(config) : input.stop()}>
          {canConfigure ? 'Start listening' : 'Stop listening'}
        </button>
      </div>

      <LevelSourceControl input={input} />
      <fieldset disabled={!canConfigure} className="space-y-1.5 rounded border border-white/10 p-2 disabled:opacity-70">
        <legend className="px-1 text-zinc-300">Receive settings</legend>
        <label className="flex items-center justify-between gap-2">
          <span>Art-Net binding</span>
          <select className={controlClass} value={shown.address} onChange={event => {
            const address = event.target.value;
            const binding = address === '127.0.0.1' ? 'loopback' : address === '0.0.0.0' ? 'all' : 'interface';
            setConfig(current => ({ ...current, binding, address }));
          }}>
            <option value="127.0.0.1">Loopback (127.0.0.1)</option>
            <option value="0.0.0.0">All interfaces (0.0.0.0)</option>
            {interfaces.map(iface => <option key={iface.address} value={iface.address}>{iface.name} ({iface.address})</option>)}
          </select>
        </label>
        <div className="grid grid-cols-[5rem_3.5rem_1fr_auto] gap-1 text-[9px] text-zinc-400" aria-hidden="true">
          <span>Port-Address</span><span>Universe</span><span>Pinned sender IPv4</span>
        </div>
        {shown.mappings.map((entry, index) => (
          <div key={index} className="grid grid-cols-[5rem_3.5rem_1fr_auto] gap-1">
            <input type="number" min={0} max={32767} step={1} className={controlClass}
              aria-label={`Port-Address mapping ${index + 1}`} value={entry.portAddress}
              onChange={event => changeMapping(index, { portAddress: Number(event.target.value) })} />
            <select aria-label={`Universe mapping ${index + 1}`} value={entry.universe} className={controlClass}
              onChange={event => changeMapping(index, { universe: Number(event.target.value) })}>
              {LOGICAL_DMX_UNIVERSES.map(item => <option key={item} value={item}>U{item}</option>)}
            </select>
            <input aria-label={`Pinned sender mapping ${index + 1}`} maxLength={15} className={controlClass}
              value={entry.sender} onChange={event => changeMapping(index, { sender: event.target.value })} />
            <button type="button" aria-label={`Remove mapping ${index + 1}`} className={controlClass} disabled={shown.mappings.length === 1}
              onClick={() => setConfig(current => ({ ...current, mappings: current.mappings.filter((_, i) => i !== index) }))}>×</button>
          </div>
        ))}
        <button type="button" className="transport-btn" disabled={shown.mappings.length >= 16} onClick={addMapping}>Add mapping</button>
      </fieldset>

      {(snapshot.error || interfaceError) && <p role="alert" className="text-amber-300">{snapshot.error ?? interfaceError}</p>}
      <div className="flex items-center justify-between gap-2">
        <p data-testid="artnet-input-status" role="status" className="font-semibold text-cyan-200">{label}</p>
        <label className="flex items-center gap-2 text-zinc-300">
          <span>Received universe</span>
          <select className={controlClass} value={mapping.universe} onChange={event => setUniverse(Number(event.target.value))}>
            {shown.mappings.filter((entry, index, all) => all.findIndex(item => item.universe === entry.universe) === index)
              .map(entry => <option key={entry.universe} value={entry.universe}>U{entry.universe}</option>)}
          </select>
        </label>
      </div>
      <p className="font-mono-tech text-[10px] text-zinc-300">
        UDP {shown.address}{snapshot.port !== null && `:${snapshot.port}`} · Port-Address {mapping.portAddress} → U{mapping.universe} · {mapping.sender}
      </p>
      <p className="font-mono-tech text-[10px] text-zinc-300">
        Age {age === null ? '—' : `${(age / 1000).toFixed(1)} s`} · Received {row?.received ?? 0} · Sequence loss {row?.lost ?? 0}
      </p>
      <p className="font-mono-tech text-[10px] text-zinc-400">
        Dropped · Sender {snapshot.batch?.drops.unselected ?? 0} · Address {snapshot.batch?.drops.unmapped ?? 0} ·
        Sequence {snapshot.batch?.drops.sequence ?? 0} · Invalid {snapshot.batch?.drops.invalid ?? 0}
      </p>
      <div aria-label="Received channel levels" className="grid grid-cols-8 gap-0.5 font-mono-tech text-[9px]">
        {Array.from(data, (level, index) => {
          const channel = `U${mapping.universe}.${String(index + 1).padStart(3, '0')}`;
          return <span key={index} title={`${channel}: ${level}`} aria-label={`${channel}: ${level}`}
            data-testid={`artnet-input-slot-${index + 1}`}
            className={`rounded border border-white/10 p-0.5 text-center ${level ? 'bg-cyan-500/20 text-cyan-100' : 'text-zinc-500'}`}>
            <span className="block text-[8px] text-zinc-400">{index + 1}</span>{level}
          </span>;
        })}
      </div>
    </section>
  );
}
