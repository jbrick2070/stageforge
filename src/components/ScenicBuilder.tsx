import { useState } from 'react';
import { Plus, Shapes, Trash2 } from 'lucide-react';
import { createStageProp, PROP_CATALOG } from '../data/stageProps';
import type { RigConfig, StageProp, StagePropKind } from '../types/show';

const kinds = Object.keys(PROP_CATALOG) as StagePropKind[];

export function ScenicBuilder({ rig, onChange }: { rig: RigConfig; onChange: (rig: RigConfig) => void }) {
  const pieces = rig.props ?? [];
  const [kind, setKind] = useState<StagePropKind>('star');
  const [selectedId, setSelectedId] = useState('');
  const selected = pieces.find(p => p.id === selectedId) ?? pieces[0];
  const change = (patch: Partial<StageProp>) => onChange({
    ...rig, props: pieces.map(p => p.id === selected.id ? { ...p, ...patch } : p),
  });
  const add = () => {
    const slots = [-0.32, 0.32, -0.17, 0.17, 0];
    const x = kind === 'arch' ? 0 : Math.round(rig.stageWidth * slots[pieces.length % slots.length] * 10) / 10;
    const item = createStageProp(kind, crypto.randomUUID(), x, kind === 'arch' ? -rig.stageDepth / 4 : 1.3);
    onChange({ ...rig, props: [...pieces, item] });
    setSelectedId(item.id);
  };
  return (
    <section aria-label="Scenic props" className="rounded-lg border border-white/15 bg-black/35 p-2.5 space-y-2">
      <h3 className="font-mono-tech text-[11px] tracking-widest flex items-center gap-2 text-amber-200">
        <Shapes size={15} /> INFLATABLES &amp; STAGE PROPS
      </h3>
      <div className="flex items-center gap-2">
        <select aria-label="Prop to add" value={kind} onChange={e => setKind(e.target.value as StagePropKind)}
          className="min-w-0 flex-1 rounded border border-white/15 bg-zinc-900 p-1.5">
          {kinds.map(k => <option key={k} value={k}>{PROP_CATALOG[k].label}</option>)}
        </select>
        <button onClick={add} className="rounded bg-amber-200 px-2.5 py-1.5 text-zinc-950 font-semibold flex items-center gap-1">
          <Plus size={13} /> Add prop
        </button>
      </div>
      {selected && <>
        <div className="flex items-center gap-2">
          <select aria-label="Placed prop" value={selected.id} onChange={e => setSelectedId(e.target.value)}
            className="flex-1 min-w-0 rounded border border-white/15 bg-zinc-900 p-1.5">
            {pieces.map((p, index) => <option key={p.id} value={p.id}>{index + 1}. {PROP_CATALOG[p.kind].label}</option>)}
          </select>
          <input aria-label="Prop color" title="Prop color" type="color" value={selected.color}
            onChange={e => change({ color: e.target.value })} className="w-8 h-7 cursor-pointer" />
          <button aria-label="Remove selected prop" title="Remove selected prop" className="p-1.5 text-zinc-400 hover:text-rose-300"
            onClick={() => onChange({ ...rig, props: pieces.filter(p => p.id !== selected.id) })}><Trash2 size={15} /></button>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {([
            ['x', 'Left / right', -rig.stageWidth / 2, rig.stageWidth / 2, 0.1, ' m'],
            ['z', 'Back / front', -rig.stageDepth / 2, rig.stageDepth / 2, 0.1, ' m'],
            ['scale', 'Size', 0.35, 2, 0.05, '×'],
            ['rotation', 'Rotation', -180, 180, 1, '°'],
          ] as const).map(([key, label, min, max, step, unit]) => (
            <label key={key} className="flex flex-col gap-1 text-[10px] text-zinc-300">
              <span className="flex justify-between">{label}<output className="font-mono-tech text-amber-200">{selected[key]}{unit}</output></span>
              <input aria-label={label} type="range" min={min} max={max} step={step} value={selected[key]}
                onChange={e => change({ [key]: Number(e.target.value) })} className="w-full accent-amber-200" />
            </label>
          ))}
        </div>
      </>}
    </section>
  );
}
