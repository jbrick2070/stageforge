import { useEffect, useState } from 'react';
import { Monitor, Plus, Trash2 } from 'lucide-react';
import type { RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import {
  createSecondaryWall,
  isCustomMainWall,
  MAX_STAGE_WALLS,
  MAX_WALL_HEIGHT,
  MAX_WALL_WIDTH,
  pruneNativeStage,
  removeStageWall,
  resolveWallFrame,
  upsertStageWall,
  type StageWall,
} from '../data/studioGeometry';

function ScreenNumber({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
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
    const clamped = Math.max(min, Math.min(max, next));
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

export function ScreenWallsEditor({
  rig,
  stage,
  onChangeStage,
}: {
  rig: RigConfig;
  stage?: NativeStage;
  onChangeStage: (next?: NativeStage) => void;
}) {
  const walls = stage?.walls ?? [];
  const secondaryCount = walls.filter(w => w.id !== 'main-led').length;
  const [selectedId, setSelectedId] = useState('');
  const selected = walls.find(w => w.id === selectedId) ?? walls.find(w => w.id !== 'main-led') ?? walls[0];
  const [labelDraft, setLabelDraft] = useState(selected?.label ?? '');
  useEffect(() => setLabelDraft(selected?.label ?? ''), [selected?.id, selected?.label]);

  const addWall = () => {
    if (walls.length >= MAX_STAGE_WALLS) return;
    const created = createSecondaryWall(rig, stage);
    onChangeStage(upsertStageWall(rig, stage, created));
    setSelectedId(created.id);
  };

  const mainWall = walls.find(w => w.id === 'main-led');
  if (!secondaryCount && !isCustomMainWall(mainWall)) {
    return (
      <button
        type="button"
        onClick={addWall}
        className="w-full rounded border border-white/15 bg-white/5 hover:bg-white/10 py-1 px-2 text-[10px] font-mono-tech text-zinc-200 flex items-center justify-center gap-1.5 cursor-pointer"
      >
        <Monitor className="w-3 h-3 text-fuchsia-300" />
        Add secondary LED screen
      </button>
    );
  }

  const round2 = (n: number) => Number(n.toFixed(2));
  const resolved = (wall: StageWall) => {
    const f = resolveWallFrame(rig, wall);
    return { x: round2(f.x), y: round2(f.y), z: round2(f.z), width: round2(f.width), height: round2(f.height), yaw: f.yaw };
  };

  // Pin only the edited field. Unset main-led fields keep following the rig's stock
  // wall, and a label edit never turns the stock wall into a custom panel.
  const editWall = (patch: Partial<StageWall>) => {
    if (!selected) return;
    onChangeStage(pruneNativeStage(upsertStageWall(rig, stage, { ...selected, ...patch })));
  };

  const removeSelected = () => {
    if (!selected) return;
    const cueCount = (stage?.screenEvents ?? []).filter(e => e.target === selected.id).length;
    if (cueCount && !window.confirm(`Remove ${selected.label || selected.id} and its ${cueCount} wall ${cueCount === 1 ? 'cue' : 'cues'}?`)) return;
    onChangeStage(removeStageWall(rig, stage, selected.id));
    setSelectedId('');
  };

  const dims = selected ? resolved(selected) : null;

  return (
    <fieldset className="rounded border border-fuchsia-400/25 bg-black/35 p-2 space-y-2">
      <legend className="px-1 text-[10px] font-mono-tech text-fuchsia-200 tracking-wider">
        STAGE LED SCREENS ({walls.length})
      </legend>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={addWall}
          disabled={walls.length >= MAX_STAGE_WALLS}
          className="px-2 py-1 rounded bg-fuchsia-500/20 hover:bg-fuchsia-500/35 border border-fuchsia-400/50 text-[10px] font-mono-tech text-fuchsia-100 flex items-center gap-1 cursor-pointer disabled:opacity-40"
        >
          <Plus className="w-3 h-3" /> Add screen
        </button>
      </div>
      {selected && dims && (
        <>
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Stage screen"
              value={selected.id}
              onChange={e => setSelectedId(e.currentTarget.value)}
              className="flex-1 min-w-0 rounded border border-white/15 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-100"
            >
              {walls.map(w => (
                <option key={w.id} value={w.id}>
                  {w.label ? `${w.label} (${w.id})` : w.id}
                </option>
              ))}
            </select>
            {selected.id !== 'main-led' && (
              <button
                type="button"
                aria-label="Remove stage screen"
                title="Remove stage screen"
                onClick={removeSelected}
                className="p-1.5 rounded bg-white/5 hover:bg-rose-500/25 text-zinc-300 hover:text-rose-200 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            {selected.id === 'main-led' && isCustomMainWall(selected) && (
              <button
                type="button"
                title="Return the main wall to the rig's stock placement, size and IMAG wings"
                onClick={() => editWall({ x: undefined, y: undefined, z: undefined, width: undefined, height: undefined, yaw: undefined })}
                className="px-1.5 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] font-mono-tech text-zinc-300 cursor-pointer"
              >
                Use rig placement
              </button>
            )}
          </div>
          {selected.id === 'main-led' && isCustomMainWall(selected) && (
            <p className="text-[10px] text-zinc-400">Custom main wall: one panel replaces the stock wall and IMAG wings.</p>
          )}
          <label className="grid gap-0.5 text-[10px] text-zinc-300">
            <span>Screen label</span>
            <input
              type="text"
              aria-label="Screen label"
              value={labelDraft}
              placeholder={selected.id}
              className="w-full rounded border border-white/15 bg-zinc-900 px-1.5 py-1 text-zinc-100"
              onChange={e => setLabelDraft(e.currentTarget.value)}
              onBlur={() => { if (labelDraft.trim() !== (selected.label ?? '')) editWall({ label: labelDraft }); }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <ScreenNumber label="Screen X (m)" value={dims.x} min={-40} max={40} step={0.1} onChange={x => editWall({ x })} />
            <ScreenNumber label="Screen Y (m)" value={dims.y} min={0.2} max={25} step={0.1} onChange={y => editWall({ y })} />
            <ScreenNumber label="Screen Z (m)" value={dims.z} min={-40} max={40} step={0.1} onChange={z => editWall({ z })} />
            <ScreenNumber label="Screen width (m)" value={dims.width} min={0.2} max={MAX_WALL_WIDTH} step={0.1} onChange={width => editWall({ width })} />
            <ScreenNumber label="Screen height (m)" value={dims.height} min={0.2} max={MAX_WALL_HEIGHT} step={0.1} onChange={height => editWall({ height })} />
            <ScreenNumber label="Screen yaw (°)" value={dims.yaw} min={-180} max={180} step={1} onChange={yaw => editWall({ yaw })} />
          </div>
        </>
      )}
    </fieldset>
  );
}
