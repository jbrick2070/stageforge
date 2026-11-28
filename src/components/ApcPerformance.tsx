import { useState, type CSSProperties } from 'react';
import {
  APC_FADERS, APC_ROWS, APC_SCENES, apcFaderValue, apcPadSelected,
  type ApcAction, type ApcRig,
} from '../input/apc40Pack';
import type { useApc40 } from '../input/useApc40';
import type { ShowState } from '../types/show';

export function ApcPerformance({ open, toggle, look, rig, cueId, available, send, midi }: {
  open: boolean;
  toggle: () => void;
  look: ShowState;
  rig: ApcRig;
  cueId: string | null;
  available: (action: ApcAction) => boolean;
  send: (action: ApcAction) => void;
  midi: ReturnType<typeof useApc40>;
}) {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const blocked = !available({ kind: 'blackout' });
  const suspended = !blocked && !available({ kind: 'fader', fader: 'masterDimmer', value: 0 });
  return (
    <aside className="apc-performance" aria-label="APC40 mkII Deep House performance">
      <button type="button" className="transport-btn apc-toggle" onClick={toggle} aria-expanded={open}>
        {open ? 'Close APC40 desk' : 'APC40 performance'}
      </button>
      {open && <div className="apc-desk">
        <header>
          <h2>Deep House</h2>
          <button type="button" className="transport-btn" disabled={blocked} onClick={() => send({ kind: 'blackout' })}>Latch blackout</button>
        </header>
        {blocked && <p role="status">Available on the Deep House U3 rehearsal stage in the editor with physical output off.</p>}
        {suspended && <p role="status">Playback owns the desk. Blackout is available.</p>}
        <div className="apc-pads">
          {APC_ROWS.map(row => <div className="apc-row" role="group" aria-label={row.name} key={row.name}>
            <h3>{row.name}</h3>
            <div>
              {row.pads.map(pad => {
                const selected = apcPadSelected(pad.action, look, cueId);
                return <button type="button" key={pad.name} aria-label={row.name + ' ' + pad.name}
                  aria-pressed={selected} disabled={!available(pad.action)} onClick={() => send(pad.action)}
                  style={{ '--pad-primary': pad.hex, '--pad-accent': pad.accent ?? pad.hex } as CSSProperties}>
                  <span className="apc-color-strip" aria-hidden="true" />
                  <span>{pad.name}</span>
                  {selected && <span className="apc-selected" aria-hidden="true">✓</span>}
                </button>;
              })}
            </div>
          </div>)}
        </div>
        <div className="apc-scenes" role="group" aria-label="Scene buttons">
          {APC_SCENES.map(scene => <button type="button" key={scene.name} aria-pressed={apcPadSelected(scene.action, look, cueId)}
            disabled={!available(scene.action)} onClick={() => send(scene.action)} className="transport-btn">
            {scene.name}
          </button>)}
        </div>
        <div className="apc-faders" role="group" aria-label="Performance faders">
          {APC_FADERS.map(([fader, label]) => {
            const value = apcFaderValue(look, fader, rig);
            const allowed = available({ kind: 'fader', fader, value });
            return <label key={fader}>
              <span>{label}</span>
              <input type="range" min="0" max="1" step="0.01" value={value} aria-label={label}
                disabled={!allowed} onChange={event => send({ kind: 'fader', fader, value: Number(event.target.value) })} />
              <span>{allowed ? Math.round(value * 100) + '%' : 'Unavailable'}</span>
            </label>;
          })}
        </div>
        <details className="apc-midi">
          <summary>APC40 mkII MIDI connection</summary>
          <p role="status">{midi.status}</p>
          <p>USB and controller LEDs have been checked with protocol mocks. A physical device check is pending.</p>
          {!midi.ports ? <button type="button" className="transport-btn" disabled={blocked || midi.requesting} onClick={() => void midi.enable()}>
            {midi.requesting ? 'Requesting MIDI…' : 'Enable MIDI access'}
          </button> : <div>
            <label>MIDI input<select aria-label="APC40 MIDI input" value={input} onChange={event => { midi.disconnect(); setInput(event.target.value); }}>
              <option value="">Select input</option>
              {midi.ports.inputs.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}
            </select></label>
            <label>MIDI output<select aria-label="APC40 MIDI output" value={output} onChange={event => { midi.disconnect(); setOutput(event.target.value); }}>
              <option value="">Select output</option>
              {midi.ports.outputs.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}
            </select></label>
            {midi.connected ? <button type="button" className="transport-btn" onClick={midi.disconnect}>Disconnect APC40 mkII</button>
              : <button type="button" className="transport-btn" disabled={blocked || !input || !output} onClick={() => midi.connect(input, output)}>Connect APC40 mkII</button>}
          </div>}
        </details>
      </div>}
    </aside>
  );
}
