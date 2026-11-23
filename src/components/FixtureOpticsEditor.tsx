import { useEffect, useRef, useState } from 'react';
import type { BeamProfile, FixtureOptics } from '../types/show';
import { fixtureOptics, MAX_ANGLE, MAX_LUMENS, MIN_ANGLE, REFERENCE_OPTICS, type MovingHeadKind } from '../data/fixtureOptics';

function OpticNumber({ label, value, inherited, source, min, max, onChange }: {
  label: string; value?: number; inherited: number; source: string;
  min: number; max: number; onChange: (v?: number) => void;
}) {
  const [draft, setDraft] = useState(value?.toString() ?? '');
  useEffect(() => setDraft(value?.toString() ?? ''), [value]);
  return <label className="min-w-0">{label}
    <input type="number" aria-label={label} min={min} max={max} step="any" value={draft}
      placeholder={String(+inherited.toFixed(2))} className="block w-full rounded bg-zinc-950 px-1.5 py-1 text-zinc-100"
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onBlur={() => {
        if (!draft.trim()) { if (value !== undefined) onChange(undefined); return; }
        const n = Number(draft);
        if (Number.isFinite(n) && n >= min && n <= max) { if (n !== value) onChange(n); }
        else setDraft(value?.toString() ?? '');
      }}/>
    <span className="text-zinc-400">{value === undefined ? source : 'User override'}</span>
  </label>;
}

export function FixtureOpticsEditor({ kind, settings, onChange }: {
  kind: MovingHeadKind; settings?: FixtureOptics; onChange: (value?: FixtureOptics) => void;
}) {
  const baseline = fixtureOptics(kind, { profile: settings?.profile });
  const current = fixtureOptics(kind, settings);
  const source = settings?.profile?.source === 'datasheet' ? 'Manufacturer sheet' : 'GDTF value';
  const referenceIndex = REFERENCE_OPTICS.findIndex(p => settings?.profile?.source === 'datasheet' &&
    p.fixture === settings.profile.fixture && p.geometry === settings.profile.geometry &&
    p.lumens === settings.profile.lumens && p.beamAngle === settings.profile.beamAngle);
  const choiceId = referenceIndex >= 0 ? String(referenceIndex) : settings?.profile ? 'saved' : '';
  const [choices, setChoices] = useState<BeamProfile[]>([]);
  const [choice, setChoice] = useState(0);
  const [error, setError] = useState('');
  const request = useRef(0);
  const load = async (file: File) => {
    const token = ++request.current;
    setChoices([]); setError('');
    try {
      const { readGdtfOptics } = await import('../data/gdtfOptics');
      const profiles = await readGdtfOptics(file);
      if (token === request.current) { setChoices(profiles); setChoice(0); }
    } catch (reason) {
      if (token === request.current) setError(reason instanceof Error ? reason.message : 'Cannot open GDTF.');
    }
  };
  const override = (key: 'lumens' | 'beamAngle', value?: number) => {
    const next = { ...settings, [key]: value };
    onChange(next.profile || next.lumens !== undefined || next.beamAngle !== undefined ? next : undefined);
  };
  return <details className="rounded bg-black/20 px-2 py-1 text-[10px] text-zinc-300">
    <summary className="cursor-pointer">Fixture optics · {Math.round(current.lumens).toLocaleString()} lm</summary>
    <label className="mt-1.5 block">Reference optics
      <select aria-label="Reference optics" className="block w-full bg-zinc-900"
        value={choiceId}
        onChange={e => { onChange(e.target.value === '' ? undefined : { profile: REFERENCE_OPTICS[Number(e.target.value)] }); setChoices([]); }}>
        <option value="">Generic {kind}</option>
        {REFERENCE_OPTICS.map((p, index) => <option key={p.fixture} value={index}>{p.fixture} · {p.geometry}</option>)}
        {settings?.profile && choiceId === 'saved' && <option value="saved">{settings.profile.fixture} · {settings.profile.geometry}</option>}
      </select>
    </label>
    <div className="mt-1.5 grid grid-cols-2 gap-2">
      <OpticNumber label="Rated lumens per fixture" value={settings?.lumens} inherited={baseline.lumens}
        source={settings?.profile?.lumens !== undefined ? source : 'Estimated'} min={0} max={MAX_LUMENS}
        onChange={v => override('lumens', v)}/>
      <OpticNumber label="Beam angle at 1× (°)" value={settings?.beamAngle} inherited={baseline.beamAngle}
        source={settings?.profile?.beamAngle !== undefined ? source : 'Estimated'} min={MIN_ANGLE} max={MAX_ANGLE}
        onChange={v => override('beamAngle', v)}/>
    </div>
    {settings?.profile && <p>{settings.profile.manufacturer} · {settings.profile.fixture} · {settings.profile.geometry}</p>}
    <label className="my-1 block">Import GDTF optics
      <input type="file" accept=".gdtf" aria-label="Import GDTF optics" className="block w-full"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void load(f); }}/>
    </label>
    {choices.length > 0 && <div className="space-y-1">
      <label>Beam geometry
        <select aria-label="Beam geometry" value={choice} onChange={e => setChoice(+e.target.value)}
          className="block w-full bg-zinc-900">{choices.map((p, i) =>
            <option key={i} value={i}>{p.fixture} · {p.geometry}</option>)}</select>
      </label>
      <p>Applies this emitter to each unit. The group keeps its StageForge DMX layout.</p>
      <button type="button" className="rounded bg-cyan-900 px-2 py-1" onClick={() => {
        onChange({ profile: choices[choice] }); setChoices([]);
      }}>Use beam profile</button>
    </div>}
    {error && <p role="alert" className="text-amber-300">{error}</p>}
    {settings && <button type="button" onClick={() => { onChange(undefined); setChoices([]); }}>Reset optics</button>}
  </details>;
}
