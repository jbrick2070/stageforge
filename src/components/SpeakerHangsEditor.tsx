import { useEffect, useState } from 'react';
import { Plus, RotateCcw, Speaker, Trash2 } from 'lucide-react';
import type { RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import { defaultSpeakerHangs, MAX_STAGE_HANGS, NATIVE_RENDERED_HANGS, setAuthoredHangs, type SpeakerHang } from '../data/studioGeometry';
import { GRID_HEIGHT } from '../data/stageEquipment';

function HangField({
  label,
  value,
  min,
  max,
  step,
  integer,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (raw: string) => {
    const next = Number(raw);
    if (!raw.trim() || !Number.isFinite(next) || next === value) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, integer ? Math.round(next) : next));
    if (clamped !== value) onChange(clamped);
    setDraft(String(clamped));
  };
  return (
    <label className="grid gap-0.5 text-[10px] text-zinc-300">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft}
        className="w-full rounded border border-white/15 bg-zinc-900 px-1.5 py-1 text-zinc-100 font-mono-tech"
        onChange={e => setDraft(e.currentTarget.value)}
        onBlur={e => commit(e.currentTarget.value)}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </label>
  );
}

export function SpeakerHangsEditor({
  rig,
  stage,
  onChangeStage,
}: {
  rig: RigConfig;
  stage?: NativeStage;
  onChangeStage: (next?: NativeStage) => void;
}) {
  const authored = stage?.layout?.hangs;
  const [index, setIndex] = useState(0);

  if (authored === undefined) {
    return (
      <button
        type="button"
        className="w-full rounded border border-white/15 bg-white/5 hover:bg-white/10 py-1 px-2 text-[10px] font-mono-tech text-zinc-200 flex items-center justify-center gap-1.5 cursor-pointer"
        onClick={() => {
          const seed = defaultSpeakerHangs(rig);
          const initial: SpeakerHang[] = seed.length
            ? seed
            : [{ x: -(rig.stageWidth / 2 + 1.35), y: Math.min(GRID_HEIGHT[rig.venue] - 1.1, 4.1), z: 1, yaw: 0, tilt: 0, count: 4, splay: 4 }];
          onChangeStage(setAuthoredHangs(rig, stage, initial));
          setIndex(0);
        }}
      >
        <Speaker className="w-3 h-3 text-amber-300" />
        Aim individual speaker hangs
      </button>
    );
  }

  const safeIndex = Math.min(index, Math.max(0, authored.length - 1));
  const selected = authored[safeIndex];
  const updateSelected = (patch: Partial<SpeakerHang>) => {
    if (!selected) return;
    const next = authored.map((hang, i) => (i === safeIndex ? { ...hang, ...patch } : hang));
    onChangeStage(setAuthoredHangs(rig, stage, next));
  };

  const addHang = () => {
    if (authored.length >= MAX_STAGE_HANGS) return;
    const side = authored.length % 2 === 0 ? -1 : 1;
    const created: SpeakerHang = {
      x: Number((side * (rig.stageWidth / 2 + 0.5)).toFixed(2)),
      y: Number(Math.min(GRID_HEIGHT[rig.venue] - 0.8, 4.5).toFixed(2)),
      z: 1,
      yaw: side * 12,
      tilt: 0,
      count: Math.max(1, Math.min(16, rig.audioRig.boxesPerSide ?? 4)),
      splay: 4,
    };
    onChangeStage(setAuthoredHangs(rig, stage, [...authored, created]));
    setIndex(authored.length);
  };

  const removeSelected = () => {
    const next = authored.filter((_, i) => i !== safeIndex);
    onChangeStage(setAuthoredHangs(rig, stage, next));
    setIndex(Math.max(0, safeIndex - 1));
  };

  return (
    <fieldset className="rounded border border-amber-400/25 bg-black/35 p-2 space-y-2">
      <legend className="px-1 text-[10px] font-mono-tech text-amber-200 tracking-wider">
        AUTHORED SPEAKER HANGS ({authored.length})
      </legend>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={addHang}
          disabled={authored.length >= MAX_STAGE_HANGS}
          className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/50 text-[10px] font-mono-tech text-amber-100 flex items-center gap-1 cursor-pointer disabled:opacity-40"
        >
          <Plus className="w-3 h-3" /> Add hang
        </button>
        <button
          type="button"
          onClick={() => {
            // Resetting discards every authored position and angle; ask once.
            if (authored.length && !window.confirm(`Discard ${authored.length} authored speaker ${authored.length === 1 ? 'hang' : 'hangs'} and return to symmetric L/R arrays?`)) return;
            onChangeStage(setAuthoredHangs(rig, stage, undefined));
            setIndex(0);
          }}
          className="ml-auto px-2 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] font-mono-tech text-zinc-300 flex items-center gap-1 cursor-pointer"
          title="Return to symmetric L/R line arrays"
        >
          <RotateCcw className="w-3 h-3" /> Reset L/R
        </button>
      </div>
      {authored.length > NATIVE_RENDERED_HANGS && (
        <p className="text-[10px] text-amber-300">The native desk draws the first {NATIVE_RENDERED_HANGS} hangs only.</p>
      )}
      {selected ? (
        <>
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Speaker hang"
              value={safeIndex}
              onChange={e => setIndex(Number(e.currentTarget.value))}
              className="flex-1 min-w-0 rounded border border-white/15 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-100"
            >
              {authored.map((h, i) => (
                <option key={i} value={i}>
                  Hang {i + 1} · {h.count} boxes · {h.yaw}°
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Remove speaker hang"
              title="Remove speaker hang"
              onClick={removeSelected}
              className="p-1.5 rounded bg-white/5 hover:bg-rose-500/25 text-zinc-300 hover:text-rose-200 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <HangField label="Hang X (m)" value={selected.x} min={-40} max={40} step={0.1} onChange={x => updateSelected({ x })} />
            <HangField label="Hang height (m)" value={selected.y} min={0.5} max={25} step={0.1} onChange={y => updateSelected({ y })} />
            <HangField label="Hang Z (m)" value={selected.z} min={-40} max={40} step={0.1} onChange={z => updateSelected({ z })} />
            <HangField label="Hang aim (°)" value={selected.yaw} min={-180} max={180} step={1} onChange={yaw => updateSelected({ yaw })} />
            <HangField label="Hang tilt (°)" value={selected.tilt} min={-90} max={90} step={1} onChange={tilt => updateSelected({ tilt })} />
            <HangField label="Hang boxes" value={selected.count} min={1} max={16} step={1} integer onChange={count => updateSelected({ count })} />
            <HangField label="Hang splay (°)" value={selected.splay} min={0} max={15} step={0.5} onChange={splay => updateSelected({ splay })} />
          </div>
        </>
      ) : (
        <p className="text-[10px] text-zinc-400">No flown speaker hangs on this stage. Add a hang or reset to L/R arrays.</p>
      )}
    </fieldset>
  );
}
